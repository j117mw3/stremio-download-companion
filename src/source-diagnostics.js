import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES=1024*1024;
const MAX_MEMORY_RECORDS=250;
const SAFE_STATUS=new Set(['ok','empty','timeout','http_error','network_error','invalid_response','verified','working','slow','inconclusive','failed']);

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
  if(typeof record.category==='string'&&/^(?:ok|empty|timeout|network_error|invalid_response|http_[1-5]\d\d|verified|no_useful_pieces|metadata_timeout|source_media|source_file|http_stall|test_inconclusive|provider_failure|no_sources|source_cooldown|torrent_failure|verification_failure|other)$/.test(record.category))safe.category=record.category;
  for(const key of ['latencyMs','resultCount','quality','verifiedBytes','bytes','rate']){const value=number(record[key]);if(value!==undefined)safe[key]=value;}
  return safe;
}

/** Small allow-listed JSONL log. URLs, provider names, credentials and error text
 * are deliberately not representable in its schema. */
export class SourceDiagnostics{
  constructor(directory,{maxBytes=MAX_LOG_BYTES}={}){
    this.file=path.join(directory,'source-diagnostics.jsonl');this.backup=this.file+'.1';this.maxBytes=maxBytes;this.records=[];
    try{const lines=fs.readFileSync(this.file,'utf8').trim().split(/\r?\n/).filter(Boolean);for(const line of lines.slice(-MAX_MEMORY_RECORDS)){try{const record=sanitize(JSON.parse(line));if(record)this.records.push(record);}catch{}}}catch{}
  }
  record(value){
    const entry=sanitize(value);if(!entry)return;
    this.records.push(entry);if(this.records.length>MAX_MEMORY_RECORDS)this.records.splice(0,this.records.length-MAX_MEMORY_RECORDS);
    try{
      fs.mkdirSync(path.dirname(this.file),{recursive:true});
      let size=0;try{size=fs.statSync(this.file).size;}catch{}
      if(size>=this.maxBytes){try{fs.rmSync(this.backup,{force:true});}catch{}try{fs.renameSync(this.file,this.backup);}catch{}}
      fs.appendFileSync(this.file,JSON.stringify(entry)+'\n',{encoding:'utf8'});
    }catch{}
  }
  list(limit=100){return this.records.slice(-Math.max(0,Math.min(250,Number(limit)||100))).map(entry=>({...entry}));}
}
