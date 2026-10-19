import fs from 'node:fs';import path from 'node:path';import snappy from 'snappyjs';
function variable(b,c){let n=0,shift=0;while(c.i<b.length){const x=b[c.i++];n+=(x&127)*2**shift;if(!(x&128))return n;shift+=7;if(shift>49)throw Error('Bad varint')}throw Error('Truncated')}
function entries(b){const count=b.readUInt32LE(b.length-4),end=b.length-4-count*4;let prev=Buffer.alloc(0),c={i:0},out=[];while(c.i<end){const shared=variable(b,c),size=variable(b,c),len=variable(b,c);const key=Buffer.concat([prev.subarray(0,shared),b.subarray(c.i,c.i+size)]);c.i+=size;out.push({key,value:b.subarray(c.i,c.i+len)});c.i+=len;prev=key}return out}
export function readTable(file){const b=fs.readFileSync(file);function block(offset,size){const data=b.subarray(offset,offset+size);return b[offset+size]===1?Buffer.from(snappy.uncompress(data)):data}const c={i:b.length-48};variable(b,c);variable(b,c);const off=variable(b,c),size=variable(b,c);return entries(block(off,size)).flatMap(e=>{const p={i:0};return entries(block(variable(e.value,p),variable(e.value,p)))})}
export function discover(){
const root=path.join(process.env.LOCALAPPDATA||'','Programs/Stremio/stremio-shell-ng.exe.WebView2/EBWebView/Default/Local Storage/leveldb');
if(!fs.existsSync(root))return [];let profile;let newest=-1n;
for(const f of fs.readdirSync(root).filter(x=>x.endsWith('.ldb')).sort())try{for(const e of readTable(path.join(root,f))){if(!e.key.toString('utf8').includes('profile'))continue;try{const p=JSON.parse(e.value.subarray(1).toString('utf16le'));const sequence=e.key.length>=8?e.key.readBigUInt64LE(e.key.length-8)>>8n:0n;if(Array.isArray(p.addons)&&sequence>newest){profile=p;newest=sequence;}}catch{}}}catch{}
for(const f of fs.readdirSync(root).filter(x=>x.endsWith('.log')))try{const b=fs.readFileSync(path.join(root,f));let fragments=[];
for(let offset=0;offset+7<=b.length;){const blockEnd=Math.min(b.length,(Math.floor(offset/32768)+1)*32768);if(offset+7>blockEnd){offset=blockEnd;continue;}const length=b.readUInt16LE(offset+4),type=b[offset+6];if(!length){offset=blockEnd;continue;}if(offset+7+length>blockEnd)break;const chunk=b.subarray(offset+7,offset+7+length);offset+=7+length;if(type===1)fragments=[chunk];else if(type===2)fragments=[chunk];else fragments.push(chunk);if(type!==1&&type!==4)continue;const record=Buffer.concat(fragments);fragments=[];if(record.length<12)continue;const sequence=record.readBigUInt64LE(0);const cursor={i:12};for(let n=0;n<record.readUInt32LE(8);n++){const tag=record[cursor.i++];const size=variable(record,cursor),key=record.subarray(cursor.i,cursor.i+size);cursor.i+=size;if(tag!==1)continue;const len=variable(record,cursor),value=record.subarray(cursor.i,cursor.i+len);cursor.i+=len;if(key.toString().includes('profile'))try{const p=JSON.parse(value.subarray(1).toString('utf16le'));if(Array.isArray(p.addons)&&sequence+BigInt(n)>newest){profile=p;newest=sequence+BigInt(n);}}catch{}}}
}catch{}
return (profile?.addons||[]).flatMap(a=>{
const resources=(a.manifest?.resources||[]).filter(r=>(typeof r==='string'?r:r.name)==='stream');
if(!resources.length)return [];
const types=[...new Set(resources.flatMap(r=>Array.isArray(r?.types)?r.types:(a.manifest?.types||[])))];
return [{name:a.manifest.name,url:a.transportUrl,types}];
}).filter(a=>{try{return new URL(a.url).protocol==='https:'}catch{return false}});
}
