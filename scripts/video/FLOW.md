# The 5-minute demo — shot list

Total target **300s**. Every beat is held for at least the length of its narration line; the
driver logs `DEMO_LINE <ms> <id>` as it goes and the edit is cut from that log, never by eye.

Intro and outro are HyperFrames compositions. Everything between them is the real app, driven
over CDP with a drawn cursor and visible click rings, recorded at capture-crop.

| # | id | beat | what is on screen | ~s |
|---|----|------|-------------------|----|
| — | — | **INTRO** *(HyperFrames)* | | **22** |
| 1 | `01-problem` | The problem | "Zerops deploys what you tell it. Nobody tells it everything." | 8 |
| 2 | `02-wall` | What we hit | Three platform behaviours that return 200 and do nothing | 7 |
| 3 | `03-built` | What we built | The five things, as a build | 7 |
| — | — | **THE APP** | | **255** |
| 4 | `04-token` | Token | Paste the PAT, real verify call, redacted hint | 14 |
| 5 | `05-board` | The board | React Flow: drag a node, pan, zoom, fit | 22 |
| 6 | `06-blast` | Blast radius | Click the runtime → everything unrelated dims | 18 |
| 7 | `07-add` | Add a service | `+` → search "post" → PostgreSQL lands dashed | 18 |
| 8 | `08-scan` | Scan | Point at the repo, scan, six gaps appear | 20 |
| 9 | `09-evidence` | Evidence | Each gap cites the import that proves it | 18 |
| 10 | `10-config` | Config drift | Variables the code reads that the project lacks | 14 |
| 11 | `11-secrets` | Secrets | Committed credentials, by file and line, never the value | 24 |
| 12 | `12-design` | Design | Plain English in | 12 |
| 13 | `13-rejected` | The rejections | Why Typesense beat Meilisearch; why not Qdrant | 26 |
| 14 | `14-auto-intro` | Autopilot | Disarmed, with a ceiling | 14 |
| 15 | `15-auto-run` | The measurement | Real load through the deployed URL | 14 |
| 16 | `16-auto-panel` | The argument | Three lenses disagree, on real numbers | 26 |
| 17 | `17-auto-apply` | Armed | It really resizes the service, and verifies | 22 |
| 18 | `18-actions` | Actions | Every REST call, writes marked | 20 |
| 19 | `19-envs` | Environments | Two projects, nine real differences | 12 |
| 20 | `20-honest` | What it will not do | Refused / pending / applied are different words | 18 |
| — | — | **OUTRO** *(HyperFrames)* | | **23** |
| 21 | `21-outro` | Live | The URL, the numbers, the repo | 23 |

## Rules carried over from the last take

- **Drawn SVG cursor**, not the hardware pointer — the OS cursor does not appear in
  `avfoundation` capture and four takes were lost to discovering that separately.
- **Click ring** on every press, so a click is visible rather than inferred from the result.
- **`typeInto` at ~24cps with jitter**, because instant text reads as a scripted screenshot.
- **Named `until()` waits** — never a bare sleep. A slow Zerops response stretches the pause,
  it does not desynchronise everything after it.
- **Crop at capture time**, not in the edit.
- **No burned-in captions.** A real `.srt` ships alongside.
- **Pre-take checks**: screen unlocked, correct Electron app fronted, motion check per interval
  (not max), daemon answering, session connected.
