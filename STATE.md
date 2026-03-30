# STATE.md — Working State (re-read after compaction)
## Updated: 2026-03-30 09:30

### Active Work
- Sprite alignment fixes COMPLETE (vertical Y offsets + horizontal X offsets)
- Character selection order fix COMPLETE (0-degree originals first, shuffled)
- Card centering fix COMPLETE (padding-left: 0 on .session-card)
- Attachments section draggable resize COMPLETE (att-h-resize)
- Octopus dedup COMPLETE: only octopus-pink in BASE, others in hue batch
- frog3 added to BASE set with correct x/y alignment offsets
- IDENTITY_SEQ_KEY bumped to v9, BASE_ANIMAL_COUNT=10
- IN PROGRESS: remove OPEN button from input bar; keep status dot + gear icon (gear bigger)

### Key IDs
- Collection: pixel_terminal (gemini-memory)
- localStorage key: 'pixel-terminal-identity-seq-v9'

### Decisions This Session
- SPRITE_Y_OFFSETS: per-animal Y offset table (0/3/6px at 3x) for bottom-alignment
- SPRITE_X_OFFSETS: per-animal X offset table (0/2/3/5px at 3x) for horizontal centering
- BASE_ANIMAL_COUNT=10 (cat2, snake, penguin, octopus-pink, crab, rat, seal, rabbit, cat, frog3)
- session-card padding-left: 0 (was 10px) for sprite centering between sidebar left and text
- att-h-resize draggable handle: resizes voice-log vs attachments-panel boundary
- attachments-panel: flex: 1 1 40% (equal default height to voice-log)

### Blockers
- Production .app PATH fix (deferred to packaging)

### Last Session Snapshot
Date: 2026-03-30
Open actions:
- [ ] Production PATH fix — context: get_shell_path() Rust + cached invoke; packaging only
- [ ] Full A/B test: drop image, ask dimensions → verify zero Bash commands
- [ ] Per-animal hue subsets (ANIMAL_HUES map) *(auto-recovered)*
- [ ] Remove OPEN button from input bar; enlarge gear icon — context: in progress now
Decisions: 14 | Fixes: 9
Next: → remove OPEN button, enlarge gear icon in input bar
