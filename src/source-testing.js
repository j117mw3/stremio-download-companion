import {failure} from './transfer-state.js';

export class ExtraBudget {
  constructor(limit=2){this.limit=limit;this.used=0;this.waiters=[];}
  lease(){this.used++;let released=false;return ()=>{if(released)return;released=true;this.used--;this.drain();};}
  tryAcquire(){return this.used<this.limit&&!this.waiters.length?this.lease():null;}
  acquire(signal,round=0){
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const item={resolve,reject,signal,round};
      item.abort=()=>{this.waiters=this.waiters.filter(w=>w!==item);reject(signal.reason);};
      signal.addEventListener('abort',item.abort,{once:true});this.waiters.push(item);this.waiters.sort((a,b)=>a.round-b.round);this.drain();
    });
  }
  drain(){while(this.used<this.limit&&this.waiters.length){const item=this.waiters.shift();item.signal.removeEventListener('abort',item.abort);if(!item.signal.aborted)item.resolve(this.lease());else item.reject(item.signal.reason);}}
}

export class ConnectivityEvidence {
  constructor(now){this.started=now;this.bytes=0;this.verified=0;this.windows=[];this.ready=false;this.video=false;this.complete=false;this.firstByteAt=null;this.lastByteAt=null;}
  update(bytes,verified,now,{complete=false,video=false}={}){
    if(bytes>this.bytes){this.firstByteAt??=now;this.lastByteAt=now;if(!this.windows.length||now-this.windows.at(-1)>=1000){this.windows.push(now);if(this.windows.length>120)this.windows.shift();}}
    this.bytes=Math.max(this.bytes,bytes);this.verified=Math.max(this.verified,verified);this.complete=complete;this.video||=video;
  }
  qualifies(torrent){return this.bytes>0&&(torrent?this.verified>0:this.video)&&(this.complete||(this.windows.length>=2&&this.windows.at(-1)-this.windows[0]>=3000));}
  // Exclude setup time, but include any idle time after payload begins so a
  // burst followed by a stall does not appear to be a fast source.
  score(now){if(this.firstByteAt===null)return 0;const end=this.complete&&this.lastByteAt!==null?this.lastByteAt:this.cappedAt!==undefined?Math.max(this.cappedAt,this.lastByteAt??this.cappedAt):now;return this.bytes/Math.max(.001,(end-this.firstByteAt)/1000);}
}

export function verifiedFileBytes(torrent,file){
  let bytes=0;const end=file.offset+file.length;
  for(let index=Math.floor(file.offset/torrent.pieceLength);index<=Math.floor((end-1)/torrent.pieceLength);index++){
    if(torrent.bitfield?.get(index))bytes+=Math.max(0,Math.min(end,(index+1)*torrent.pieceLength)-Math.max(file.offset,index*torrent.pieceLength));
  }
  return bytes;
}

// Select a bounded candidate window at full speed; episode-byte and verification
// limits, rather than an artificial per-second window, bound the network test.
export function probeSelection(entry,file){
  const t=entry.torrent;let range=null,released=false;
  const clear=()=>{if(range&&!t.destroyed)t.deselect(range[0],range[1],2);range=null;};
  const advance=()=>{
    if(released||t.destroyed)return;
    if(range){for(let i=range[0];i<=range[1];i++)if(!t.bitfield.get(i))return;clear();}
    const last=Math.floor((file.offset+file.length-1)/t.pieceLength);
    let first=Math.floor(file.offset/t.pieceLength);while(first<=last&&t.bitfield.get(first))first++;
    if(first>last)return;
    range=[first,Math.min(last,first+Math.max(1,Math.floor(TEST_LIMIT/t.pieceLength))-1)];t.select(range[0],range[1],2);
  };
  advance();return {advance,release(){if(released)return;released=true;clear();}};
}

export const TEST_LIMIT=16*1024*1024;
export const MAX_SOURCE_TURN_SOURCES=5;
export const SOURCE_TURN_LIMIT_MS=60_000;
export const testStopped=reason=>failure('TEST_INCONCLUSIVE',reason);

// The shared budget admits waiting first candidates before second candidates.
// Up to two alternatives may run together when capacity is available.
export async function compareSources({signal,primary,candidates,getCandidates=null,discoveryDone=()=>true,start,budget,now=Date.now,onView=()=>{},onResult=()=>{},shouldCompare=()=>false,isRecovered=()=>false,shouldYield=()=>false,shouldSwitch,noDataAfterMs=15000,noDataLimitMs=45000,comparisonLimitMs=30000,sourceTurnDeadline=null}){
  const active=new Set();let original,adopted,testing=false,testDone=false,testTask=null,stop;
  const owned=new AbortController();const combined=AbortSignal.any([signal,owned.signal]);
  const own=(choice,probe)=>{const attempt=start(choice,probe,combined);active.add(attempt);attempt.promise.then(value=>{attempt.result={value};},error=>{attempt.result={error};});return attempt;};
  original=own(primary,false);adopted=original;
  let recoveryStart=null,recoveryVerified=0,triggerMode=null;
  const recovered=()=>triggerMode==='slow'?isRecovered(original.job):recoveryStart!==null&&original.evidence.windows.filter(time=>time>=recoveryStart).length>=2&&(!primary.infoHash||original.evidence.verified>recoveryVerified);
  const rateOf=attempt=>{
    const rolling=Number(attempt?.job?.rollingSpeed);
    return Math.max(0,Number.isFinite(rolling)?rolling:Number(attempt?.job?.speed)||0);
  };
  const clearsSwitchThreshold=candidate=>{
    const candidateRate=candidate.evidence.score(now()),currentRate=rateOf(original);
    return shouldSwitch?shouldSwitch({currentRate,candidateRate,primary:original,candidate}):candidateRate>=currentRate*2&&candidateRate>=currentRate+262144;
  };
  const hasUsefulData=attempt=>!!attempt&&(attempt.choice.infoHash?attempt.evidence.verified>0:attempt.evidence.video&&attempt.evidence.bytes>0);
  const makeFailure=()=>failure(primary.infoHash?'NO_USEFUL_PIECES':'HTTP_STALL',primary.infoHash?'No verified episode data within the source search window':'No valid HTTP video payload within the source search window');
  const terminalFailure=()=>original.result?.error&&original.result.error.code!=='TEST_INCONCLUSIVE'?original.result.error:makeFailure();
  const test=async(limitMs,mode)=>{
    const session=new AbortController();const testSignal=AbortSignal.any([combined,session.signal]);
    const comparisonTimer=setTimeout(()=>session.abort(testStopped('Source comparison time limit reached')),Math.max(0,limitMs));
    let pool=new Set(),finished=0,workerError=null,adoptedWinner=false;
    const report=(choice,candidate)=>{
      if(candidate.reported||!candidate.result)return;
      candidate.reported=true;
      const qualifies=candidate.evidence.qualifies(!!choice.infoHash),code=candidate.result.error?.code||null;
      const status=code==='TEST_INCONCLUSIVE'?(qualifies?'working':'inconclusive'):['ENOSPC','VERIFY_UNAVAILABLE','METADATA_TIMEOUT','HTTP_STALL'].includes(code)?'inconclusive':code?'failed':'working';
      onResult(choice,{status,bytes:candidate.evidence.bytes,verifiedBytes:candidate.evidence.verified,speed:candidate.evidence.score(now()),code});
    };
    const runCandidate=async(choice,index)=>{
      let release,candidate;
      try{
        release=await budget.acquire(testSignal,Math.floor(index/2));
        if(testSignal.aborted||recovered())return;
        candidate=own(choice,true);pool.add(candidate);onView('testing',candidate,mode);
        while(!testSignal.aborted&&adopted===original&&!recovered()){
          if(original.result&&!original.result.error)break;
          if(candidate.result){report(choice,candidate);break;}
          await new Promise(resolve=>setTimeout(resolve,100));
        }
      }catch(error){if(!testSignal.aborted)workerError=error;}
      finally{
        if(candidate&&candidate!==adopted){candidate.cancel();await candidate.promise.catch(()=>{});active.delete(candidate);}
        if(candidate)report(choice,candidate);
        pool.delete(candidate);release?.();finished++;
      }
    };
    try{
      const candidateCap=mode==='slow'?2:(getCandidates?4:candidates.length);
      const testedKeys=new Set();let offset=0;
      const candidateKey=choice=>choice.infoHash?'torrent:'+choice.infoHash.toLowerCase():'url:'+choice.url;
      while(offset<candidateCap&&!testSignal.aborted&&!recovered()){
        const available=getCandidates?getCandidates():candidates;
        const first=available.find(choice=>!testedKeys.has(candidateKey(choice)));
        if(!first){if(!getCandidates||discoveryDone())break;await new Promise(resolve=>setTimeout(resolve,100));continue;}
        const wave=[first];testedKeys.add(candidateKey(first));
        let end=offset+1;
        // Never probe a lower quality while an eligible requested-quality
        // release in this turn is still being tested.
        if(offset+1<candidateCap){
          const second=available.find(choice=>!testedKeys.has(candidateKey(choice))&&choice.res===first.res);
          if(second){wave.push(second);testedKeys.add(candidateKey(second));end++;}
        }
        pool=new Set();finished=0;
        const workers=wave.map((choice,index)=>runCandidate(choice,offset+index));
        const all=Promise.allSettled(workers);
        try{
          while(!testSignal.aborted&&finished<workers.length&&!recovered()){
            if(original.result&&!original.result.error)break;
            const qualified=[...pool].filter(a=>a.evidence.qualifies(!!a.choice.infoHash)&&!a.result?.error);
            qualified.sort((a,b)=>(b.choice.res||0)-(a.choice.res||0)||b.evidence.score(now())-a.evidence.score(now()));
            const best=qualified.find(clearsSwitchThreshold);
            if(best&&original.job.stage!=='Checking video and audio'&&original.job.stage!=='Verifying replacement'){
              const measuredAt=now(),currentRate=rateOf(original),candidateRate=best.evidence.score(measuredAt);
              if(hasUsefulData(original))onResult(primary,{status:'slow',comparisonConfirmed:true,bytes:original.evidence.bytes,verifiedBytes:original.evidence.verified,speed:currentRate,comparedAt:measuredAt});
              best.reported=true;onResult(best.choice,{status:'working',comparisonConfirmed:true,bytes:best.evidence.bytes,verifiedBytes:best.evidence.verified,speed:candidateRate,comparedAt:measuredAt});
              onView('switching',best);
              if(!original.result){original.cancel();await original.promise.catch(()=>{});}
              if(original.result&&!original.result.error)break;
              adopted=best;best.promote();adoptedWinner=true;break;
            }
            await new Promise(resolve=>setTimeout(resolve,100));
          }
        }finally{await all;}
        if(workerError||adoptedWinner||original.result&&!original.result.error||recovered())break;
        offset=end;
      }
    }finally{
      session.abort(testStopped('Comparison sampling finished'));
      clearTimeout(comparisonTimer);
      testDone=true;
    }
    if(workerError&&!combined.aborted)throw workerError;
  };

  try{
    while(true){
      signal.throwIfAborted();
      if(adopted!==original){onView('primary',adopted);if(adopted.result){if(adopted.result.error){onResult(adopted.choice,{status:['ENOSPC','VERIFY_UNAVAILABLE'].includes(adopted.result.error.code)?'inconclusive':'failed',code:adopted.result.error.code});throw Object.assign(adopted.result.error,{sourceChoice:adopted.choice});}return {file:adopted.result.value,attempt:adopted,switched:true};}await new Promise(resolve=>setTimeout(resolve,100));continue;}
      if(original.result&&!original.result.error)return {file:original.result.value,attempt:original,switched:false};
      if(original.result?.error&&!['NO_USEFUL_PIECES','HTTP_STALL'].includes(original.result.error.code))throw original.result.error;
      const idle=now()-(original.job.lastProgressAt??original.job.dataStartedAt??original.started);
      const idleDue=idle>=noDataAfterMs,slowDue=!!shouldCompare(original.job);
      if(testing&&triggerMode==='idle'&&slowDue)triggerMode='slow';
      if(testing&&testDone&&recovered()){testing=false;testDone=false;testTask=null;recoveryStart=null;triggerMode=null;}
      if(!testing&&(idleDue||slowDue)){
        triggerMode=slowDue?'slow':'idle';
        if(candidates.length||(getCandidates&&(getCandidates().length||!discoveryDone()))){
          if(triggerMode==='idle'&&sourceTurnDeadline!==null&&now()>=sourceTurnDeadline){original.cancel();await original.promise.catch(()=>{});throw terminalFailure();}
          testing=true;recoveryStart=now();recoveryVerified=original.evidence.verified;
          const limit=triggerMode==='idle'&&sourceTurnDeadline!==null?Math.max(0,sourceTurnDeadline-now()):comparisonLimitMs;
          testTask=test(limit,triggerMode).catch(error=>{if(!combined.aborted)stop=error;testDone=true;});
        }else if(triggerMode==='slow'&&shouldYield(original.job)){original.cancel();await original.promise.catch(()=>{});return {yielded:true,attempt:original,switched:false};}
      }
      if(testing&&testDone&&triggerMode==='slow'&&!recovered()&&shouldYield(original.job)){
        original.cancel();await original.promise.catch(()=>{});return {yielded:true,attempt:original,switched:false};
      }
      if(stop)throw stop;
      if(original.result?.error&&(!testing||testDone)){
        if(original.result.error.code==='TEST_INCONCLUSIVE'&&!hasUsefulData(original))throw terminalFailure();
        throw original.result.error;
      }
      const useful=hasUsefulData(original);
      if(!useful&&sourceTurnDeadline!==null&&now()>=sourceTurnDeadline&&(!testing||testDone)){
        if(!original.result){original.cancel();await original.promise.catch(()=>{});}
        throw terminalFailure();
      }
      if(!original.result&&sourceTurnDeadline===null&&idle>=noDataLimitMs){
        original.cancel();await original.promise.catch(()=>{});
        throw makeFailure();
      }
      onView(testing&&!testDone?'testing':'primary',adopted,triggerMode);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }finally{
    owned.abort(testStopped('Comparison ended'));
    for(const attempt of active)attempt.cancel();
    await Promise.allSettled([...active].map(attempt=>attempt.promise));
    if(testTask)await testTask;
  }
}
