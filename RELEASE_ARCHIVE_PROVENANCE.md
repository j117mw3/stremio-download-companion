# Release snapshot provenance

Generated on 2026-10-25 from the preserved Windows packages in the local workspace. The existing public v0.4.10 commit is the parent. Each subsequent commit was authored on the date above from its matching packaged application source; no earlier dates or historical commits were reconstructed.

| Tag | Recovered package | Sorted `/src` path-and-content SHA-256 |
|---|---|---|
| v0.4.11 | `dist-0.4.11` | `58d859cee4abe389cb3e723cf88a295fd24e96ccac3e4f8d0cd9724125bb11d2` |
| v0.4.12 | `dist-0.4.12` | `3a8337e7233ae2f36e1a18bedb7e3ce2c5af37b7e9fc0448970e62da5b72ad1a` |
| v0.4.13 | `dist-0.4.13-unpacked` | `88ef6c5d727830d3fed02a1464cd7e3ff20f8a721d164af5a14a68e56e209e50` |
| v0.4.14 | `dist-0.4.14-local-unpacked` | `534303b5d3898c3a0c480bda2fdcfa46c0137a4a09be831dcfcda113cfae0634` |
| v0.4.15 | `dist-0.4.15-local-unpacked` | `22cb85e906a7453c629abea6b84e2712d0d255fe3fdac0d676dbb8c6bd4c56d8` |
| v0.4.16 | `dist-0.4.16-local-unpacked` | `8f2a7ac3af323c47752ebee7d0665b2ba4666dca028c3e6d8165d8b1a16e8c7f` |
| v0.4.17 | `dist-0.4.17-local-unpacked` | `52882096f5cf2ac9c2b337475fb4addc64903f5587378e292ebef8760bd599c9` |

The two preserved 0.4.13 packages both identify as version 0.4.13. Their application source differs in `src/queue-ui.js` and `src/server.js`; the selected `dist-0.4.13-unpacked` snapshot includes stable series-heading navigation, refresh suppression during jumps, and active-download cycling. The alternate `dist-0.4.13` source does not contain those fixes.

The original v0.4.11–v0.4.13 installers were not available in the verified release workspace, so all seven installers were built from their corresponding recovered tag snapshots on 2026-10-25. Portable archives are assembled from complete matching `win-unpacked` runtimes with license notices.

