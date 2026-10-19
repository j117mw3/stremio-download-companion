import W from 'webtorrent';import fs from 'node:fs';import {Downloader}from'../src/downloader.js';import path from'node:path';import os from'node:os';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'companion-torrent-'));const seed=new W({dht:false,tracker:false,lsd:false});const receiver=new W({dht:false,tracker:false,lsd:false});let timer;
try{
 const source=await new Promise((resolve,reject)=>{seed.once('error',reject);seed.seed(path.resolve('test/fixture.mkv'),{announce:[]},resolve)});
 const target=receiver.add(source.torrentFile,{path:root});target.addPeer('127.0.0.1:'+seed.torrentPort);
 await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Local torrent timeout')),15000);target.once('done',resolve);target.once('error',reject)});clearTimeout(timer);
 const d=Object.create(Downloader.prototype);d.controllers=new Map([['fixture',new AbortController()]]);d.acquire=async()=>({torrent:target});d.release=()=>{};const job={id:'fixture',seriesName:'Fixture',title:'Episode',season:1,episode:1,profile:{english:true,resolution:480}};
 const file=await d.downloadTorrent(job,{infoHash:source.infoHash,fileIdx:0},root,'S01E01 - ');console.log({torrentTransfer:'passed',verification:job.verification,bytes:fs.statSync(file).size});
}finally{clearTimeout(timer);await Promise.all([new Promise(r=>seed.destroy(r)),new Promise(r=>receiver.destroy(r))]);fs.rmSync(root,{recursive:true,force:true})}

