# STATE.md — Working State (re-read after compaction)
## Updated: 2026-04-03

### Active Work
- pixel-terminal companion system session — large batch of fixes and features shipped
- Reload pixel-terminal to test: session scheduler, stale badge, file-context commentary, buddy log color, FILES tab hidden fix

### Session Shipped (2026-04-03)
- **_teardownLivePin()** — consolidated 3 scattered destroy+null pairs in history.js
- **Session scheduler** — lastActivityAt on sessions, getStaleSessionIds(), creation gate at 5+ sessions, ⊖ stale badge on cards, 60s refresh tick
- **Buddy log color** — pollMasterOut uses 'vexil' state → .vexil-entry--buddy → companion hue color
- **Hook gate removed from log** — approval requests bubble-only, no red log entry
- **FILES tab fix** — #attachments-panel.hidden { display: none } was missing; showTab('vexil') on init
- **Drop files orphan removed** — static .att-empty div gone from index.html
- **reportingMode filter** — vexil_master.py suppresses internal refs in user mode; buddy.json has reportingMode:dev
- **Plan A built** — events.js passes file+cwd in tool_use feed; vexil_master.py reads file excerpts at trigger time; all tuple unpacks use *_ splat
- **Rate limit prompt grounded** — passes actual tool context, banned speculation about causes

### Key IDs
- Collection: pixel_terminal (gemini-memory)
- buddy.json: ~/.config/pixel-terminal/buddy.json (reportingMode: dev, syncedFrom: claude-code)
- Handoff doc: ~/Projects/command-center/research/buddy-system-port-handoff.md

### Next
- Reload and verify: stale badge, file-context commentary quality, FILES tab hidden, buddy log color
- Plan B (buddy port): ASCII sprites, face render, companion intro dedup — defer until A verified
- Future Plan C: per-turn conversation context in feed (full Vexil-quality ceiling)

### Key IDs
- Collection: pixel_terminal (gemini-memory)
- Type scale: --fs-lg(13) --fs-base(12) --fs-sm(11) --fs-xs(10)
- Spacing: --sp-1(2) --sp-2(4) --sp-3(8) --sp-4(16)
- Line-height: --lh-tight(1.2) --lh-base(1.4)

### Decisions This Session
- CSS design tokens fully applied
- white-space: pre-wrap moved from .msg-bubble to .msg.user .msg-bubble only
- .system-label margin-top removed, opacity 0.75 + color --text-mute
- .msg.user margin-top: 16px added (now suspected too large)

### Blockers
- Message spacing: 16px user turn gap looks wrong per screenshot

### Last Session Snapshot
Date: 2026-04-01
Open actions (MERGED):
- [ ] Production PATH fix
- [ ] Full A/B test: drop image, ask dimensions
- [ ] Per-animal hue subsets (ANIMAL_HUES map)
- [ ] Dot click always-restart bridge
- [ ] Tune message spacing — Gemini Vision + --seq
- [ ] Pixel companion sprite — intercept /buddy in slash-menu, 16x32 sprite in px-master slot 0, states: idle/thinking/error/done from stream-json events
- [ ] Vexil Memory Linter — memory_lint.py (PreToolUse hook) + companion.js (3s file poll) — spec at command-center/scripts/memory_lint.py. No new Rust. read_file_as_text already exists.
Decisions: 9 | Fixes: 4
Next: → Apply Gemini Vision spacing feedback

### Research Log: Kairos + Buddy (2026-04-02)
- **KAIROS** (Claude Code leak 2026-03-31): internal always-on daemon, feature-flagged, not in public builds. autoDream = idle memory consolidation. px-master covers the architecture — gap is passive autonomous triggering without user prompt.
- **/buddy** (shipped 2026-04-01, April Fools): ASCII terminal pet, 18 species, Pro only, deterministic by account hash. Build native pixel sprite companion instead — persistent via px-master, multi-session aware, reacts to stream-json. Strictly better than ASCII.
