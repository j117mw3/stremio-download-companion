import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Downloader } from '../src/downloader.js';
test('HTTP transfer preserves bytes and never overwrites completed output',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-test-'));
 const data=Buffer.from('fixture-video-bytes');
 const server=http.createServer((req,res)=>{res.setHeader('ETag','"fixture"');res.setHeader('Content-Length',data.length);res.end(data)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const d=Object.create(Downloader.prototype);d.inspectMedia=async()=>({fixture:true});d.controllers=new Map([['fixture',new AbortController()]]);
 const c={url:`http://127.0.0.1:${server.address().port}/video.mp4`,filename:'video.mp4',raw:{}};
 try{const file=await d.downloadHttp({id:'fixture'},c,dir,'S01E01 - ');assert.deepEqual(fs.readFileSync(file),data);await assert.rejects(d.downloadHttp({id:'fixture'},c,dir,'S01E01 - '),{code:'EEXIST'});assert.deepEqual(fs.readFileSync(file),data)}finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
});
test('cancel preserves job and prevents resume while transfer is stopping',()=>{
 const d=Object.create(Downloader.prototype);const controller=new AbortController();d.controllers=new Map([['a',controller]]);d.jobs=[{id:'a',status:'downloading'}];d.save=()=>{};d.pump=()=>{};
 d.control('a','cancel');assert.equal(d.jobs[0].status,'cancelled');assert.ok(controller.signal.aborted);assert.throws(()=>d.control('a','resume'),/stopping/);
 d.controllers.clear();d.control('a','resume');assert.equal(d.jobs[0].status,'queued');
});
test('metadata cancellation releases acquisition instead of waiting for timeout',async()=>{
 const d=Object.create(Downloader.prototype);d.torrents=new Map();let released=false;
 d.torrents.set('fixture',{refs:0,promise:new Promise(()=>{})});d.release=()=>{released=true};
 const controller=new AbortController();const pending=d.acquire({infoHash:'fixture'},controller.signal);controller.abort();
 await assert.rejects(pending,/Stopped/);assert.ok(released);
});
test('startup recovers interrupted jobs and preserves paused jobs',()=>{
 const d=Object.create(Downloader.prototype);d.store={read:()=>[{id:'a',status:'downloading'},{id:'b',status:'paused'}]};d.pump=()=>{};d.load();assert.equal(d.jobs[0].status,'queued');assert.equal(d.jobs[1].status,'paused');
});
test('torrent metadata and no-progress failures switch to the next eligible release',async()=>{
 const {createHash}=await import('node:crypto');
 for(const code of ['METADATA_TIMEOUT','NO_USEFUL_PIECES']){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'companion-source-fallback-'));
  const first={name:'Torrentio\n720p',title:'Dead.S01E01.720p',infoHash:'a'.repeat(40),fileIdx:0};
  const second={name:'Torrentio\n720p',title:'Live.S01E01.720p',infoHash:'b'.repeat(40),fileIdx:0};
  const sourceOverride=createHash('sha256').update(JSON.stringify([first.infoHash,first.fileIdx,first.url])).digest('hex');
  const d=Object.create(Downloader.prototype);const tried=[];d.streamsFor=async()=>[first,second];d.downloadTorrent=async(_job,choice)=>{tried.push(choice.title);if(choice.raw===first)throw Object.assign(new Error('source failed'),{code});return 'verified-file'};d.controllers=new Map();d.seasonHashes=new Map();d.save=()=>{};
  const job={id:'tt0000001:1:1',profile:{resolution:720,allowedResolutions:[720],english:false,downloadDir:directory},kind:'imdb',series:'tt0000001',seriesName:'Show',title:'Episode',season:1,episode:1,status:'queued',sourceOverride};
  try{await d.run(job);assert.equal(job.status,'done');assert.deepEqual(tried,['Dead.S01E01.720p','Live.S01E01.720p']);}finally{fs.rmSync(directory,{recursive:true,force:true});}
 }
});
test('shutdown keeps interrupted active jobs queued for restart',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'companion-shutdown-'));
 const source={name:'Torrentio\n720p',title:'Show.S01E01.720p',infoHash:'c'.repeat(40),fileIdx:0};
 const d=Object.create(Downloader.prototype);d.streamsFor=async()=>[source];d.controllers=new Map();d.seasonHashes=new Map();d.jobs=[];d.running=new Set();d.save=()=>{};d.saveNow=()=>{};d.client=null;
 let announceStarted;const started=new Promise(resolve=>announceStarted=resolve);
 d.downloadTorrent=async job=>{const controller=d.controllers.get(job.id);announceStarted();await new Promise((resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('Stopped')),{once:true}));};
 const job={id:'tt0000002:1:1',profile:{resolution:720,allowedResolutions:[720],english:false,downloadDir:directory},kind:'imdb',series:'tt0000002',seriesName:'Show',title:'Episode',season:1,episode:1,status:'queued'};d.jobs.push(job);
 try{const pending=d.run(job);await started;await d.shutdown();await pending;assert.equal(job.status,'queued');assert.equal(job.stage,'Queued after restart');assert.equal(job.error,null);}finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('invalid persisted state fails visibly instead of discarding the queue',()=>{
 const d=Object.create(Downloader.prototype);d.store={read:()=>({invalid:true})};assert.throws(()=>d.load(),/original database preserved/);
});
test('HTTP resume requests the retained offset and produces exact bytes',async()=>{
 const {createHash}=await import('node:crypto');const directory=fs.mkdtempSync(path.join(os.tmpdir(),'companion-resume-'));const bytes=Buffer.from('0123456789abcdef');let range;
 const server=http.createServer((req,res)=>{range=req.headers.range;assert.equal(req.headers['if-range'],'"version1"');res.writeHead(206,{'Content-Range':'bytes 6-15/16','Content-Length':10,ETag:'"version1"'});res.end(bytes.subarray(6))});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/video.mkv`;const suffix=createHash('sha256').update(url).digest('hex').slice(0,16);const part=path.join(directory,`Series - S01E01 - Episode.mkv.${suffix}.part`);fs.writeFileSync(part,bytes.subarray(0,6));fs.writeFileSync(part+'.json',JSON.stringify({validator:'"version1"'}));const d=Object.create(Downloader.prototype);d.inspectMedia=async()=>({fixture:true});d.controllers=new Map([['resume',new AbortController()]]);
 try{const file=await d.downloadHttp({id:'resume'},{url,filename:'video.mkv',raw:{}},directory,'S01E01 - ');assert.equal(range,'bytes=6-');assert.deepEqual(fs.readFileSync(file),bytes)}finally{await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true})}
});
test('finalization exposes complete bytes and preserves an existing destination',async()=>{
 const{finalize}=await import('../src/finalize.js');const directory=fs.mkdtempSync(path.join(os.tmpdir(),'companion-finalize-'));const source=path.join(directory,'source'),destination=path.join(directory,'destination');fs.writeFileSync(source,'complete');try{finalize(source,destination);assert.equal(fs.readFileSync(destination,'utf8'),'complete');fs.writeFileSync(source,'replacement');assert.throws(()=>finalize(source,destination),{code:'EEXIST'});assert.equal(fs.readFileSync(destination,'utf8'),'complete');assert.deepEqual(fs.readdirSync(directory).sort(),['destination','source'])}finally{fs.rmSync(directory,{recursive:true,force:true})}
});
