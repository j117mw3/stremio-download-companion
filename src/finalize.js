import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {signature} from './existing.js';
export function finalize(source,destination,replacement){
 const staging=destination+'.'+randomUUID()+'.finalizing';
 const backup=replacement?.path+'.corrupt-backup';let moved=false;
 try{
  fs.copyFileSync(source,staging,fs.constants.COPYFILE_EXCL);
  if(replacement){
   if(signature(fs.statSync(replacement.path))!==replacement.signature)throw new Error('Existing file changed; retry verification');
   fs.linkSync(replacement.path,backup);
   fs.unlinkSync(replacement.path);moved=true;
  }
  try{fs.linkSync(staging,destination);}catch(error){
   if(moved){fs.linkSync(backup,replacement.path);fs.unlinkSync(backup);moved=false;}throw error;
  }
  if(moved)fs.unlinkSync(backup);
 }finally{try{fs.unlinkSync(staging);}catch{}}
 return destination;
}
