# STATE.md — Working State (re-read after compaction)
## Updated: 2026-04-04

### Active Branch
`security/pr1-hardening` — PR #1 open, accumulated changes being pushed

### What Shipped This Session (2026-04-04 — Session 2)

#### Vexil Oracle Voice Rewrite
| Problem | Root Cause | Fix |
|---------|------------|-----|
| Oracle silent (no responses) | `--max-tokens` is invalid claude CLI flag — exit code 1 every call | Removed flag from both subprocess calls |
| Oracle blind to "is this right?" | `turn_complete` only emitted when `tool_count > 0` — pure chat turns never captured | `events.js`: emit for all turns with `turn_text` |
| Generic confused voice | `call_claude_oracle()` never loaded companion personality | Now loads `load_claude_companion()` → `~/.claude.json` personality first |
| Hedging, confused responses | "Only reference what you were told" instruction | Removed; replaced with "Be opinionated and specific. 2 sentences max." |
| Cut off / scroll race | `scrollTop = scrollHeight` before layout reflow | `requestAnimationFrame` in `voice.js` |
| Wrong session for context | `max(key=len)` picked most-history session | Now picks most-recent by timestamp |

#### Audit — Vexil Oracle + Sprite Spec
- Full 8-stage audit + Gemini two-pass adversarial → `docs/preaudit/AUDIT_VEXIL_ORACLE_2026-04-04.md`
- **CRITICAL found**: `ascii-sprites.js` per-frame line-drop vs spec all-frames (intentional — skip per user)
- **CRITICAL found**: `attachments.js` reads file before size check (OOM risk) — pending PR #3
- **WARNING corroborated**: `_read_file_context` uses `str.startswith()` not `is_relative_to()`

#### Accumulated from Previous Session (now committed)
- App rename: "Pixel Claude" → **Anima**, bundle ID `com.bradleytangonan.anima`
- Icons rebuilt (squircle PNG, all bundle sizes)
- Security: 5 CRITICALs closed (path allowlist, XSS, CSP, vexil paths, thread safety)
- Vitest 15/15 + cargo test 15/15
- CSS split: `styles.css` → 5 modules
- Rust split: `lib.rs` → `commands/` modules

### Pending / Next

#### PR #3 (next)
- [ ] `attachments.js`: file size check before `read_file_as_base64` (OOM guard)
- [ ] `src-tauri/src/commands/file_io.rs:_read_file_context`: `is_relative_to()` fix
- [ ] `vexil_master.py`: inode check for feed rotation
- [ ] `scripts/generate-buddy.js`: fix rollStat distribution (2d10 → intended behavior)
- [ ] CI: `.github/workflows/test.yml`

#### Launch Sequence
- [ ] Demo GIF (30-45s)
- [ ] README rewrite (`docs/launch/REPO_POSITIONING_PLAN.md`)
- [ ] GitHub Release `v0.1.0-alpha` with `.dmg`
- [ ] PR to `hesreallyhim/awesome-claude-code`
- [ ] Show HN → r/ClaudeCode → r/rust

### Key Files
- `scripts/vexil_master.py` — oracle persona, `_session_convo`, commentary triggers
- `src/events.js` — `turn_complete` emitted for all turns (tool + chat)
- `src/voice.js` — oracle chat display, rAF scroll fix
- `src/companion.js` — sprite rendering, buddy polling, master output poll
- `src/ascii-sprites.js` — 18 species × 3 frames, `renderFrame()`
- `src-tauri/src/commands/file_io.rs` — `expand_and_validate_path()`, path allowlist
- `docs/preaudit/AUDIT_VEXIL_ORACLE_2026-04-04.md` — latest audit
- `docs/launch/REPO_POSITIONING_PLAN.md` — launch strategy

### Key Constants
- Font: Menlo (`/System/Library/Fonts/Menlo.ttc`)
- Color: `#d87756` orange, `#0d0d0d` bg
- `REROLL_NIM_COST = 0` in `src/nim.js` — gate open for testing
- `NIM_PER_TOKENS = 1000` — 1 nim per 1000 tokens
- `FAMILIAR_SALT = 'pixel-familiar-2026'`
- Collection: `pixel_terminal` (gemini-memory)
- buddy.json: `~/.config/pixel-terminal/buddy.json`
- App name: **Anima** | Bundle ID: `com.bradleytangonan.anima`
- Oracle model: `claude-sonnet-4-6` (sessions), `claude-haiku-4-5-20251001` (no sessions)

### Launch: `./launch.command`
Kills old daemon + app, wipes feeds, clears WebKit cache, restarts everything. One command gets all changes.
