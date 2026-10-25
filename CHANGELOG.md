# Changelog

## 0.4.10

- Compare up to two distinct sources after 30 seconds without useful episode data, while the original keeps running.
- Respect quality/audio settings and prefer requested quality over explicitly permitted fallbacks.
- Require new verified torrent pieces or a continuing HTTP video response, rather than trusting peers, cached bytes, or seed counts.
- Share two extra slots between source comparisons and extra-episode work; bound setup, test duration, and payload use.
- Promote successful candidates without reconnecting, retain original partials, and keep the original when it recovers.
- Persist short-lived anonymous connectivity observations and expose candidate feedback in the queue/source APIs.
- Cancel all owned tests on pause, cancel, clear, or shutdown; recover interrupted comparisons safely after restart.

## 0.4.9

- Try one extra episode after 30 seconds without useful data, without interrupting existing downloads.
- Yield a still-stalled episode after 90 seconds and prefer untried sources on its next scheduled turn.
- Add a right-hand series progress navigator, proportional queue segments, jump controls, and draggable scroll-position marker.
- Display episode percentages and series progress across queued episodes, including partial progress.
- Preserve scroll position across queue updates and keep manually paused entries paused.

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

## 0.4.11

- Track rolling 30-second episode rates and compare sources after 60 seconds of sustained slow progress.
- Keep the current transfer running while testing up to two eligible alternatives; choose a replacement only when verified episode data is at least 2x faster and 0.25 MiB/s faster.
- Remove the artificial candidate speed ceiling while retaining payload, time, setup, quality, fallback, and shared-activity limits.
- Yield slow jobs behind ready queue work without discarding source-specific partials, then resume them fairly when capacity opens.
- Show rolling rates, source-comparison progress, candidate rates, and when an episode waits behind other downloads.
- Store expiring source-speed history under opaque identifiers and mark a source slow only after a confirmed speed comparison.

## 0.4.12

- Increase the built-in normal download concurrency from two to four while retaining a shared budget of two extra network activities.
- Fail over on torrent metadata timeouts after 15 seconds; compare other eligible sources after 15 seconds without useful episode data and resolve no-data attempts within 45 seconds.
- Keep candidate limits, verified episode-data checks, source quality/audio restrictions, and the clear-win switching threshold.
- Try no more than three distinct sources in one scheduling turn and keep later ready episodes moving when sources are unavailable.
- Replace terminal source failures with persisted deferred retries after the existing 5, 15, and 60-minute cycle: 30 minutes, one hour, then every two hours.
- Run at most one deferred retry at a time and only after fresh queued work drains; migrate source-related Needs attention jobs into this retry path.
- Show source wait, metadata wait, comparison progress, and deferred retry timing in queue feedback and job responses.

## 0.4.13

- Search up to five distinct releases, including the initial source, within a 60-second no-data turn; retain the 15-second metadata timeout, two-test budget, 30-second candidate cap, and 16 MiB test cap.
- Test requested-quality releases before explicitly permitted lower-quality fallbacks, and count only verified torrent episode bytes or valid HTTP video payload as useful connectivity.
- Rank otherwise eligible releases using short-lived throughput from verified downloads and source comparisons; keep torrent history keyed by swarm and HTTP history keyed by a hashed hostname.
- Show source-turn progress, candidate rates, and remaining search time in the queue while preserving retry behavior, partial downloads, and quality/audio restrictions.

## 0.4.14

- Start source-turn timing before Stremio add-on lookup and feed provider results into episode source selection as they arrive.
- Share add-on requests fairly across queued jobs with a global limit of 32 in flight and no more than eight per episode.
- Rank providers using recent response latency and verified download throughput; short-lived provider cooldowns only affect ordering.
- Record rotating, privacy-safe source diagnostics with opaque provider and release identifiers, response categories, latency, result count, and verified transfer rates.
- Retry up to four due deferred episodes in available normal slots after queued work drains, rotating fairly across shows while keeping fresh work first.
- Recover the requested episode by a unique filename or episode tag when a provider's torrent file index points at another episode; reject ambiguous matches.
- Expose concise add-on lookup progress in the queue and preserve existing request formats, source limits, quality rules, and media verification.
