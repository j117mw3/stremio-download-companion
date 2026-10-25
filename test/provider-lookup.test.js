import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createStreamLookup,ProviderRequestPool,providerIdentifier} from '../src/resolver.js';
import {SourceDiagnostics} from '../src/source-diagnostics.js';

async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;}
async function close(server){await new Promise(resolve=>server.close(resolve));}

test('forty cancelled active fetches release every lease and a healthy lookup still completes',async()=>{
 const server=http.createServer((req,res)=>{if(req.url.includes('/healthy/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({streams:[]}));}});
 const base=await listen(server),pool=new ProviderRequestPool(32,{originSpacingMs:0});
 try{
  for(let index=0;index<40;index++){
   const controller=new AbortController(),arrived=new Promise(resolve=>server.once('request',resolve));
   const pending=createStreamLookup('ep0',{providers:[{name:'Fixture',url:base+'/hang'}],pool,signal:controller.signal}).promise;
   await arrived;controller.abort();await assert.rejects(pending);assert.equal(pool.health().active,0);assert.equal(pool.health().waiting,0);
  }
  const result=await createStreamLookup('ep0',{providers:[{name:'Fixture',url:base+'/healthy'}],pool}).promise;
  assert.equal(result.completed,1);assert.equal(pool.health().cancelled,40);assert.equal(pool.health().completed,1);
  const release=await pool.acquire(undefined,'shared');const waiting=new AbortController();
  const held=await pool.acquire(undefined,'shared');const blocked=pool.acquire(waiting.signal,'shared');waiting.abort();await assert.rejects(blocked);release();held();assert.equal(pool.health().active,0);assert.equal(pool.health().waiting,0);
 }finally{server.closeAllConnections();await close(server);}
});

test('60 provider responses stream progressively, deduplicate swarms and classify failures',async()=>{
 let completed=0,firstUpdateBeforeAll=false;const hash='a'.repeat(40);
 const server=http.createServer((req,res)=>{
  const provider=Number(/manifest(\d+)/.exec(req.url)?.[1]);
  const send=()=>{
   if(provider===3){res.writeHead(503);res.end('private failure text');return;}
   if(provider===4){setTimeout(()=>{if(!res.destroyed){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({streams:[]}));}},120);return;}
   res.setHeader('Content-Type','application/json');
   const streams=provider===0?[{name:'720p',title:'Show.S01E01.720p',infoHash:hash,fileIdx:0}]:provider===1?[{name:'720p',title:'Show.S01E01.720p',infoHash:hash,fileIdx:1}]:[];
   res.end(JSON.stringify({streams}));
  };
  setTimeout(send,provider===0?2:provider===1?4:provider===2?8:1);
 });
 const base=await listen(server);const providers=Array.from({length:60},(_,index)=>({name:`Fixture ${index}`,url:`${base}/manifest${index}`,types:['series']}));
 try{
  const lookup=createStreamLookup('tt0000001:1:1',{providers,pool:new ProviderRequestPool(32,{perOriginLimit:60,originSpacingMs:0}),timeoutMs:35,onUpdate:snapshot=>{completed=snapshot.completed;if(snapshot.completed>0&&snapshot.completed<60)firstUpdateBeforeAll=true;}});
  const result=await lookup.promise;
  assert.equal(result.diagnostics.length,60);assert.equal(result.completed,60);assert.equal(result.streams.length,1);
  assert.equal(result.streams[0].fileIdx,null);assert.equal(result.streams[0].providerIds.length,2);assert.equal(result.streams[0].addonNames.length,2);
  assert.ok(result.diagnostics.some(item=>item.status==='empty'));assert.ok(result.diagnostics.some(item=>item.status==='timeout'));assert.ok(result.diagnostics.some(item=>item.category==='http_503'));
  assert.equal(firstUpdateBeforeAll,true);assert.equal(completed,60);
  assert.match(providerIdentifier(providers[0]),/^p-[a-f0-9]{24}$/);assert.ok(!providerIdentifier(providers[0]).includes(base));
 }finally{await close(server);}
});

test('five concurrent episode lookups honor 32 global and eight per-episode requests',async()=>{
 let active=0,maxActive=0;const activeByEpisode=new Map(),maxByEpisode=new Map(),started=[];
 const server=http.createServer((req,res)=>{
  const episode=/series\/(ep\d+)\.json/.exec(req.url)?.[1]||'unknown';
  started.push(episode);
  active++;maxActive=Math.max(maxActive,active);activeByEpisode.set(episode,(activeByEpisode.get(episode)||0)+1);maxByEpisode.set(episode,Math.max(maxByEpisode.get(episode)||0,activeByEpisode.get(episode)));
  setTimeout(()=>{active--;activeByEpisode.set(episode,activeByEpisode.get(episode)-1);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({streams:[]}));},25);
 });
 const base=await listen(server),pool=new ProviderRequestPool(32,{perOriginLimit:32,originSpacingMs:0}),providers=Array.from({length:16},(_,index)=>({name:`Provider ${index}`,url:`${base}/addon${index}`,types:['series']}));
 try{
  const lookups=Array.from({length:5},(_,index)=>createStreamLookup(`ep${index}`,{providers,pool,timeoutMs:1000}));
  const results=await Promise.all(lookups.map(lookup=>lookup.promise));
  assert.ok(maxActive<=32,`global peak ${maxActive}`);assert.ok(maxActive>8,`global peak only ${maxActive}`);
  for(let index=0;index<5;index++)assert.ok(maxByEpisode.get(`ep${index}`)<=8,`episode ep${index} peak ${maxByEpisode.get(`ep${index}`)}`);
  const initialWave=started.slice(0,32);for(let index=0;index<4;index++)assert.equal(initialWave.filter(episode=>episode===`ep${index}`).length,8,`initial request share for ep${index}`);
  assert.ok(results.every(result=>result.completed===16));assert.deepEqual(pool.snapshot(),{active:0,waiting:0,limit:32});
 }finally{await close(server);}
});

test('multiple episode lookups share a two-request origin limit',async()=>{
 let active=0,maxActive=0;const server=http.createServer((req,res)=>{active++;maxActive=Math.max(maxActive,active);setTimeout(()=>{active--;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({streams:[]}));},15);});
 const base=await listen(server),pool=new ProviderRequestPool(32,{perOriginLimit:2,originSpacingMs:0}),providers=Array.from({length:8},(_,index)=>({name:`Shared host ${index}`,url:`${base}/addon${index}`,types:['series']}));
 try{const results=await Promise.all(Array.from({length:4},(_,index)=>createStreamLookup(`ep${index}`,{providers,pool,timeoutMs:1000}).promise));assert.ok(maxActive<=2,`origin peak ${maxActive}`);assert.equal(results.reduce((sum,result)=>sum+result.completed,0),32);assert.deepEqual(pool.snapshot(),{active:0,waiting:0,limit:32});}
 finally{await close(server);}
});

test('429 cooldown on an add-on host suppresses queued sibling add-ons',async()=>{
 let requests=0;const server=http.createServer((_req,res)=>{requests++;res.writeHead(429,{'Retry-After':'30'});res.end('rate limited');});
 const base=await listen(server),providers=Array.from({length:4},(_,index)=>({name:`Rate limited ${index}`,url:`${base}/manifest${index}`,types:['series']})),history={};
 try{
  const result=await createStreamLookup('ep0',{providers,providerHistory:history,pool:new ProviderRequestPool(8,{perOriginLimit:1,originSpacingMs:0}),onProvider:record=>{if(record.category==='http_429')history[record.originId]={cooldownUntil:Date.now()+60000};}}).promise;
  assert.equal(requests,1);assert.equal(result.completed,1);assert.equal(result.providerCount,1);assert.equal(result.suppressedCount,3);assert.equal(result.diagnostics[0].retryAfterMs,30000);assert.match(result.diagnostics[0].originId,/^h-[a-f0-9]{24}$/);
 }finally{await close(server);}
});

test('provider history ranks responsive useful add-ons ahead of timed out ones',async()=>{
 const started=[];const server=http.createServer((req,res)=>{started.push(req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({streams:[]}));});
 const base=await listen(server),providers=[0,1,2].map(index=>({name:`P${index}`,url:`${base}/manifest${index}`,types:['series']}));
 const {providerIdentifier}=await import('../src/resolver.js');
 const history={
  [providerIdentifier(providers[0])]:{responsive:false,cooldownUntil:Date.now()+300000,usefulRate:8*1024*1024,expires:Date.now()+300000},
  [providerIdentifier(providers[1])]:{responsive:true,latencyMs:100,usefulRate:2*1024*1024,expires:Date.now()+300000},
 };
 try{await createStreamLookup('ep0',{providers,pool:new ProviderRequestPool(4),workersPerEpisode:1,providerHistory:history}).promise;assert.match(started[0],/manifest1/);}
 finally{await close(server);}
});

test('provider cooldown skips failing add-ons, expires, and reports a prompt all-cooling lookup',async()=>{
 const started=[];const server=http.createServer((req,res)=>{started.push(req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({streams:[]}));});
 const base=await listen(server),providers=[0,1].map(index=>({name:`Cooldown ${index}`,url:`${base}/manifest${index}`,types:['series']})),now=100000;
 const history={[providerIdentifier(providers[0])]:{responsive:false,cooldownUntil:now+300000,expires:now+1800000},[providerIdentifier(providers[1])]:{responsive:false,cooldownUntil:now+300000,expires:now+1800000}};
 try{
  const allCooling=await createStreamLookup('ep0',{providers,providerHistory:history,now,pool:new ProviderRequestPool(2)}).promise;
  assert.equal(allCooling.providerCount,0);assert.equal(allCooling.suppressedCount,2);assert.equal(allCooling.completed,0);assert.deepEqual(started,[]);
  const expired=await createStreamLookup('ep0',{providers,providerHistory:history,now:now+300001,pool:new ProviderRequestPool(2),workersPerEpisode:1}).promise;
  assert.equal(expired.providerCount,2);assert.equal(expired.suppressedCount,0);assert.equal(expired.completed,2);assert.equal(started.length,2);
 }finally{await close(server);}
});

test('source diagnostics rotate and discard URLs, names, credentials, and error text',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-diagnostics-'));
 try{
  const diagnostics=new SourceDiagnostics(dir,{maxBytes:220});
  for(let index=0;index<8;index++)diagnostics.record({event:'provider_response',time:100+index,job:'b'.repeat(32),providerId:'p-'+'a'.repeat(24),status:'timeout',category:'timeout',latencyMs:7000,resultCount:0,url:'https://private:token@example.test/addon?secret=key',name:'Private add-on',message:'token=secret'});
  const log=fs.readFileSync(path.join(dir,'source-diagnostics.jsonl'),'utf8');
  assert.ok(fs.existsSync(path.join(dir,'source-diagnostics.jsonl.1')));assert.ok(!log.includes('private'));assert.ok(!log.includes('secret'));assert.ok(!log.includes('example.test'));
  assert.ok(diagnostics.list().every(row=>!JSON.stringify(row).includes('url')));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('hourly source summaries aggregate safe outcomes, survive restart, and retain fourteen days',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-hourly-')),now=Date.now(),providerId='p-'+'c'.repeat(24),job='b'.repeat(32);
 try{
  const diagnostics=new SourceDiagnostics(dir);
  diagnostics.record({event:'provider_response',time:now,job,providerId,status:'timeout',category:'timeout',latencyMs:7000,resultCount:0,url:'https://token:private@example.test/addon'});
  diagnostics.record({event:'source_result',time:now+1000,job,providerId,status:'inconclusive',category:'no_verified_episode_bytes',verifiedBytes:0,bytes:1048576,rate:0,message:'private error text'});
  diagnostics.record({event:'source_result',time:now-15*24*60*60*1000,job,providerId,status:'failed',category:'metadata_timeout'});
  diagnostics.flush();
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'source-diagnostics-hourly.json'),'utf8'));
  assert.equal(saved.records.length,2);assert.ok(!JSON.stringify(saved).includes('private'));assert.ok(!JSON.stringify(saved).includes('example.test'));assert.ok(!JSON.stringify(saved).includes('url'));
  const restarted=new SourceDiagnostics(dir);const hourly=restarted.hourlySummary();assert.equal(hourly.length,2);assert.ok(hourly.some(row=>row.category==='no_verified_episode_bytes'&&row.bytes===1048576));assert.ok(hourly.every(row=>Date.now()-Date.parse(row.hour)<=14*24*60*60*1000));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
