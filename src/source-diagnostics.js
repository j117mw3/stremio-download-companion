import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES=1024*1024;
const MAX_MEMORY_RECORDS=250;
const SAFE_STATUS=new Set(['ok','empty','timeout','http_error','network_error','invalid_response','verified','working','slow','inconclusive','failed']);
const SUMMARY_RETENTION_MS=14*24*60*60*1000;
const SAFE_CATEGORY=/^(?:ok|empty|timeout|network_error|invalid_response|http_[1-5]\d\d|http_failure|http_incomplete|http_resume|verified|no_useful_pieces|metadata_timeout|no_peers|no_verified_episode_bytes|http_payload_stall|http_stall|source_media|source_file|time_cap|traffic_cap|source_time_cap|source_traffic_cap|original_recovered|cancelled|test_inconclusive|provider_failure|no_sources|source_cooldown|torrent_failure|verification_failure|other)$/;

function number(value){return Number.isFinite(value)?Math.max(0,Math.round(value)):undefined;}

function sanitize(record){
  if(!record||typeof record!=='object')return null;
  const event=['provider_response','source_selected','source_result','source_verified'].includes(record.event)?record.event:null;
  if(!event)return null;
  const safe={time:number(record.time)||Date.now(),event};
  if(typeof record.job==='string'&&/^[a-f0-9]{16,64}$/i.test(record.job))safe.job=record.job;
  if(typeof record.providerId==='string'&&/^p-[a-f0-9]{24}$/i.test(record.providerId))safe.providerId=record.providerId;
  if(typeof record.releaseId==='string'&&/^[a-f0-9]{16,64}$/i.test(record.releaseId))safe.releaseId=record.releaseId;
  if(SAFE_STATUS.has(record.status))safe.status=record.status;
  if(typeof record.category==='string'&&SAFE_CATEGORY.test(record.category))safe.category=record.category;
  for(const key of ['latencyMs','resultCount','quality','verifiedBytes','bytes','rate']){const value=number(record[key]);if(value!==undefined)safe[key]=value;}
  return safe;
}

/** Small allow-listed JSONL log. URLs, provider names, credentials and error text
 * are deliberately not representable in its schema. */
export class SourceDiagnostics{
  constructor(directory,{maxBytes=MAX_LOG_BYTES}={}){
    this.directory=directory;this.file=path.join(directory,'source-diagnostics.jsonl');this.backup=this.file+'.1';this.hourlyFile=path.join(directory,'source-diagnostics-hourly.json');this.hourlyTemp=this.hourlyFile+'.tmp';this.maxBytes=maxBytes;this.records=[];this.hourly=new Map();this.pending=0;this.flushTimer=null;
    try{const lines=fs.readFileSync(this.file,'utf8').trim().split(/\r?\n/).filter(Boolean);for(const line of lines.slice(-MAX_MEMORY_RECORDS)){try{const record=sanitize(JSON.parse(line));if(record)this.records.push(record);}catch{}}}catch{}
    try{const saved=JSON.parse(fs.readFileSync(this.hourlyFile,'utf8'));if(saved?.version===1&&Array.isArray(saved.records))for(const row of saved.records){const clean=this.sanitizeSummary(row);if(clean)this.hourly.set(this.summaryKey(clean),clean);}}catch{}
    if(this.prune(Date.now()))this.flush();
  }
  summaryKey(row){return [row.hour,row.event,row.providerId||'none',row.status||'',row.category||''].join('\u001f');}
  sanitizeSummary(row){
    if(!row||typeof row!=='object'||typeof row.hour!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/.test(row.hour)||!Number.isFinite(Date.parse(row.hour)))return null;
    const event=['provider_response','source_selected','source_result','source_verified'].includes(row.event)?row.event:null;if(!event)return null;
    const providerId=typeof row.providerId==='string'&&/^p-[a-f0-9]{24}$/.test(row.providerId)?row.providerId:undefined;
    if(row.providerId!==undefined&&!providerId)return null;
    if(row.status!==undefined&&!SAFE_STATUS.has(row.status))return null;
    if(row.category!==undefined&&(typeof row.category!=='string'||!SAFE_CATEGORY.test(row.category)))return null;
    const clean={hour:row.hour,event,count:number(row.count)||0};if(providerId)clean.providerId=providerId;if(row.status)clean.status=row.status;if(row.category)clean.category=row.category;
    for(const field of ['latencyTotalMs','latencyCount','resultCount','bytes','verifiedBytes','rateTotal','rateCount','rateMax']){const value=number(row[field]);if(value!==undefined)clean[field]=value;}
    return clean;
  }
  prune(now){const oldest=now-SUMMARY_RETENTION_MS;let changed=false;for(const [key,row] of this.hourly)if(Date.parse(row.hour)<oldest){this.hourly.delete(key);changed=true;}return changed;}
  addSummary(entry){
    const date=new Date(entry.time),hour=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),date.getUTCHours())).toISOString();
    const row={hour,event:entry.event,providerId:entry.providerId,status:entry.status,category:entry.category},key=this.summaryKey(row),current=this.hourly.get(key)||{...row,count:0};
    current.count++;
    if(entry.latencyMs!==undefined){current.latencyTotalMs=(current.latencyTotalMs||0)+entry.latencyMs;current.latencyCount=(current.latencyCount||0)+1;}
    if(entry.resultCount!==undefined)current.resultCount=(current.resultCount||0)+entry.resultCount;
    for(const field of ['bytes','verifiedBytes'])if(entry[field]!==undefined)current[field]=(current[field]||0)+entry[field];
    if(entry.rate!==undefined){current.rateTotal=(current.rateTotal||0)+entry.rate;current.rateCount=(current.rateCount||0)+1;current.rateMax=Math.max(current.rateMax||0,entry.rate);}
    this.hourly.set(key,current);
  }
  flush(){
    clearTimeout(this.flushTimer);this.flushTimer=null;this.prune(Date.now());
    try{fs.mkdirSync(this.directory,{recursive:true});fs.writeFileSync(this.hourlyTemp,JSON.stringify({version:1,records:[...this.hourly.values()]}),{encoding:'utf8'});fs.renameSync(this.hourlyTemp,this.hourlyFile);this.pending=0;}catch{try{fs.rmSync(this.hourlyTemp,{force:true});}catch{}}
  }
  record(value){
    const entry=sanitize(value);if(!entry)return;
    this.records.push(entry);if(this.records.length>MAX_MEMORY_RECORDS)this.records.splice(0,this.records.length-MAX_MEMORY_RECORDS);
    this.addSummary(entry);this.prune(entry.time);this.pending++;
    try{
      fs.mkdirSync(path.dirname(this.file),{recursive:true});
      let size=0;try{size=fs.statSync(this.file).size;}catch{}
      if(size>=this.maxBytes){try{fs.rmSync(this.backup,{force:true});}catch{}try{fs.renameSync(this.file,this.backup);}catch{}}
      fs.appendFileSync(this.file,JSON.stringify(entry)+'\n',{encoding:'utf8'});
    }catch{}
    if(this.pending>=100)this.flush();
    else if(!this.flushTimer){this.flushTimer=setTimeout(()=>this.flush(),5000);this.flushTimer.unref?.();}
  }
  list(limit=100){return this.records.slice(-Math.max(0,Math.min(250,Number(limit)||100))).map(entry=>({...entry}));}
  hourlySummary(){if(this.prune(Date.now()))this.flush();return [...this.hourly.values()].map(row=>({...row})).sort((a,b)=>a.hour.localeCompare(b.hour));}
}
