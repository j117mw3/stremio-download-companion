import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import WebTorrent from 'webtorrent';
import {Downloader} from '../src/downloader.js';
import {cfg} from '../src/config.js';

test('local season torrent downloads selected episodes only; cancelling a sibling preserves the survivor', {timeout:25000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'season-selection-'));const original=cfg.downloadDir;cfg.downloadDir=root;
 const seed=new WebTorrent({dht:false,tracker:false,lsd:false});const receiver=new WebTorrent({dht:false,tracker:false,lsd:false});
 const d=Object.create(Downloader.prototype);d.torrents=new Map();d.controllers=new Map();d.getClient=async()=>receiver;d.inspectMedia=async()=>({resolution:720});
 const sourceDir=path.join(root,'pack');fs.mkdirSync(sourceDir);const out=path.join(root,'output');fs.mkdirSync(out);
 for(const [index,size] of [[1,98311],[2,98317],[3,2*1024*1024]])fs.writeFileSync(path.join(sourceDir,`Show.S01E0${index}.mkv`),randomBytes(size));
 try{
  const seeded=await new Promise((resolve,reject)=>{seed.once('error',reject);seed.seed(sourceDir,{pieceLength:16384,announce:[]},resolve);});
  const c={infoHash:seeded.infoHash};fs.mkdirSync(path.join(root,'.tmp'));fs.writeFileSync(path.join(root,'.tmp',c.infoHash+'.torrent'),seeded.torrentFile);
  const entry=await d.acquire(c);const torrent=entry.torrent;
  assert.equal(torrent._selections.length,0,'no default season-wide selection remains');
  const a={id:'a',seriesName:'Show',season:1,episode:1,title:'One'},b={id:'b',seriesName:'Show',season:1,episode:2,title:'Two'};
  d.controllers.set('a',new AbortController());d.controllers.set('b',new AbortController());
  const first=d.downloadTorrent(a,{...c,fileIdx:0},out,'S01E01 - ');const stopped=assert.rejects(first,/Stopped/);
  const second=d.downloadTorrent(b,{...c,fileIdx:1},out,'S01E02 - ');
  await new Promise(setImmediate);assert.equal(entry.selections.size,2);
  d.controllers.get('a').abort();await stopped;assert.equal(entry.selections.size,1);
  torrent.addPeer('127.0.0.1:'+seed.torrentPort);
  const downloaded=await second;assert.deepEqual(fs.readFileSync(downloaded),fs.readFileSync(path.join(sourceDir,'Show.S01E02.mkv')));
  assert.ok(torrent.files[0].downloaded<=torrent.pieceLength,'cancelled sibling gets at most its boundary piece');
  assert.ok(torrent.files[2].downloaded<=torrent.pieceLength,'unselected episode gets at most its boundary piece');
  assert.equal(entry.selections.size,0,'completion releases the active selection');
  d.controllers.set('a',new AbortController());const resumed=await d.downloadTorrent(a,{...c,fileIdx:0},out,'S01E01 - ');
  assert.deepEqual(fs.readFileSync(resumed),fs.readFileSync(path.join(sourceDir,'Show.S01E01.mkv')));
  assert.ok(torrent.files[2].downloaded<=torrent.pieceLength);d.release(c.infoHash);
 }finally{
  await Promise.all([new Promise(resolve=>seed.destroy(resolve)),new Promise(resolve=>receiver.destroy(resolve))]);
  cfg.downloadDir=original;fs.rmSync(root,{recursive:true,force:true});
 }
});
