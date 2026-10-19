import fs from 'node:fs';
export function ensureSpace(directory,required){if(!Number.isFinite(required)||required<=0)return;const disk=fs.statfsSync(directory,{bigint:true});const available=disk.bavail*disk.bsize;if(available<BigInt(Math.ceil(required))+64n*1024n*1024n){const e=new Error('Not enough free disk space; choose another folder or free space before resuming');e.code='ENOSPC';throw e;}}
