const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function video(id, season, episode, title, released = '2020-01-01T00:00:00.000Z') {
  return { id: `${id}:${season}:${episode}`, season, episode, title, released };
}

function show(name, id, seasonCounts, specials = 4) {
  const videos = [];
  for (const [season, count] of seasonCounts.entries()) {
    for (let episode = 1; episode <= count; episode++) {
      videos.push(video(id, season + 1, episode, `Season ${season + 1} episode ${episode} title`));
    }
  }
  if (specials) {
    for (let episode = 1; episode <= specials; episode++) {
      videos.push(video(id, 0, episode, `Special episode ${episode} title`));
    }
  }
  if (id === 'tt1442437') {
    videos.push(video(id, 3, 25, 'Future episode', '2099-01-01T00:00:00.000Z'));
  }
  return { meta: { name, genres: [], videos } };
}

const metadata = new Map([
  ['tt1442437', show('Modern Family', 'tt1442437', [24, 24, 24, 24, 24, 24, 22, 22, 22, 22, 18])],
  ['tt0108778', show('Friends', 'tt0108778', Array(10).fill(2), 1)],
  ['tt9999999', { meta: { name: 'Metadata Missing', genres: [] } }],
  ['tt8888888', {}],
]);

const nativeFetch = global.fetch;
let metadataRequests = 0;
global.fetch = async (input, options) => {
  const url = String(input);
  const match = url.match(/\/meta\/series\/(tt\d+)\.json/);
  if (match) {
    metadataRequests++;
    return new Response(JSON.stringify(metadata.get(match[1]) || { meta: { name: 'Unknown', videos: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.includes('/catalog/series/top/search=')) {
    return new Response(JSON.stringify({ metas: [{ id: 'tt1442437', name: 'Modern Family', releaseInfo: '2009-2020' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return nativeFetch(input, options);
};

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log('PASS', message);
}

async function waitFor(read, message) {
  for (let index = 0; index < 200; index++) {
    if (await read()) return;
    if (index === 199) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

app.whenReady().then(async () => {
  const { cfg } = await import('../src/config.js');
  cfg.port = 7011;
  cfg.downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-ui-'));
  const backend = await import('../src/server.js');
  await backend.ready;
  const releaseVersion = require('../package.json').version;
  const health = await (await fetch('http://127.0.0.1:7011/api/health')).json();
  const manifest = await (await fetch('http://127.0.0.1:7011/manifest.json')).json();
  check(health.version === releaseVersion && manifest.version === releaseVersion, 'backend health and Stremio manifest match the package version');
  let lastBatch = null;
  backend.downloader.enqueue = batch => {
    lastBatch = batch;
    return batch.episodes.length;
  };

  const window = new BrowserWindow({
    show: false,
    width: 1180,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const js = code => window.webContents.executeJavaScript(code);
  await window.loadURL('http://127.0.0.1:7011/?scope=season&id=tt1442437:3:1');
  await waitFor(() => js("document.getElementById('chosen').textContent==='Modern Family' && document.getElementById('summary').textContent==='Season 3 · 24 episodes'"), 'Season shortcut metadata timeout');

  check(await js("document.getElementById('modes').getAttribute('role')==='tablist' && document.getElementById('chosen').compareDocumentPosition(document.getElementById('modes')) & Node.DOCUMENT_POSITION_FOLLOWING"), 'show title appears above the mode tabs');
  check(await js("document.querySelector('[data-mode=season]').getAttribute('aria-selected')==='true' && !document.getElementById('episodeNumber') && document.getElementById('seasonNumber').value==='3'"), 'season shortcut opens Season 3 with no episode field');
  check(await js("!document.querySelector('#selectionPanel input[type=checkbox]') && document.querySelectorAll('#selectionPanel select').length===1"), 'Season mode displays only its season dropdown');
  check(await js("document.getElementById('summary').textContent==='Season 3 · 24 episodes' && document.getElementById('download').textContent==='Download season'"), 'Season 3 summary and action label match the complete season');

  await js("document.getElementById('quality').value='1080';document.getElementById('quality').dispatchEvent(new Event('change'))");
  await js("document.getElementById('setup').requestSubmit()");
  await waitFor(() => !!lastBatch, 'Season queue timeout');
  check(lastBatch.episodes.length === 24 && lastBatch.episodes.every(item => item.season === 3), 'Season 3 queues all 24 episodes without an episode selector');
  lastBatch = null;

  await js("document.querySelector('[data-mode=episode]').click()");
  await waitFor(() => js("!document.getElementById('download').disabled"), 'Episode shortcut resolution timeout');
  check(await js("!!document.getElementById('seasonNumber') && !!document.getElementById('episodeNumber') && document.getElementById('seasonNumber').value==='3' && document.getElementById('episodeNumber').value==='1'"), 'episode shortcut preserves its embedded season and episode');
  check(await js("document.getElementById('summary').textContent==='Season 3 · Episode 1 — Season 3 episode 1 title' && document.getElementById('download').textContent==='Download episode'"), 'episode summary includes the metadata title and matching action');
  check(await js("!document.querySelector('#selectionPanel input[type=checkbox]') && document.querySelectorAll('#selectionPanel select').length===2"), 'Episode mode displays only its season and episode dropdowns');
  await js("document.getElementById('setup').requestSubmit()");
  await waitFor(() => !!lastBatch, 'Episode queue timeout');
  check(lastBatch.episodes.length === 1 && lastBatch.episodes[0].season === 3 && lastBatch.episodes[0].episode === 1, 'Episode mode queues exactly one episode');
  lastBatch = null;

  await js("document.querySelector('[data-mode=series]').click()");
  await waitFor(() => js("!document.getElementById('download').disabled"), 'Series default selection resolution timeout');
  check(await js("!document.getElementById('seasonNumber') && !document.getElementById('episodeNumber')"), 'Series mode displays no dropdowns');
  check(await js("document.querySelectorAll('#selectionPanel input[type=checkbox]').length===12 && !document.querySelector('#selectionPanel select')"), 'Series mode displays whole-season checkboxes only');
  check(await js("[...document.querySelectorAll('[data-season]')].every(box=>box.dataset.season==='0'?!box.checked:box.checked)"), 'Series defaults to regular seasons with Specials unchecked');
  check(await js("document.getElementById('summary').textContent.endsWith('Specials excluded')"), 'Series summary reports that Specials are excluded');
  await js("document.querySelector('#selectionPanel button:first-child').click()");
  await waitFor(() => js("!document.getElementById('download').disabled"), 'Select-all resolution timeout');
  check(await js("[...document.querySelectorAll('[data-season]')].every(box=>box.dataset.season==='0'?!box.checked:box.checked) && document.getElementById('summary').textContent.endsWith('Specials excluded')"), 'Select all seasons selects regular seasons and keeps Specials excluded');
  await js("document.querySelector('#selectionPanel button:last-child').click()");
  check(await js("document.getElementById('download').disabled && document.getElementById('summary').textContent==='No eligible episodes selected.'"), 'empty Series selection disables download');
  for (const number of [1, 2, 3]) {
    await js(`document.querySelector('[data-season="${number}"]').click()`);
  }
  await waitFor(() => js("!document.getElementById('download').disabled"), 'selected series resolution timeout');
  check(await js("document.getElementById('summary').textContent==='Seasons 1, 2, 3 · 72 episodes · Specials excluded' && document.getElementById('download').textContent==='Download selected seasons'"), 'Series summary reports exactly seasons 1, 2, and 3');
  await js("document.getElementById('setup').requestSubmit()");
  await waitFor(() => !!lastBatch, 'Series queue timeout');
  check(lastBatch.episodes.length === 72 && lastBatch.episodes.every(item => [1, 2, 3].includes(item.season)), 'Series queues only seasons 1, 2, and 3');
  lastBatch = null;

  await js("document.querySelector('[data-season=\"0\"]').click()");
  await waitFor(() => js("!document.getElementById('download').disabled"), 'Specials selection resolution timeout');
  check(await js("document.getElementById('summary').textContent==='Seasons 1, 2, 3 · 76 episodes · Specials included'"), 'Series summary and resolved selection include Specials only after an explicit check');
  await js("document.getElementById('setup').requestSubmit()");
  await waitFor(() => !!lastBatch, 'Series with Specials queue timeout');
  check(lastBatch.episodes.length === 76 && lastBatch.episodes.filter(item => item.season === 0).length === 4, 'Series queue includes the explicitly selected Specials collection');
  lastBatch = null;
  await js("document.querySelector('[data-mode=episode]').click();document.querySelector('[data-mode=series]').click()");
  await waitFor(() => js("!document.getElementById('download').disabled"), 'Mode-switch selection resolution timeout');
  check(await js("[...document.querySelectorAll('[data-season]')].every(box=>[0,1,2,3].includes(Number(box.dataset.season))===box.checked) && document.getElementById('summary').textContent.endsWith('Specials included')"), 'mode switching preserves the Series selection');

  await js("document.querySelector('[data-mode=season]').click();document.getElementById('seasonNumber').value='0';document.getElementById('seasonNumber').dispatchEvent(new Event('change'))");
  await waitFor(() => js("!document.getElementById('download').disabled"), 'Season Specials resolution timeout');
  check(await js("!document.getElementById('episodeNumber') && document.getElementById('summary').textContent==='Specials · 4 episodes'"), 'Season mode selects the Specials collection without an episode field');
  await js("document.getElementById('setup').requestSubmit()");
  await waitFor(() => !!lastBatch, 'Season Specials queue timeout');
  check(lastBatch.episodes.length === 4 && lastBatch.episodes.every(item => item.season === 0), 'Season mode queues Specials as season zero');
  lastBatch = null;

  await js("window.loadShow('tt9999999','series')");
  await waitFor(() => js("document.getElementById('chosen').textContent==='Metadata Missing'"), 'Missing episode metadata timeout');
  check(await js("!document.querySelector('[data-season]') && document.getElementById('download').disabled && document.getElementById('summary').textContent==='No eligible episodes selected.'"), 'missing episode metadata leaves no selectable seasons and disables download');
  await js("window.loadShow('tt8888888','series')");
  await waitFor(() => js("document.getElementById('chosen').textContent==='Show unavailable'"), 'Missing show metadata timeout');
  check(await js("document.getElementById('download').disabled && document.getElementById('message').textContent.includes('metadata')"), 'missing show metadata is reported and cannot be queued');

  await js("window.loadShow('tt1442437:3:25','episode')");
  await waitFor(() => js("document.getElementById('chosen').textContent==='Modern Family'"), 'Future episode shortcut metadata timeout');
  check(await js("document.getElementById('download').disabled && document.getElementById('summary').textContent==='No eligible episodes selected.' && ![...document.querySelectorAll('#episodeNumber option')].some(item=>item.value==='25')"), 'future episodes are absent from Episode controls and cannot be queued');
  const token = await js("document.querySelector('meta[name=companion-token]').content");
  const futurePreview = await js(`(async()=>{const r=await fetch('/api/preview',{method:'POST',headers:{'Content-Type':'application/json','X-Companion-Token':'${token}'},body:JSON.stringify({id:'tt1442437',scope:'episode',season:3,episode:25})});return {status:r.status,body:await r.json()}})()`);
  check(futurePreview.status === 400, 'server rejects a Stremio request for an unreleased episode');
  const subsetPreview = await js(`(async()=>{const r=await fetch('/api/preview',{method:'POST',headers:{'Content-Type':'application/json','X-Companion-Token':'${token}'},body:JSON.stringify({id:'tt1442437',scope:'season',season:3,selected:['tt1442437:3:1']})});return {status:r.status,body:await r.json()}})()`);
  check(subsetPreview.status === 400 && subsetPreview.body.error.includes('subsets'), 'server rejects arbitrary episode subsets');

  await js("window.loadShow('tt1442437','series')");
  await waitFor(() => js("document.getElementById('chosen').textContent==='Modern Family' && !document.getElementById('download').disabled"), 'Series shortcut metadata timeout');
  check(await js("[...document.querySelectorAll('[data-season]')].every(box=>box.dataset.season==='0'?!box.checked:box.checked)"), 'Series shortcut initializes regular seasons with Specials unchecked');
  await js("document.querySelector('[data-season=\"2\"]').click();window.loadShow('tt0108778','series')");
  await waitFor(() => js("document.getElementById('chosen').textContent==='Friends' && !document.getElementById('download').disabled"), 'Changed show metadata timeout');
  check(await js("[...document.querySelectorAll('[data-season]')].every(box=>box.dataset.season==='0'?!box.checked:box.checked)"), 'changing shows clears the old selection and defaults the new regular seasons');
  await js("document.getElementById('query').value='Modern Family';document.getElementById('search').requestSubmit()");
  await waitFor(() => js("document.querySelector('#results button')?.textContent.includes('Modern Family')"), 'Search result timeout');
  check(await js("document.querySelectorAll('#results button').length===1"), 'show search still returns selectable results');
  await js("document.querySelector('#results button').click()");
  await waitFor(() => js("document.getElementById('chosen').textContent==='Modern Family' && !document.getElementById('download').disabled && document.getElementById('summary').textContent.endsWith('Specials excluded')"), 'Search show selection timeout');
  await js("document.getElementById('quality').value='1080';document.getElementById('quality').dispatchEvent(new Event('change'))");
  await js("window.loadShow('tt1442437','series')");
  await waitFor(() => js("document.getElementById('chosen').textContent==='Modern Family' && document.getElementById('summary').textContent==='Seasons 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 · 250 episodes · Specials excluded' && !document.getElementById('download').disabled"), 'Stable layout selection timeout');
  const wideState = await js("JSON.stringify({mode:document.querySelector('[data-mode=series]').getAttribute('aria-selected'),quality:document.getElementById('quality').value,summary:document.getElementById('summary').textContent,disabled:document.getElementById('download').disabled})");
  check(JSON.parse(wideState).mode === 'true' && JSON.parse(wideState).quality === '1080' && !JSON.parse(wideState).disabled, 'normal-width capture uses a settled Series selection');
  check(metadataRequests === 4, 'selection previews reuse server-fetched show metadata');

  backend.downloader.jobs = [
    {id:'fixture:1:1',seriesName:'Fixture Show',season:1,episode:1,status:'retry_wait',stage:'Retry scheduled',nextRetryAt:Date.now()+300000,speed:0,progress:.2},
    {id:'fixture:1:2',seriesName:'Fixture Show',season:1,episode:2,status:'downloading',stage:'Waiting for useful pieces',speed:0,torrentSpeed:1048576,peers:4,progress:.1},
    {id:'fixture:1:3',seriesName:'Fixture Show',season:1,episode:3,status:'needs_attention',stage:'Needs attention',speed:0,progress:0}
  ];
  await js('tick()');
  check(await js("document.getElementById('t').textContent.includes('Next retry:') && document.getElementById('t').textContent.includes('Waiting for useful pieces') && document.getElementById('t').textContent.includes('Shared torrent traffic: 1.0 MB/s') && document.getElementById('t').textContent.includes('Needs attention') && document.getElementById('t').textContent.includes('0.0 MB/s')"), 'queue distinguishes retry time, stalled episode speed, shared traffic, and Needs attention');
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync('test/selection-layout-final-wide.png', (await window.webContents.capturePage()).toPNG());
  await js("document.getElementById('t').scrollIntoView({block:'start'})");
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync('test/recovery-queue-wide.png', (await window.webContents.capturePage()).toPNG());
  window.setSize(520, 900);
  await new Promise(resolve => setTimeout(resolve, 100));
  check(await js('document.documentElement.scrollWidth<=innerWidth'), 'narrow desktop layout has no horizontal overflow');
  fs.writeFileSync('test/selection-layout-final-narrow.png', (await window.webContents.capturePage()).toPNG());
  await js("document.getElementById('t').scrollIntoView({block:'start'})");
  await new Promise(resolve => setTimeout(resolve, 100));
  check(await js("document.getElementById('t').scrollWidth<=document.getElementById('t').clientWidth"), 'narrow queue shows recovery information without horizontal scrolling');
  fs.writeFileSync('test/recovery-queue-narrow.png', (await window.webContents.capturePage()).toPNG());
  console.log('Selection UI checks complete');
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
