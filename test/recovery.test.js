import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Downloader} from '../src/downloader.js';
import {failure,FileProgress,selectFile,RETRY_DELAYS,DEFERRED_RETRY_DELAYS,SOURCE_FAILURES} from '../src/transfer-state.js';
import {ExtraBudget} from '../src/source-testing.js';
import {cfg} from '../src/config.js';

function worker(){
 const d=Object.create(Downloader.prototype);d.jobs=[];d.controllers=new Map();d.running=new Set();d.active=0;d.seasonHashes=new Map();d.cooldowns={};d.save=()=>{};d.saveNow=()=>{};
 return d;
}
const source=n=>({name:'720p',title:'Source '+n,infoHash:String(n).repeat(40),fileIdx:0});
const job=(root,n)=>({id:'show:1:'+n,series:'show',seriesName:'Show',season:1,episode:n,status:'queued',profile:{downloadDir:root,resolution:720,allowedResolutions:[720]}});

test('two exhausted jobs release both slots and later healthy episodes proceed',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-'));const d=worker();let calls={};
 d.jobs=[1,2,3,4].map(n=>job(root,n));d.streamsFor=async()=>[1,2,3,4].map(source);
 d.downloadTorrent=async(j)=>{const id=j.id.split('#')[0];calls[id]=(calls[id]||0)+1;if(j.episode<=2)throw failure('TORRENT_FAILURE','failed');return 'healthy';};
 try{d.pump();for(let i=0;i<100&&d.jobs.some(j=>['queued','downloading','resolving'].includes(j.status));i++)await new Promise(resolve=>setTimeout(resolve,20));
 assert.deepEqual(d.jobs.map(j=>j.status),['retry_wait','retry_wait','done','done']);
 assert.equal(calls['show:1:1'],4);assert.equal(calls['show:1:2'],4);assert.equal(d.active,0);
 }finally{d.stopping=true;clearTimeout(d.retryTimer);fs.rmSync(root,{recursive:true,force:true});}
});

test('source failures move from the 5/15/60-minute cycle to repeating deferred retries',()=>{
 let now=100;const d=worker();d.now=()=>now;const j={id:'a'};
 for(let round=0;round<3;round++){d.defer(j,failure('NO_USEFUL_PIECES','stalled'));assert.equal(j.nextRetryAt,now+RETRY_DELAYS[round]);assert.equal(j.retryRound,round+1);now=j.nextRetryAt;}
 d.defer(j,failure('NO_USEFUL_PIECES','stalled'));assert.equal(j.status,'deferred');assert.equal(j.nextRetryAt,now+DEFERRED_RETRY_DELAYS[0]);assert.equal(j.deferredRetryRound,1);
 now=j.nextRetryAt;d.defer(j,failure('METADATA_TIMEOUT','timeout'));assert.equal(j.nextRetryAt,now+DEFERRED_RETRY_DELAYS[1]);
 now=j.nextRetryAt;d.defer(j,failure('NO_SOURCES','none'));assert.equal(j.nextRetryAt,now+DEFERRED_RETRY_DELAYS[2]);
 now=j.nextRetryAt;d.defer(j,failure('NO_USEFUL_PIECES','stalled'));assert.equal(j.nextRetryAt,now+DEFERRED_RETRY_DELAYS[2]);
 const queued={id:'b',status:'retry_wait',nextRetryAt:now+1000,retryRound:1};
 const sourceAttention={id:'attention',status:'needs_attention',failureCode:'NO_USEFUL_PIECES',retryRound:3};
 const localAttention={id:'local',status:'needs_attention',failureCode:'ENOSPC'};
 const paused={id:'paused',status:'paused',failureCode:'NO_USEFUL_PIECES'};
 const interrupted={id:'interrupted',status:'resolving',backgroundRetryActive:true,deferredRetryRound:2,failureCode:'NO_USEFUL_PIECES'};
 d.store={read:key=>key==='jobs'?[queued,sourceAttention,localAttention,paused,interrupted]:{'torrent:abc':now+500}};d.pump=()=>{};d.save=()=>{};d.load();
 assert.equal(d.jobs[0].nextRetryAt,now+1000);assert.equal(d.jobs[1].status,'deferred');assert.equal(d.jobs[1].nextRetryAt,now+DEFERRED_RETRY_DELAYS[0]);assert.equal(d.jobs[2].status,'needs_attention');assert.equal(d.jobs[3].status,'paused');assert.equal(d.jobs[4].status,'deferred');assert.equal(d.jobs[4].nextRetryAt,now);assert.equal(d.jobs[4].deferredRetryRound,2);assert.equal(d.cooldowns['torrent:abc'],now+500);
 d.jobs=[j];d.control('a','retry');assert.equal(j.status,'queued');assert.equal(j.retryRound,0);
});

test('normal scheduler admits four transfers and leaves extra network activities to the shared budget',async()=>{
 const previous=cfg.concurrency;cfg.concurrency=4;const d=worker();d.jobs=Array.from({length:7},(_,i)=>({id:'normal-'+i,status:'queued'}));d.extraBudget=new ExtraBudget(2);const started=[],finish=[];
 d.run=j=>{j.status='downloading';started.push(j.id);return new Promise(resolve=>finish.push(()=>{j.status='done';resolve();}));};
 try{d.pump();assert.equal(d.active,4);assert.equal(started.length,4);const a=d.extraBudget.tryAcquire(),b=d.extraBudget.tryAcquire();assert.ok(a&&b);assert.equal(d.extraBudget.tryAcquire(),null);a();b();d.stopping=true;finish.splice(0).forEach(done=>done());await Promise.all([...d.running]);}
 finally{d.stopping=true;clearTimeout(d.retryTimer);cfg.concurrency=previous;}
});

test('four normal downloads plus the shared two-activity budget cap total work at six',async()=>{
 const previous=cfg.concurrency;cfg.concurrency=4;const d=worker();let now=30000;d.now=()=>now;d.extraBudget=new ExtraBudget(2);
 const originals=Array.from({length:4},(_,i)=>({id:'active-'+i,series:'show',season:1,status:'downloading',runStartedAt:0}));originals.forEach(j=>d.controllers.set(j.id,new AbortController()));
 const extra={id:'extra-episode',series:'show',season:1,status:'queued',queueOrder:1};d.jobs=[...originals,extra];d.active=4;let finish;
 d.run=j=>{j.status='downloading';d.controllers.set(j.id,new AbortController());return new Promise(resolve=>{finish=()=>{j.status='done';d.controllers.delete(j.id);resolve();};});};let comparisonLease;
 try{d.pump();assert.equal(d.active,5);assert.equal(extra.isProbe,true);assert.equal(d.extraBudget.used,1);comparisonLease=d.extraBudget.tryAcquire();assert.ok(comparisonLease);assert.equal(d.extraBudget.used,2);assert.equal(d.extraBudget.tryAcquire(),null);}
 finally{d.stopping=true;clearTimeout(d.retryTimer);comparisonLease?.();finish?.();await Promise.all([...d.running]);cfg.concurrency=previous;}
});

test('deferred retries wait behind ready work and then fill every normal slot',async()=>{
 const previous=cfg.concurrency;cfg.concurrency=2;const d=worker();let now=10000;d.now=()=>now;d.extraBudget=new ExtraBudget(2);d.queueSequence=5;
 d.jobs=[{id:'fresh-1',status:'queued',queueOrder:1},{id:'fresh-2',status:'queued',queueOrder:2},{id:'fresh-3',status:'queued',queueOrder:3},{id:'deferred-1',status:'deferred',nextRetryAt:now,queueOrder:4,deferredRetryRound:1},{id:'deferred-2',status:'deferred',nextRetryAt:now,queueOrder:5,deferredRetryRound:1}];
 const started=[],complete=new Map();d.run=j=>{j.status=j.backgroundRetryActive?'resolving':'downloading';d.controllers.set(j.id,new AbortController());started.push(j.id);return new Promise(resolve=>complete.set(j.id,()=>{j.status='done';d.controllers.delete(j.id);resolve();}));};
 const settle=async id=>{complete.get(id)();await new Promise(resolve=>setImmediate(resolve));};
 try{
  d.pump();assert.deepEqual(started,['fresh-1','fresh-2']);
  await settle('fresh-1');assert.deepEqual(started,['fresh-1','fresh-2','fresh-3']);
  await settle('fresh-2');assert.deepEqual(started,['fresh-1','fresh-2','fresh-3','deferred-1']);
  await settle('fresh-3');assert.deepEqual(started,['fresh-1','fresh-2','fresh-3','deferred-1','deferred-2']);
  await settle('deferred-1');await settle('deferred-2');
 }finally{d.stopping=true;clearTimeout(d.retryTimer);await Promise.all([...d.running]);cfg.concurrency=previous;}
});

test('four due deferred episodes run across fair show turns and leave paused entries alone',async()=>{
 const previous=cfg.concurrency;cfg.concurrency=4;const d=worker();let now=50000;d.now=()=>now;d.extraBudget=new ExtraBudget(2);d.queueSequence=10;
 d.jobs=[
  {id:'a-1',series:'A',status:'deferred',nextRetryAt:now,queueOrder:1},
  {id:'a-2',series:'A',status:'deferred',nextRetryAt:now,queueOrder:2},
  {id:'b-1',series:'B',status:'deferred',nextRetryAt:now,queueOrder:3},
  {id:'c-1',series:'C',status:'deferred',nextRetryAt:now,queueOrder:4},
  {id:'d-1',series:'D',status:'deferred',nextRetryAt:now,queueOrder:5},
  {id:'paused',series:'E',status:'paused',nextRetryAt:now,queueOrder:6},
 ];
 const started=[],complete=new Map();d.run=j=>{j.status='resolving';d.controllers.set(j.id,new AbortController());started.push(j.id);return new Promise(resolve=>complete.set(j.id,()=>{j.status='done';d.controllers.delete(j.id);resolve();}));};
 try{d.pump();assert.equal(d.active,4);assert.equal(started.length,4);assert.equal(new Set(started.map(id=>d.jobs.find(j=>j.id===id).series)).size,4);assert.equal(d.jobs.find(j=>j.id==='paused').status,'paused');}
 finally{d.stopping=true;clearTimeout(d.retryTimer);for(const finish of complete.values())finish();await Promise.all([...d.running]);cfg.concurrency=previous;}
});

test('metadata cooldown spans episodes; piece cooldown only blocks its episode',()=>{
 const d=worker();let now=10;d.now=()=>now;const s={infoHash:'a'.repeat(40),fileIdx:0};
 d.cool({id:'a'},s,failure('NO_USEFUL_PIECES','stalled'));assert.equal(d.available({id:'a'},s),false);assert.equal(d.available({id:'b'},s),true);
 d.cool({id:'a'},s,failure('METADATA_TIMEOUT','no metadata'));assert.equal(d.available({id:'b'},s),false);now+=300001;assert.equal(d.available({id:'b'},s),true);
});

test('provider backoff is categorized, exponential, expiring, and cleared by a successful response',()=>{
 const d=worker();let now=100000;d.now=()=>now;d.providerResults={};d.sourceDiagnostics={record(){}};
 const providerId='p-'+'a'.repeat(24),originId='h-'+'c'.repeat(24),provider={providerId,originId};
 const transientId='p-'+'b'.repeat(24);for(const minutes of [5,10,20,30,30]){d.recordProviderResponse({id:'show:transient'},{providerId:transientId,status:'network_error',category:'network_error'});assert.equal(d.providerResults[transientId].cooldownUntil,now+minutes*60000);now+=minutes*60000;}
 d.recordProviderResponse({id:'show:1:1'},{...provider,status:'network_error',category:'network_error',latencyMs:7000,resultCount:0});
 assert.equal(d.providerResults[providerId].cooldownUntil,now+5*60000);assert.equal(d.providerResults[providerId].failureStreak,1);
 now+=5*60000;d.recordProviderResponse({id:'show:1:2'},{...provider,status:'timeout',category:'timeout',latencyMs:7000,resultCount:0});
 assert.equal(d.providerResults[providerId].cooldownUntil,now+10*60000);assert.equal(d.providerResults[providerId].failureStreak,2);
 now+=10*60000;d.recordProviderResponse({id:'show:1:3'},{...provider,status:'http_error',category:'http_403',latencyMs:10,resultCount:0});
 assert.equal(d.providerResults[providerId].cooldownUntil,now+30*60000);
 now+=30*60000;d.recordProviderResponse({id:'show:1:4'},{...provider,status:'http_error',category:'http_429',latencyMs:10,resultCount:0});
 assert.equal(d.providerResults[providerId].cooldownUntil,now+5*60000);
 assert.equal(d.providerResults[originId].cooldownUntil,now+5*60000);
 now+=60000;d.recordProviderResponse({id:'show:1:5'},{...provider,status:'empty',category:'empty',latencyMs:10,resultCount:0});
 assert.equal(d.providerResults[originId].cooldownUntil,now-60000+5*60000,'a sibling success must not clear an active origin-wide 429 cooldown');
 now+=4*60000;d.recordProviderResponse({id:'show:1:6'},{...provider,status:'http_error',category:'http_429',retryAfterMs:60*60000,latencyMs:10,resultCount:0});
 assert.equal(d.providerResults[providerId].cooldownUntil,now+60*60000);assert.equal(d.providerResults[originId].cooldownUntil,now+60*60000);
 now+=60*60000;d.recordProviderResponse({id:'show:1:7'},{...provider,status:'empty',category:'empty',latencyMs:10,resultCount:0});
 assert.equal(d.providerResults[providerId].responsive,true);assert.equal(d.providerResults[providerId].cooldownUntil,0);assert.equal(d.providerResults[providerId].failureStreak,0);
 assert.equal(d.providerResults[originId].responsive,true);assert.equal(d.providerResults[originId].cooldownUntil,0);
});

test('queue lookup feedback keeps the all-providers-cooling count when lookup resolves empty',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-cooldown-feedback-')),d=worker();d.jobs=[];d.seasonHashes=new Map();d.sourceResults={};d.providerResults={};d.controllers=new Map();
 d.streamsFor=async(_id,_signal,{onUpdate})=>{onUpdate({streams:[],diagnostics:[],completed:0,providerCount:0,suppressedCount:60,done:true});return [];};
 const j={id:'tt0000001:1:1',series:'tt0000001',seriesName:'Show',kind:'imdb',season:1,episode:1,title:'Episode',status:'queued',profile:{downloadDir:root,resolution:720,allowedResolutions:[720],english:true}};
 try{await d.run(j);assert.equal(j.status,'retry_wait');assert.equal(j.sourceDiscovery.providerCount,0);assert.equal(j.sourceDiscovery.suppressedCount,60);assert.match(j.error,/providers are cooling down/);}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('primary torrent metadata timeout is capped at 15 seconds',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const root=fs.mkdtempSync(path.join(os.tmpdir(),'primary-metadata-'));const previousDir=cfg.downloadDir,previousTimeout=cfg.metadataTimeoutSeconds;cfg.downloadDir=root;cfg.metadataTimeoutSeconds=30;
 const d=worker();d.torrents=new Map();const torrent=Object.assign(new EventEmitter(),{destroy(){this.destroyed=true;}});d.getClient=async()=>({add:()=>torrent});
 try{
  const pending=d.acquire({infoHash:'d'.repeat(40)});let settled=false;pending.catch(()=>settled=true);await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(14999);await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  t.mock.timers.tick(1);await assert.rejects(pending,{code:'METADATA_TIMEOUT'});assert.equal(torrent.destroyed,true);
 }finally{cfg.downloadDir=previousDir;cfg.metadataTimeoutSeconds=previousTimeout;fs.rmSync(root,{recursive:true,force:true});}
});

test('retry wakeup queues due jobs, leaves paused jobs alone, and clear shuts off wakeup',async()=>{
 const d=worker();d.now=()=>1000;d.jobs=[{id:'a',status:'retry_wait',nextRetryAt:500},{id:'b',status:'retry_wait',nextRetryAt:2000},{id:'c',status:'paused'}];
 d.run=async j=>{j.status='done';};d.pump();await Promise.all([...d.running]);assert.equal(d.jobs[0].status,'done');assert.equal(d.jobs[1].status,'retry_wait');assert.equal(d.jobs[2].status,'paused');
 await d.clearAll();assert.equal(d.jobs.length,0);assert.equal(d.active,0);clearTimeout(d.retryTimer);
});

test('speed is per-file and slow useful progress resets the stall timer',()=>{
 const a=new FileProgress(100,0),b=new FileProgress(0,0);
 assert.deepEqual(a.sample(110,89000),{speed:10*1000/89000,rollingSpeed:10*1000/89000,idleMs:0});
 assert.equal(b.sample(0,89000).speed,0);assert.equal(b.sample(0,90000).idleMs,90000);
 assert.equal(a.sample(111,178000).idleMs,0);assert.equal(a.sample(111,179000).speed,0);
});

test('rolling rate uses the most recent 30 seconds and smooths a brief dip',()=>{
 const meter=new FileProgress(0,0);let bytes=0,sample;
 for(let second=1;second<=60;second++){bytes+=second<=30?100000:500000;sample=meter.sample(bytes,second*1000);}
 assert.ok(sample.rollingSpeed>490000&&sample.rollingSpeed<510000,sample.rollingSpeed);
 const before=sample.rollingSpeed;sample=meter.sample(bytes+1000,61000);assert.ok(sample.rollingSpeed>before*.96);
});

test('slow trigger waits 60 seconds below the absolute or relative threshold and resets on recovery',()=>{
 const d=worker();let now=0;d.now=()=>now;const slow={id:'slow',status:'downloading',rollingSpeed:400000},fast={id:'fast',status:'downloading',rollingSpeed:2000000};d.jobs=[slow,fast];d.controllers.set('slow',new AbortController());d.controllers.set('fast',new AbortController());
 assert.equal(d.slowThreshold(slow),500000);d.updateSlowState(slow,now);assert.equal(slow.slowSince,0);now=59999;assert.equal(d.slowComparisonDue(slow),false);now=60000;assert.equal(d.slowComparisonDue(slow),true);
 slow.rollingSpeed=700000;d.updateSlowState(slow,now);assert.equal(slow.slowSince,null);assert.equal(d.slowComparisonDue(slow),false);now=64999;assert.equal(d.originalRecovered(slow),false);now=65000;assert.equal(d.originalRecovered(slow),true);
});

test('slow comparison yields its slot without deleting partials and marks the job behind ready work',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yield-partial-'));const d=worker();d.jobs=[];d.controllers=new Map();d.contexts=new Map();d.extraBudget=new ExtraBudget(2);d.queueSequence=1;d.save=()=>{};d.now=()=>1000;
 const partial=path.join(root,'source.part');const j={id:'show:1:1',series:'show',seriesName:'Show',season:1,episode:1,title:'Episode',status:'queued',profile:{downloadDir:root,resolution:720,allowedResolutions:[720]}};
 d.streamsFor=async()=>[{name:'720p',infoHash:'a'.repeat(40),fileIdx:0}];d.downloadWithComparison=async()=>{fs.writeFileSync(partial,'preserve-me');throw failure('YIELD_TRANSFER','Waiting behind other downloads');};
 try{await d.run(j);assert.equal(j.status,'queued');assert.equal(j.stage,'Waiting behind other downloads');assert.equal(j.error,null);assert.ok(j.yieldedAt);assert.equal(fs.readFileSync(partial,'utf8'),'preserve-me');}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('fresh backlog drains before yielded jobs, and yielded jobs rejoin FIFO without starving',async()=>{
 const previous=cfg.concurrency;cfg.concurrency=1;const d=worker();d.jobs=[
  {id:'yielded',status:'queued',yieldedAt:10,queueOrder:10},
  {id:'backlog',status:'queued',queueOrder:2},
  {id:'arrived-later',status:'queued',queueOrder:11},
  {id:'manual-pause',status:'paused',queueOrder:1}
 ];d.active=0;d.running=new Set();d.controllers=new Map();d.extraBudget=new ExtraBudget(2);d.queueSequence=11;d.stopping=false;d.clearing=false;d.save=()=>{};const order=[];
 d.run=async j=>{order.push(j.id);j.status='done';await new Promise(resolve=>setTimeout(resolve,0));};
 try{d.pump();for(let n=0;n<100&&d.jobs.some(j=>j.status==='queued');n++)await new Promise(resolve=>setTimeout(resolve,5));assert.deepEqual(order,['backlog','arrived-later','yielded']);assert.equal(d.jobs.find(j=>j.id==='manual-pause').status,'paused');}
 finally{d.stopping=true;clearTimeout(d.retryTimer);cfg.concurrency=previous;}
});

test('slow yielded work gives its slot to a due deferred retry and resumes after retry work drains',async()=>{
 const previous=cfg.concurrency;cfg.concurrency=1;const d=worker();let now=20000;d.now=()=>now;d.extraBudget=new ExtraBudget(2);d.active=0;d.queueSequence=8;d.stopping=false;d.clearing=false;d.running=new Set();
 const yielded={id:'yielded',status:'queued',yieldedAt:now-1000,queueOrder:8},deferred={id:'due-retry',status:'deferred',nextRetryAt:now,queueOrder:2,deferredRetryRound:2},paused={id:'manual',status:'paused',nextRetryAt:now,queueOrder:1};d.jobs=[yielded,deferred,paused];
 const started=[],finishes=new Map();d.run=job=>{started.push(job.id);job.status='downloading';d.controllers.set(job.id,new AbortController());return new Promise(resolve=>finishes.set(job.id,()=>{job.status='done';d.controllers.delete(job.id);resolve();}));};
 const settle=async id=>{finishes.get(id)();await new Promise(resolve=>setImmediate(resolve));};
 try{
  assert.equal(d.hasReadyWork('slow-active'),true);d.pump();assert.deepEqual(started,['due-retry']);assert.ok(yielded.yieldedAt);assert.equal(paused.status,'paused');
  await settle('due-retry');assert.deepEqual(started,['due-retry','yielded']);assert.equal(yielded.yieldedAt,null);
 }finally{d.stopping=true;clearTimeout(d.retryTimer);for(const finish of finishes.values())finish();await Promise.all([...d.running]);cfg.concurrency=previous;}
});

test('after 30 idle seconds one extra episode starts without interrupting stalled siblings',async()=>{
 const previous=cfg.concurrency;cfg.concurrency=4;
 const d=worker();let now=29999;d.now=()=>now;
 const original=['a','b','c','d'].map(id=>({id,series:'show',season:1,status:'downloading',runStartedAt:0}));
 original.forEach(j=>d.controllers.set(j.id,new AbortController()));d.active=4;
 d.jobs=[...original,{id:'paused',series:'show',season:1,status:'paused'},{id:'other',series:'other',season:1,status:'queued'},{id:'next',series:'show',season:1,status:'queued'},{id:'later',series:'show',season:1,status:'queued'}];
 let finish;
 d.run=j=>{j.status='downloading';j.runStartedAt=now;d.controllers.set(j.id,new AbortController());return new Promise(resolve=>{finish=()=>{j.status='done';d.controllers.delete(j.id);resolve();};});};
 try{
  d.pump();assert.equal(d.active,4);now=30000;d.pump();assert.equal(d.active,5);
  assert.equal(d.jobs.find(j=>j.id==='next').isProbe,true);assert.equal(d.jobs.find(j=>j.id==='other').status,'queued');
  now=60000;d.pump();assert.equal(d.active,5);assert.ok(original.every(j=>!d.controllers.get(j.id).signal.aborted));assert.equal(d.jobs.find(j=>j.id==='paused').status,'paused');
 }finally{d.stopping=true;clearTimeout(d.retryTimer);finish?.();await Promise.all([...d.running]);cfg.concurrency=previous;}
});

test('a failed no-progress source yields to an untried release within the same turn',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'episode-switch-'));const d=worker();let now=1000;d.now=()=>now;
 const sources=[source(1),source(2)];d.streamsFor=async()=>sources;const tried=[];
 d.downloadTorrent=async(j,choice)=>{tried.push(choice.infoHash);if(choice.infoHash===sources[0].infoHash)throw failure('NO_USEFUL_PIECES','stalled');return 'verified';};
 const j=job(root,1);
 try{await d.run(j);assert.equal(j.status,'done');assert.deepEqual(tried,sources.map(s=>s.infoHash));}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('shared file references and overlapping boundary selections survive cancellation',()=>{
 const selections=[{start:0,end:9,priority:0}];const t={pieces:Array(10),pieceLength:10,select:(start,end,priority)=>selections.push({start,end,priority}),deselect:(start,end,priority)=>{const i=selections.findIndex(s=>s.start===start&&s.end===end&&s.priority===priority);if(i>=0)selections.splice(i,1);}};
 const entry={torrent:t};const a={path:'a',offset:0,length:15},b={path:'b',offset:15,length:15};
 const a1=selectFile(entry,a),a2=selectFile(entry,a),b1=selectFile(entry,b);assert.equal(selections.length,2);assert.ok(selections.every(s=>s.priority===1));
 a1();assert.equal(selections.length,2);a2();assert.deepEqual(selections,[{start:1,end:2,priority:1}]);a2();assert.equal(selections.length,1);b1();assert.equal(selections.length,0);
});

test('live transfer waits for useful file pieces, reports zero speed, times out and cleans up',async context=>{
 context.mock.timers.enable({apis:['setInterval']});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'stalled-'));const d=worker();let now=0;d.now=()=>now;
 const torrent=Object.assign(new EventEmitter(),{pieces:Array(4),pieceLength:1024,numPeers:8,downloadSpeed:900000,select(){},deselect(){}});
 const file={path:'Show.S01E01.mkv',offset:0,length:2048,downloaded:0,progress:0};torrent.files=[file];const entry={torrent};
 d.acquire=async()=>entry;let released=0;d.release=()=>released++;d.controllers.set('a',new AbortController());const j={id:'a',season:1,episode:1};
 try{const pending=d.downloadTorrent(j,{infoHash:'a',fileIdx:0},root,'S01E01 - ');await new Promise(setImmediate);now=1000;context.mock.timers.tick(1000);assert.equal(j.speed,0);assert.equal(j.torrentSpeed,900000);assert.equal(j.stage,'Waiting for useful pieces');
 now=90000;context.mock.timers.tick(1000);await assert.rejects(pending,{code:'NO_USEFUL_PIECES'});assert.equal(entry.selections.size,0);assert.equal(released,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
