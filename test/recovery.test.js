import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Downloader} from '../src/downloader.js';
import {failure,FileProgress,selectFile,RETRY_DELAYS} from '../src/transfer-state.js';

function worker(){
 const d=Object.create(Downloader.prototype);d.jobs=[];d.controllers=new Map();d.running=new Set();d.active=0;d.seasonHashes=new Map();d.cooldowns={};d.save=()=>{};d.saveNow=()=>{};
 return d;
}
const source=n=>({name:'720p',title:'Source '+n,infoHash:String(n).repeat(40),fileIdx:0});
const job=(root,n)=>({id:'show:1:'+n,series:'show',seriesName:'Show',season:1,episode:n,status:'queued',profile:{downloadDir:root,resolution:720,allowedResolutions:[720]}});

test('two exhausted jobs release both slots and later healthy episodes proceed',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-'));const d=worker();let calls={};
 d.jobs=[1,2,3,4].map(n=>job(root,n));d.streamsFor=async()=>[1,2,3,4].map(source);
 d.downloadTorrent=async(j)=>{calls[j.id]=(calls[j.id]||0)+1;if(j.episode<=2)throw failure('NO_USEFUL_PIECES','stalled');return 'healthy';};
 try{d.pump();for(let i=0;i<40&&d.jobs.some(j=>['queued','downloading','resolving'].includes(j.status));i++)await new Promise(setImmediate);
 assert.deepEqual(d.jobs.map(j=>j.status),['retry_wait','retry_wait','done','done']);
 assert.equal(calls['show:1:1'],3);assert.equal(calls['show:1:2'],3);assert.equal(d.active,0);
 }finally{d.stopping=true;clearTimeout(d.retryTimer);fs.rmSync(root,{recursive:true,force:true});}
});

test('retry delays persist through restart and stop after three automatic retries',()=>{
 let now=100;const d=worker();d.now=()=>now;const j={id:'a'};
 for(let round=0;round<3;round++){d.defer(j,failure('NO_USEFUL_PIECES','stalled'));assert.equal(j.nextRetryAt,now+RETRY_DELAYS[round]);assert.equal(j.retryRound,round+1);now=j.nextRetryAt;}
 d.defer(j,failure('NO_USEFUL_PIECES','stalled'));assert.equal(j.status,'needs_attention');assert.equal(j.nextRetryAt,null);
 const queued={id:'b',status:'retry_wait',nextRetryAt:now+1000,retryRound:1};
 d.store={read:key=>key==='jobs'?[queued,{id:'c',status:'paused'}]:{'torrent:abc':now+500}};d.pump=()=>{};d.load();
 assert.equal(d.jobs[0].nextRetryAt,now+1000);assert.equal(d.jobs[1].status,'paused');assert.equal(d.cooldowns['torrent:abc'],now+500);
 d.jobs=[j];d.control('a','retry');assert.equal(j.status,'queued');assert.equal(j.retryRound,0);
});

test('metadata cooldown spans episodes; piece cooldown only blocks its episode',()=>{
 const d=worker();let now=10;d.now=()=>now;const s={infoHash:'a'.repeat(40),fileIdx:0};
 d.cool({id:'a'},s,failure('NO_USEFUL_PIECES','stalled'));assert.equal(d.available({id:'a'},s),false);assert.equal(d.available({id:'b'},s),true);
 d.cool({id:'a'},s,failure('METADATA_TIMEOUT','no metadata'));assert.equal(d.available({id:'b'},s),false);now+=300001;assert.equal(d.available({id:'b'},s),true);
});

test('retry wakeup queues due jobs, leaves paused jobs alone, and clear shuts off wakeup',async()=>{
 const d=worker();d.now=()=>1000;d.jobs=[{id:'a',status:'retry_wait',nextRetryAt:500},{id:'b',status:'retry_wait',nextRetryAt:2000},{id:'c',status:'paused'}];
 d.run=async j=>{j.status='done';};d.pump();await Promise.all([...d.running]);assert.equal(d.jobs[0].status,'done');assert.equal(d.jobs[1].status,'retry_wait');assert.equal(d.jobs[2].status,'paused');
 await d.clearAll();assert.equal(d.jobs.length,0);assert.equal(d.active,0);clearTimeout(d.retryTimer);
});

test('speed is per-file and slow useful progress resets the stall timer',()=>{
 const a=new FileProgress(100,0),b=new FileProgress(0,0);
 assert.deepEqual(a.sample(110,89000),{speed:10*1000/89000,idleMs:0});
 assert.equal(b.sample(0,89000).speed,0);assert.equal(b.sample(0,90000).idleMs,90000);
 assert.equal(a.sample(111,178000).idleMs,0);assert.equal(a.sample(111,179000).speed,0);
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
