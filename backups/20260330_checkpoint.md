# Session Checkpoint — pixel-terminal
**Date**: 2026-03-30 (session 2)
**Commit**: 715d2fc

## Decisions Made
- OPEN button (always-on-btn) hidden — input bar keeps only status dot + gear
- Gear icon 22px (was 16px)
- HIST/LIVE tabs + VOICE LOG/ATTACHMENTS/MIC SOURCE labels → var(--text-mid) to match token count
- #input-row align-items: center for vertical textarea centering
- Empty state: #empty-state ghost line in #message-log (pointer-events:none, matches placeholder style)
- body.no-session-active class drives all no-session visibility across CSS
- showEmptyState uses querySelectorAll('.msg,.working-cursor') — never innerHTML='' on #message-log
- --logo-green: #7bb54f added to :root (sampled from frog in pixel-claude-logo.png)
- Pulse animation on + button removed — user prefers static UI for onboarding hints
- BASE_ANIMAL_COUNT=10, IDENTITY_SEQ_KEY=v9, frog3 in BASE, octopus-pink only in base cycle

## Fixes Applied
- Sprite Y offsets (SPRITE_Y_OFFSETS) for bottom baseline alignment across all animals
- Sprite X offsets (SPRITE_X_OFFSETS) for horizontal centering in 48px frame
- Card padding-left: 0 (was 10px) for correct sprite centering vs sidebar left edge
- att-h-resize draggable handle for voice-log/attachments resize
- attachments-panel flex: 1 1 40% matching voice-log default height

## Friction
- No-session entry UX took 3 iterations. Disabled textarea blocks click bubbling (silent failure). Hint button replacing input-row felt wrong ("fucking terrible"). Correct: ghost line in message-log, input bar untouched. /plan agent was the unlock.

## Memories Logged
- 7 new (decisions/tips) → pixel_terminal (logged mid-session)
- 2 new (friction + preference) → pixel_terminal (this retro)

---

# Session Checkpoint — pixel-terminal
**Date**: 2026-03-30 (session 3)

## Decisions Made
- Session prompt popup: `position:fixed` + `getBoundingClientRect()` + `ResizeObserver` for dynamic sidebar-width
- Whale sprite: k-whale-half5 (36×10px, 2 frames @3x = 54px wide). `scaleX(-1)` = facing right
- Plus button inverted toggle: `_whaleTick % 2` JS sync, not CSS animation (avoids orange-state conflict)
- History VIEWING pin: `#history-current` stable element above `#history-list` — never touched by `innerHTML=''` wipe
- HISTORY tab label (was HIST)

## Fixes Applied
- **History pin wiped on re-render**: `showCurrentHistoryCard()` populates `#history-current`; only `exitHistoryView()` clears it
- **Whale direction inverted**: sprite faces left natively → `scaleX(-1)` initially to face right
- **Transparent sprite rows**: k-whale-half4 had 4 empty rows → switched to k-whale-half5 (10px tall, clean)

## Progress
- Session prompt popup shipped: orange bg, START HERE, whale animation, message, GOT IT button
- Plus button orange ↔ inverted in sync with whale swim
- History VIEWING pin persists across sidebar list refreshes

## Friction
- `gate-deny.sh` blocks Bash writes in walk-away mode → use Edit tool directly
- Edit tool requires Read tool (not `cat`) before editing
- 5 sprite iterations to find clean k-whale-half5
- 2 iterations on history pin before Grade-A `#history-current` solution

## Memories Logged
- 6 new → pixel_terminal (history pin fix, session prompt complete, whale sprite, plus toggle, 2× friction)

## Open Items
- [ ] Production PATH fix — get_shell_path() Rust + cached invoke; .app loses homebrew PATH
- [ ] Full A/B test: drop image → ask dims → verify zero Bash
- [ ] Per-animal hue subsets (ANIMAL_HUES map)

## Next Session
→ Production PATH fix (~15 lines: one Tauri command in lib.rs + one cached invoke in session-lifecycle.js)
