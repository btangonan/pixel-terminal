# Session Report — 2026-04-04
**Branch**: `security/pr1-hardening` → **PR**: btangonan/pixel-terminal#1
**Scope**: Security hardening + test infrastructure + structural splits

---

## What Was Done

### PR 1 — Security Hardening (5 audit CRITICALs closed)

Source: `docs/preaudit/PRE_AUDIT_SUMMARY.md`

| # | Risk | File | Fix |
|---|------|------|-----|
| CRITICAL 1 | `send_signal` — arbitrary process kill | `lib.rs` | Already on branch: restricted to `SpawnedPids` Tauri State + SIGINT/SIGTERM only |
| CRITICAL 2 | Unrestricted file read/write IPC | `commands/file_io.rs` | `expand_and_validate_path()` tightened from broad `$HOME/` to strict prefix allowlist |
| CRITICAL 3 | `cards.js` XSS → RCE via `dialog.innerHTML` | `src/cards.js`, `tauri.conf.json` | DOM construction already in place; CSP set |
| CRITICAL 4 | `/tmp` symlink attack in vexil daemon | `scripts/vexil_master.py` | Already moved to `~/.local/share/pixel-terminal/` |
| CRITICAL 5 | Thread safety race on `recent_activity` | `scripts/vexil_master.py` | Already had `threading.Lock` in place |

**Unplanned fix (same class as CRITICAL 2):**
`load_session_history(file_path)` opened arbitrary paths from webview JS with no validation. Fixed: restricted to `~/.claude/projects/` prefix with traversal check.

**Path allowlist** (`commands/file_io.rs:expand_and_validate_path`):
- `~/Projects/` — project files, attachment reads
- `~/.config/pixel-terminal/` — buddy.json, project-chars.json
- `~/.local/share/pixel-terminal/` — vexil_feed.jsonl, oracle_query.json
- `/tmp/` — vexil IPC files, hook gate, alive marker
- `~/.claude.json` (exact) — companion reads Claude config

---

### Phase 2 — Testing Infrastructure

**dom.js refactor:**
`window.marked.parse.bind()` and `window.marked.setOptions()` were at module scope — threw in jsdom because `window.marked` is undefined at load time. Moved both into `mdParse()` body. Module is now importable in non-browser environments.

**Vitest setup:**
- `vite.config.js`: `{ test: { globals: true, environment: 'jsdom' } }`
- `package.json`: vitest, jsdom, @tauri-apps/api devDeps + `"test": "vitest run"`

**Test files:**

`tests/dom.test.js` (6 tests):
- `mdParse` strips `<script>` tags from LLM output
- `esc()` escapes HTML special chars
- `esc(null)` doesn't throw
- `toolHint` extracts `file_path` basename
- `toolHint` extracts `query_texts[0]`
- `toolHint` returns truncated string on non-JSON

`tests/nim.test.js` (9 tests):
- `getNimBalance` returns 0 when empty
- `addNim(0)` is a no-op
- `addNim` increases balance
- `spendNim(0)` always returns true without touching balance
- `spendNim` deducts when affordable
- `spendNim` returns false when insufficient
- `accrueNimForSession` earns 1 nim per `NIM_PER_TOKENS` tokens
- `accrueNimForSession` does not double-count on repeated calls
- `accrueNimForSession` with no new tokens is a no-op

**Rust tests** (`src-tauri/src/lib.rs`, `#[cfg(test)]`, 15 tests):
- Path traversal blocked (`../../../etc/passwd`)
- System paths blocked (`/etc/passwd`)
- Home root blocked (`~/secret.txt`)
- `.ssh/` blocked
- Allowlist accepts: `~/.config/pixel-terminal/`, `~/.local/share/pixel-terminal/`, `~/Projects/`, `/tmp/`, `~/.claude.json`
- `write_file_as_text` rejects system paths
- `read_file_as_text` rejects traversal
- `~Desktop/` rejected (not in allowlist)
- `load_session_history` rejects arbitrary paths
- `load_session_history` rejects traversal within allowed prefix
- `load_session_history` accepts valid `~/.claude/projects/` path

**Cargo.toml:** `tauri = { features = ["test"] }` + `[dev-dependencies] tokio` with rt+macros.

---

### Phase 3 — Structural Splits

**CSS split** — `src/styles.css` (1967 LOC) → 5 feature modules:

| File | LOC | Contents |
|------|-----|----------|
| `src/styles/base.css` | 973 | Root vars, reset, layout, sidebar, messages, slash menu, input bar, overlays, settings, attachments, session prompt, accessibility |
| `src/styles/cards.css` | 428 | Session cards, pixel sprites, familiar profile card (fc-*, fc-confirm-*) |
| `src/styles/companion.css` | 159 | Vexil panel, ASCII sprite, companion bubble |
| `src/styles/history.css` | 206 | Session LIVE/HIST tabs, history view, history find bar |
| `src/styles/voice.css` | 201 | Omi indicator, voice log, oracle pre-session chat |

Total: 1967 lines — zero-loss split (verified by line count). `src/index.html` updated to load all 5.

**Rust split** — `src-tauri/src/lib.rs` (862 LOC) → 4 files:

| File | Contents |
|------|----------|
| `commands/file_io.rs` | `expand_and_validate_path`, `encode_base64`, read/write/append/base64 IPC commands |
| `commands/history.rs` | `scan_session_history`, `load_session_history`, all history helpers |
| `commands/misc.rs` | `SpawnedPids`, slash command readers, `send_signal`, `js_log` |
| `lib.rs` | Module declarations, `run()`, `set_squircle_dock_icon`, `#[cfg(test)]` |

`SpawnedPids` given a `new()` constructor; all command functions made `pub` for handler registration and test access.

---

## Test Results

```
cargo test   → 15/15  (Rust — path validation, load_session_history)
npm test     → 15/15  (JS — dom.test.js × 6, nim.test.js × 9)
```

---

## What's Left Before Merge

- [ ] `npm run tauri dev` — visual smoke test, CSS regression check
- [ ] Vexil daemon: confirm writes to `~/.local/share/pixel-terminal/vexil_feed.jsonl`

## What's Left for PR 2 (future)

Per `docs/preaudit/PRE_AUDIT_SUMMARY.md`:
- Split `src/styles.css` further if needed *(done above)*
- `src/attachments.js`: add `cleanupSession(id)` + call on session destroy (memory leak fix)
- CI: `.github/workflows/test.yml` — `cargo test` + `npm test` on push
