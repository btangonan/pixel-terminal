# PRE_AUDIT_SUMMARY — Pixel Terminal
**Date**: 2026-04-04 | **Branch**: feat/familiar-card-phase2 | **Auditor**: Claude Sonnet 4.6 + Gemini Adversarial

---

## Repo Shape
Single-repo Tauri v2 desktop app (macOS). Vanilla JS frontend (no framework, no bundler),
Rust backend, Python daemon. ~25 source files excluding build artifacts and sprites.

---

## Stage 8: Maturity Scores (Post-Adversarial)

| Dimension | Score | /3 | Notes |
|-----------|-------|----|-------|
| LOC Discipline | 0 | ░░░ | 12/25 files >300 LOC, styles.css 1967 LOC |
| Validation Coverage | 0 | ░░░ | Zero input validation on Tauri IPC commands |
| Secrets Hygiene | 2 | ██░ | No secrets; CSP=null; no lint enforcement |
| State & Persistence | 1 | █░░ | In-memory sessions + localStorage + active attachment leak |
| Errors/Retry/Idempotency | 1 | █░░ | Rust Result good; JS has 10+ silent catch blocks |
| Testing/CI | 0 | ░░░ | No framework, no CI |
| **TOTAL** | **4/18** | **22%** | Early/Prototype Stage |

---

## Stage 9: Adversarial Cross-Model Review

### Contested Findings (DISAGREEs)

**⚠ CONTESTED — Validation Coverage 0/3**
Gemini argued DOMPurify use on message stream contradicts 0%. **Claude rebuts**: DOMPurify
sanitizes HTML output from LLM content. The 0% validation claim is specifically about
Tauri IPC command *inputs* (path, pid, signal parameters on the Rust side). These are
different layers. **Score 0 stands.**

**✓ CONCEDED — cards.js innerHTML: HIGH → CRITICAL**
Gemini correctly identified that `f.name`/`f.species` are interpolated into `dialog.innerHTML`
(cards.js:225) without DOMPurify. Both fields originate from `.claude.json`/`buddy.json` —
user-controlled / potentially network-sourced files. In a CSP=null webview with unrestricted
IPC (read_file, send_signal), this is a full XSS→RCE chain. **Upgraded to CRITICAL.**

**✓ CONCEDED — State 1/3: attachment leak makes it worse**
Gemini found the attachments.js Map leak is an active memory degradation, not just crash-loss.
Score stays 1 (no change to criteria), but the leak is promoted to a named risk.

**✓ CONCEDED — LOC in top-5 risks: Gemini CRITICAL findings should displace it**
/tmp symlink attack and thread safety race in vexil_master.py are more severe than LOC count.
LOC concerns remain in hotspots.md but no longer occupy a top-5 risk slot.

### Gemini CRITICAL findings confirmed (high confidence)

| # | Finding | File | Severity |
|---|---------|------|----------|
| G1 | /tmp/vexil_feed.jsonl symlink attack — daemon appends to world-writable path | scripts/vexil_master.py | CRITICAL |
| G2 | Thread safety race — dict iterated by oracle worker while main loop modifies | scripts/vexil_master.py | CRITICAL |

### Gemini WARNING findings (medium confidence)
- `attachments.js` Map never cleaned up on session destroy — memory leak over long sessions
- `app.js` setInterval 400ms runs even when app hidden — CPU waste

---

## Final Top 5 Risks (Post-Adversarial)

### 🔴 CRITICAL 1 — send_signal: Arbitrary Process Kill
**File**: `src-tauri/src/lib.rs:488`
`send_signal(pid: u32, signal: i32)` — any JS in the webview can send any UNIX signal
to any PID on the system. No allowlist, no pid range check, no signal allowlist.
**Fix**: Restrict to child PIDs the app spawned (store in Tauri State). Never accept arbitrary pid.

### 🔴 CRITICAL 2 — Unrestricted File Read/Write IPC
**Files**: `src-tauri/src/lib.rs:32,39,45,54`
`read_file_as_text(path)`, `write_file_as_text(path, content)`, etc. — no path sandboxing.
Webview JS can read `~/.ssh/id_rsa`, `~/.claude.json`, write to any directory.
**Fix**: Enforce path prefix allowlist (e.g., `~/Projects/`, `~/.config/pixel-terminal/`).

### 🔴 CRITICAL 3 — cards.js XSS → RCE via unsanitized innerHTML *(Gemini escalated)*
**File**: `src/cards.js:225`, `src-tauri/tauri.conf.json` (csp: null)
`dialog.innerHTML` interpolates `f.name` / `f.species` without DOMPurify. These fields
come from `.claude.json` / `buddy.json`. CSP=null + unrestricted IPC = XSS becomes RCE.
**Fix**: Use `document.createElement` + `textContent` OR escape all interpolations. Set CSP.

### 🔴 CRITICAL 4 — /tmp symlink attack in vexil daemon *(Gemini — high confidence)*
**File**: `scripts/vexil_master.py`, `scripts/start_vexil_daemon.py`
Daemon uses `/tmp/vexil_feed.jsonl` and `/tmp/vexil_master.log` — world-writable paths.
A symlink at either path redirects daemon writes to arbitrary files (e.g., `~/.ssh/authorized_keys`).
**Fix**: Move runtime files to `~/.local/share/pixel-terminal/` or `$TMPDIR/<uuid>/`.

### 🔴 CRITICAL 5 — Thread safety race in vexil daemon *(Gemini — high confidence)*
**File**: `scripts/vexil_master.py` (main loop + oracle worker thread)
`recent_activity` dict is modified by main loop and iterated by oracle worker without a lock.
`RuntimeError: dictionary changed size during iteration` will crash the daemon.
**Fix**: Use `threading.Lock()` or snapshot with `list(recent_activity.items())`.

---

## Top 3 Strengths

1. **DOMPurify + marked.js on message stream** — `dom.js:8` sanitizes all LLM output before injection.
2. **Rust Result<T,String> propagation** — All Tauri commands return typed results to JS.
3. **WebSocket bound to 127.0.0.1** — Voice bridge inaccessible from external network.

---

## 2-PR Minimum Fix Plan

### PR 1 — Security Hardening (URGENT)
**Acceptance criteria**: No arbitrary pid/path/signal from webview. No /tmp symlink risk. Daemon thread-safe.
- `src-tauri/src/lib.rs`: Add path prefix allowlist to all file IPC commands
- `src-tauri/src/lib.rs`: Restrict `send_signal` to managed child PIDs (Tauri State)
- `src-tauri/tauri.conf.json`: Set minimal CSP (`default-src 'self'`)
- `src/cards.js:225`: Replace `dialog.innerHTML` with safe DOM construction
- `scripts/vexil_master.py`: Move /tmp paths → `~/.local/share/pixel-terminal/`
- `scripts/vexil_master.py`: Add `threading.Lock` around `recent_activity` access
- Files: `lib.rs`, `tauri.conf.json`, `cards.js`, `vexil_master.py`

### PR 2 — LOC + Cleanup (After Security)
**Acceptance criteria**: styles.css split, lib.rs split, attachment leak fixed.
- Split `src/styles.css` → `base.css`, `cards.css`, `companion.css`, `history.css`, `voice.css`
- Split `src-tauri/src/lib.rs` → `commands/file_io.rs`, `commands/history.rs`, `commands/misc.rs`
- `src/attachments.js`: Add `cleanupSession(id)` export + call on session destroy
- Files: new CSS/RS modules + `attachments.js`

---

## Artifacts
- `repo-shape.json` — repo type, languages, infra
- `file-inventory.json` — all files with LOC
- `hotspots.md` — top files by LOC
- `frameworks.json` — IPC surface, shell spawns
- `api-validation.json` — validation coverage analysis
- `secrets-findings.json` — secret scan results
- `state-map.md` — persistence architecture
- `error-surface.md` — error handling analysis
- `test-landscape.md` — test coverage
- `ci-signals.json` — CI/CD analysis
- `maturity.json` — maturity scores (0-3)
