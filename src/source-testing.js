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
  constructor(now){this.started=now;this.bytes=0;this.verified=0;this.windows=[];this.ready=false;this.video=false;this.complete=false;}
  update(bytes,verified,now,{complete=false,video=false}={}){
    if(bytes>this.bytes&&(!this.windows.length||now-this.windows.at(-1)>=1000)){this.windows.push(now);if(this.windows.length>120)this.windows.shift();}
    this.bytes=Math.max(this.bytes,bytes);this.verified=Math.max(this.verified,verified);this.complete=complete;this.video||=video;
  }
  qualifies(torrent){return this.bytes>0&&(torrent?this.verified>0:this.video)&&(this.complete||(this.windows.length>=2&&this.windows.at(-1)-this.windows[0]>=3000));}
  score(now){return this.bytes/Math.max(1,(now-this.started)/1000);}
}

export function verifiedFileBytes(torrent,file){
  let bytes=0;const end=file.offset+file.length;
  for(let index=Math.floor(file.offset/torrent.pieceLength);index<=Math.floor((end-1)/torrent.pieceLength);index++){
    if(torrent.bitfield?.get(index))bytes+=Math.max(0,Math.min(end,(index+1)*torrent.pieceLength)-Math.max(file.offset,index*torrent.pieceLength));
  }
  return bytes;
}

// Test one small missing-piece window per sampling interval. This avoids a fast
// candidate exhausting its traffic allowance before sustained progress can be measured.
export function probeSelection(entry,file){
  const t=entry.torrent;let range=null,released=false;
  const clear=()=>{if(range&&!t.destroyed)t.deselect(range[0],range[1],2);range=null;};
  const advance=()=>{
    if(released||t.destroyed)return;
    if(range){for(let i=range[0];i<=range[1];i++)if(!t.bitfield.get(i))return;clear();}
    const last=Math.floor((file.offset+file.length-1)/t.pieceLength);
    let first=Math.floor(file.offset/t.pieceLength);while(first<=last&&t.bitfield.get(first))first++;
    if(first>last)return;
    range=[first,Math.min(last,first+Math.max(1,Math.floor(1048576/t.pieceLength))-1)];t.select(range[0],range[1],2);
  };
  advance();return {advance,release(){if(released)return;released=true;clear();}};
}

export const TEST_LIMIT=16*1024*1024;
export const testStopped=reason=>failure('TEST_INCONCLUSIVE',reason);

// The shared budget admits waiting first candidates before second candidates.
// Up to two alternatives may run together when capacity is available.
export async function compareSources({signal,primary,candidates,start,budget,now=Date.now,onView=()=>{},onResult=()=>{}}){
  const active=new Set();let original,adopted,testing=false,testDone=false,testTask=null,stop;
  const owned=new AbortController();const combined=AbortSignal.any([signal,owned.signal]);
  const own=(choice,probe)=>{const attempt=start(choice,probe,combined);active.add(attempt);attempt.promise.then(value=>{attempt.result={value};},error=>{attempt.result={error};});return attempt;};
  original=own(primary,false);adopted=original;
  let recoveryStart=null,recoveryVerified=0;
  const recovered=()=>recoveryStart!==null&&original.evidence.windows.filter(time=>time>=recoveryStart).length>=2&&(!primary.infoHash||original.evidence.verified>recoveryVerified);
  const test=async()=>{
    const session=new AbortController();const testSignal=AbortSignal.any([combined,session.signal]);
    const pool=new Set();let finished=0;
    const workers=candidates.slice(0,2).map(async(choice,index)=>{
      let release,candidate;
      try{
        // Allow other stalled episodes to enqueue their first test before a second.
        if(index)await new Promise(resolve=>setTimeout(resolve,100));
        if(testSignal.aborted)return;
        release=await budget.acquire(testSignal,index);
        if(testSignal.aborted||recovered())return;
        candidate=own(choice,true);pool.add(candidate);onView('testing',candidate);
        while(!testSignal.aborted&&adopted===original&&!recovered()){
          if(original.result&&!original.result.error)break;
          if(candidate.result){onResult(choice,{status:candidate.result.error?.code==='TEST_INCONCLUSIVE'?'inconclusive':'failed',bytes:candidate.evidence.bytes,code:candidate.result.error?.code||'TEST_INCONCLUSIVE'});break;}
          await new Promise(resolve=>setTimeout(resolve,100));
        }
      }catch(error){if(!testSignal.aborted)throw error;}
      finally{
        if(candidate&&candidate!==adopted){candidate.cancel();await candidate.promise.catch(()=>{});active.delete(candidate);}
        pool.delete(candidate);release?.();finished++;
      }
    });
    const all=Promise.allSettled(workers);
    try{
      while(!combined.aborted&&finished<workers.length&&!recovered()){
        if(original.result&&!original.result.error)break;
        const qualified=[...pool].filter(a=>a.evidence.qualifies(!!a.choice.infoHash)&&!a.result?.error);
        qualified.sort((a,b)=>(b.choice.res||0)-(a.choice.res||0)||b.evidence.score(now())-a.evidence.score(now()));
        const best=qualified[0];
        const preferredPending=best&&[...pool].some(a=>(a.choice.res||0)>(best.choice.res||0)&&!a.result&&!a.evidence.qualifies(!!a.choice.infoHash));
        if(best&&!preferredPending&&original.job.stage!=='Checking video and audio'&&original.job.stage!=='Verifying replacement'){
          onResult(best.choice,{status:'working',bytes:best.evidence.bytes,speed:best.evidence.score(now())});onView('switching',best);
          original.cancel();await original.promise.catch(()=>{});
          if(original.result&&!original.result.error)break;
          adopted=best;best.promote();break;
        }
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }finally{
      session.abort(testStopped('Comparison sampling finished'));
      const results=await all;
      const failed=results.find(r=>r.status==='rejected');if(failed&&!combined.aborted)throw failed.reason;
      testDone=true;
    }
  };

  try{
    while(true){
      signal.throwIfAborted();
      if(adopted!==original){onView('primary',adopted);if(adopted.result){if(adopted.result.error){onResult(adopted.choice,{status:['ENOSPC','VERIFY_UNAVAILABLE'].includes(adopted.result.error.code)?'inconclusive':'failed',code:adopted.result.error.code});throw Object.assign(adopted.result.error,{sourceChoice:adopted.choice});}return {file:adopted.result.value,attempt:adopted,switched:true};}await new Promise(resolve=>setTimeout(resolve,100));continue;}
      if(original.result&&!original.result.error)return {file:original.result.value,attempt:original,switched:false};
      if(original.result?.error&&!['NO_USEFUL_PIECES','HTTP_STALL'].includes(original.result.error.code))throw original.result.error;
      const idle=now()-(original.job.lastProgressAt??original.started);
      if(testing&&testDone&&recovered()){testing=false;testDone=false;testTask=null;recoveryStart=null;}
      if(!testing&&idle>=30000&&candidates.length){testing=true;recoveryStart=now();recoveryVerified=original.evidence.verified;testTask=test().catch(error=>{if(!combined.aborted)stop=error;testDone=true;});}
      if(stop)throw stop;
      if(original.result?.error&&(!testing||testDone||idle>=90000))throw original.result.error;
      onView(testing&&!testDone?'testing':'primary',adopted);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }finally{
    owned.abort(testStopped('Comparison ended'));
    for(const attempt of active)attempt.cancel();
    await Promise.allSettled([...active].map(attempt=>attempt.promise));
    if(testTask)await testTask;
  }
}
