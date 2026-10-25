import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {ExtraBudget,ConnectivityEvidence,compareSources,verifiedFileBytes,TEST_LIMIT,testStopped,MAX_SOURCE_TURN_SOURCES,SOURCE_TURN_LIMIT_MS} from '../src/source-testing.js';
import {Downloader} from '../src/downloader.js';
import {failure} from '../src/transfer-state.js';
import {cfg} from '../src/config.js';
import {parseStream} from '../src/resolver.js';
import WebTorrent from 'webtorrent';

const worker=()=>{const d=Object.create(Downloader.prototype);d.controllers=new Map();d.contexts=new Map();d.torrents=new Map();d.seasonHashes=new Map();d.extraBudget=new ExtraBudget(2);d.cooldowns={};d.save=()=>{};return d;};
const fixture=fs.readFileSync('test/fixture.mkv');

test('global extra budget is FIFO, bounded, shared with episode work, and cancellable',async()=>{
 const b=new ExtraBudget(2),a=b.tryAcquire(),c=b.tryAcquire();assert.equal(b.used,2);assert.equal(b.tryAcquire(),null);
 const one=new AbortController(),two=new AbortController();let admitted=[];
 const first=b.acquire(one.signal).then(release=>{admitted.push(1);return release;});
 const second=b.acquire(two.signal).then(release=>{admitted.push(2);return release;});
 assert.equal(b.tryAcquire(),null);a();const release1=await first;assert.deepEqual(admitted,[1]);release1();const release2=await second;assert.deepEqual(admitted,[1,2]);
 const abort=new AbortController();const waiting=b.acquire(abort.signal);abort.abort();await assert.rejects(waiting,{name:'AbortError'});release2();c();c();assert.equal(b.used,0);assert.equal(b.waiters.length,0);
});

test('cached bytes, peer counts, and unverified payload cannot win a torrent test',()=>{
 const e=new ConnectivityEvidence(0);assert.equal(e.qualifies(true),false);
 e.update(1000,0,1000);e.update(2000,0,4000);assert.equal(e.qualifies(true),false);
 e.update(3000,1000,5000);assert.equal(e.qualifies(true),true);
 const short=new ConnectivityEvidence(0);short.update(15,15,10,{complete:true});assert.equal(short.qualifies(true),true);
 const web=new ConnectivityEvidence(0);web.update(100,0,1000);web.update(200,0,4000);assert.equal(web.qualifies(false),false);web.update(300,0,5000,{video:true});assert.equal(web.qualifies(false),true);
 const torrent={pieceLength:10,bitfield:{get:i=>i===0||i===2}};assert.equal(verifiedFileBytes(torrent,{offset:5,length:20}),10);
});

function fakeAttempt(choice,probe,signal,now){
 let resolve,reject;const attempt={choice,probe,started:0,job:{lastProgressAt:null,rollingSpeed:0,stage:'Downloading video'},evidence:new ConnectivityEvidence(0)};
 attempt.promise=new Promise((a,b)=>{resolve=a;reject=b;});attempt.resolve=resolve;attempt.reject=reject;attempt.cancel=()=>reject(testStopped('Stopped'));attempt.promote=()=>resolve('winner');
 signal.addEventListener('abort',attempt.cancel,{once:true});return attempt;
}

test('a productive candidate wins without relying on seed counts, then all leases are released',async()=>{
 const signal=new AbortController(),budget=new ExtraBudget(2);const attempts=[];
 const result=await compareSources({signal:signal.signal,primary:{infoHash:'dead',seeders:9999},candidates:[{infoHash:'live',seeders:0}],budget,now:()=>31000,
 start:(c,p,s)=>{const a=fakeAttempt(c,p,s);attempts.push(a);if(p){a.evidence.update(1024*1024,1024*1024,31000,{complete:true});}return a;}});
 assert.equal(result.switched,true);assert.equal(result.file,'winner');assert.equal(result.attempt.choice.infoHash,'live');assert.equal(budget.used,0);
});

test('comparison consumes provider candidates before the full lookup completes',async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2),candidates=[];let lookupDone=false,candidateStarted=false;
 setTimeout(()=>candidates.push({infoHash:'new'}),20);
 const finishLookup=setTimeout(()=>{lookupDone=true;},1000);
 try{
  const result=await compareSources({signal:owner.signal,primary:{infoHash:'old'},candidates:[],getCandidates:()=>candidates,discoveryDone:()=>lookupDone,budget,noDataAfterMs:0,sourceTurnDeadline:Date.now()+2000,
   start:(choice,probe,signal)=>{const attempt=fakeAttempt(choice,probe,signal);if(probe){candidateStarted=true;attempt.evidence.update(1024*1024,1024*1024,Date.now(),{complete:true});}else setTimeout(()=>attempt.reject(failure('NO_USEFUL_PIECES','stalled')),500);return attempt;}});
  assert.equal(result.attempt.choice.infoHash,'new');assert.equal(candidateStarted,true);assert.equal(lookupDone,false);assert.equal(budget.used,0);
 }finally{clearTimeout(finishLookup);}
});

test('slow 0.15 MiB/s source switches to a verified 1.8 MiB/s source',async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2);let primary;
 const result=await compareSources({signal:owner.signal,primary:{infoHash:'old'},candidates:[{infoHash:'fast'}],budget,now:()=>31000,
 start:(choice,probe,signal)=>{const a=fakeAttempt(choice,probe,signal);if(!probe){primary=a;a.job.rollingSpeed=157286;}else{a.evidence.update(1.8*1024*1024,1024*1024,31000,{complete:true});}return a;}});
 assert.equal(result.switched,true);assert.equal(result.attempt.choice.infoHash,'fast');assert.equal(budget.used,0);
});

test('a faster candidate below the 2x plus 0.25 MiB/s win margin keeps the original',async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2);let primary;
 const result=await compareSources({signal:owner.signal,primary:{infoHash:'old'},candidates:[{infoHash:'marginal'}],budget,now:()=>31000,
 start:(choice,probe,signal)=>{const a=fakeAttempt(choice,probe,signal);if(!probe){primary=a;a.job.rollingSpeed=180000;setTimeout(()=>a.resolve('original-file'),60);}else{a.evidence.update(400000,1,31000,{complete:true});a.resolve('candidate-file');}return a;}});
 assert.equal(result.switched,false);assert.equal(result.file,'original-file');assert.equal(budget.used,0);
});

test('slow comparison yields only when no source wins and other work is ready',async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2);
 const result=await compareSources({signal:owner.signal,primary:{infoHash:'slow'},candidates:[],budget,now:()=>31000,shouldCompare:()=>true,shouldYield:()=>true,start:(c,p,s)=>fakeAttempt(c,p,s)});
 assert.equal(result.yielded,true);assert.equal(result.switched,false);assert.equal(budget.used,0);
});

test('when two candidates qualify together, measured useful throughput selects the winner',async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2);
 const result=await compareSources({signal:owner.signal,primary:{infoHash:'old'},candidates:[{infoHash:'slow',res:1080},{infoHash:'fast',res:1080}],budget,now:()=>31000,
 start:(c,p,s)=>{const a=fakeAttempt(c,p,s);if(p)a.evidence.update(c.infoHash==='fast'?2*1024*1024:1024*1024,1,31000,{complete:true});return a;}});
 assert.equal(result.attempt.choice.infoHash,'fast');assert.equal(budget.used,0);
});

test('a qualifying lower-quality fallback waits for the requested-quality test to finish',async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2);let higherFinished=false;
 const result=await compareSources({signal:owner.signal,primary:{infoHash:'old'},candidates:[{infoHash:'higher',res:1080},{infoHash:'fallback',res:720}],budget,now:()=>31000,
 start:(c,p,s)=>{const a=fakeAttempt(c,p,s);if(c.infoHash==='higher')setTimeout(()=>{higherFinished=true;a.reject(testStopped('deadline'));},250);if(c.infoHash==='fallback'){a.evidence.update(1024*1024,1,31000,{complete:true});a.promote=()=>{assert.equal(higherFinished,true);a.resolve('fallback');};}return a;}});
 assert.equal(result.attempt.choice.infoHash,'fallback');assert.equal(budget.used,0);
});

test('recovering original retains ownership; a candidate never finalizes',async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2);let primary,alternative,promoted=false;
 const result=await compareSources({signal:owner.signal,primary:{infoHash:'original'},candidates:[{infoHash:'alternative'}],budget,now:()=>31000,
 start:(c,p,s)=>{const a=fakeAttempt(c,p,s);if(!p)primary=a;else{alternative=a;a.promote=()=>{promoted=true;};primary.evidence.update(20,20,31000);primary.evidence.update(40,40,33000);primary.resolve('original-file');}return a;}});
 assert.equal(result.file,'original-file');assert.equal(result.switched,false);assert.equal(promoted,false);assert.ok(alternative);assert.equal(budget.used,0);
});

test('all tests failing preserve the original stall failure and classify limits as inconclusive',async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2),outcomes=[];let original;
 await assert.rejects(compareSources({signal:owner.signal,primary:{infoHash:'original'},candidates:[{infoHash:'one'},{infoHash:'two'}],budget,now:()=>31000,
 start:(c,p,s)=>{const a=fakeAttempt(c,p,s);if(!p)original=a;else{a.reject(testStopped('time limit'));if(c.infoHash==='two')original.reject(failure('NO_USEFUL_PIECES','stalled'));}return a;},onResult:(c,r)=>outcomes.push(r.status)}),{code:'NO_USEFUL_PIECES'});
 assert.deepEqual(outcomes,['inconclusive','inconclusive']);assert.equal(budget.used,0);
});

test('candidate diagnostics distinguish a connected torrent with no peers from a generic test timeout',async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2),outcomes=[];
 await assert.rejects(compareSources({signal:owner.signal,primary:{infoHash:'primary'},candidates:[{infoHash:'alternative'}],budget,now:()=>31000,noDataAfterMs:0,noDataLimitMs:0,
  start:(choice,probe,signal)=>{const attempt=fakeAttempt(choice,probe,signal);if(probe){attempt.job.peers=0;attempt.evidence.ready=true;attempt.reject(testStopped('candidate limit reached','time_cap'));}return attempt;},
  onResult:(choice,outcome)=>outcomes.push(outcome.reasonCode)
 }),{code:'NO_USEFUL_PIECES'});
 assert.deepEqual(outcomes,['no_peers']);assert.equal(budget.used,0);
});

test('no-data source turns test four alternatives in fair waves of at most two', {timeout:5000},async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2),started=[];let active=0,maxActive=0;
 const start=(choice,probe,signal)=>{
  let reject;const attempt={choice,probe,started:Date.now(),job:{lastProgressAt:null,dataStartedAt:Date.now(),rollingSpeed:0,stage:'Downloading video'},evidence:new ConnectivityEvidence(Date.now()),promise:new Promise((_,fail)=>reject=fail),cancel:()=>reject(testStopped('cancelled')),promote(){}};
  signal.addEventListener('abort',attempt.cancel,{once:true});
  if(probe){started.push(choice.infoHash);maxActive=Math.max(maxActive,++active);attempt.promise.then(()=>active--,()=>active--);setTimeout(()=>reject(failure('SOURCE_FILE','unusable source')),5);}
  else setTimeout(()=>reject(failure('NO_USEFUL_PIECES','stalled')),250);
  return attempt;
 };
 await assert.rejects(compareSources({signal:owner.signal,primary:{infoHash:'primary'},candidates:[1,2,3,4].map(n=>({infoHash:String(n)})),start,budget,noDataAfterMs:0,noDataLimitMs:1000,sourceTurnDeadline:Date.now()+3000}),{code:'NO_USEFUL_PIECES'});
 assert.deepEqual(started,['1','2','3','4']);assert.equal(maxActive,2);assert.equal(budget.used,0);assert.equal(MAX_SOURCE_TURN_SOURCES,5);assert.equal(SOURCE_TURN_LIMIT_MS,60000);
});

test('the no-data turn deadline stops remaining tests and releases every lease', {timeout:5000},async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2),started=[];
 const start=(choice,probe,signal)=>{
  let reject;const attempt={choice,probe,started:Date.now(),job:{lastProgressAt:null,dataStartedAt:Date.now(),rollingSpeed:0,stage:'Downloading video'},evidence:new ConnectivityEvidence(Date.now()),promise:new Promise((_,fail)=>reject=fail),cancel:()=>reject(testStopped('cancelled')),promote(){}};
  signal.addEventListener('abort',attempt.cancel,{once:true});if(probe)started.push(choice.infoHash);return attempt;
 };
 await assert.rejects(compareSources({signal:owner.signal,primary:{infoHash:'primary'},candidates:[1,2,3,4].map(n=>({infoHash:String(n)})),start,budget,noDataAfterMs:0,noDataLimitMs:5000,sourceTurnDeadline:Date.now()+80}),{code:'NO_USEFUL_PIECES'});
 assert.deepEqual(started,['1','2']);assert.equal(budget.used,0);assert.equal(budget.waiters.length,0);
});

test('one source turn tests no more than four alternatives and exhausts requested quality first',async()=>{
 const d=worker();d.now=()=>31000;const owner=new AbortController(),primary={name:'1080p',infoHash:'a'.repeat(40),fileIdx:0};d.controllers.set('job',owner);
 const sources=[primary,...['b','c','d'].map(hash=>({name:'1080p',infoHash:hash.repeat(40),fileIdx:0})),...['e','f'].map(hash=>({name:'720p',infoHash:hash.repeat(40),fileIdx:0})),{name:'480p',infoHash:'g'.repeat(40),fileIdx:0}];
 const started=[];let active=0,maxActive=0;
 d.startAttempt=(job,choice,probe,signal)=>{
  const attempt=fakeAttempt(choice,probe,signal);attempt.started=d.now();attempt.job.lastProgressAt=d.now()-16000;
  if(probe){started.push(choice.infoHash[0]);maxActive=Math.max(maxActive,++active);attempt.promise.then(()=>active--,()=>active--);setTimeout(()=>attempt.reject(failure('SOURCE_FILE','unusable episode file')),5);}
  else setTimeout(()=>attempt.reject(failure('NO_USEFUL_PIECES','stalled')),200);
  return attempt;
 };
 const attempted=new Set([d.turnIdentity(parseStream(primary))]);
 await assert.rejects(d.downloadWithComparison({id:'job',series:'show',profile:{resolution:1080,allowedResolutions:[720,1080]}},parseStream(primary),sources,{allowedResolutions:[720,1080],maxResolution:1080},'unused','',attempted),{code:'NO_USEFUL_PIECES'});
 assert.deepEqual(started,['b','c','d','e']);assert.equal(maxActive,2);assert.equal(attempted.size,5);assert.equal(d.extraBudget.used,0);
});

test('no-data comparison begins 15 seconds after a valid source response and resolves by 45 seconds',async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2),attempts=[];let clock=1000;
 const start=(choice,probe,signal)=>{
  let reject;const attempt={choice,probe,started:clock,job:{lastProgressAt:null,dataStartedAt:clock,rollingSpeed:0,stage:'Downloading video'},evidence:new ConnectivityEvidence(clock),promise:new Promise((_,fail)=>reject=fail),cancel:()=>reject(testStopped('cancelled')),promote(){}};
  signal.addEventListener('abort',attempt.cancel,{once:true});attempts.push(attempt);return attempt;
 };
 await assert.rejects(compareSources({signal:owner.signal,primary:{infoHash:'empty'},candidates:[{infoHash:'alternate'}],budget,now:()=>clock,noDataAfterMs:15,noDataLimitMs:45,comparisonLimitMs:5000,onView:()=>{clock+=10;},start}),{code:'NO_USEFUL_PIECES'});
 assert.equal(attempts.length,2);assert.equal(attempts[0].choice.infoHash,'empty');assert.equal(attempts[1].choice.infoHash,'alternate');assert.equal(budget.used,0);
});

test('a candidate failing after adoption reports the winning source identity',async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2),candidate={infoHash:'winner'},outcomes=[];
 await assert.rejects(compareSources({signal:owner.signal,primary:{infoHash:'old'},candidates:[candidate],budget,now:()=>31000,
 start:(c,p,s)=>{const a=fakeAttempt(c,p,s);if(p){a.evidence.update(1024*1024,1,31000,{complete:true});a.promote=()=>a.reject(failure('SOURCE_MEDIA','wrong quality'));}return a;},onResult:(c,r)=>{if(c===candidate)outcomes.push(r.status);}}),e=>e.code==='SOURCE_MEDIA'&&e.sourceChoice===candidate);
 assert.deepEqual(outcomes,['working','failed']);assert.equal(budget.used,0);
});

test('owner cancellation aborts source tests and releases pending or active budget leases',async()=>{
 const owner=new AbortController(),budget=new ExtraBudget(2);let tests=0;
 const pending=compareSources({signal:owner.signal,primary:{infoHash:'old'},candidates:[{infoHash:'new'}],budget,now:()=>31000,
 start:(c,p,s)=>{const a=fakeAttempt(c,p,s);if(p){tests++;queueMicrotask(()=>owner.abort());}return a;}});
 await assert.rejects(pending,{name:'AbortError'});assert.equal(tests,1);assert.equal(budget.used,0);assert.equal(budget.waiters.length,0);
});

test('candidate traffic limit is inconclusive and cannot mark a job complete',async()=>{
 const d=worker();d.downloadTorrent=async j=>{const context=d.contexts.get(j.id);context.observe(TEST_LIMIT+1,0);context.signal.throwIfAborted();throw new Error('traffic limit missing');};
 const attempt=d.startAttempt({id:'episode'},{infoHash:'a'.repeat(40)},true,new AbortController().signal,'unused','');
 await assert.rejects(attempt.promise,{code:'TEST_INCONCLUSIVE'});assert.equal(d.contexts.size,0);assert.equal(d.controllers.size,0);
});

test('HTTP comparison candidates have no artificial 1 MiB/s throttle', {timeout:8000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'http-probe-rate-'));const payload=Buffer.alloc(4*1024*1024,0x42);
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'video/x-matroska','Content-Length':payload.length,'Connection':'close'});res.end(payload);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const d=worker(),owner=new AbortController(),url=`http://127.0.0.1:${server.address().port}/probe.mkv`;d.checkMedia=async()=>({verified:true});d.finishFile=async()=>{};
 let completed=false;
 try{
  const started=Date.now(),attempt=d.startAttempt({id:'rate-episode',seriesName:'Rate Show',season:1,episode:1,title:'Episode',profile:{downloadDir:root}}, {url,raw:{}},true,owner.signal,root,'S01E01 - ');
  for(let i=0;i<100&&attempt.evidence.bytes<payload.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  const elapsed=Date.now()-started;assert.equal(attempt.evidence.bytes,payload.length);assert.ok(elapsed<2000,`probe took ${elapsed}ms`);
  attempt.promote();assert.equal(await attempt.promise,path.join(root,'Rate Show - S01E01 - Episode.mkv'));completed=true;
 }finally{if(!completed)server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});

test('candidate metadata connection deadline is 15 seconds and cleans up the torrent',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const root=fs.mkdtempSync(path.join(os.tmpdir(),'metadata-test-'));const previous=cfg.downloadDir;cfg.downloadDir=root;
 const d=worker();const torrent=Object.assign(new EventEmitter(),{destroy(){this.destroyed=true;}});d.getClient=async()=>({add:()=>torrent});
 try{const a=d.startAttempt({id:'episode'},{infoHash:'b'.repeat(40)},true,new AbortController().signal,root,'');await new Promise(setImmediate);t.mock.timers.tick(15000);await assert.rejects(a.promise,{code:'TEST_INCONCLUSIVE'});assert.equal(d.torrents.size,0);assert.equal(torrent.destroyed,true);}
 finally{cfg.downloadDir=previous;fs.rmSync(root,{recursive:true,force:true});}
});

test('candidate total deadline is 30 seconds even after metadata becomes ready',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});const root=fs.mkdtempSync(path.join(os.tmpdir(),'deadline-test-'));const d=worker();
 const file={path:'Show.S01E01.mkv',offset:0,length:2048,downloaded:0,progress:0};const torrent=Object.assign(new EventEmitter(),{files:[file],pieces:[{},{}],pieceLength:1024,bitfield:{get:()=>false},select(){},deselect(){}});
 d.acquire=async()=>({torrent});d.release=()=>{};
 try{const a=d.startAttempt({id:'episode',season:1,episode:1},{infoHash:'a',fileIdx:0},true,new AbortController().signal,root,'');await new Promise(setImmediate);t.mock.timers.tick(30000);await assert.rejects(a.promise,{code:'TEST_INCONCLUSIVE'});assert.equal(a.evidence.ready,true);}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('100 percent received torrent blocks cannot finalize until every episode piece is hash-verified',async t=>{
 t.mock.timers.enable({apis:['setInterval']});const root=fs.mkdtempSync(path.join(os.tmpdir(),'verified-completion-'));const d=worker();let verified=false,finalized=false;
 const file={path:'Show.S01E01.mkv',offset:0,length:2048,downloaded:2048,progress:1};
 const torrent=Object.assign(new EventEmitter(),{path:root,files:[file],pieces:[{},{}],pieceLength:1024,bitfield:{get:()=>verified},select(){},deselect(){}});
 d.acquire=async()=>({torrent,tmp:root});d.release=()=>{};d.checkMedia=async()=>({resolution:480});d.finishFile=async()=>{finalized=true;};d.stageVerifiedCleanup=async()=>{};
 try{const a=d.startAttempt({id:'a',seriesName:'Show',season:1,episode:1},{infoHash:'a',fileIdx:0},false,new AbortController().signal,root,'S01E01 - ');await new Promise(setImmediate);t.mock.timers.tick(1000);assert.equal(finalized,false);assert.equal(a.evidence.complete,false);verified=true;t.mock.timers.tick(1000);await a.promise;assert.equal(finalized,true);assert.equal(a.evidence.complete,true);}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('real HTTP comparison replaces a stalled near-complete release while preserving its partial', {timeout:10000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'http-comparison-'));let stalledClosed=false,liveRequests=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/old.mkv'){assert.ok(req.headers.range);res.writeHead(206,{'Content-Type':'video/x-matroska','Content-Length':fixture.length-15000,'Content-Range':`bytes 15000-${fixture.length-1}/${fixture.length}`,ETag:'"old"'});res.flushHeaders();res.on('close',()=>stalledClosed=true);}
  else{liveRequests++;res.writeHead(200,{'Content-Type':'video/x-matroska','Content-Length':fixture.length,ETag:'"new"'});res.end(fixture);}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;const old=base+'/old.mkv',live=base+'/new.mkv';const d=worker();
 const startAttempt=d.startAttempt.bind(d);d.startAttempt=(...args)=>{const attempt=startAttempt(...args);if(!args[2])attempt.job.lastProgressAt=attempt.started-31000;return attempt;};
 const dir=path.join(root,'Show','Season 01');fs.mkdirSync(dir,{recursive:true});
 const part=path.join(dir,'Show - S01E01 - Episode.mkv.'+createHash('sha256').update(old).digest('hex').slice(0,16)+'.part');
 fs.writeFileSync(part,fixture.subarray(0,15000));fs.writeFileSync(part+'.json',JSON.stringify({validator:'"old"'}));
 d.streamsFor=async()=>[{name:'480p',title:'Old',url:old},{name:'480p',title:'Working',url:live},{name:'1080p',title:'Wrong quality',url:base+'/wrong.mkv'}];
 const j={id:'show:1:1',series:'show',seriesName:'Show',season:1,episode:1,title:'Episode',profile:{downloadDir:root,resolution:480,allowedResolutions:[480]}};
 try{await d.run(j);assert.equal(j.status,'done',j.error);assert.equal(j.release,'Working');assert.equal(liveRequests,1);assert.equal(stalledClosed,true);assert.deepEqual(fs.readFileSync(j.file),fixture);assert.equal(fs.statSync(part).size,15000);assert.ok(j.switchNote.includes('Previous partial'));assert.equal(d.extraBudget.used,0);assert.equal(d.contexts.size,0);assert.equal(d.controllers.size,0);assert.equal(Object.values(d.sourceResults)[0].status,'working');}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});

test('comparison excludes duplicate swarms, unknown quality, and disallowed resolutions',async()=>{
 const d=worker();d.now=()=>31000;const owner=new AbortController();d.controllers.set('a',owner);
 const original={name:'480p',title:'Original',infoHash:'a'.repeat(40),fileIdx:0};
 const sources=[original,{...original,fileIdx:3},{name:'1080p',title:'Disallowed',infoHash:'b'.repeat(40),fileIdx:0},{name:'Unlabelled',title:'Unknown',infoHash:'c'.repeat(40),fileIdx:0},{name:'480p',title:'Eligible',infoHash:'d'.repeat(40),fileIdx:0}];
 const tested=[];
 d.startAttempt=(job,choice,probe,signal)=>{const a=fakeAttempt(choice,probe,signal);if(probe){tested.push(choice);a.evidence.update(1024*1024,1024*1024,1,{complete:true});}return a;};
 const job={id:'a',series:'show',profile:{resolution:480}};
 const file=await d.downloadWithComparison(job,parseStream(original),sources,{mode:'off',allowedResolutions:[480],maxResolution:480},'unused','');
 assert.equal(file,'winner');assert.deepEqual(tested.map(c=>c.infoHash),['d'.repeat(40)]);assert.equal(job.quality,'480p');
 assert.ok(!JSON.stringify(d.sourceResults).includes('http'));
});

test('season connectivity history guides ordering but inconclusive results do not ban sources',()=>{
 const d=worker();d.now=()=>1000;const job={id:'a',series:'show'},source={infoHash:'a',fileIdx:0};
 const seriesKey=createHash('sha256').update('show').digest('hex');
 d.sourceResults={[d.historyKey(source)]:{status:'working',speed:1234,expires:2000,seriesKey,swarmKey:d.historyKey(source)}};
 assert.equal(d.connectivityScore(job,source),1234);assert.equal(d.available(job,source),true);
 d.sourceResults={[d.historyKey(source)]:{status:'inconclusive',speed:0,expires:2000,seriesKey,swarmKey:d.historyKey(source)}};assert.equal(d.connectivityScore(job,source),0);assert.equal(d.available(job,source),true);
});

test('HTTP source history uses only a short-lived hostname hash and expires',()=>{
 const d=worker();d.sourceResults={};let now=100;d.now=()=>now;
 const first={url:'https://user:secret@cdn.example.test/video-a?token=secret'},second={url:'https://cdn.example.test/video-b?key=private'};
 assert.equal(d.historyKey(first),d.historyKey(second));
 d.sourceResults[d.historyKey(first)]={status:'working',speed:400000,expires:200};
 assert.equal(d.sourceResult(second).speed,400000);assert.ok(!JSON.stringify(d.sourceResults).includes('secret'));assert.ok(!JSON.stringify(d.sourceResults).includes('private'));
 now=201;assert.equal(d.sourceResult(second),null);
});

test('torrent source history is keyed by swarm even when the listing also includes a URL',()=>{
 const d=worker(),swarm='b'.repeat(40),first={infoHash:swarm,url:'https://addon.example.test/stream?token=private',fileIdx:1},second={infoHash:swarm,url:'https://other-addon.example.test/stream',fileIdx:3};
 assert.equal(d.historyKey(first),d.historyKey(second));assert.ok(!d.historyKey(first).includes('private'));
});

test('healthy transfers do not launch comparison traffic',async()=>{
 const d=worker();d.controllers.set('a',new AbortController());const started=[];
 d.startAttempt=(job,choice,probe,signal)=>{started.push(probe);const a=fakeAttempt(choice,probe,signal);a.started=Date.now();a.resolve('healthy-file');return a;};
 const raw={name:'480p',infoHash:'a'.repeat(40)},alternative={name:'480p',infoHash:'b'.repeat(40)};
 assert.equal(await d.downloadWithComparison({id:'a',profile:{resolution:480}},parseStream(raw),[raw,alternative],{allowedResolutions:[480]},'unused',''),'healthy-file');assert.deepEqual(started,[false]);assert.equal(d.extraBudget.used,0);
});

test('local disk failures after a switch pause the job and do not label the source unusable',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-disk-'));const partial=path.join(root,'old.part');fs.writeFileSync(partial,'retained');const d=worker();d.now=()=>31000;
 const raw={name:'480p',infoHash:'a'.repeat(40)},alternative={name:'480p',infoHash:'b'.repeat(40)};d.streamsFor=async()=>[raw,alternative];
 d.startAttempt=(job,choice,probe,signal)=>{const a=fakeAttempt(choice,probe,signal);if(probe){a.evidence.update(1024*1024,1,1,{complete:true});a.promote=()=>a.reject(failure('ENOSPC','Disk full'));}return a;};
 const j={id:'a',series:'show',seriesName:'Show',season:1,episode:1,profile:{downloadDir:root,resolution:480,allowedResolutions:[480]}};
 try{await d.run(j);assert.equal(j.status,'paused');assert.equal(j.failureCode,'ENOSPC');assert.equal(fs.readFileSync(partial,'utf8'),'retained');assert.ok(Object.values(d.sourceResults).some(r=>r.status==='inconclusive'));assert.equal(d.extraBudget.used,0);}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('restart discards persisted comparison ownership while keeping manual pauses',()=>{
 const d=worker();d.pump=()=>{};d.store={read:key=>key==='jobs'?[{id:'a',status:'downloading',comparison:{status:'testing'},isProbe:true},{id:'b',status:'paused',comparison:{status:'testing'}}]:{}};
 d.load();assert.equal(d.jobs[0].status,'queued');assert.equal(d.jobs[0].comparison,null);assert.equal(d.jobs[0].isProbe,false);assert.equal(d.jobs[1].status,'paused');assert.equal(d.jobs[1].comparison,null);
});

test('source tests and extra episodes cannot exceed the shared two-slot allowance',async()=>{
 const d=worker();d.jobs=[{id:'a',status:'downloading',runStartedAt:0},{id:'b',status:'downloading',runStartedAt:0},{id:'c',status:'downloading',runStartedAt:0},{id:'d',status:'downloading',runStartedAt:0},{id:'extra',status:'queued'}];d.active=4;d.running=new Set();d.now=()=>31000;for(const id of ['a','b','c','d'])d.controllers.set(id,new AbortController());
 let finish;d.run=j=>{j.status='downloading';d.controllers.set(j.id,new AbortController());return new Promise(resolve=>finish=()=>{d.controllers.delete(j.id);resolve();});};
 const sourceLease=d.extraBudget.tryAcquire();
 try{d.pump();assert.equal(d.active,5);assert.equal(d.extraBudget.used,2);assert.equal(d.extraBudget.tryAcquire(),null);d.pump();assert.equal(d.active,5);}
 finally{d.stopping=true;clearTimeout(d.retryTimer);finish();await Promise.all([...d.running]);sourceLease();assert.equal(d.extraBudget.used,0);}
});

test('real torrent candidate transfers verified episode pieces and is promoted without reconnecting', {timeout:15000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'torrent-comparison-'));const previous=cfg.downloadDir;cfg.downloadDir=root;
 const seed=new WebTorrent({dht:false,tracker:false,lsd:false}),receiver=new WebTorrent({dht:false,tracker:false,lsd:false});const d=worker();d.getClient=async()=>receiver;d.now=()=>Date.now()*10;
 const originalDir=path.join(root,'old'),liveDir=path.join(root,'live');fs.mkdirSync(originalDir);fs.mkdirSync(liveDir);
 fs.writeFileSync(path.join(originalDir,'Show.S01E01.mkv'),Buffer.concat([fixture,Buffer.from('old')]));fs.writeFileSync(path.join(liveDir,'Show.S01E01.mkv'),fixture);
 try{
  const seedFile=file=>new Promise(resolve=>seed.seed(file,{announce:[]},resolve));
  const old=await seedFile(path.join(originalDir,'Show.S01E01.mkv')),live=await seedFile(path.join(liveDir,'Show.S01E01.mkv'));
  fs.mkdirSync(path.join(root,'.tmp'));for(const t of [old,live])fs.writeFileSync(path.join(root,'.tmp',t.infoHash+'.torrent'),t.torrentFile);
  const acquire=d.acquire.bind(d);const acquired=[];d.acquire=async(c,signal)=>{acquired.push(c.infoHash);const entry=await acquire(c,signal);if(c.infoHash===live.infoHash)entry.torrent.addPeer('127.0.0.1:'+seed.torrentPort);return entry;};
  d.streamsFor=async()=>[{name:'480p',title:'Old',infoHash:old.infoHash,fileIdx:0},{name:'480p',title:'Live',infoHash:live.infoHash,fileIdx:0}];
  const j={id:'show:1:1',series:'show',seriesName:'Show',season:1,episode:1,title:'Episode',profile:{downloadDir:root,resolution:480,allowedResolutions:[480]}};
  await d.run(j);assert.equal(j.status,'done',j.error);assert.equal(j.release,'Live');assert.deepEqual(fs.readFileSync(j.file),fixture);assert.deepEqual(acquired,[old.infoHash,live.infoHash]);
  assert.equal(d.extraBudget.used,0);assert.equal(d.torrents.size,0);assert.equal(d.contexts.size,0);assert.ok(Object.values(d.sourceResults).some(r=>r.status==='working'&&r.bytes>0));
 }finally{await Promise.all([new Promise(r=>seed.destroy(r)),new Promise(r=>receiver.destroy(r))]);cfg.downloadDir=previous;fs.rmSync(root,{recursive:true,force:true});}
});
