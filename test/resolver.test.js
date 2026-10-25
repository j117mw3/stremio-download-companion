import assert from 'node:assert/strict';
import { pickBest, parseId, parseStream } from '../src/resolver.js';

const mk = (name, title, extra = {}) => ({ name: `Torrentio\n${name}`, title, infoHash: Math.random().toString(16).slice(2).padEnd(40, '0'), ...extra });

const streams = [
  mk('1080p', 'Show.S01E01.1080p.JPN.Subbed\n👤 500 💾 1.4 GB'),
  mk('720p', 'Show.S01E01.720p.English.Dub\n👤 90 💾 700 MB'),
  mk('1080p', 'Show.S01E01.1080p.Dual-Audio\n👤 40 💾 1.5 GB'),
  mk('2160p', 'Show.S01E01.2160p.JPN\n👤 900 💾 6 GB'),
];

// require: only dubs, highest resolution among them
let best = pickBest(streams, { mode: 'require' });
assert.equal(best.res, 720);
assert.ok(best.dub);

// prefer: dub wins over a higher-res non-dub
best = pickBest(streams, { mode: 'prefer' });
assert.ok(best.dub);
assert.equal(best.res, 720);

// off: pure highest resolution
best = pickBest(streams, { mode: 'off' });
assert.equal(best.res, 2160);

// Require mode falls back to unmarked native-language sources, but not sources
// explicitly labeled with a foreign audio language.
assert.equal(pickBest([streams[0], streams[3]], { mode: 'require' }), null);
const unmarked = mk('720p', 'Show.S01E01.720p.WEB-DL');
assert.equal(pickBest([unmarked], { mode: 'require' }).raw, unmarked);
const knownForeign = mk('720p', 'Show.S01E01.720p.GERMAN');
assert.equal(pickBest([knownForeign], { mode: 'prefer' }).raw, knownForeign, 'audio preference must not block the only eligible source');

// max resolution cap
best = pickBest(streams, { mode: 'off', maxResolution: 1080 });
assert.equal(best.res, 1080);

// ids
assert.deepEqual(parseId('tt0944947:1:2'), { kind: 'imdb', series: 'tt0944947', season: 1, episode: 2 });
assert.deepEqual(parseId('kitsu:1234:5'), { kind: 'kitsu', series: 'kitsu:1234', season: 1, episode: 5 });

console.log('resolver tests passed');


// Known unapproved resolutions are excluded. Unlabeled providers remain
// candidates and are checked against the selected quality after download.
assert.equal(pickBest([streams[1]],{mode:'off',maxResolution:1080,allowedResolutions:[1080]}),null);
const unknownQuality=mk('unknown','Unknown quality');
assert.equal(pickBest([unknownQuality],{mode:'off',maxResolution:1080,allowedResolutions:[1080,720]}).raw,unknownQuality);
assert.equal(pickBest([unknownQuality,streams[1]],{mode:'off',maxResolution:1080,allowedResolutions:[1080,720]}).raw,streams[1]);
assert.equal(pickBest([streams[1]],{mode:'require',maxResolution:1080,allowedResolutions:[1080,720]}).res,720);
assert.equal(parseStream({title:'Show 720p\n👤 12 seeders'}).seeders,12);
assert.equal(parseStream({title:'Show 720p'}).seeders,null);
