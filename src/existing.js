import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inspectMedia} from './media.js';
const run=promisify(execFile);
export const signature=s=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export async function fingerprint(file,signal){
  signal?.throwIfAborted();
  const before=signature(fs.statSync(file));const hash=createHash('sha256');
  for await(const bytes of fs.createReadStream(file,{signal})) hash.update(bytes);
  if(before!==signature(fs.statSync(file)))throw new Error('File changed during verification');
  return {hash:hash.digest('hex'),signature:before};
}
export async function verifyExisting(file,record,signal){
  const stamp=await fingerprint(file,signal);
  if(record?.hash===stamp.hash&&record?.version===1)return {...stamp,media:record.media,version:1};
  const candidates=[process.env.COMPANION_FFMPEG,process.resourcesPath&&path.join(process.resourcesPath,'ffmpeg.exe'),path.join(process.env.LOCALAPPDATA||'','Programs/Stremio/ffmpeg.exe')].filter(Boolean);
  const exe=candidates.find(p=>fs.existsSync(p));
  if(!exe)throw new Error('Cannot verify existing file: FFmpeg is unavailable');
  let media;
  try{
    media=await inspectMedia(file,{signal});
    const decoded=await run(exe,['-nostdin','-v','error','-xerror','-err_detect','explode','-i',file,'-map','0:v:0','-map','0:a?','-f','null','-'],{signal,windowsHide:true,maxBuffer:4*1024*1024});
    if(/premature|truncated|corrupt|error while decoding/i.test(decoded.stderr))throw new Error(decoded.stderr);
  }catch(error){
    signal?.throwIfAborted();
    const details=String(error.stderr||error.message);
    if(/Invalid data found|moov atom not found|corrupt|truncated|premature|Error while decoding|Invalid NAL|Invalid packet|no valid video/i.test(details)){
      const damaged=new Error('Existing video is damaged');damaged.code='CORRUPT_MEDIA';damaged.stamp=stamp;throw damaged;
    }
    throw new Error('Could not verify existing file: '+details.slice(0,500));
  }
  if(stamp.signature!==signature(fs.statSync(file)))throw new Error('File changed during verification');
  return {...stamp,media,version:1};
}
export function findExisting(dir,prefix,saved){
  // A disconnected output drive must not be mistaken for a missing episode.
  fs.accessSync(path.parse(path.resolve(dir)).root,fs.constants.R_OK);
  const found=new Set();
  if(saved){try{if(fs.statSync(saved).isFile())found.add(path.resolve(saved));}catch(e){if(e.code!=='ENOENT')throw e;}}
  let entries=[];try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const entry of entries)if(entry.isFile()&&entry.name.toLowerCase().startsWith(prefix.toLowerCase())&&/\.(mkv|mp4|avi|webm|mov|m4v|ts)$/i.test(entry.name))found.add(path.resolve(dir,entry.name));
  if(found.size>1)throw new Error('Multiple existing files match this episode; resolve duplicates before retrying');
  return [...found][0]||null;
}
