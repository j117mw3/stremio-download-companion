import {selectEpisodes} from './selection.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import express from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { cfg } from './config.js';
import { Downloader } from './downloader.js';
import { parseId, getEpisodes, getStreams, parseStream } from './resolver.js';

const app = express();
const token = randomBytes(32).toString("hex");
app.use(express.json({limit:"64kb"}));
app.use((req,res,next)=>{if(req.method!=="GET" && (req.get("X-Companion-Token")!==token || (req.get("origin") && req.get("origin")!==`http://127.0.0.1:${cfg.port}`))) return res.sendStatus(403); next();});
const dl = new Downloader();
export {dl as downloader};
const base = `http://127.0.0.1:${cfg.port}`;
const preferences=dl.store.read('preferences');if(preferences?.downloadDir)cfg.downloadDir=preferences.downloadDir;

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

// ---- Stremio addon protocol ----
app.get('/manifest.json', (req, res) =>
  res.json({
    id: 'local.season.downloader',
    version: '0.4.4',
    name: 'Season Downloader',
    description: 'Choose an episode, a whole season, or multiple seasons to download.',
    resources: ['stream'],
    types: ['series', 'anime'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
  }),
);

app.get('/stream/:type/:id.json', (req, res) => {
  const id = encodeURIComponent(req.params.id);
  res.json({
    streams: [
      { name: 'Downloader', title: '⬇ Download this episode', externalUrl: `${base}/?scope=episode&id=${id}` },
      { name: 'Downloader', title: '⬇ Download entire series', externalUrl: `${base}/?scope=series&id=${id}` },
      { name: 'Downloader', title: '⬇ Download entire season', externalUrl: `${base}/?scope=season&id=${id}` },
    ],
  });
});

// ---- the "button": opened in the browser by Stremio, queues the job, then shows progress ----
const previews=new Map();
const showMetadata=new Map();
async function showData(id){if(typeof id!=='string'||!/^(tt\d+(:\d+:\d+)?|kitsu:\d+(:\d+)?)$/.test(id))throw Error('Invalid show');const parsed=parseId(id);let cached=showMetadata.get(parsed.series);if(!cached||cached.expires<Date.now()){const {name,episodes,anime}=await getEpisodes(parsed,'series',{includeSpecials:true});cached={data:{name,episodes,anime},expires:Date.now()+300000};for(const [key,value]of showMetadata)if(value.expires<Date.now())showMetadata.delete(key);showMetadata.set(parsed.series,cached);}return {...cached.data,parsed};}
app.get('/api/show',async(req,res)=>{try{res.json(await showData(req.query.id))}catch{res.status(502).json({error:'Could not load show metadata'})}});
app.get('/selection.js',(req,res)=>res.type('text/javascript').sendFile(fileURLToPath(new URL('./selection-ui.js',import.meta.url))));
app.post('/api/preview',async(req,res)=>{try{const data=await showData(req.body?.id);const episodes=selectEpisodes(data.episodes,req.body);if(!episodes.length)return res.status(400).json({error:'No released episodes selected'});const previewToken=randomBytes(24).toString('hex');for(const [key,value]of previews)if(value.expires<Date.now())previews.delete(key);previews.set(previewToken,{data,episodes,expires:Date.now()+300000});res.json({previewToken,count:episodes.length,episodes});}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/queue',(req,res)=>{if(dl.clearing)return res.status(409).json({error:'The queue is being cleared; try again shortly'});const{previewToken,resolution,fallbacks=[],english}=req.body;const preview=previews.get(previewToken);if(!preview||preview.expires<Date.now())return res.status(400).json({error:'Selection expired; please try again'});if(![480,720,1080,1440,2160].includes(resolution)||!Array.isArray(fallbacks)||fallbacks.some(n=>![480,720,1080,1440,2160].includes(n)||n>=resolution))return res.sendStatus(400);const{data,episodes}=preview;const added=dl.enqueue({kind:data.parsed.kind,series:data.parsed.series,seriesName:data.name,episodes,profile:{resolution,allowedResolutions:[resolution,...fallbacks],english:!!english||data.anime}});previews.delete(previewToken);res.json({added});});
app.get('/api/sources',async(req,res)=>{try{const job=dl.jobs.find(j=>j.id===req.query.id);if(!job)return res.sendStatus(404);const streams=await getStreams(job.id);res.json({sources:streams.map(raw=>{const source=parseStream(raw);return {key:createHash('sha256').update(JSON.stringify([raw.infoHash,raw.fileIdx,raw.url])).digest('hex'),title:source.title,providers:source.addonNames,resolution:source.res,english:source.dub,seeders:source.seeders}})});}catch{res.status(502).json({error:'Sources could not load'})}});
app.post('/api/source',(req,res)=>{try{const job=dl.jobs.find(j=>j.id===req.body.id);if(!job||!/^[a-f0-9]{64}$/.test(req.body.key))return res.sendStatus(400);if(dl.controllers.has(job.id))return res.status(409).json({error:'Pause the job before choosing a source'});job.sourceOverride=req.body.key;dl.control(job.id,'retry');res.json({ok:true})}catch{res.sendStatus(400)}});
app.post('/api/control',(req,res)=>{try{dl.control(req.body.id,req.body.action);res.json({ok:true})}catch(e){res.status(dl.clearing?409:400).json({error:e.message})}});
app.delete('/api/jobs',async(req,res)=>{try{res.json({removed:await dl.clearAll()})}catch(e){res.status(409).json({error:e.message})}});
app.delete('/api/jobs/:id',(req,res)=>{try{if(!dl.remove(req.params.id))return res.sendStatus(404);res.json({removed:1})}catch(e){res.status(dl.clearing?409:400).json({error:e.message})}});
app.get('/api/search',async(req,res)=>{try{const q=String(req.query.q||'').trim();if(q.length<2||q.length>120)return res.status(400).json({error:'Enter a show name'});const response=await fetch('https://v3-cinemeta.strem.io/catalog/series/top/search='+encodeURIComponent(q)+'.json',{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error();const data=await response.json();res.json({results:(data.metas||[]).map(m=>({id:m.id,name:m.name,year:m.releaseInfo,poster:m.poster}))});}catch{res.status(502).json({error:'Search is unavailable. Please try again.'})}});
app.post('/api/settings', (req,res)=>{const directory=req.body.downloadDir;if(typeof directory!=='string'||!path.isAbsolute(directory))return res.sendStatus(400);try{fs.mkdirSync(directory,{recursive:true});fs.accessSync(directory,fs.constants.W_OK);dl.store.write('preferences',{downloadDir:directory});cfg.downloadDir=directory;res.json({downloadDir:directory})}catch{res.status(400).json({error:'Folder is not writable'})}});
app.get('/api/settings',(req,res)=>res.json({downloadDir:cfg.downloadDir}));
app.get('/api/health',(req,res)=>res.json({app:'stremio-download-companion',version:'0.4.4',ready:true}));
app.get('/api/jobs', (req, res) => res.json(dl.jobs.map(job=>({...job,canRemove:!dl.controllers.has(job.id)}))));

app.get('/', (req, res) => res.set('Cache-Control','no-store').type('html').send(PAGE.replaceAll('__TOKEN__',token)));

export const ready = new Promise((resolve,reject)=>{
const server = app.listen(cfg.port, '127.0.0.1', () => {
  resolve(base);
  console.log(`Season Downloader running.`);
  console.log(`Install in Stremio: ${base}/manifest.json`);
  console.log(`Status page:        ${base}/`);
  console.log(`Saving to:          ${cfg.downloadDir}`);
});

server.once('error',reject);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await dl.shutdown();

    process.exit(0);
  });
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="companion-token" content="__TOKEN__"><title>Season Downloader</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{max-width:1160px;margin:0 auto;padding:24px;font:14px system-ui;background:#14141c;color:#e6e6ee}
h2{line-height:1.25}button,input,select{font:inherit;padding:9px;border:1px solid #47445d;border-radius:7px;background:#242233;color:#eee;max-width:100%}
button{cursor:pointer;background:#5741a0}button:disabled{opacity:.45;cursor:default}
#search{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:14px 0}
#search label{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#installAddon{margin:0 0 10px}#results{display:flex;gap:10px;flex-wrap:wrap}
#setup{display:grid;gap:12px;margin:0;padding:8px 0 18px}
#chosen{margin:8px 0 0;overflow-wrap:anywhere}
#modes{display:flex;gap:8px;flex-wrap:wrap;margin:0}
#modes button[aria-selected="true"]{background:#9375ef;border-color:#c8b7ff}
#selectionPanel,.settings{min-width:0;padding:16px;background:#1e1c2b;border:1px solid #2c293d;border-radius:12px}
#selectionPanel{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:10px;max-height:320px;overflow:auto}
#selectionPanel .selection-actions{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap}
#selectionPanel .selection-field{display:grid;grid-template-columns:minmax(72px,.35fr) minmax(0,1fr);gap:10px;align-items:center;min-width:0}
#selectionPanel select{width:100%;min-width:0}
#selectionPanel .season-choice{display:flex;gap:10px;align-items:center;min-width:0;min-height:42px;padding:8px 10px;border:1px solid #38344b;border-radius:7px;overflow-wrap:anywhere}
#selectionPanel .season-choice input{flex:0 0 auto;margin:0}
#selectionPanel .specials{grid-column:1/-1;border-top:2px solid #706186;margin-top:4px}
.settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px;align-items:center}
.settings label{display:flex;gap:8px;align-items:center;min-width:0;overflow-wrap:anywhere}
.settings select{min-width:0;max-width:100%}.settings input[type=checkbox]{flex:0 0 auto}
.destination-panel{min-width:0;padding:2px 0 8px}.destination-panel p{overflow-wrap:anywhere}
#summary{min-height:1.5em;margin:0;font-size:15px;font-weight:600}
#download{justify-self:start;min-width:190px}
#preview{max-height:45vh;overflow:auto}#preview button{max-width:100%;white-space:normal;overflow-wrap:anywhere;text-align:left}#message{min-height:1.3em;overflow-wrap:anywhere}
#t{max-width:100%;overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px}td,th{padding:6px 10px;border-bottom:1px solid #2a2a38;text-align:left}
.bar{background:#2a2a38;border-radius:4px;width:140px;height:10px}.bar i{display:block;height:10px;border-radius:4px;background:#7b5cff}
.queue-header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0 8px}.queue-actions{display:flex;gap:6px;flex-wrap:wrap}
.queue-actions button{padding:7px 10px}.queue-actions button[data-action="remove"]{background:#403348}
.failed{color:#ff6b6b}.done{color:#5be38a}
@media(max-width:520px){body{padding:16px}#selectionPanel,.settings{padding:12px}#selectionPanel{grid-template-columns:minmax(0,1fr)}.settings{grid-template-columns:minmax(0,1fr)}.settings label{align-items:flex-start}}
</style>
<h2>Stremio Download Companion</h2><form id="search"><label>Find a show <input id="query" placeholder="Modern Family" required minlength="2"></label><button>Search</button></form><button id="installAddon" type="button">Connect Stremio</button><div id="results"></div><form id="setup"><input id="media" type="hidden"><h2 id="chosen">Search for a show to begin</h2><nav id="modes" role="tablist" aria-label="Download mode"><button type="button" role="tab" id="tab-episode" aria-controls="selectionPanel" data-mode="episode">Episode</button><button type="button" role="tab" id="tab-season" aria-controls="selectionPanel" data-mode="season">Season</button><button type="button" role="tab" id="tab-series" aria-controls="selectionPanel" data-mode="series">Series</button></nav><section id="selectionPanel" role="tabpanel" aria-labelledby="tab-episode"></section><section class="settings" aria-label="Shared download settings"><label>Quality <select id="quality" required><option value="">Choose quality</option><option>2160</option><option>1440</option><option>1080</option><option>720</option><option>480</option></select></label><label>Fallback <select id="fallback"><option value="none">Same quality only</option><option value="720">Allow 720p</option><option value="480">Allow 720p and 480p</option></select></label><label title="English-labeled streams are preferred. When none are listed, downloaded audio is checked when the file has language metadata."><input type="checkbox" id="english">Prefer English audio</label></section><div class="destination-panel"><p id="destination"></p><button id="folder" type="button">Choose download folder</button> <button id="openFolder" type="button">Open folder</button> </div><p id="summary" role="status" aria-live="polite"></p><button id="download" type="submit" disabled>Download episode</button></form><div id="preview"></div><p id="message" role="status" aria-live="polite"></p><div id="t">Loading…</div>
<script>
document.getElementById('search').onsubmit=async e=>{e.preventDefault();const panel=document.getElementById('results');panel.textContent='Searching…';try{const r=await fetch('/api/search?q='+encodeURIComponent(document.getElementById('query').value));if(!r.ok)throw Error();const data=await r.json();panel.replaceChildren();for(const show of data.results){const b=document.createElement('button');b.type='button';b.textContent=show.name+' '+(show.year||'');b.onclick=()=>{window.loadShow(show.id,'series');panel.replaceChildren();};panel.append(b);}if(!data.results.length)panel.textContent='No shows found';}catch{panel.textContent='Search could not load. Try again.'}};
fetch('/api/settings').then(r=>r.json()).then(s=>document.getElementById('destination').textContent='Save to: '+s.downloadDir);
const api=async(url,body,method='POST')=>{const r=await fetch(url,{method,headers:{'Content-Type':'application/json','X-Companion-Token':'__TOKEN__'},body:JSON.stringify(body||{})});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Request failed');return data};
document.getElementById('folder').onclick=async()=>{if(!window.companion){document.getElementById('message').textContent='Folder selection is available in the desktop app';return;}const directory=await window.companion.chooseFolder();if(directory){const settings=await api('/api/settings',{downloadDir:directory});document.getElementById('destination').textContent='Save to: '+settings.downloadDir;}};
document.getElementById('openFolder').onclick=()=>window.companion?.openFolder();
document.getElementById('installAddon').onclick=async()=>{try{if(!window.companion){document.getElementById('message').textContent='In Stremio, open Addons → Add addon and paste http://127.0.0.1:7000/manifest.json';return;}const result=await window.companion.installAddon();document.getElementById('message').textContent='Addon address copied: '+result.manifest+'. If Stremio does not show Season Downloader, open Addons → Add addon and paste it. Keep http:// and :7000.';}catch{document.getElementById('message').textContent='Could not open Stremio. Add http://127.0.0.1:7000/manifest.json in its Addons page.';}};
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mb=b=>(b/1048576).toFixed(1)+' MB/s';
async function tick(){
 const jobs=await (await fetch('/api/jobs')).json();
 jobs.sort((a,b)=>a.seriesName.localeCompare(b.seriesName)||a.season-b.season||a.episode-b.episode);
 const countLabel=jobs.length===1?'1 episode queued':jobs.length+' episodes queued';
 document.getElementById('t').innerHTML = jobs.length ? '<div class="queue-header"><strong>'+countLabel+'</strong><button type="button" data-clear-queue>Remove all</button></div><table><tr><th>Episode</th><th>Status</th><th>Progress</th><th>Quality</th><th>Release / note</th></tr>'+ 
  jobs.map(j=>'<tr><td>'+escape(j.seriesName)+' S'+String(j.season).padStart(2,'0')+'E'+String(j.episode).padStart(2,'0')+'</td>'+ 
   '<td class="'+j.status+'">'+j.status+(j.status==='downloading'&&j.speed?' · '+mb(j.speed):'')+'</td>'+
   '<td><div class="bar"><i style="width:'+Math.round((j.progress||0)*100)+'%"></i></div></td>'+
   '<td>'+(j.quality||'')+(j.dub?' dub':'')+'</td><td class="'+(j.error?'failed':'')+'">'+escape(j.error||j.release||'')+(j.sourceProviders?.length?'<p>Stremio add-on: '+escape(j.sourceProviders.join(', '))+'</p>':'')+'<p>'+escape(j.stage||'')+' · '+(j.peers||0)+' peers</p><p>'+escape(j.verification?.audio||'')+'</p><p>'+escape(j.status==='done'?'':j.attempts?.at(-1)?'Previous '+j.attempts.at(-1).source+': '+j.attempts.at(-1).error:'')+'</p><div class="queue-actions">'+['pause','resume','cancel','retry','sources'].map(a=>'<button data-id="'+escape(encodeURIComponent(j.id))+'" data-action="'+a+'">'+a+'</button>').join('')+'<button data-id="'+escape(encodeURIComponent(j.id))+'" data-action="remove"'+(j.canRemove?'':' disabled title="Cancel and wait for this job to stop first"')+'>remove</button></div></td></tr>').join('')+'</table>' : 'Nothing queued yet.';
}
document.getElementById('t').onclick=async e=>{
 const message=document.getElementById('message');
 if(e.target.closest('[data-clear-queue]')){
  if(!window.confirm('Remove all queue entries? Active downloads will be cancelled.'))return;
  try{const result=await api('/api/jobs',{},'DELETE');message.textContent=result.removed+' queue entries removed';await tick();}
  catch(error){message.textContent=error.message||'Could not clear the queue';}
  return;
 }
 const b=e.target.closest('button[data-action]');if(!b)return;
 if(b.dataset.action==='sources'){
  const r=await fetch('/api/sources?id='+b.dataset.id);const data=await r.json();const panel=document.getElementById('preview');panel.replaceChildren();
  for(const source of data.sources){const button=document.createElement('button');const quality=source.resolution?source.resolution+'p':'Unknown quality';const seeders=Number.isInteger(source.seeders)?source.seeders+' seeders':'seed count unknown';const providers=source.providers?.length?' · '+source.providers.join(', '):'';button.textContent=quality+' · '+seeders+' · '+source.title+providers+(source.english?' · English audio label':'');button.onclick=async()=>{try{await api('/api/source',{id:decodeURIComponent(b.dataset.id),key:source.key});panel.replaceChildren();}catch{message.textContent='Pause the episode and wait for it to stop before changing source';}};panel.append(button,document.createElement('br'));}
  return;
 }
 try{
  if(b.dataset.action==='remove'){
   await api('/api/jobs/'+b.dataset.id,{},'DELETE');message.textContent='Queue entry removed';
  }else await api('/api/control',{id:decodeURIComponent(b.dataset.id),action:b.dataset.action});
  await tick();
 }catch(error){message.textContent=error.message||'Action could not complete; retry shortly';}
};tick();setInterval(tick,2000);
</script><script type="module" src="/selection.js"></script>`;
