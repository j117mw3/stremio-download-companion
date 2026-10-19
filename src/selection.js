function hasEpisodeMetadata(episode) {
  return episode && typeof episode.id === 'string' && episode.id.length > 0 &&
    Number.isInteger(episode.season) && episode.season >= 0 &&
    Number.isInteger(episode.episode) && episode.episode >= 0;
}

function isReleased(episode, now) {
  const released = episode.released;
  if (released == null || released === 0) return true;
  const timestamp = typeof released === 'number' ? released : Date.parse(released);
  return Number.isFinite(timestamp) && timestamp <= now;
}

/** Resolve a whole episode, season, or set of seasons from show metadata. */
export function selectEpisodes(episodes, selection, now = Date.now()) {
  if (!Array.isArray(episodes)) throw new Error('Show metadata is unavailable');
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new Error('Invalid selection');
  if ('selected' in selection) throw new Error('Episode subsets are not supported');

  const { scope } = selection;
  if (!['episode', 'season', 'series'].includes(scope)) throw new Error('Invalid mode');

  const hasSeason = Object.hasOwn(selection, 'season');
  const hasEpisode = Object.hasOwn(selection, 'episode');
  const hasSeasons = Object.hasOwn(selection, 'seasons');
  if (scope === 'episode') {
    if (!hasSeason || !Number.isInteger(selection.season) || selection.season < 0) throw new Error('Choose a season');
    if (!hasEpisode || !Number.isInteger(selection.episode) || selection.episode < 0) throw new Error('Choose an episode');
    if (hasSeasons) throw new Error('Episode mode accepts one season and episode');
  } else if (scope === 'season') {
    if (!hasSeason || !Number.isInteger(selection.season) || selection.season < 0) throw new Error('Choose a season');
    if (hasEpisode || hasSeasons) throw new Error('Season mode accepts one whole season');
  } else {
    if (hasSeason || hasEpisode) throw new Error('Series mode accepts seasons only');
    if (!Array.isArray(selection.seasons) || selection.seasons.some(n => !Number.isInteger(n) || n < 0)) throw new Error('Choose valid seasons');
    if (new Set(selection.seasons).size !== selection.seasons.length) throw new Error('Choose each season once');
  }

  const eligible = episodes.filter(e => hasEpisodeMetadata(e) && isReleased(e, now));
  if (scope === 'series') {
    const knownSeasons = new Set(eligible.map(e => e.season));
    if (selection.seasons.some(n => !knownSeasons.has(n))) throw new Error('A selected season has no eligible episodes');
    return eligible.filter(e => selection.seasons.includes(e.season));
  }
  return eligible.filter(e => e.season === selection.season && (scope === 'season' || e.episode === selection.episode));
}
