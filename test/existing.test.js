import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Downloader} from '../src/downloader.js';
import {findExisting,verifyExisting,fingerprint,signature} from '../src/existing.js';
import {finalize} from '../src/finalize.js';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'reuse-test-'));
function worker(){const d=Object.create(Downloader.prototype);d.controllers=new Map();d.seasonHashes=new Map();d.save=()=>{};const state={};d.store={read:k=>state[k],write:(k,v)=>state[k]=v};return d;}
test('healthy disk file skips all providers after queue removal and ignores quality',async()=>{
 const root=temp();try{const dir=path.join(root,'Show','Season 01');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'Show - S01E01 - Old title.mkv');fs.copyFileSync('test/fixture.mkv',file);
 const d=worker();d.streamsFor=()=>{throw Error('must not request sources')};
 for(let i=0;i<2;i++){const job={id:'show:1:1',seriesName:'Show',season:1,episode:1,title:'New title',profile:{downloadDir:root,resolution:2160,english:true}};await d.run(job);assert.equal(job.status,'done',job.error);assert.equal(job.reused,true);assert.equal(job.file,file);assert.equal(job.progress,1);}
 assert.equal(Object.keys(d.store.read('verifiedFiles')).length,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('missing, changed titles, extensions, partials, ambiguity and unavailable drive',()=>{
 const root=temp();try{assert.equal(findExisting(root,'Show - S01E01 - ',path.join(root,'missing.mkv')),null);fs.writeFileSync(path.join(root,'Show - S01E01 - A.mkv.part'),'partial');assert.equal(findExisting(root,'Show - S01E01 - '),null);const file=path.join(root,'Show - S01E01 - B.avi');fs.writeFileSync(file,'x');assert.equal(findExisting(root,'Show - S01E01 - '),file);fs.writeFileSync(path.join(root,'Show - S01E01 - C.mp4'),'x');assert.throws(()=>findExisting(root,'Show - S01E01 - '),/Multiple/);if(!fs.existsSync('Q:\\'))assert.throws(()=>findExisting('Q:\\unavailable','Show'));}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('decode, cached fingerprint, damaged video and cancellation',async()=>{
 const root=temp();try{const file=path.join(root,'video.mkv');fs.copyFileSync('test/fixture.mkv',file);const result=await verifyExisting(file);assert.equal(result.version,1);assert.deepEqual(await verifyExisting(file,result),result);fs.writeFileSync(file,'broken video');await assert.rejects(verifyExisting(file,result),{code:'CORRUPT_MEDIA'});const c=new AbortController();c.abort();await assert.rejects(verifyExisting(file,null,c.signal),{name:'AbortError'});}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('verified replacement and collision rollback preserve old bytes',async()=>{
 const root=temp();try{const source=path.join(root,'new'),old=path.join(root,'old'),collision=path.join(root,'occupied');fs.writeFileSync(source,'healthy');fs.writeFileSync(old,'damaged');fs.writeFileSync(collision,'unrelated');let replacement={path:old,...await fingerprint(old)};assert.throws(()=>finalize(source,collision,replacement),{code:'EEXIST'});assert.equal(fs.readFileSync(old,'utf8'),'damaged');assert.equal(fs.readFileSync(collision,'utf8'),'unrelated');replacement={path:old,signature:signature(fs.statSync(old))};finalize(source,old,replacement);assert.equal(fs.readFileSync(old,'utf8'),'healthy');assert.ok(!fs.existsSync(old+'.corrupt-backup'));}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('done entries are requeued for verification while active entries are retained',()=>{
 const d=worker();d.pump=()=>{};d.jobs=[{id:'a',status:'done',file:'old'},{id:'b',status:'downloading'}];assert.equal(d.enqueue({seriesName:'Show',episodes:[{id:'a',season:1,episode:1},{id:'b',season:1,episode:2}]}),1);assert.equal(d.jobs.find(j=>j.id==='a').file,'old');assert.equal(d.jobs.find(j=>j.id==='a').status,'queued');
});
test('replacement verification failure preserves original',async()=>{
 const root=temp();try{const file=path.join(root,'old');fs.writeFileSync(file,'damaged');const d=worker();d.verifyExisting=async()=>{throw Error('verification unavailable')};await assert.rejects(d.finishFile({id:'x',replacement:{path:file,...await fingerprint(file)}},'missing',file),/unavailable/);assert.equal(fs.readFileSync(file,'utf8'),'damaged');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('corrupt file is replaced only after real decode verification',async()=>{
 const root=temp();try{const dir=path.join(root,'Show','Season 00');fs.mkdirSync(dir,{recursive:true});const old=path.join(dir,'Show - S00E01 - Old title.avi');fs.writeFileSync(old,'broken');const d=worker();let requests=0;
 d.streamsFor=async()=>{requests++;return [{name:'720p',title:'Show.S00E01.720p',infoHash:'a'.repeat(40),fileIdx:0}]};
 d.downloadTorrent=async(job,c,folder)=>{const dest=path.join(folder,'Show - S00E01 - New title.mkv');await d.finishFile(job,path.resolve('test/fixture.mkv'),dest);return dest;};
 const job={id:'show:0:1',seriesName:'Show',season:0,episode:1,profile:{downloadDir:root,resolution:720,allowedResolutions:[720]}};await d.run(job);assert.equal(job.status,'done',job.error);assert.equal(requests,1);assert.ok(!fs.existsSync(old));assert.deepEqual(fs.readFileSync(job.file),fs.readFileSync('test/fixture.mkv'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('interrupted swap restores original from recovery link',async()=>{
 const root=temp();try{const dir=path.join(root,'Show','Season 01');fs.mkdirSync(dir,{recursive:true});const old=path.join(dir,'Show - S01E01 - Old.mkv');fs.copyFileSync('test/fixture.mkv',old+'.corrupt-backup');const d=worker();d.streamsFor=()=>{throw Error('unexpected request')};const job={id:'show:1:1',seriesName:'Show',season:1,episode:1,profile:{downloadDir:root}};await d.run(job);assert.equal(job.status,'done',job.error);assert.ok(fs.existsSync(old));assert.ok(!fs.existsSync(old+'.corrupt-backup'));}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('missing verifier is not classified as corruption',async()=>{
 const root=temp();const prior=process.env.COMPANION_FFMPEG;try{const file=path.join(root,'video.mkv');fs.copyFileSync('test/fixture.mkv',file);const fake=path.join(root,'invalid.exe');fs.writeFileSync(fake,'not executable');process.env.COMPANION_FFMPEG=fake;await assert.rejects(verifyExisting(file),e=>e.code!=='CORRUPT_MEDIA'&&/Could not verify/.test(e.message));}finally{if(prior===undefined)delete process.env.COMPANION_FFMPEG;else process.env.COMPANION_FFMPEG=prior;fs.rmSync(root,{recursive:true,force:true});}
});
test('truncated media is rejected without overwriting it',async()=>{
 const root=temp();try{const file=path.join(root,'truncated.mkv');const bytes=fs.readFileSync('test/fixture.mkv');fs.writeFileSync(file,bytes.subarray(0,Math.floor(bytes.length/2)));await assert.rejects(verifyExisting(file),{code:'CORRUPT_MEDIA'});assert.equal(fs.statSync(file).size,Math.floor(bytes.length/2));}finally{fs.rmSync(root,{recursive:true,force:true});}
});
