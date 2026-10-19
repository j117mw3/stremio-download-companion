import test from 'node:test';
import assert from 'node:assert/strict';
import { selectEpisodes } from '../src/selection.js';

const episodes = [0, 1, 2, 3, 4].flatMap(season => [1, 2].map(episode => ({
  id: `s${season}e${episode}`,
  title: `Season ${season} episode ${episode}`,
  season,
  episode,
  released: 1,
}))).concat({ id: 'future', season: 3, episode: 3, released: Date.now() + 86400000 });

test('episode resolves exactly one requested episode', () => {
  assert.deepEqual(
    selectEpisodes(episodes, { scope: 'episode', season: 3, episode: 1 }).map(item => item.id),
    ['s3e1'],
  );
});

test('season resolves every eligible episode without an episode selector', () => {
  assert.deepEqual(
    selectEpisodes(episodes, { scope: 'season', season: 3 }).map(item => item.id),
    ['s3e1', 's3e2'],
  );
  assert.throws(() => selectEpisodes(episodes, { scope: 'season', season: 3, episode: 1 }), /whole season/);
});

test('series resolves only the requested whole seasons', () => {
  const selected = selectEpisodes(episodes, { scope: 'series', seasons: [1, 2, 3] });
  assert.equal(selected.length, 6);
  assert.ok(selected.every(item => [1, 2, 3].includes(item.season)));
  assert.ok(!selected.some(item => item.season === 0 || item.season === 4));
  assert.throws(() => selectEpisodes(episodes, { scope: 'series', seasons: [1], season: 1 }), /seasons only/);
});

test('season zero is an explicit Specials selection', () => {
  assert.equal(selectEpisodes(episodes, { scope: 'season', season: 0 }).length, 2);
  assert.deepEqual(
    selectEpisodes(episodes, { scope: 'series', seasons: [0, 1] }).map(item => item.season),
    [0, 0, 1, 1],
  );
});

test('future episodes are excluded and an empty selection stays empty', () => {
  assert.equal(selectEpisodes(episodes, { scope: 'season', season: 3 }, 50000).length, 2);
  assert.deepEqual(selectEpisodes(episodes, { scope: 'series', seasons: [] }), []);
  assert.deepEqual(selectEpisodes([], { scope: 'season', season: 3 }), []);
  assert.throws(() => selectEpisodes(episodes, { scope: 'series', seasons: [99] }), /no eligible episodes/);
});

test('missing or malformed episode metadata cannot be selected', () => {
  assert.throws(() => selectEpisodes(null, { scope: 'series', seasons: [1] }), /metadata is unavailable/);
  const incomplete = [
    { season: 1, episode: 1, released: 1 },
    { id: 'missing-episode', season: 1, released: 1 },
    { id: 'bad-date', season: 1, episode: 2, released: 'not a date' },
    { id: 'good', season: 1, episode: 3, released: 1 },
  ];
  assert.deepEqual(selectEpisodes(incomplete, { scope: 'season', season: 1 }).map(item => item.id), ['good']);
});

test('episode subsets and mode-inappropriate fields are rejected', () => {
  assert.throws(() => selectEpisodes(episodes, { scope: 'season', season: 3, selected: ['s3e1'] }), /subsets/);
  assert.throws(() => selectEpisodes(episodes, { scope: 'episode', season: 3 }), /Choose an episode/);
  assert.throws(() => selectEpisodes(episodes, { scope: 'episode', season: 3, episode: 1, seasons: [3] }), /one season and episode/);
  assert.throws(() => selectEpisodes(episodes, { scope: 'series', seasons: [1, 1] }), /each season once/);
});
