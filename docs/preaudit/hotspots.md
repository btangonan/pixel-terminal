# Top 20 Files by LOC (Source Only)

| Rank | File | LOC | Concern |
|------|------|-----|---------|
| 1 | src/styles.css | 1967 | 6.5× limit — monolithic stylesheet |
| 2 | scripts/vexil_master.py | 716 | Daemon script, all logic in one file |
| 3 | src/companion.js | 710 | Companion UI + polling + buddy.json read |
| 4 | src-tauri/src/lib.rs | 602 | All Tauri commands in single file |
| 5 | src/history.js | 528 | Session history + render |
| 6 | src/session-lifecycle.js | 491 | Spawn, kill, restart, directory logic |
| 7 | scripts/sprite-gen.js | 471 | Sprite generation, PNG encoding |
| 8 | src/voice.js | 431 | Voice UI + WS client + PTT state |
| 9 | src/events.js | 418 | All stream event handlers |
| 10 | src/app.js | 402 | Entry point + scroll + confirm + drag |
| 11 | src/cards.js | 397 | Session cards + familiar card UI |
| 12 | src/attachments.js | 330 | File attachment staging + display |

## Key Observation
12 of 25 source files violate the 300-LOC rule (48%). The CSS file is the worst
offender at 1967 lines — it encodes layout, theming, animations, companion,
cards, history, voice, and more in a single flat file with no scoping structure.

lib.rs concentrates all Tauri IPC surface in 602 lines — any new command lands
here, making it a growth magnet.
