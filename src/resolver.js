import { discover } from './profile.js';
import { cfg } from './config.js';

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

/** Query the same installed series-stream add-ons Stremio uses, with bounded
 * concurrency and short per-provider timeouts so dead add-ons cannot stall a queue. */
export async function getStreams(epId, { signal } = {}) {
  const providers=streamProviders();
  const collected=Array.from({length:providers.length},()=>[]);
  let cursor=0;
  const workers=Array.from({length:Math.min(16,providers.length)},async()=>{
    while(cursor<providers.length&&!signal?.aborted){
      const index=cursor++;
      const provider=providers[index];
      const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(7000)]):AbortSignal.timeout(7000);
      try{
        const {streams}=await getJson(streamEndpoint(provider,epId),requestSignal,7000);
        for(const stream of Array.isArray(streams)?streams:[]){
          if(!stream||typeof stream!=='object')continue;
          collected[index].push({...stream,addonNames:provider.names});
        }
      }catch(error){
        if(signal?.aborted)break;
        // Stremio profiles often contain retired or unrelated add-ons. A single
        // unavailable provider must not prevent usable results from other ones.
      }
    }
  });
  await Promise.all(workers);
  if(signal?.aborted)signal.throwIfAborted();

  // The same torrent is often exposed by Torrentio variants. Merge duplicate
  // tracker lists and provider names so retries do not revisit the same swarm.
  const unique=new Map();
  for(const stream of collected.flat()){
    const hash=/^[a-f0-9]{40}$/i.test(stream.infoHash||'')?stream.infoHash.toLowerCase():null;
    const index=Number.isInteger(stream.fileIdx)?stream.fileIdx:'unknown';
    const key=/^https?:\/\//i.test(stream.url||'')?`url:${stream.url}`:hash?`btih:${hash}:${index}`:`other:${stream.addonNames.join('|')}:${stream.title||stream.name||''}`;
    const previous=unique.get(key);
    if(!previous){unique.set(key,stream);continue;}
    previous.sources=[...new Set([...(Array.isArray(previous.sources)?previous.sources:[]),...(Array.isArray(stream.sources)?stream.sources:[])])];
    previous.addonNames=[...new Set([...(previous.addonNames||[]),...(stream.addonNames||[])])];
  }
  return [...unique.values()].filter(stream=>/^[a-f0-9]{40}$/i.test(stream.infoHash||'')||/^https?:\/\//i.test(stream.url||''));
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
  };
}

/**
 * Pick the best stream: English-labeled audio first (unless mode is "off"), then highest resolution,
 * then direct links and sources with the most seeders; reuse a season torrent only to break ties.
 */
export function pickBest(streams, { mode, preferHashes = new Set(), maxResolution = 0, allowedResolutions } = {}) {
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
      Number(!!b.url) - Number(!!a.url) ||
      (b.seeders || 0) - (a.seeders || 0) ||
      prefW(b) - prefW(a),
  );
  return list[0] || null;
}
