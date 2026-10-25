# Stremio Download Companion

A Windows desktop companion for downloading an episode, a season, or selected seasons using sources from your Stremio add-ons.

## Install

1. Download the current **Stremio Download Companion Setup** installer from [the latest public release](https://github.com/j117mw3/stremio-download-companion/releases/latest).
2. Quit an older companion using its tray menu, then run the installer. Existing downloads and queue data are retained.
3. Open the companion, choose your download folder, and connect Stremio using **Install addon**. If needed, paste `http://127.0.0.1:7000/manifest.json` into Stremio's Addons page.

**Requirements:** Windows 10/11 x64; Stremio desktop with working source add-ons; FFmpeg and FFprobe. By default the companion finds these tools in `%LOCALAPPDATA%\Programs\Stremio`. For another installation location, set `COMPANION_FFMPEG` and `COMPANION_FFPROBE` to the full executable paths before launching the companion. These tools are not bundled in this release. The installer is not code-signed.

The companion listens on localhost port 7000. Closing its window hides it to the tray; **Quit** stops it. A browser window is not required for torrent or direct-link downloads.

## Choose downloads

- **Episode:** choose a season and one episode.
- **Season:** download the whole selected season.
- **Series:** check the seasons to download. Regular seasons start selected; Specials start unchecked.

Future episodes are excluded. Select quality, allowed lower-quality fallbacks, audio preference, and destination before downloading. Specials can be explicitly selected. Stremio shortcuts initialize the matching selection.

## Queue and existing files

Pause, resume, cancel, retry, choose sources, remove stopped entries, or remove all queue entries. Removing entries does not delete downloaded media. Partial downloads are retained for recovery.

Only active episode files are selected in a season torrent. Episode speed measures that file's progress; shared torrent traffic is shown separately. The built-in scheduler runs up to four normal downloads and reserves two additional activities for source comparisons or an extra episode. Stremio add-on lookups share a global cap of 32 active requests and eight requests per episode. Each provider result is fed into source selection as it arrives, rather than waiting for every add-on; the 60-second source-turn limit includes lookup time. Recent response latency and verified throughput guide provider and release ordering. Add-ons in backoff are skipped until expiry: persistent 4xx responses wait 30 minutes, while timeouts, network errors, and server errors wait 5 minutes with exponential growth capped at 30 minutes. Successful and empty responses clear backoff. Torrent metadata has a 15-second deadline. A no-data source turn searches up to five distinct releases, starting alternatives after 15 seconds without verified episode data. Each candidate has a 15-second setup deadline, 30-second test limit, and 16 MiB payload cap, with no more than two tests running at once. Slow but progressing sources remain eligible for the existing rate comparison. Peer counts alone do not establish a working source. After 30 seconds without episode data, one bounded extra slot can try another episode (preferably in the same season). If no source qualifies, the job follows the retry schedule and yields to fresh work or due deferred retries.

Source failures first retry after 5, 15, and 60 minutes. After those retries, an entry becomes **Deferred retry** and is retried after 30 minutes, then one hour, then every two hours. Deferred attempts wait until fresh queued work drains; up to four due retries can fill otherwise idle normal slots, scheduled fairly across shows. The queue shows its next retry time, current source wait, comparison progress, and add-on lookup outcomes. These retries and their timing survive restarts; paused and cancelled entries remain inactive. Manual retry starts a fresh retry cycle.

Provider response and transfer measurements are written to a rotating `source-diagnostics.jsonl` log in the companion's local data folder. The log uses opaque provider/release identifiers and records status categories, latency, result counts, and verified bytes/rates; it does not store add-on URLs, credentials, or proxy headers. Hourly aggregates are retained for 14 days and are available with the raw records from `/api/diagnostics/sources`. The queue also shows a concise lookup summary and the cause of a failed source test.

After a torrent episode has passed media checks and the final copy's SHA-256 matches its staged source, the companion removes only that exact staged episode file once no active jobs reference that torrent. Existing cache contents and unrelated partial files are not bulk-pruned.

Before requesting sources, the companion checks the saved episode path and its show/season folder. Healthy episodes are reused regardless of the newly selected quality. The first check reads the file and performs a full FFmpeg decode; subsequent checks compare its SHA-256 with a stored verification. The queue shows **Checking existing file**, then **Already downloaded — verified**. Checks can be cancelled.

Confirmed damaged files are replaced only after the replacement passes verification. If replacement fails, the original is retained. Unavailable drives, access errors, or missing verification tools are reported rather than treated as corruption. Multiple matching files require manual resolution. A `.corrupt-backup` left by an interrupted replacement is retained or restored during recovery; do not discard it until the intended file is confirmed.

When an episode receives no useful data for 15 seconds, or its rolling 30-second speed stays below 0.25 MiB/s or 25% of the fastest active episode for 60 seconds, the companion compares up to two distinct alternatives while the current source keeps running. A no-data attempt resolves within 45 seconds. It switches only when a candidate measures at least twice the current rate and at least 0.25 MiB/s faster. Requested quality is tested first, and lower qualities are considered only when explicitly allowed. Duplicate swarms are merged; unknown-resolution listings remain eligible for the normal serial download/inspection path but are not promoted by connectivity tests.

Each candidate gets at most 30 seconds, with a 15-second setup deadline and a 16 MiB new-payload allowance (plus unavoidable boundary pieces and outstanding requests). Torrent probes request up to the bounded episode-file window; HTTP probes run at full speed and stop at the same traffic limit. For torrents, cached data or peers alone cannot win: a candidate must deliver newly verified episode data and sustained progress, or complete a small verified file. HTTP candidates must deliver a video response and continued payload progress. Final media/audio checks still apply.

Source tests and the extra-episode slot share two additional network slots globally. Tests are fair across waiting episodes. A working winner is promoted in place, preserving its test data. If the original recovers, it is retained. If no candidate wins and queued work is waiting, a slow episode yields its normal slot and resumes in fair queue order with its source-specific partial intact. Limits are recorded as inconclusive, not permanent source failures. Recent rates expire after 15 minutes and are keyed by an opaque hostname hash for HTTP or swarm hash for torrents; they guide source ordering but never replace checking the requested episode.

Switching releases may reset an episode's displayed percentage because different releases cannot share arbitrary bytes. The previous source-specific partial remains available. Pausing, cancelling, clearing the queue, or quitting stops that episode's tests as well. The queue displays the current and rolling 30-second episode rates, **Checking for a faster source**, candidate rates, **Waiting behind other downloads**, received versus verified bytes, and a release-switch explanation.

The right-hand series navigator replaces the page scrollbar with labelled segments sized to each show's share of the queue. Each segment shows overall progress across queued episodes, including partial progress. Click a series to jump, or drag the marker to scroll. Each episode bar displays its percentage. Paused episodes remain paused.

## Source limitations

Sources come from locally saved Stremio add-ons, with the public Torrentio endpoint as a fallback. The companion reads the Stremio profile without modifying it. Downloads require a supported torrent or direct video URL; add-ons returning browser-only handoffs cannot be downloaded by this queue. Source availability, useful torrent peers, and provider access are outside the companion's control.

English audio is checked where language tags exist. Untagged audio is shown as unverified rather than claimed as English. Existing-file checks detect decoding failures but cannot establish the identity of arbitrarily renamed videos or every possible media defect. Use media you are authorized to download.

Dependency status at publication: `npm audit --omit=dev` reports six high-severity findings in the WebTorrent dependency tree. This release retains WebTorrent 1.9.7; the audit is not a determination that every finding is exploitable in this application.

## Development

Install Node.js 22.13 or newer (Node 22 recommended), then:

```powershell
npm ci
npm test
npm run test:ui
npm run test:torrent
npm start
# Or launch the desktop app:
npm run desktop
# Build the Windows x64 installer:
npm run dist
```

Tests use temporary data and synthetic/local fixtures; the UI test uses port 7011. The media tests require FFmpeg/FFprobe as described above. `npm start` starts the backend at `http://127.0.0.1:7000/`; open that URL in a browser. Do not run it alongside the installed companion on the same port.

For local development overrides, copy `config.example.json` to `config.json`. This file is ignored by Git and excluded from installers. Built-in defaults are used by clean installations. Never commit configured provider URLs containing account tokens. Electron and electron-builder versions are pinned in the development dependencies.

## Release and license

[Changelog](CHANGELOG.md) · [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

v0.4.16 paces provider requests per service origin, shares cooldowns after HTTP 429 responses, honors `Retry-After`, and treats English audio as a preference. v0.4.15 lets slow transfers yield to due retries, applies expiring add-on backoff, records 14 days of privacy-safe hourly source summaries, and cleans only verified completed torrent staging files. v0.4.14 streams Stremio add-on responses into source selection, caps global provider requests, and fills idle normal slots with fair deferred retries. v0.4.13 expands no-data source search to five distinct releases within 60 seconds and uses short-lived, privacy-safe throughput rankings from verified transfers. Earlier local development builds are summarized in the changelog and are not published as historical releases.
