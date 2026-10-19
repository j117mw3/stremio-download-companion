export function failure(code,message,extra={}) {
  return Object.assign(new Error(message),{code,...extra});
}

// Only this manager owns priority-1 selections. WebTorrent's default priority-0
// whole-pack selection must be removed explicitly in 1.9.x.
export function prepareTorrent(entry) {
  if(entry.selections)return;
  const t=entry.torrent;
  if(t.pieces.length)t.deselect(0,t.pieces.length-1,0);
  entry.selections=new Map();
}

export function selectFile(entry,file) {
  prepareTorrent(entry);
  const key=file.path;
  let selected=entry.selections.get(key);
  if(!selected){
    const start=Math.floor(file.offset/entry.torrent.pieceLength);
    const end=Math.floor((file.offset+file.length-1)/entry.torrent.pieceLength);
    selected={refs:0,start,end};entry.selections.set(key,selected);
    if(file.length)entry.torrent.select(start,end,1);
  }
  selected.refs++;
  let released=false;
  return ()=>{
    if(released)return;released=true;
    if(--selected.refs)return;
    entry.selections.delete(key);
    if(file.length&&!entry.torrent.destroyed)entry.torrent.deselect(selected.start,selected.end,1);
  };
}

export class FileProgress {
  constructor(bytes,now){this.bytes=bytes;this.tick=now;this.lastProgress=now;}
  sample(bytes,now){
    const changed=bytes>this.bytes;
    const speed=changed?(bytes-this.bytes)*1000/Math.max(1,now-this.tick):0;
    if(changed)this.lastProgress=now;
    this.bytes=bytes;this.tick=now;
    return {speed,idleMs:now-this.lastProgress};
  }
}

export const RETRY_DELAYS=[5,15,60].map(minutes=>minutes*60000);
export const SOURCE_FAILURES=new Set(['METADATA_TIMEOUT','NO_USEFUL_PIECES','HTTP_FAILURE','HTTP_STALL','HTTP_INCOMPLETE','HTTP_RESUME','SOURCE_MEDIA','SOURCE_FILE','TORRENT_FAILURE','NO_SOURCES','PROVIDER_FAILURE','SOURCE_COOLDOWN']);
