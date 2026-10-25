import {ExtraBudget,ConnectivityEvidence,compareSources,verifiedFileBytes,probeSelection,TEST_LIMIT,testStopped,MAX_SOURCE_TURN_SOURCES,SOURCE_TURN_LIMIT_MS} from './source-testing.js';
import {failure, prepareTorrent, selectFile, FileProgress, RETRY_DELAYS, DEFERRED_RETRY_DELAYS, SOURCE_FAILURES} from './transfer-state.js';
import {findExisting, verifyExisting, fingerprint} from './existing.js';
import { finalize } from './finalize.js';
import { ensureSpace } from './disk.js';
import { inspectMedia } from './media.js';
import { Store } from './store.js';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import parseTorrent from 'parse-torrent';
import { cfg } from './config.js';
import { getStreams, pickBest, effectiveDubMode, parseStream } from './resolver.js';

const pad = (n) => String(n).padStart(2, '0');
const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim() || 'untitled';
const VIDEO_EXT = /\.(mkv|mp4|avi|webm|mov|m4v|ts)$/i;
const MIB=1024*1024;
const LOW_RATE=MIB*.25;

function readCachedTorrent(file, expectedHash) {
  try {
    const bytes=fs.readFileSync(file);
    const parsed=parseTorrent(bytes);
    if(parsed.infoHash?.toLowerCase()===expectedHash.toLowerCase()) return bytes;
  } catch {}
  try { fs.unlinkSync(file); } catch {}
  return null;
}

function cacheTorrent(file, torrent) {
  const bytes=torrent?.torrentFile;
  if(!Buffer.isBuffer(bytes)||!bytes.length||fs.existsSync(file)) return;
  const temp=`${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(temp,bytes,{flag:'wx'});
    try { fs.renameSync(temp,file); }
    catch(error) {
      try { fs.unlinkSync(temp); } catch {}
      if(!fs.existsSync(file)) throw error;
    }
  } catch {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function namesEpisode(text, job) {
  const value=String(text||'');
  let m=/(?:^|[^a-z0-9])s0*(\d{1,2})[ ._-]*e0*(\d{1,3})(?:[^0-9]|$)/i.exec(value);
  if(m)return Number(m[1])===job.season&&Number(m[2])===job.episode;
  m=/(?:^|\D)(\d{1,2})\s*[xÃƒâ€”]\s*(\d{1,3})(?:\D|$)/i.exec(value);
  if(m)return Number(m[1])===job.season&&Number(m[2])===job.episode;
  m=/season\s*0*(\d+).*?episode\s*0*(\d+)/i.exec(value);
  return !!m&&Number(m[1])===job.season&&Number(m[2])===job.episode;
}

function torrentEpisodeFile(torrent, choice, job) {
  if(Number.isInteger(choice.fileIdx))return torrent.files[choice.fileIdx]||null;
  const videos=torrent.files.filter(file=>VIDEO_EXT.test(file.path));
  if(choice.filename){
    const target=path.basename(choice.filename).toLowerCase();
    const exact=videos.filter(file=>path.basename(file.path).toLowerCase()===target);
    if(exact.length===1)return exact[0];
  }
  const tagged=videos.filter(file=>namesEpisode(file.path,job));
  if(tagged.length===1)return tagged[0];
  // Some Stremio add-ons return a single-episode torrent without fileIdx. Only
  // infer its sole video file when the provider's own label names this episode.
  if(videos.length===1&&namesEpisode(choice.title+' '+(choice.filename||''),job))return videos[0];
  return null;
}

export class Downloader {
  constructor() {
    this.stateFile = path.join(cfg.downloadDir, 'jobs.json');
    this.store = new Store(cfg.downloadDir);
    this.jobs = [];
    this.active = 0;
    this.running = new Set();
    this.controllers = new Map();
    this.stopping = false;
    this.clearing = false;
    this.queueSequence=0;
    this.client = null;
    this.torrents = new Map(); // infoHash -> { refs, promise, torrent, tmp }
    this.seasonHashes = new Map(); // series|season -> Set(infoHash) chosen so far
    this.saveTimer = null;
    this.cooldowns={};this.contexts=new Map();this.extraBudget=new ExtraBudget(2);this.sourceResults={};
    this.load();
  }

  load() {
    const cooldowns=this.store.read('sourceCooldowns');
    this.cooldowns=cooldowns&&!Array.isArray(cooldowns)&&typeof cooldowns==='object'?cooldowns:{};
    const results=this.store.read('sourceResults');this.sourceResults=results&&!Array.isArray(results)&&typeof results==='object'?results:{};
    for(const [key,result] of Object.entries(this.sourceResults))if(!Number.isFinite(result?.expires)||result.expires<=this.now())delete this.sourceResults[key];
    this.jobs=this.store.read('jobs');
    if(this.jobs===null){
      this.jobs=[];
      if(fs.existsSync(this.stateFile)){
        const legacy=JSON.parse(fs.readFileSync(this.stateFile,'utf8'));
        if(!Array.isArray(legacy))throw new Error('Legacy queue is not a valid job list');
        if(!fs.existsSync(this.stateFile+'.migration-backup'))fs.copyFileSync(this.stateFile,this.stateFile+'.migration-backup',fs.constants.COPYFILE_EXCL);
        this.jobs=legacy;for(const job of this.jobs)if(job.status==='done'){job.status='paused';job.error='Legacy completed file requires verification';}
      }
      this.store.write('jobs',this.jobs);
    }
    if(!Array.isArray(this.jobs))throw new Error('Saved queue is invalid; original database preserved');
    let migrated=false;
    for(const [index,job] of this.jobs.entries()){
      job.queueOrder=Number.isFinite(job.queueOrder)?job.queueOrder:index+1;this.queueSequence=Math.max(this.queueSequence,job.queueOrder);job.comparison=null;job.isProbe=false;
      if(job.sourceSearch?.phase==='searching')job.sourceSearch={...job.sourceSearch,phase:'interrupted'};
      if(job.status==='needs_attention'&&SOURCE_FAILURES.has(job.failureCode)){
        job.status='deferred';job.retryRound=Math.max(RETRY_DELAYS.length,Number(job.retryRound)||0);job.deferredRetryRound=0;
        job.nextRetryAt=this.now()+DEFERRED_RETRY_DELAYS[0];job.stage='Deferred retry scheduled';job.backgroundRetryActive=false;migrated=true;
      }
      if(job.status==='deferred'&&job.backgroundRetryActive){
        job.backgroundRetryActive=false;job.nextRetryAt=Math.min(Number.isFinite(job.nextRetryAt)?job.nextRetryAt:this.now(),this.now());job.stage='Deferred retry waiting for ready work';migrated=true;
      }
      if(['downloading','resolving','verifying'].includes(job.status)){
        if(job.backgroundRetryActive){job.status='deferred';job.backgroundRetryActive=false;job.nextRetryAt=Math.min(Number.isFinite(job.nextRetryAt)?job.nextRetryAt:this.now(),this.now());job.stage='Deferred retry waiting for ready work';}
        else job.status='queued';
        migrated=true;
      }
    }
    if(migrated)this.save();
    this.pump();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  saveNow() {
    fs.mkdirSync(cfg.downloadDir, { recursive: true });
    this.store.write('jobs',this.jobs);
    this.store.write('sourceCooldowns',this.cooldowns||{});
    this.store.write('sourceResults',this.sourceResults||{});
  }

  async getClient() {
    if (!this.client) { const {default:WebTorrent}=await import("webtorrent"); this.client = new WebTorrent(); }
    return this.client;
  }

  async streamsFor(id, signal) {
    return getStreams(id,{signal});
  }

  /** Queue episodes. Active entries are retained; completed files are rechecked before reuse. */
  enqueue({ kind, series, seriesName, episodes, profile = {} }) {
    if (this.clearing) throw new Error('The queue is being cleared; try again shortly');
    let added = 0;
    for (const ep of episodes) {
      const existing = this.jobs.find((j) => j.id === ep.id);
      if (existing && !['failed','done'].includes(existing.status)) continue;
      if (existing) this.jobs.splice(this.jobs.indexOf(existing), 1);
      this.jobs.push({
        id: ep.id,
        queueOrder: this.nextQueueOrder(),
        profile: {...profile,downloadDir:cfg.downloadDir},
        title: ep.title,
        kind,
        series,
        seriesName,
        season: ep.season,
        episode: ep.episode,
        status: 'queued',
        progress: 0,
        speed: 0,
        rollingSpeed: 0,
        slowSince: null,
        quality: null,
        release: null,
        error: null,
        file: existing?.file || null,
      });
      added++;
    }
    this.save();
    this.pump();
    return added;
  }

  now() { return Date.now(); }
  nextQueueOrder() { this.queueSequence=(this.queueSequence||0)+1;return this.queueSequence; }

  sourceKey(source) {
    return createHash('sha256').update(JSON.stringify([source.infoHash,source.fileIdx,source.url,source.filename])).digest('hex');
  }

  turnIdentity(source) {
    return source.infoHash?'torrent:'+String(source.infoHash).toLowerCase():'http:'+this.sourceKey(source);
  }

  historyKey(source) {
    if(source.infoHash)return createHash('sha256').update('torrent:'+String(source.infoHash).toLowerCase()).digest('hex');
    if(source.url){let host='';try{host=new URL(source.url).hostname.toLowerCase();}catch{}if(host)return createHash('sha256').update('host:'+host).digest('hex');}
    return this.sourceKey(source);
  }

  sourceResult(source) {
    const result=this.sourceResults?.[this.historyKey(source)];
    return result?.expires>this.now()?result:null;
  }

  recordSourceResult(job,source,outcome) {
    const key=this.historyKey(source),now=this.now();
    this.sourceResults||={};
    this.sourceResults[key]={...outcome,time:now,expires:now+15*60000,swarmKey:key,seriesKey:createHash('sha256').update(String(job.series)).digest('hex')};
    for(const [entry,value] of Object.entries(this.sourceResults))if(value.expires<now)delete this.sourceResults[entry];
    this.save();
  }

  available(job,source) {
    const cooldowns=this.cooldowns||{};
    return (!source.infoHash||!!source.url||(cooldowns['torrent:'+source.infoHash]||0)<=this.now()) &&
      (cooldowns[job.id+'|'+this.sourceKey(source)]||0)<=this.now();
  }

  connectivityScore(job,source) {
    const results=this.sourceResults||{},exact=this.sourceResult(source);
    if(exact?.status==='working')return exact.speed||0;
    if(exact?.status==='slow')return -Math.max(1,exact.speed||0);
    if(exact?.status==='failed')return -1;
    const swarmKey=this.historyKey(source);
    const seriesKey=createHash('sha256').update(String(job.series)).digest('hex');
    const positive=Object.values(results).filter(r=>r.expires>this.now()&&r.status==='working'&&r.swarmKey===swarmKey&&r.seriesKey===seriesKey);
    return positive.length?Math.max(...positive.map(r=>r.speed||0)):0;
  }

  activeEpisodeRates(exceptId) {
    return (this.jobs||[]).filter(job=>job.id!==exceptId&&this.controllers.has(job.id)&&job.status==='downloading').map(job=>Math.max(0,Number(job.rollingSpeed)||0));
  }

  slowThreshold(job) {
    const fastest=Math.max(0,...this.activeEpisodeRates(job.id));
    return Math.max(LOW_RATE,fastest*.25);
  }

  updateSlowState(job,now=this.now()) {
    const ownerId=job.ownerId||job.id,target=(this.jobs||[]).find(item=>item.id===ownerId)||job;
    target.speed=job.speed;target.rollingSpeed=job.rollingSpeed;
    const rate=Math.max(0,Number(target.rollingSpeed)||0),slow=rate<this.slowThreshold(target);
    if(slow){target.slowSince??=now;target.recoveredSince=null;}
    else {target.slowSince=null;target.recoveredSince??=now;}
  }

  slowComparisonDue(job) {
    return Number.isFinite(job.slowSince)&&this.now()-job.slowSince>=60000;
  }

  originalRecovered(job) {
    const rate=Math.max(0,Number(job.rollingSpeed)||0);
    if(rate<this.slowThreshold(job)){job.recoveredSince=null;return false;}
    job.recoveredSince??=this.now();
    return this.now()-job.recoveredSince>=5000;
  }

  hasReadyWork(exceptId) {
    return (this.jobs||[]).some(job=>job.id!==exceptId&&job.status==='queued'&&!this.controllers.has(job.id));
  }

  cool(job,source,error) {
    this.cooldowns||={};
    const key=error.code==='METADATA_TIMEOUT'?'torrent:'+source.infoHash:job.id+'|'+this.sourceKey(source);
    this.cooldowns[key]=this.now()+5*60000;
  }

  defer(job,error) {
    job.failureCode=error.code;job.error=error.message;job.speed=0;job.torrentSpeed=0;
    const round=job.retryRound||0;
    job.backgroundRetryActive=false;
    if(round>=RETRY_DELAYS.length){
      const deferredRound=Math.max(0,Number(job.deferredRetryRound)||0),delay=DEFERRED_RETRY_DELAYS[Math.min(deferredRound,DEFERRED_RETRY_DELAYS.length-1)];
      job.status='deferred';job.stage='Deferred retry scheduled';job.nextRetryAt=this.now()+delay;job.deferredRetryRound=deferredRound+1;
    }else {job.status='retry_wait';job.stage='Retry scheduled';job.nextRetryAt=this.now()+RETRY_DELAYS[round];job.retryRound=round+1;}
  }

  pump() {
    clearTimeout(this.retryTimer);
    if(this.stopping||this.clearing)return;
    const now=this.now();this.extraBudget||=new ExtraBudget(2);
    for(const job of this.jobs)if(job.status==='retry_wait'&&Number.isFinite(job.nextRetryAt)&&job.nextRetryAt<=now){job.status='queued';job.nextRetryAt=null;}
    const stalled=this.jobs.filter(j=>this.controllers.has(j.id)&&['downloading','resolving'].includes(j.status)&&now-(j.lastProgressAt??j.runStartedAt??now)>=30000);
    const canProbe=stalled.length>0&&!this.jobs.some(j=>j.isProbe&&this.controllers.has(j.id));
    const limit=cfg.concurrency+(canProbe?1:0);
    while (this.active < limit) {
      const queued=this.jobs.filter(j=>j.status==='queued'&&!this.controllers.has(j.id)).sort((a,b)=>(a.queueOrder??0)-(b.queueOrder??0));
      const probe=this.active>=cfg.concurrency;
      const activeDeferred=this.jobs.some(j=>j.backgroundRetryActive&&this.controllers.has(j.id));
      let job=(probe&&stalled.length?queued.find(j=>stalled.some(s=>s.series===j.series&&s.season===j.season)):null)||queued[0];
      let deferred=false;
      if(!job&&!probe&&this.active<cfg.concurrency&&!activeDeferred){
        job=this.jobs.filter(j=>j.status==='deferred'&&!this.controllers.has(j.id)&&Number.isFinite(j.nextRetryAt)&&j.nextRetryAt<=now).sort((a,b)=>(a.nextRetryAt-b.nextRetryAt)||(a.queueOrder-b.queueOrder))[0];
        deferred=!!job;
      }
      if (!job) break;
      const releaseExtra=probe?this.extraBudget.tryAcquire():null;
      if(probe&&!releaseExtra)break;
      job.isProbe=probe;
      if(deferred){job.backgroundRetryActive=true;job.nextRetryAt=null;job.stage='Deferred retry starting after ready work';}
      if(job.yieldedAt){job.yieldedAt=null;job.stage='Resuming after higher priority downloads';}
      this.active++;
      const task=this.run(job).finally(() => {
        releaseExtra?.();this.running.delete(task);this.active--;this.save();this.pump();
      });
      this.running.add(task);
    }
    const due=this.jobs.filter(j=>['retry_wait','deferred'].includes(j.status)&&Number.isFinite(j.nextRetryAt)&&j.nextRetryAt>now).map(j=>j.nextRetryAt);
    const activeNetwork=this.jobs.some(j=>this.controllers.has(j.id)&&['downloading','resolving'].includes(j.status));
    if(due.length||activeNetwork){this.retryTimer=setTimeout(()=>this.pump(),Math.max(1,Math.min(activeNetwork?1000:Infinity,...due.map(time=>time-this.now()))));this.retryTimer.unref?.();}
  }

  async run(job) {
    const controller = new AbortController(); this.controllers.set(job.id,controller);
    try {
      job.status = 'resolving';
      job.runStartedAt=this.now();job.lastProgressAt=null;job.idleSeconds=0;
      job.error = null;job.failureCode=null;job.speed=0;job.rollingSpeed=0;job.slowSince=null;job.recoveredSince=null;job.torrentSpeed=0;job.nextRetryAt=null;
      job.reused=false;job.replacement=null;
      const existingDir=path.join(job.profile?.downloadDir||cfg.downloadDir,safe(job.seriesName),`Season ${pad(job.season)}`);
      const existingPrefix=`${safe(job.seriesName)} - S${pad(job.season)}E${pad(job.episode)} - `;
      let entries=[];try{entries=fs.readdirSync(existingDir);}catch(e){if(e.code!=='ENOENT')throw e;}
      for(const name of entries.filter(n=>n.startsWith(existingPrefix)&&n.endsWith('.corrupt-backup'))){
        const backup=path.join(existingDir,name),original=backup.slice(0,-15);
        if(!fs.existsSync(original)){fs.linkSync(backup,original);fs.unlinkSync(backup);}
        else if(fs.statSync(original).ino===fs.statSync(backup).ino){fs.unlinkSync(backup);}
        else throw new Error('Replacement recovery copy preserved at '+backup+'; resolve it before retrying');
      }
      const existingFile=findExisting(existingDir,existingPrefix,job.file);
      if(existingFile){
        job.status='verifying';job.stage='Checking existing file';job.speed=0;this.save();
        const records=this.store?.read('verifiedFiles')||{};
        try{
          const checked=await (this.verifyExisting||verifyExisting)(existingFile,records[existingFile],controller.signal);
          records[existingFile]=checked;this.store?.write('verifiedFiles',records);
          job.file=existingFile;job.verification=checked.media;job.quality=checked.media.resolution+'p';
          job.reused=true;job.stage='Already downloaded — verified';job.status='done';job.progress=1;job.peers=0;return;
        }catch(e){
          if(e.code!=='CORRUPT_MEDIA')throw e;
          job.replacement={path:existingFile,...e.stamp};job.stage='Replacing damaged file';
        }
      }
      job.status='resolving';
      const mode = job.profile?.english ? "require" : job.profile ? "off" : effectiveDubMode(job.kind);
      const key = `${job.series}|${job.season}`;
      if (!this.seasonHashes.has(key)) this.seasonHashes.set(key, new Set());
      const hashes = this.seasonHashes.get(key);

      let streams;
      try{streams=await this.streamsFor(job.id,controller.signal);}catch(e){controller.signal.throwIfAborted();throw failure('PROVIDER_FAILURE',e.message);}
      const originalCount=streams.length;
      streams=streams.filter(raw=>this.available(job,parseStream(raw)));
      const choiceOptions = { mode, connectivityScore:source=>this.connectivityScore(job,source), preferHashes: hashes, allowedResolutions:job.profile?.allowedResolutions, maxResolution: job.profile?.resolution || cfg.maxResolution };
      const preferredSource = job.sourceOverride && streams.find(s => createHash('sha256').update(JSON.stringify([s.infoHash,s.fileIdx,s.url])).digest('hex')===job.sourceOverride);
      const attemptedSources=new Set();
      const sourceTurnStartedAt=this.now(),sourceTurnDeadline=sourceTurnStartedAt+SOURCE_TURN_LIMIT_MS;
      job.sourceSearch={startedAt:sourceTurnStartedAt,deadlineAt:sourceTurnDeadline,elapsedSeconds:0,limitSeconds:SOURCE_TURN_LIMIT_MS/1000,attempted:0,maxSources:MAX_SOURCE_TURN_SOURCES,phase:'searching'};
      const choose=sources=>{
        const untried=sources.filter(raw=>!attemptedSources.has(this.turnIdentity(parseStream(raw))));
        const fresh=untried.filter(raw=>!job.recentSources?.includes(this.sourceKey(parseStream(raw))));
        return pickBest(fresh,choiceOptions)||pickBest(untried,choiceOptions);
      };
      let choice = preferredSource&&!job.recentSources?.includes(this.sourceKey(parseStream(preferredSource))) ? pickBest([preferredSource], choiceOptions) : null;
      if (!choice) choice = choose(streams);
      if (!choice) throw failure(originalCount&&!streams.length?'SOURCE_COOLDOWN':'NO_SOURCES',originalCount&&!streams.length?'Sources are cooling down':mode==='require'?'No English dub found':'No streams found');

      job.quality = choice.res ? `${choice.res}p` : '?';
      job.release = choice.title;
      job.sourceProviders = choice.addonNames || [];
      job.dub = choice.dub;
      job.status = 'downloading';
      this.save();

      const dir = path.join(job.profile?.downloadDir||cfg.downloadDir, safe(job.seriesName), `Season ${pad(job.season)}`);
      fs.mkdirSync(dir, { recursive: true });
      const prefix = `S${pad(job.season)}E${pad(job.episode)} - `;

      job.attempts ||= [];
      let completedThisTurn=false,sourceTurnFailure=null;
      while(choice) {
        controller.signal.throwIfAborted();
        if(this.now()>=sourceTurnDeadline||attemptedSources.size>=MAX_SOURCE_TURN_SOURCES)break;
        const identity=this.turnIdentity(choice);
        attemptedSources.add(identity);
        job.sourceSearch.attempted=attemptedSources.size;job.sourceSearch.elapsedSeconds=Math.floor((this.now()-sourceTurnStartedAt)/1000);
        job.speed=0;job.torrentSpeed=0;job.progress=0;
        job.release=choice.title;job.sourceProviders=choice.addonNames||[];job.quality=choice.res?`${choice.res}p`:'?';
        try {
          job.file=await this.downloadWithComparison(job,choice,streams,choiceOptions,dir,prefix,attemptedSources,sourceTurnDeadline);
          completedThisTurn=true;
          break;
        }catch(e){
          sourceTurnFailure=e;
          if(e.sourceChoice)choice=e.sourceChoice;
          if(controller.signal.aborted||!SOURCE_FAILURES.has(e.code))throw e;
          if(!job.sourceSearch.lastCode||job.sourceSearch.lastCode!==e.code)job.sourceSearch.lastCode=e.code;
          this.cool(job,choice,e);
          job.recentSources=[...(job.recentSources||[]).filter(key=>key!==this.sourceKey(choice)),this.sourceKey(choice)].slice(-100);
          job.attempts.push({source:choice.title,providers:choice.addonNames||[],attempt:1,code:e.code,error:e.message,time:this.now()});
          job.attempts=job.attempts.slice(-100);this.save();
          streams=streams.filter(raw=>this.turnIdentity(parseStream(raw))!==identity&&this.available(job,parseStream(raw)));
          const next=choose(streams);
          if(!next||this.now()>=sourceTurnDeadline||(!attemptedSources.has(this.turnIdentity(next))&&attemptedSources.size>=MAX_SOURCE_TURN_SOURCES))throw e;
          choice=next;job.fallbackReason='Previous source failed';job.stage='Trying another source';job.sourceSearch.phase='searching';
        }
      }
      if(!completedThisTurn)throw sourceTurnFailure||failure('NO_USEFUL_PIECES','Source search reached its 60-second limit without verified episode data');
      if(job.verification?.resolution)job.quality=job.verification.resolution+'p';
      job.retryRound=0;job.deferredRetryRound=0;job.backgroundRetryActive=false;job.failureCode=null;job.nextRetryAt=null;job.torrentSpeed=0;
      job.stage='Complete';
      job.status = 'done';
      job.progress = 1;
      job.speed = 0;
      if(job.sourceSearch)job.sourceSearch.phase='complete';
    } catch (e) {
      if(e.code==='YIELD_TRANSFER'&&!controller.signal.aborted){job.status='queued';job.backgroundRetryActive=false;job.yieldedAt=this.now();job.queueOrder=this.nextQueueOrder();job.stage='Waiting behind other downloads';job.error=null;job.failureCode=null;job.speed=0;}
      else if (!['paused','cancelled','queued'].includes(job.status)){
        if(!controller.signal.aborted&&SOURCE_FAILURES.has(e.code))this.defer(job,e);
        else {job.status=e.code==='ENOSPC'?'paused':'failed';job.failureCode=e.code||'LOCAL_FAILURE';}
      }
      if(job.sourceSearch){job.sourceSearch.phase=job.status==='queued'?'yielded':job.status==='retry_wait'||job.status==='deferred'?'retry_scheduled':job.status==='paused'||job.status==='cancelled'?'stopped':'failed';job.sourceSearch.elapsedSeconds=Math.floor((this.now()-job.sourceSearch.startedAt)/1000);}
      if(controller.signal.aborted&&['paused','cancelled'].includes(job.status))job.backgroundRetryActive=false;
      job.error = e.code==='YIELD_TRANSFER'||controller.signal.aborted ? null : e.message;
      job.speed = 0;
    } finally {if(job.sourceSearch){if(job.sourceSearch.phase==='searching')job.sourceSearch.phase=job.status==='done'?'complete':'ended';job.sourceSearch.elapsedSeconds=Math.floor((this.now()-job.sourceSearch.startedAt)/1000);}job.speed=0;job.torrentSpeed=0;job.isProbe=false;job.comparison=null;job.backgroundRetryActive=false;this.controllers.delete(job.id);}
  }

  startAttempt(parent,choice,probe,ownerSignal,dir,prefix) {
    this.contexts||=new Map();
    const id=parent.id+'#'+this.sourceKey(choice)+'#'+Math.random().toString(16).slice(2);
    const controller=new AbortController();
    const signal=AbortSignal.any([ownerSignal,controller.signal]);
    const job={...parent,id,ownerId:parent.ownerId||parent.id,comparison:null,progress:0,speed:0,rollingSpeed:0,lastProgressAt:null,sourceWaitStartedAt:this.now(),waitLimitSeconds:45,metadataWaitStartedAt:null,sourceResponseAt:null,dataStartedAt:null};
    this.controllers.set(id,{signal,abort:()=>controller.abort()});
    let adopt;
    const adoption=new Promise(resolve=>adopt=resolve);
    const attempt={job,choice,probe,started:this.now(),evidence:new ConnectivityEvidence(this.now()),cancel:()=>controller.abort(testStopped('Source test cancelled'))};
    const context={attempt,signal,adopted:!probe,bytes:0,previous:0,baseline:0,verifiedBaseline:0,started:this.now()};
    let connectTimer,totalTimer;
    context.ready=()=>{attempt.evidence.ready=true;attempt.job.sourceResponseAt=this.now();attempt.job.dataStartedAt=this.now();attempt.job.metadataWaitStartedAt=null;clearTimeout(connectTimer);};
    context.observe=(bytes,verified=0,complete=false,video=false)=>{
      context.bytes+=Math.max(0,bytes-context.previous);context.previous=bytes;
      attempt.evidence.update(context.bytes,Math.max(0,verified-context.verifiedBaseline),this.now(),{complete,video});
      if(probe&&!context.adopted&&context.bytes>=TEST_LIMIT){context.capped=true;attempt.evidence.cappedAt??=this.now();if(!attempt.evidence.qualifies(!!choice.infoHash))controller.abort(testStopped('Source test reached its traffic limit'));}
    };
    context.beforeFinalize=async()=>{
      if(context.adopted)return;
      await new Promise((resolve,reject)=>{
        const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
        if(signal.aborted)return abort();
        signal.addEventListener('abort',abort,{once:true});adoption.then(()=>{signal.removeEventListener('abort',abort);resolve();});
      });
      signal.throwIfAborted();
    };
    attempt.promote=()=>{attempt.probe=false;context.adopted=true;clearTimeout(connectTimer);clearTimeout(totalTimer);adopt();};
    if(probe){connectTimer=setTimeout(()=>controller.abort(testStopped('Source test connection deadline reached')),15000);totalTimer=setTimeout(()=>controller.abort(testStopped('Source test time limit reached')),30000);}
    this.contexts.set(id,context);
    attempt.promise=(choice.url?this.downloadHttp(job,choice,dir,prefix):this.downloadTorrent(job,choice,dir,prefix)).finally(()=>{clearTimeout(connectTimer);clearTimeout(totalTimer);this.controllers.delete(id);this.contexts.delete(id);});
    return attempt;
  }

  async downloadWithComparison(job,choice,streams,options,dir,prefix,attemptedSources=new Set(),sourceTurnDeadline=null) {
    this.extraBudget||=new ExtraBudget(2);this.sourceResults||={};
    const candidates=[];const seen=new Set([choice.url?'url:'+choice.url:'torrent:'+choice.infoHash]);
    let remaining=streams.filter(raw=>this.available(job,parseStream(raw)));
    const candidateLimit=Math.min(MAX_SOURCE_TURN_SOURCES-1,Math.max(0,MAX_SOURCE_TURN_SOURCES-attemptedSources.size));
    const resolutions=[...new Set(remaining.map(raw=>parseStream(raw).res).filter(Boolean))];
    const requested=Number(job.profile?.resolution)||0;
    resolutions.sort((a,b)=>Number(b===requested)-Number(a===requested)||b-a);
    for(const resolution of resolutions){
      let tier=remaining.filter(raw=>parseStream(raw).res===resolution);
      while(tier.length&&candidates.length<candidateLimit){
        const selected=pickBest(tier,options);if(!selected)break;
        tier=tier.filter(raw=>raw!==selected.raw);remaining=remaining.filter(raw=>raw!==selected.raw);
        const identity=selected.url?'url:'+selected.url:'torrent:'+selected.infoHash;
        if(seen.has(identity)||attemptedSources.has(this.turnIdentity(selected)))continue;seen.add(identity);candidates.push(selected);
      }
      if(candidates.length>=candidateLimit)break;
    }
    const signal=this.controllers.get(job.id).signal;
    const sync=attempt=>{
      for(const key of ['progress','speed','rollingSpeed','torrentSpeed','peers','downloadedBytes','idleSeconds','lastProgressAt','stage','totalBytes','sourceWaitStartedAt','waitLimitSeconds','metadataWaitStartedAt','sourceResponseAt','dataStartedAt'])job[key]=attempt.job[key];
      if(job.sourceSearch?.phase==='searching'&&attempt.job.lastProgressAt)job.sourceSearch.phase='transferring';
    };
    const tested=[];
    const result=await compareSources({signal,primary:choice,candidates,budget:this.extraBudget,now:()=>this.now(),
      start:(source,probe,owner)=>{
        if(probe){attemptedSources.add(this.turnIdentity(source));if(job.sourceSearch){job.sourceSearch.attempted=attemptedSources.size;job.sourceSearch.elapsedSeconds=Math.floor((this.now()-job.sourceSearch.startedAt)/1000);}}
        const attempt=this.startAttempt(job,source,probe,owner,dir,prefix);
        if(probe)tested.push(attempt);
        return attempt;
      },
      onView:(phase,attempt,comparisonMode)=>{
        if(!attempt.probe)sync(attempt);
        if(phase==='testing'&&comparisonMode==='idle'&&job.sourceSearch)job.sourceSearch.phase='searching';
        if(job.sourceSearch){job.sourceSearch.elapsedSeconds=Math.floor((this.now()-job.sourceSearch.startedAt)/1000);job.sourceSearch.attempted=attemptedSources.size;}
        const comparisonLimit=comparisonMode==='slow'||sourceTurnDeadline===null?30:Math.max(0,Math.ceil((sourceTurnDeadline-(tested[0]?.started||this.now()))/1000));
        job.comparison=phase==='testing'?{status:'testing',startedAt:tested[0]?.started||this.now(),elapsedSeconds:Math.floor((this.now()-(tested[0]?.started||this.now()))/1000),limitSeconds:comparisonLimit,primaryRate:job.rollingSpeed||0,candidates:tested.map(test=>({key:this.sourceKey(test.choice),bytes:test.evidence.bytes,verifiedBytes:test.evidence.verified,ready:test.evidence.ready,elapsedSeconds:Math.floor((this.now()-test.started)/1000),limitSeconds:30,rate:test.evidence.score(this.now()),score:test.evidence.score(this.now())}))}:null;
        if(phase==='testing')job.stage='Checking for a faster source';
        if(phase==='switching'){job.release=attempt.choice.title;job.sourceProviders=attempt.choice.addonNames||[];job.quality=attempt.choice.res?attempt.choice.res+'p':'?';job.stage='Switching to a verified working source';job.switchNote='Different release selected; percentage reflects this release. Previous partial download retained.';}
      },
      onResult:(source,outcome)=>{
        this.recordSourceResult(job,source,outcome);
      },
      shouldCompare:()=>this.slowComparisonDue(job),
      isRecovered:()=>this.originalRecovered(job),
      shouldYield:()=>this.hasReadyWork(job.id),
      shouldSwitch:({currentRate,candidateRate})=>candidateRate>=currentRate*2&&candidateRate-currentRate>=LOW_RATE,
      sourceTurnDeadline
    });
    if(result.yielded)throw failure('YIELD_TRANSFER','Waiting behind other downloads');
    Object.assign(job,{verification:result.attempt.job.verification,release:result.attempt.choice.title,sourceProviders:result.attempt.choice.addonNames||[],quality:result.attempt.choice.res?result.attempt.choice.res+'p':'?',comparison:null});
    job.replacement=result.attempt.job.replacement;
    const evidence=result.attempt.evidence;
    const usefulBytes=result.attempt.choice.infoHash?evidence.verified:evidence.video?evidence.bytes:0;
    const usefulRate=evidence.score(this.now());
    if(usefulBytes>0&&usefulRate>0)this.recordSourceResult(job,result.attempt.choice,{status:'working',verifiedDownload:true,bytes:evidence.bytes,verifiedBytes:evidence.verified,speed:usefulRate,completedAt:this.now()});
    if(result.attempt.choice.infoHash){const seasonKey=`${job.series}|${job.season}`;this.seasonHashes.get(seasonKey)?.add(result.attempt.choice.infoHash);}
    return result.file;
  }

  async checkMedia(file,options) {
    return (this.inspectMedia||inspectMedia)(file,options);
  }

  async finishFile(job,source,destination) {
    const signal=this.controllers.get(job.id)?.signal;
    if(job.replacement){
      job.stage='Verifying replacement';
      let checked;try{checked=await (this.verifyExisting||verifyExisting)(source,null,signal);}catch(e){if(e.code==='CORRUPT_MEDIA')throw failure('SOURCE_MEDIA','Replacement video failed verification');throw e;}
      const current=await fingerprint(job.replacement.path,signal);
      if(current.hash!==job.replacement.hash)throw new Error('Existing file changed; retry verification');
      signal?.throwIfAborted();
      finalize(source,destination,{...job.replacement,signature:current.signature});
      const records=this.store?.read('verifiedFiles')||{};
      delete records[job.replacement.path];records[destination]=checked;this.store?.write('verifiedFiles',records);
      job.replacement=null;
    }else{signal?.throwIfAborted();finalize(source,destination);}
  }

  // ---- direct (debrid) links, resumable via HTTP Range ----
  async downloadHttp(job, c, dir, prefix) {
    const name = c.filename || decodeURIComponent(path.basename(new URL(c.url).pathname)) || 'video.mkv';
    const dest = path.join(dir, safe(job.seriesName||'Series')+' - '+prefix+safe(job.title||'Episode')+(path.extname(name)||'.mkv'));
    const identity=createHash("sha256").update(c.url).digest("hex").slice(0,16);
    const part = `${dest}.${identity}.part`;
    const metaPath=part+".json";
    let meta={};try{meta=JSON.parse(fs.readFileSync(metaPath))}catch{}
    let start = 0;
    try {
      start = fs.statSync(part).size;
    } catch {
      /* fresh download */
    }
    if(!meta.validator) start=0;
    const idle=new AbortController();let idleTimer;const resetIdle=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>idle.abort(failure('HTTP_STALL','HTTP transfer stalled')),90000);idleTimer.unref();};resetIdle();
    const signal=AbortSignal.any([this.controllers.get(job.id).signal,idle.signal]);
    job.stage='Downloading video';
    let speedTimer;
    try {
    let res;try{res = await fetch(c.url, {signal, headers:{...c.raw.behaviorHints?.proxyHeaders?.request,...(start?{Range:'bytes='+start+'-','If-Range':meta.validator}:{})},redirect:'follow'});}catch(e){if(this.controllers.get(job.id)?.signal.aborted)throw this.controllers.get(job.id).signal.reason;if(idle.signal.aborted)throw idle.signal.reason;throw failure('HTTP_FAILURE','HTTP connection failed');}
    if (!res.ok && res.status !== 206){await res.body?.cancel();throw failure('HTTP_FAILURE',`HTTP ${res.status}`,{status:res.status});}
    const context=this.contexts?.get(job.id);context?.ready();
    const resumed = res.status === 206;
    if(resumed && (!start || !res.headers.get("content-range")?.startsWith(`bytes ${start}-`))) {await res.body.cancel();throw failure('HTTP_RESUME','Invalid resume response');}
    fs.writeFileSync(metaPath,JSON.stringify({validator:res.headers.get("etag")||res.headers.get("last-modified")}));
    if (!resumed) start = 0;
    const total = start + Number(res.headers.get('content-length') || 0);
    job.totalBytes=total;
    try{ensureSpace(dir,Math.max(0,total-start)+total)}catch(e){await res.body.cancel();throw e;}
    let got = start;
    if(context){context.previous=got;context.baseline=got;}
    let header=Buffer.alloc(0);
    const videoType=/^video\//i.test(res.headers.get('content-type')||'');
    const meter=new FileProgress(got,this.now());
    speedTimer=setInterval(()=>{const sample=meter.sample(got,this.now());job.speed=sample.speed;job.rollingSpeed=sample.rollingSpeed;if(!context?.attempt.probe)this.updateSlowState(job);},1000);
    const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
      resetIdle();
      got += chunk.length;
      if(header.length<512)header=Buffer.concat([header,chunk.subarray(0,512-header.length)]);
      const sniff=header.subarray(0,4).toString('hex')==='1a45dfa3'||header.subarray(4,8).toString()==='ftyp'||header.subarray(0,4).toString()==='RIFF'||header[0]===0x47;
      const video=sniff||(videoType&&!/^\s*(?:<|\{|\[)/.test(header.toString()));
        context?.observe(got,0,total>0&&got===total,video);
        if(video)job.lastProgressAt=this.now();job.idleSeconds=video?0:Math.floor((this.now()-(job.lastProgressAt??job.dataStartedAt??context?.attempt.started??this.now()))/1000);job.downloadedBytes=got;
      if (total) job.progress = got / total;

    });
    const throttle=async function*(source){for await(const chunk of source){if(context?.capped&&!context.adopted)await context.beforeFinalize();yield chunk;}};
    try{await pipeline(body,throttle,fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }),{signal});}catch(e){if(this.controllers.get(job.id)?.signal.aborted)throw this.controllers.get(job.id).signal.reason;if(idle.signal.aborted)throw idle.signal.reason;if(['ECONNRESET','ETIMEDOUT','ERR_STREAM_PREMATURE_CLOSE'].includes(e.code))throw failure('HTTP_FAILURE','HTTP connection interrupted');throw e;}finally{clearTimeout(idleTimer);}
    if(total && got!==total) throw failure('HTTP_INCOMPLETE','Incomplete response');
    await this.contexts?.get(job.id)?.beforeFinalize();
    job.stage='Checking video and audio';
    job.verification=await this.checkMedia(part,{english:!!job.profile?.english,maxResolution:job.profile?.resolution,allowedResolutions:job.profile?.allowedResolutions,signal:this.controllers.get(job.id)?.signal});
    this.controllers.get(job.id)?.signal.throwIfAborted();
    await this.finishFile(job,part,dest);
    fs.unlinkSync(part);fs.unlinkSync(metaPath);
    return dest;
    }finally{clearTimeout(idleTimer);clearInterval(speedTimer);job.speed=0;}
  }

  // ---- torrents: only the wanted file is downloaded, even from a season pack ----
  async acquire(c, signal) {
    let e = this.torrents.get(c.infoHash);
    if (!e) {
      e = { refs: 0, torrent: null, promise: null, tmp: path.join(cfg.downloadDir, '.tmp', c.infoHash), metainfo: path.join(cfg.downloadDir, '.tmp', c.infoHash+'.torrent') };
      this.torrents.set(c.infoHash, e);
      // Some Stremio providers return only an info hash and a displayed seeder
      // count. DHT alone can be unreachable on common home networks, so provide
      // tracker fallbacks as well as any provider-supplied trackers.
      const trackers = [...new Set([...(c.trackers || []),
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://open.stealth.si:80/announce',
        'udp://tracker.torrent.eu.org:451/announce',
        'udp://tracker.dler.org:6969/announce',
        'https://tracker.tamersunion.org:443/announce',
      ])];
      const magnet = `magnet:?xt=urn:btih:${c.infoHash}` + trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
      const cached=readCachedTorrent(e.metainfo,c.infoHash);
      e.promise = new Promise((resolve, reject) => {
        const metadataTimeout=Math.min(15,Number(cfg.metadataTimeoutSeconds)||15);
        const timer = setTimeout(() => reject(failure('METADATA_TIMEOUT','Timed out fetching torrent metadata from peers')), metadataTimeout * 1000);
        e.cleanup=()=>clearTimeout(timer);
        this.getClient().then(client=>{
        if(this.torrents.get(c.infoHash)!==e)throw failure('STOPPED','Stopped');
        const t = client.add(cached||magnet, { path: e.tmp });
        e.torrent = t;
        t.on('metadata',()=>cacheTorrent(e.metainfo,t));
        t.on('error', (err) => {
          clearTimeout(timer);
          reject(failure('TORRENT_FAILURE',err.message));
        });
        t.on('ready', () => {
          clearTimeout(timer);
          cacheTorrent(e.metainfo,t);
          prepareTorrent(e);
          resolve(e);
        });
        }).catch(reject);
      });
    }
    e.refs++;
    try {
      if(signal){
        let abort;try{await Promise.race([e.promise,new Promise((_,reject)=>{abort=()=>reject(signal.reason?.code==='TEST_INCONCLUSIVE'?signal.reason:new Error('Stopped'));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});})]);}finally{signal.removeEventListener('abort',abort);}
      }else await e.promise;
    } catch (err) {
      this.release(c.infoHash);
      throw err;
    }
    return e;
  }

  release(infoHash) {
    const e = this.torrents.get(infoHash);
    if (!e) return;
    e.refs--;
    if (e.refs > 0) return;
    this.torrents.delete(infoHash);
    e.cleanup?.();
    try {
      e.torrent?.destroy();
    } catch {
      /* already gone */
    }
    // Keep verified pieces for restart recovery.
  }

  async downloadTorrent(job, c, dir, prefix) {
    job.speed=0;job.torrentSpeed=0;job.stage='Finding torrent metadata';
    job.metadataWaitStartedAt=this.now();
    job.peers=0;
    const peerMonitor=setInterval(()=>{job.peers=this.torrents.get(c.infoHash)?.torrent?.numPeers||0;},1000);
    let e;
    try { e = await this.acquire(c,this.controllers.get(job.id)?.signal); }
    finally { clearInterval(peerMonitor); }
    job.metadataWaitStartedAt=null;job.sourceResponseAt=this.now();
    job.dataStartedAt??=this.now();
    job.peers=e.torrent?.numPeers||0;
    job.stage='Downloading video';
    let unselect,windowSelection;
    try {
      const t = e.torrent;
      const file=torrentEpisodeFile(t,c,job);
      if (!file) throw failure('SOURCE_FILE','Source must identify the episode file explicitly or by a matching filename');
      if(!VIDEO_EXT.test(file.path))throw failure('SOURCE_FILE','Selected torrent file is not a video');
      const episodeTag=/s(\d+)[ ._-]*e(\d+)/i.exec(path.basename(file.path));if(episodeTag&&(Number(episodeTag[1])!==job.season||Number(episodeTag[2])!==job.episode))throw failure('SOURCE_FILE','Torrent file belongs to another episode');
      job.totalBytes=file.length;
      ensureSpace(dir,Math.max(0,file.length-file.downloaded)+file.length);
      const context=this.contexts?.get(job.id);
      if(context){context.previous=file.downloaded;context.verifiedBaseline=verifiedFileBytes(t,file);context.ready();}
      if(context?.attempt.probe&&!context.adopted)windowSelection=probeSelection(e,file);
      else unselect=selectFile(e,file);
      await new Promise((resolve,reject)=>{
        const signal=this.controllers.get(job.id)?.signal;
        const progress=new FileProgress(file.downloaded,this.now());
        let iv;
        const finish=error=>{clearInterval(iv);signal?.removeEventListener('abort',abort);t.removeListener('error',onError);error?reject(error):resolve();};
        const abort=()=>finish(signal?.reason?.code==='TEST_INCONCLUSIVE'?signal.reason:new Error('Stopped'));
        const onError=error=>finish(failure('TORRENT_FAILURE',error.message));
        const poll=()=>{
          if(signal?.aborted)return abort();
          if(t.destroyed)return finish(failure('TORRENT_FAILURE','Torrent connection closed'));
          const pollNow=this.now(),sample=progress.sample(file.downloaded,pollNow);
          const verified=verifiedFileBytes(t,file);
          const previouslyVerified=context?.attempt.evidence.verified||0;
          context?.observe(file.downloaded,verified,verified>=file.length);
          const newVerified=Math.max(0,verified-(context?.verifiedBaseline||0));
          if(context&&newVerified>previouslyVerified)job.lastProgressAt=pollNow;
          if(context?.adopted&&windowSelection){windowSelection.release();windowSelection=null;unselect=selectFile(e,file);}
          else if(context?.capped)windowSelection?.release();else windowSelection?.advance();
          job.progress=file.progress;job.speed=sample.speed;job.rollingSpeed=sample.rollingSpeed;job.torrentSpeed=t.downloadSpeed;job.peers=t.numPeers;
          if(!context?.attempt.probe)this.updateSlowState(job);
          const usefulIdleMs=pollNow-(job.lastProgressAt??job.dataStartedAt??context?.attempt.started??job.runStartedAt??pollNow);
          job.downloadedBytes=file.downloaded;job.idleSeconds=Math.floor(usefulIdleMs/1000);
          job.stage=usefulIdleMs>=1000?'Waiting for useful pieces':'Downloading video';
          if(file.progress>=1&&(!t.bitfield||verified>=file.length))return finish();
          if(usefulIdleMs>=45000)finish(failure('NO_USEFUL_PIECES','No verified episode data within 45 seconds'));
        };
        t.on('error',onError);signal?.addEventListener('abort',abort,{once:true});
        iv=setInterval(poll,1000);poll();
      });

      await this.contexts?.get(job.id)?.beforeFinalize();
      const src = path.join(t.path, file.path);
      const dest = path.join(dir, safe(job.seriesName)+' - '+prefix+safe(job.title||'Episode')+path.extname(file.path));
      job.verification=await this.checkMedia(src,{english:!!job.profile?.english,maxResolution:job.profile?.resolution,allowedResolutions:job.profile?.allowedResolutions,signal:this.controllers.get(job.id)?.signal});
      this.controllers.get(job.id)?.signal.throwIfAborted();
      await this.finishFile(job,src,dest);
      return dest;
    } finally {
      windowSelection?.release();unselect?.();
      job.speed=0;job.torrentSpeed=0;
      this.release(c.infoHash);
    }
  }

  control(id, action) {
    if (this.clearing) throw new Error('The queue is being cleared; try again shortly');
    const job=this.jobs.find(j=>j.id===id);if(!job) throw new Error("Unknown job");
    if(action==="pause"||action==="cancel"){if(job.status==="done")throw new Error("Completed downloads cannot be paused or cancelled");job.status=action==="pause"?"paused":"cancelled";job.backgroundRetryActive=false;job.yieldedAt=null;job.nextRetryAt=null;job.speed=0;job.torrentSpeed=0;this.controllers.get(id)?.abort();}
    else if(action==="resume"||action==="retry"){if(this.controllers.has(id)) throw new Error("Transfer is stopping; retry shortly");if(job.status!=="done"){job.status="queued";job.backgroundRetryActive=false;job.yieldedAt=null;job.queueOrder=this.nextQueueOrder();job.retryRound=0;job.deferredRetryRound=0;job.nextRetryAt=null;job.failureCode=null;job.recentSources=[];for(const key of Object.keys(this.cooldowns||{}))if(key.startsWith(job.id+'|'))delete this.cooldowns[key];}}
    else throw new Error("Unknown action");
    this.save();this.pump();
  }

  remove(id) {
    if (this.clearing) throw new Error('The queue is being cleared; try again shortly');
    const index = this.jobs.findIndex(job => job.id === id);
    if (index < 0) return false;
    if (this.controllers.has(id)) throw new Error('Cancel the job and wait for it to stop before removing it');
    this.jobs.splice(index, 1);
    clearTimeout(this.saveTimer);
    this.saveNow();
    return true;
  }

  async clearAll() {
    if (this.clearing) throw new Error('The queue is already being cleared');
    this.clearing = true;clearTimeout(this.retryTimer);
    const removed = this.jobs.length;
    for (const job of this.jobs) {
      job.status = 'cancelled';
      this.controllers.get(job.id)?.abort();
    }
    this.save();
    try {
      await Promise.allSettled([...this.running]);
      this.jobs = [];
      clearTimeout(this.saveTimer);
      this.saveNow();
      return removed;
    } finally {
      this.clearing = false;
      this.pump();
    }
  }

  async shutdown() {
    this.stopping=true;clearTimeout(this.retryTimer);
    for(const [id,c] of this.controllers){
      const job=this.jobs.find(item=>item.id===id);
      if(job&&['resolving','downloading','verifying'].includes(job.status)){
        job.status='queued';job.stage='Queued after restart';job.error=null;job.speed=0;
      }
      c.abort();
    }
    clearTimeout(this.saveTimer);
    this.saveNow();
    if(this.client)await new Promise(resolve=>this.client.destroy(resolve));
    await Promise.allSettled([...this.running]);
    clearTimeout(this.saveTimer);this.saveNow();
  }
}
