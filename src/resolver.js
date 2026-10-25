import { discover } from './profile.js';
import { cfg } from './config.js';
import { createHash } from 'node:crypto';

const RES = [
  [/2160p|\b4k\b|\buhd\b/i, 2160],
  [/1440p/i, 1440],
  [/1080p/i, 1080],
  [/720p/i, 720],
  [/480p/i, 480],
];
const DUB = /\b(?:eng(?:lish)?[ ._-]*(?:dub(?:bed)?|audio)|dub(?:bed)?[ ._-]*eng(?:lish)?)\b/i;
const NON_ENGLISH_AUDIO = /\b(?:JPN|JAP|JAPANESE|KOR|KOREAN|CHN|CHINESE|GER|GERMAN|DEU|RUS|RUSSIAN|SPA|SPANISH|FRE|FRENCH|FRA|ITA|ITALIAN|POR|PORTUGUESE|HIN|HINDI|POL|POLISH|UKR|UKRAINIAN|NLD|DUTCH)\b/i;

async function getJson(url, signal, timeoutMs = 30000) {
  const timeout=AbortSignal.timeout(timeoutMs);
  const requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
  const r = await fetch(url, { headers: { 'User-Agent': 'stremio-season-downloader' }, signal: requestSignal });
  if (!r.ok) throw new Error(`Provider HTTP ${r.status}`);
  return r.json();
}

/** A fair process-wide request limit with a small per-origin burst budget. */
export class ProviderRequestPool {
  constructor(limit=32,{perOriginLimit=2,originSpacingMs=750,now=Date.now}={}){
    this.limit=limit;this.perOriginLimit=perOriginLimit;this.originSpacingMs=originSpacingMs;this.now=now;
    this.active=0;this.waiters=[];this.activeByOrigin=new Map();this.lastStartByOrigin=new Map();this.drainTimer=null;
  }
  acquire(signal,originId=''){
    signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const item={signal,originId,resolve,reject};
      item.abort=()=>{this.waiters=this.waiters.filter(waiter=>waiter!==item);reject(signal.reason||new Error('Provider lookup cancelled'));this.drain();};
      signal?.addEventListener('abort',item.abort,{once:true});
      this.waiters.push(item);this.drain();
    });
  }
  drain(){
    clearTimeout(this.drainTimer);this.drainTimer=null;
    while(this.active<this.limit&&this.waiters.length){
      const now=this.now();let selected=-1,nextReadyAt=Infinity;
      for(let index=0;index<this.waiters.length;index++){
        const item=this.waiters[index];
        if(item.signal?.aborted){this.waiters.splice(index--,1);item.signal.removeEventListener('abort',item.abort);item.reject(item.signal.reason||new Error('Provider lookup cancelled'));continue;}
        const activeForOrigin=this.activeByOrigin.get(item.originId)||0;
        if(item.originId&&activeForOrigin>=this.perOriginLimit)continue;
        const readyAt=item.originId?(this.lastStartByOrigin.get(item.originId)||-Infinity)+this.originSpacingMs:-Infinity;
        if(readyAt<=now){selected=index;break;}
        nextReadyAt=Math.min(nextReadyAt,readyAt);
      }
      if(selected<0){
        if(Number.isFinite(nextReadyAt)){this.drainTimer=setTimeout(()=>this.drain(),Math.max(1,nextReadyAt-this.now()));this.drainTimer.unref?.();}
        break;
      }
      const item=this.waiters.splice(selected,1)[0];item.signal?.removeEventListener('abort',item.abort);
      this.active++;if(item.originId){this.activeByOrigin.set(item.originId,(this.activeByOrigin.get(item.originId)||0)+1);this.lastStartByOrigin.set(item.originId,this.now());}
      let released=false;
      item.resolve(()=>{if(released)return;released=true;this.active--;if(item.originId){const active=(this.activeByOrigin.get(item.originId)||1)-1;if(active)this.activeByOrigin.set(item.originId,active);else this.activeByOrigin.delete(item.originId);}this.drain();});
    }
  }
  snapshot(){return {active:this.active,waiting:this.waiters.length,limit:this.limit};}
}

export const providerRequestPool=new ProviderRequestPool(32);
export const PROVIDER_TIMEOUT_MS=7000;
export const PROVIDER_WORKERS_PER_EPISODE=8;

export function providerIdentifier(addon){
  // Hash the endpoint, never expose an add-on URL in diagnostics or job state.
  return createProviderHash(addon.url);
}

export function providerOriginIdentifier(addon){
  try{return createProviderHash(new URL(addon.url).origin).replace(/^p-/,'h-');}
  catch{return createProviderHash('').replace(/^p-/,'h-');}
}

function createProviderHash(value){
  return `p-${createHash('sha256').update(String(value||'')).digest('hex').slice(0,24)}`;
}

function providerPriority(addon,history,now){
  const entry=history?.[providerIdentifier(addon)];if(!entry||entry.expires<=now)return 0;
  const cooling=!entry.responsive&&entry.cooldownUntil>now;
  const responsiveness=entry.responsive?4:cooling?-4:0;
  const latency=Math.max(0,Number(entry.latencyMs)||0);
  const speed=entry.responsive?Math.max(0,Number(entry.usefulRate)||0):0;
  return responsiveness-Math.min(3,latency/5000)+Math.min(4,Math.log2(1+speed/131072));
}

/** "tt0944947:1:2" -> imdb series, season 1, episode 2. "kitsu:1234:5" -> kitsu series, episode 5. */
export function parseId(id) {
  const p = id.split(':');
  if (p[0] === 'kitsu') {
    return { kind: 'kitsu', series: `kitsu:${p[1]}`, season: 1, episode: p[2] ? Number(p[2]) : null };
  }
  return { kind: 'imdb', series: p[0], season: Number(p[1]), episode: Number(p[2]) };
}

/** Returns { name, episodes: [{ id, season, episode }] } for one episode or a whole season. */
export async function getEpisodes(parsed, scope, { includeSpecials = false } = {}) {
  const url =
    parsed.kind === 'kitsu'
      ? `https://anime-kitsu.strem.fm/meta/series/${parsed.series}.json`
      : `https://v3-cinemeta.strem.io/meta/series/${parsed.series}.json`;
  const { meta } = await getJson(url);
  if (!meta || typeof meta !== 'object') throw new Error('Show metadata is unavailable');
  const now = Date.now();
  const all = (Array.isArray(meta.videos) ? meta.videos : [])
    .filter((v) => v && typeof v === 'object')
    .map((v) => {
      const season = Number(v.season ?? 1);
      const episode = Number(v.episode ?? v.number);
      const released = v.released == null || v.released === '' ? 0 :
        typeof v.released === 'number' ? v.released : Date.parse(v.released);
      return { id: v.id, title: v.title || '', season, episode, released };
    })
    .filter((v) => typeof v.id === 'string' && v.id.length > 0 &&
      Number.isInteger(v.season) && v.season >= 0 &&
      Number.isInteger(v.episode) && v.episode >= 0 &&
      Number.isFinite(v.released));

  let episodes;
  if (scope === 'episode') {
    episodes = all.filter((v) => v.season === parsed.season && v.episode === parsed.episode);
    episodes=episodes.filter(v=>(includeSpecials||v.season>0)&&(!v.released||v.released<=now));

  } else {
    episodes = all.filter((v) => (scope === 'series' || parsed.kind === 'kitsu' || v.season === parsed.season) && (includeSpecials || v.season > 0) && (!v.released || v.released <= now));
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return { name: meta.name || parsed.series, anime: parsed.kind === 'kitsu' || (meta.genres || []).some(g => /anime/i.test(g)), episodes };
}

function streamEndpoint(addon, epId) {
  const url=new URL(addon.url);
  const basePath=url.pathname.replace(/\/manifest\.json\/?$/,'').replace(/\/+$/,'');
  url.pathname=basePath+`/stream/series/${epId}.json`;
  return url.toString();
}

function streamProviders() {
  const addons=discover().filter(a=>Array.isArray(a.types)&&a.types.includes('series'));
  if(!addons.some(a=>a.name==='Torrentio'))addons.unshift({name:'Torrentio',url:cfg.torrentioUrl,types:['series']});
  const byUrl=new Map();
  for(const addon of addons){
    let existing=byUrl.get(addon.url);
    if(!existing){existing={url:addon.url,names:[]};byUrl.set(addon.url,existing);}
    if(addon.name&&!existing.names.includes(addon.name))existing.names.push(addon.name);
  }
  return [...byUrl.values()];
}

function mergeStreams(collected){
  const unique=new Map();
  for(const {stream,provider} of collected){
    const hash=/^[a-f0-9]{40}$/i.test(stream.infoHash||'')?stream.infoHash.toLowerCase():null;
    // A torrent hash is one release even if two add-ons return inconsistent
    // file indexes. In that case, let the downloader resolve the file by name.
    const key=/^https?:\/\//i.test(stream.url||'')?`url:${stream.url}`:hash?`btih:${hash}`:null;
    if(!key)continue;
    const previous=unique.get(key);
    if(!previous){unique.set(key,{...stream,addonNames:[...provider.names],providerIds:[provider.id]});continue;}
    previous.sources=[...new Set([...(Array.isArray(previous.sources)?previous.sources:[]),...(Array.isArray(stream.sources)?stream.sources:[])])];
    previous.addonNames=[...new Set([...(previous.addonNames||[]),...provider.names])];
    previous.providerIds=[...new Set([...(previous.providerIds||[]),provider.id])];
    if(Number.isInteger(previous.fileIdx)&&Number.isInteger(stream.fileIdx)&&previous.fileIdx!==stream.fileIdx)previous.fileIdx=null;
    if(!previous.behaviorHints?.filename&&stream.behaviorHints?.filename)previous.behaviorHints={...(previous.behaviorHints||{}),filename:stream.behaviorHints.filename};
    if(!previous.sources?.length&&stream.sources?.length)previous.sources=[...stream.sources];
  }
  return [...unique.values()];
}

/** Start an add-on lookup and publish each provider's results as they arrive.
 * The lookup retains the older all-results promise API through getStreams(). */
export function createStreamLookup(epId,{signal,onUpdate=()=>{},onProvider=()=>{},providerHistory={},providers:providedProviders,pool=providerRequestPool,timeoutMs=PROVIDER_TIMEOUT_MS,workersPerEpisode=PROVIDER_WORKERS_PER_EPISODE,now=Date.now}={}){
  const nowFn=typeof now==='function'?now:()=>now;
  const allProviders=(providedProviders||streamProviders()).map(addon=>({...addon,names:addon.names||[addon.name].filter(Boolean),id:addon.id||providerIdentifier(addon),originId:addon.originId||providerOriginIdentifier(addon)}));
  // Skip providers during their expiring backoff. If every provider is cooling
  // down this lookup returns promptly; a later retry after expiry probes them.
  const providers=allProviders.filter(provider=>(Number(providerHistory?.[provider.id]?.cooldownUntil)||0)<=nowFn()&&(Number(providerHistory?.[provider.originId]?.cooldownUntil)||0)<=nowFn())
    .sort((a,b)=>providerPriority(b,providerHistory,nowFn())-providerPriority(a,providerHistory,nowFn()));
  const collected=[],diagnostics=[],changeListeners=new Set();let cursor=0,completed=0,dynamicSuppressed=0,done=false;
  const snapshot=()=>({streams:mergeStreams(collected),diagnostics:diagnostics.map(item=>({...item})),completed,providerCount:providers.length-dynamicSuppressed,suppressedCount:allProviders.length-providers.length+dynamicSuppressed,elapsedMs:Math.max(0,nowFn()-started),done});
  const publish=()=>{try{onUpdate(snapshot());}catch{}for(const listener of [...changeListeners])listener();};
  const started=nowFn();
  const worker=async()=>{
    while(cursor<providers.length&&!signal?.aborted){
      const provider=providers[cursor++];
      if((Number(providerHistory?.[provider.id]?.cooldownUntil)||0)>nowFn()||(Number(providerHistory?.[provider.originId]?.cooldownUntil)||0)>nowFn()){
        dynamicSuppressed++;publish();continue;
      }
      let release=null,resultCount=0,status='network_error',category='network_error',latencyMs=0,retryAfterMs=0,requestStarted=0;
      try{
        release=await pool.acquire(signal,provider.originId);
        if((Number(providerHistory?.[provider.id]?.cooldownUntil)||0)>nowFn()||(Number(providerHistory?.[provider.originId]?.cooldownUntil)||0)>nowFn()){
          release();release=null;dynamicSuppressed++;publish();continue;
        }
        requestStarted=nowFn();
        const timeout=AbortSignal.timeout(timeoutMs);
        const requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
        const response=await fetch(streamEndpoint(provider,epId),{headers:{'User-Agent':'stremio-season-downloader'},signal:requestSignal});
        if(!response.ok){status='http_error';category=`http_${response.status}`;if(response.status===429){const value=response.headers.get('retry-after');const seconds=Number(value);const parsedDate=Date.parse(value||'');retryAfterMs=Number.isFinite(seconds)&&seconds>0?seconds*1000:Number.isFinite(parsedDate)?Math.max(0,parsedDate-nowFn()):0;}throw Object.assign(new Error(`Provider HTTP ${response.status}`),{providerCategory:category});}
        const payload=await response.json();
        if(!payload||!Array.isArray(payload.streams)){status='invalid_response';category='invalid_response';}
        else {
          const streams=payload.streams.filter(item=>item&&typeof item==='object');resultCount=streams.length;
          for(const stream of streams)collected.push({stream,provider});
          status=resultCount?'ok':'empty';category=status;
        }
      }catch(error){
        if(signal?.aborted)break;
        if(error?.name==='TimeoutError'||error?.name==='AbortError'||error?.cause?.name==='TimeoutError'){status='timeout';category='timeout';}
        else if(error?.providerCategory){status='http_error';category=error.providerCategory;}
        else if(status!=='invalid_response'){status='network_error';category='network_error';}
      }finally{latencyMs=requestStarted?Math.max(0,nowFn()-requestStarted):0;}
      if(signal?.aborted){release?.();break;}
      const result={providerId:provider.id,originId:provider.originId,status,category,latencyMs,resultCount,retryAfterMs};
      diagnostics.push(result);completed++;
      try{onProvider({...result});}catch{}finally{release?.();release=null;}
      publish();
    }
  };
  const promise=(async()=>{
    const workers=Array.from({length:Math.min(Math.max(1,workersPerEpisode),providers.length)},()=>worker());
    await Promise.all(workers);
    if(signal?.aborted)signal.throwIfAborted();
    done=true;publish();return snapshot();
  })();
  return {promise,snapshot,get done(){return done;},waitForChange(ms=100){return new Promise(resolve=>{let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);changeListeners.delete(finish);resolve(snapshot());};const timer=setTimeout(finish,ms);changeListeners.add(finish);});}};
}

/** Query installed Stremio add-ons. The callback is progressive; the returned
 * promise still resolves to the complete stream array for compatibility. */
export async function getStreams(epId,options={}) {
  const lookup=createStreamLookup(epId,options);
  const result=await lookup.promise;
  return result.streams;
}

export function effectiveDubMode(kind) {
  if (cfg.dubMode !== 'auto') return cfg.dubMode;
  return kind === 'kitsu' ? 'require' : 'prefer';
}

export function parseStream(s) {
  const text = `${s.name || ''}\n${s.title || ''}\n${s.behaviorHints?.filename || ''}`;
  let res = 0;
  for (const [re, v] of RES) {
    if (re.test(text)) {
      res = v;
      break;
    }
  }
  const trackers = (s.sources || []).filter((x) => x.startsWith('tracker:')).map((x) => x.slice(8));
  const seedersMatch = /👤\s*(\d+)/.exec(s.title || '');
  return {
    raw: s,
    title: (s.title || '').split('\n')[0],
    res,
    seeders: seedersMatch ? Number(seedersMatch[1]) : null,
    dub: DUB.test(text),
    nonEnglishAudio: NON_ENGLISH_AUDIO.test(text),
    infoHash: s.infoHash ? s.infoHash.toLowerCase() : null,
    fileIdx: Number.isInteger(s.fileIdx) ? s.fileIdx : null,
    url: s.url || null, // present when a debrid service returns a direct link
    filename: s.behaviorHints?.filename || null,
    trackers,
    addonNames: Array.isArray(s.addonNames) ? s.addonNames : [],
    providerIds: Array.isArray(s.providerIds) ? s.providerIds : [],
  };
}

/**
 * Pick the best stream: English-labeled audio first (unless mode is "off"), then highest resolution,
 * then direct links and sources with the most seeders; reuse a season torrent only to break ties.
 */
export function pickBest(streams, { mode, preferHashes = new Set(), maxResolution = 0, allowedResolutions, connectivityScore = () => 0 } = {}) {
  let list = streams.filter(s => /^[a-f0-9]{40}$/i.test(s.infoHash||'') || /^https?:\/\//i.test(s.url||'')).map(parseStream);
  // Providers often omit resolution labels (especially for older episode files
  // and season packs). Keep those candidates so media inspection can measure
  // the downloaded file; known out-of-profile resolutions are still rejected.
  if(allowedResolutions) list=list.filter(x=>!x.res || allowedResolutions.includes(x.res));
  if (mode === 'require') {
    // Stream listings often omit audio tags for native-language releases. Prefer
    // explicitly English-labeled streams, then let media inspection validate
    // untagged sources after download when no labeled source exists.
    const english = list.filter((x) => x.dub);
    if (english.length) list = english;
    else list = list.filter((x) => !x.nonEnglishAudio);
  }
  if (maxResolution) list = list.filter((x) => !x.res || x.res <= maxResolution);
  const dubW = (x) => (mode === 'off' ? 0 : x.dub ? 1 : 0);
  const prefW = (x) => (x.infoHash && preferHashes.has(x.infoHash) ? 1 : 0);
  list.sort(
    (a, b) =>
      dubW(b) - dubW(a) ||
      b.res - a.res ||
      connectivityScore(b) - connectivityScore(a) ||
      Number(!!b.url) - Number(!!a.url) ||
      (b.seeders || 0) - (a.seeders || 0) ||
      prefW(b) - prefW(a),
  );
  return list[0] || null;
}
