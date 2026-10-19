import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const defaults = {
  port: 7000,
  downloadDir: './downloads',
  // Paste your own configured Torrentio URL here if you use a debrid service,
  // e.g. https://torrentio.strem.fun/realdebrid=YOURKEY
  torrentioUrl: 'https://torrentio.strem.fun',
  concurrency: 2,
  // "auto": require English dub for anime (kitsu ids), prefer it for everything else
  // "require": skip episodes with no dub found | "prefer" | "off"
  dubMode: 'auto',
  maxResolution: 0, // 0 = highest available, or e.g. 1080
  stallMinutes: 5,
  metadataTimeoutSeconds: 30,
};

let user = {};
try {
  user = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch {
  /* config.json is optional */
}

export const cfg = { ...defaults, ...user };
cfg.downloadDir = path.resolve(process.env.COMPANION_DATA || ROOT, cfg.downloadDir);
