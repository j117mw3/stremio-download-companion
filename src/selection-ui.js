const $ = id => document.getElementById(id);
let data = null;
let mode = 'episode';
let season = null;
let episode = null;
let picked = new Set();
let generation = 0;
let selectionVersion = 0;
let resolving = false;
let submitting = false;
let resolved = null;
let resolveError = '';

const seasonLabel = number => number === 0 ? 'Specials' : `Season ${number}`;
const available = () => data?.episodes.filter(item =>
  Number.isInteger(item.season) && item.season >= 0 &&
  Number.isInteger(item.episode) && item.episode >= 0 &&
  !(Number.isFinite(item.released) && item.released > Date.now())
) || [];
const seasons = () => [...new Set(available().map(item => item.season))].sort((a, b) => a - b);

function choice() {
  const base = { id: data.parsed.series, scope: mode };
  if (mode === 'series') return { ...base, seasons: [...picked].sort((a, b) => a - b) };
  if (mode === 'season') return { ...base, season };
  return { ...base, season, episode };
}

function selected(request = choice()) {
  const episodes = available();
  if (request.scope === 'series') return episodes.filter(item => request.seasons.includes(item.season));
  if (!Number.isInteger(request.season)) return [];
  return episodes.filter(item => item.season === request.season &&
    (request.scope === 'season' || (Number.isInteger(request.episode) && item.episode === request.episode)));
}

function option(value, text, disabled = false) {
  const result = document.createElement('option');
  result.value = value;
  result.textContent = text;
  result.disabled = disabled;
  return result;
}

function seasonSelect() {
  const label = document.createElement('label');
  label.className = 'selection-field';
  label.append(document.createTextNode('Season'));
  const select = document.createElement('select');
  select.id = 'seasonNumber';
  select.setAttribute('aria-label', 'Season');
  const all = seasons();
  const seasonExists = all.includes(season);
  if (!seasonExists) select.append(option('', all.length ? 'Choose a season' : 'No eligible seasons', true));
  for (const number of all) {
    const count = available().filter(item => item.season === number).length;
    select.append(option(number, `${seasonLabel(number)} · ${count} episodes`));
  }
  select.value = seasonExists ? String(season) : '';
  select.disabled = !all.length;
  select.onchange = () => {
    season = select.value === '' ? null : Number(select.value);
    episode = null;
    $('message').textContent = '';
    render();
  };
  label.append(select);
  return label;
}

function summaryFor(episodes, request) {
  if (request.scope === 'episode') {
    const item = episodes[0];
    return `${seasonLabel(request.season)} · Episode ${request.episode}${item.title ? ` — ${item.title}` : ''}`;
  }
  if (request.scope === 'season') {
    return request.season === 0
      ? `Specials · ${episodes.length} episodes`
      : `${seasonLabel(request.season)} · ${episodes.length} episodes`;
  }
  const included = [...new Set(episodes.map(item => item.season))].sort((a, b) => a - b);
  const regular = included.filter(number => number !== 0);
  const seasonText = regular.length ? `Seasons ${regular.join(', ')}` : 'Specials';
  return `${seasonText} · ${episodes.length} episodes · Specials ${included.includes(0) ? 'included' : 'excluded'}`;
}

function update() {
  for (const tab of $('modes').children) {
    const active = tab.dataset.mode === mode;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  $('selectionPanel').setAttribute('aria-labelledby', `tab-${mode}`);
  $('selectionPanel').inert = submitting;
  $('modes').inert = submitting;
  const current = data ? choice() : null;
  const key = current ? JSON.stringify(current) : '';
  const previewMatches = resolved && resolved.key === key;
  $('download').textContent = mode === 'episode' ? 'Download episode' :
    mode === 'season' ? 'Download season' : 'Download selected seasons';
  $('download').disabled = !data || !$('quality').value || resolving || submitting ||
    !previewMatches || !resolved.episodes.length;

  if (!data) {
    $('summary').textContent = 'Select a show to begin.';
  } else if (resolving) {
    $('summary').textContent = 'Resolving selected episodes…';
  } else if (!selected(current).length) {
    $('summary').textContent = 'No eligible episodes selected.';
  } else if (resolveError) {
    $('summary').textContent = resolveError;
  } else if (previewMatches) {
    $('summary').textContent = summaryFor(resolved.episodes, current);
  } else {
    $('summary').textContent = 'Selection is not ready yet.';
  }
}

async function resolveSelection() {
  const version = ++selectionVersion;
  resolved = null;
  resolveError = '';
  if (!data) {
    resolving = false;
    update();
    return;
  }
  const request = choice();
  const key = JSON.stringify(request);
  if (!selected(request).length) {
    resolving = false;
    update();
    return;
  }
  resolving = true;
  update();
  try {
    const preview = await api('/api/preview', request);
    if (version !== selectionVersion) return;
    resolved = { key, previewToken: preview.previewToken, episodes: preview.episodes };
  } catch (error) {
    if (version !== selectionVersion) return;
    resolveError = error.message || 'Could not resolve selection.';
  } finally {
    if (version === selectionVersion) {
      resolving = false;
      update();
    }
  }
}

function render() {
  const panel = $('selectionPanel');
  panel.replaceChildren();
  if (!data) {
    update();
    return;
  }

  const all = seasons();
  if (season === null && all.length) season = all.find(number => number > 0) ?? all[0];

  if (mode === 'series') {
    const toolbar = document.createElement('div');
    toolbar.className = 'selection-actions';
    for (const [text, action] of [
      ['Select all seasons', () => { picked = new Set(seasons().filter(number => number > 0)); }],
      ['Clear selection', () => { picked.clear(); }],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.onclick = () => {
        action();
        $('message').textContent = '';
        render();
      };
      toolbar.append(button);
    }
    panel.append(toolbar);

    const regular = all.filter(number => number !== 0);
    const specials = all.filter(number => number === 0);
    for (const number of [...regular, ...specials]) {
      const label = document.createElement('label');
      label.className = `season-choice${number === 0 ? ' specials' : ''}`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = picked.has(number);
      checkbox.dataset.season = number;
      checkbox.setAttribute('aria-label', `${seasonLabel(number)}, ${available().filter(item => item.season === number).length} episodes`);
      checkbox.onchange = () => {
        checkbox.checked ? picked.add(number) : picked.delete(number);
        $('message').textContent = '';
        update();
        resolveSelection();
      };
      label.append(checkbox, document.createTextNode(`${seasonLabel(number)} · ${available().filter(item => item.season === number).length} episodes`));
      panel.append(label);
    }
  } else {
    panel.append(seasonSelect());
    if (mode === 'episode') {
      const eligible = available().filter(item => item.season === season);
      if (episode === null && eligible.length) episode = eligible[0].episode;
      const hasEpisode = eligible.some(item => item.episode === episode);
      const label = document.createElement('label');
      label.className = 'selection-field';
      label.append(document.createTextNode('Episode'));
      const select = document.createElement('select');
      select.id = 'episodeNumber';
      select.setAttribute('aria-label', 'Episode');
      if (!hasEpisode) select.append(option('', eligible.length ? 'Choose an episode' : 'No eligible episodes', true));
      for (const item of eligible) {
        select.append(option(item.episode, `Episode ${item.episode}${item.title ? ` — ${item.title}` : ''}`));
      }
      select.value = hasEpisode ? String(episode) : '';
      select.disabled = !eligible.length;
      select.onchange = () => {
        episode = select.value === '' ? null : Number(select.value);
        $('message').textContent = '';
        update();
        resolveSelection();
      };
      label.append(select);
      panel.append(label);
    }
  }
  update();
  resolveSelection();
}

window.loadShow = async (id, initialMode = 'series') => {
  const version = ++generation;
  ++selectionVersion;
  data = null;
  resolved = null;
  resolveError = '';
  resolving = false;
  picked.clear();
  season = null;
  episode = null;
  mode = ['episode', 'season', 'series'].includes(initialMode) ? initialMode : 'episode';
  $('chosen').textContent = 'Loading show…';
  $('message').textContent = '';
  render();
  try {
    const response = await fetch('/api/show?id=' + encodeURIComponent(id));
    if (!response.ok) throw new Error('Could not load show metadata. Search and try again.');
    const next = await response.json();
    if (version !== generation) return;
    data = next;
    $('media').value = data.parsed.series;
    $('chosen').textContent = data.name;
    season = Number.isInteger(data.parsed.season) ? data.parsed.season : null;
    episode = Number.isInteger(data.parsed.episode) ? data.parsed.episode : null;
    picked = new Set(seasons().filter(number => number > 0));
    $('english').checked = data.anime;
    render();
  } catch (error) {
    if (version !== generation) return;
    $('chosen').textContent = 'Show unavailable';
    $('message').textContent = error.message || 'Could not load show metadata. Search and try again.';
    render();
  }
};

$('modes').onclick = event => {
  const tab = event.target.closest('[data-mode]');
  if (!tab || tab.dataset.mode === mode) return;
  mode = tab.dataset.mode;
  $('message').textContent = '';
  render();
};
$('quality').onchange = update;

$('setup').onsubmit = async event => {
  event.preventDefault();
  const request = data ? choice() : null;
  const key = request ? JSON.stringify(request) : '';
  if (!resolved || resolved.key !== key || !$('quality').value || submitting) return;
  const preview = resolved;
  const version = selectionVersion;
  const resolution = Number($('quality').value);
  const fallbacks = [720, 480].filter(number => number < resolution && number >= Number($('fallback').value));
  const english = $('english').checked;
  submitting = true;
  update();
  try {
    const result = await api('/api/queue', {
      previewToken: preview.previewToken,
      resolution,
      fallbacks,
      english,
    });
    $('message').textContent = `${result.added} episodes queued`;
  } catch (error) {
    $('message').textContent = error.message || 'Could not queue selection';
  } finally {
    submitting = false;
    if (version === selectionVersion) resolveSelection();
    update();
  }
};

async function api(url, body) {
  const token = document.querySelector('meta[name="companion-token"]').content;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Companion-Token': token },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}

const params = new URLSearchParams(location.search);
render();
if (params.get('id')) window.loadShow(params.get('id'), ['episode', 'season', 'series'].includes(params.get('scope')) ? params.get('scope') : 'episode');
