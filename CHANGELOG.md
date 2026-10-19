# Changelog

## 0.4.8

- Explicitly deselect whole-season torrents and download only active episode files, preserving shared boundary pieces.
- Release file selections after cancellation, failure, or completion without interrupting sibling downloads.
- Display per-episode speed separately from shared torrent traffic.
- Switch sources after a metadata timeout or 90 seconds without useful episode progress; preserve slow but progressing transfers.
- Limit each queue turn to three candidates; defer unsuccessful jobs so other episodes continue.
- Persist cooldowns and automatic retries after 5, 15, and 60 minutes, then show Needs attention.
- Use typed transfer and media failures rather than matching error wording.

## 0.4.7 — First public release

- Reuse healthy existing episode files regardless of selected quality.
- Verify existing media with FFmpeg and retain SHA-256 verification records independently of queue entries.
- Verify replacements before replacing confirmed damaged files, with recovery backups.
- Recheck completed queue entries when selected again.
- Publish Windows x64 installer, checksums, source, and documented development commands.

## Earlier local development

Local builds preceded this repository; there is no reconstructed historical Git history or dated release archive.

- Separate Episode, Season, and Series selection; explicit Specials handling and exclusion of future episodes.
- Stremio shortcuts, metadata search, quality fallbacks, and audio inspection.
- Queue controls, individual removal, remove-all, and persisted state.
- Torrent metadata caching, tracker fallbacks, source fallback, retained partial pieces, and resumable HTTP transfers.
- Windows installer and tray application.
