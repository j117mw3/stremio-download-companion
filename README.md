# Stremio Download Companion

A Windows desktop companion for downloading an episode, a season, or selected seasons using sources from your Stremio add-ons.

## Install

1. Download **Stremio Download Companion Setup 0.4.7.exe** from [the latest release](https://github.com/j117mw3/stremio-download-companion/releases/latest).
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

Before requesting sources, the companion checks the saved episode path and its show/season folder. Healthy episodes are reused regardless of the newly selected quality. The first check reads the file and performs a full FFmpeg decode; subsequent checks compare its SHA-256 with a stored verification. The queue shows **Checking existing file**, then **Already downloaded — verified**. Checks can be cancelled.

Confirmed damaged files are replaced only after the replacement passes verification. If replacement fails, the original is retained. Unavailable drives, access errors, or missing verification tools are reported rather than treated as corruption. Multiple matching files require manual resolution. A `.corrupt-backup` left by an interrupted replacement is retained or restored during recovery; do not discard it until the intended file is confirmed.

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

v0.4.7 is the first public release. Earlier local development builds are summarized in the changelog and are not published as historical releases.
