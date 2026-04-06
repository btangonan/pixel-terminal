# Security Audit Report: Anima (pixel-terminal)

**Date**: 2026-04-06
**Scope**: Pre-publication security review for btangonan/anima (public GitHub)
**Auditor**: Claude Code (Security Engineer persona)
**Commit**: HEAD of main branch

---

## Executive Summary

The codebase is in good shape for a public release. No hardcoded secrets or API keys were found. XSS mitigation is solid (DOMPurify + consistent `esc()` usage). File I/O has a well-designed path allowlist with symlink canonicalization. The main findings are a shell injection vector in the voice bridge, an overly broad `/bin/sh` spawn permission, and some PII in files that .gitignore already excludes.

**CRITICAL**: 1 finding
**WARNING**: 5 findings
**NOTE**: 5 findings

---

## CRITICAL

### C1. Shell Injection via localStorage `voiceBridgePath`

**File**: `/src/voice.js` line 330-331
**Severity**: CRITICAL

```javascript
const bridgePath = localStorage.getItem('voiceBridgePath');
const bridgeCmd = `cd ${bridgePath} && source venv/bin/activate && python3 pixel_voice_bridge.py`;
Command.create('sh', ['-c', bridgeCmd]).execute();
```

The `voiceBridgePath` value is read from localStorage and interpolated directly into a shell command without any sanitization. If an attacker can write to localStorage (e.g., via a crafted `tauri://` deep link, or if any XSS is found in the future), they achieve arbitrary shell command execution.

**Remediation**: Validate that `bridgePath` matches an expected pattern (e.g., starts with `/`, contains no `;`, `&&`, `|`, backticks, or `$()`). Better: split the command into discrete steps rather than passing a compound shell string. Best: use `Command.create('python3', [...])` with explicit `cwd` set to the bridgePath, avoiding `/bin/sh -c` entirely.

---

## WARNING

### W1. `/bin/sh` with `args: true` in Tauri Capabilities

**File**: `/src-tauri/capabilities/default.json` lines 47-49
**Severity**: WARNING

```json
{
  "name": "sh",
  "cmd": "/bin/sh",
  "args": true,
  "sidecar": false
}
```

`args: true` means ANY arguments can be passed to `/bin/sh`, including `-c "<arbitrary command>"`. This is the broadest possible shell permission. While the Tauri frontend context is trusted (same-origin only, no remote URLs), this effectively grants the webview full shell access. If any XSS or prototype pollution is ever found, the blast radius is complete system compromise.

**Remediation**: If `/bin/sh` is only used for the voice bridge, consider replacing it with a scoped Rust command that validates the exact invocation. At minimum, restrict `args` to an explicit pattern instead of `true`.

### W2. `--permission-mode bypassPermissions` Passed to Claude CLI

**File**: `/src/session-lifecycle.js` line 99
**Severity**: WARNING

```javascript
'--permission-mode', 'bypassPermissions',
```

All Claude sessions are spawned with permission bypass. This means any tool use (file writes, bash commands, etc.) inside Claude sessions runs without user confirmation. This is a design choice for UX, but it should be documented clearly for users of a public repo, as it means running Anima effectively grants Claude unrestricted access to the user's system within Claude's own scope.

**Remediation**: Document this prominently in README or a SECURITY.md. Consider making it configurable (a settings toggle between `bypassPermissions` and `default`).

### W3. `get_file_size_any` Command Has No Path Restrictions

**File**: `/src-tauri/src/commands/file_io.rs` lines 127-135
**Severity**: WARNING

```rust
pub fn get_file_size_any(path: String) -> Result<u64, String> {
    fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}
```

This command accepts any filesystem path without validation. While `fs::metadata()` only returns inode/stat data (no file contents), it still reveals:
- Whether a file exists (oracle attack)
- File sizes of sensitive files (e.g., `~/.ssh/id_rsa`, `/etc/shadow`)
- Can be used to probe the filesystem structure

The comment says it is for the attachment OOM guard on drag-dropped files from anywhere. That is a legitimate use case, but the command should still validate input.

**Remediation**: At minimum, block path traversal (`../`) and reject paths to known sensitive directories (`~/.ssh/`, `~/.gnupg/`, `/etc/`). Or restrict to paths the user explicitly drag-dropped by having the frontend pass a Tauri-validated drop event path rather than a raw string.

### W4. CSP Allows `unsafe-inline` for Both Scripts and Styles

**File**: `/src-tauri/tauri.conf.json` line 23
**Severity**: WARNING

```
script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'
```

`unsafe-inline` for `script-src` weakens XSS protections. If any HTML injection path exists (even if DOMPurify catches it now), `unsafe-inline` means injected `<script>` tags or event handlers would execute.

**Remediation**: Tauri v2 apps with `withGlobalTauri: true` may require `unsafe-inline` for the IPC bridge. Verify whether removing it breaks functionality. If it must stay, document why. For `style-src`, `unsafe-inline` is lower risk but still worth documenting.

### W5. PII in Files Tracked by Git (Covered by .gitignore)

**Files affected** (currently in .gitignore -- will NOT be pushed):
- `STATE.md` line 14: `com.bradleytangonan.anima` (bundle ID)
- `CLAUDE.md`: Contains personal workflow details
- `backups/`: Contains session transcripts
- `launch.command`: Contains local path references

**Files that WILL be pushed and contain PII**:
- `/src/index.html` line 24: `v0.1.0 — BRADLEY TANGONAN`
- `/README.md` line 115: `MIT (c) Bradley Tangonan`
- `/README.md` lines 14, 19, 71, 80: `github.com/btangonan/anima`
- `/scripts/gen_sync_buddy_vectors.ts` line 119: `'bradley-tangonan-pixel-terminal-2026'`
- `/src-tauri/tests/fixtures/sync_buddy_vectors.json` line 18188: `"bradley-tangonan-pixel-terminal-2026"`

**Assessment**: The README author attribution and GitHub username are intentional and expected for an open-source project. The `gen_sync_buddy_vectors.ts` test string is a seed identifier -- not sensitive but worth noting. The about dialog in `index.html` is intentional branding.

**Remediation**: Confirm these are all intentional. The .gitignore properly excludes CLAUDE.md, STATE.md, backups/, launch.command, claudedocs/, and .claude/. No action needed unless you want to pseudonymize the test fixture seed.

---

## NOTE

### N1. DOMPurify XSS Sanitization Is Properly Applied

**Files**: `/src/dom.js` line 8, `/src/messages.js` lines 139-170

Claude markdown output passes through `DOMPurify.sanitize(marked.parse(text))` before innerHTML injection. User messages and tool names use `esc()` which escapes `&`, `<`, `>`, `"`. The `voice.js` module has its own `escapeHtml()` with the same escaping. The `history.js` module has `escHtml()`.

This is well-implemented. No XSS vector was found in the current innerHTML usage.

### N2. Attachment `a.id` Used in `data-id` Attribute Without Escaping

**File**: `/src/attachments.js` lines 255, 258

```javascript
`<span class="att-token" data-id="${a.id}">`
```

The `a.id` is generated internally (not from user input) via the attachment store. This is not exploitable in practice since `data-*` attributes don't execute code, and the ID is app-generated. But for defense-in-depth, it should use `esc()`.

**Remediation**: Wrap `a.id` in `esc()`: `data-id="${esc(a.id)}"`.

### N3. Path Traversal Check Is Incomplete (Double-Encoded Sequences)

**File**: `/src-tauri/src/commands/file_io.rs` line 20

```rust
if path.contains("/../") || path.ends_with("/..") || path.starts_with("../") {
```

This blocks simple `../` traversal but misses:
- URL-encoded variants (`%2e%2e%2f`) -- unlikely in this context but worth noting
- `..` at the start without slash prefix (handled by the `starts_with("../")` check)

The symlink canonicalization on line 64-74 provides a strong second layer of defense that catches bypasses. The current implementation is acceptable.

### N4. npm Audit Clean, cargo-audit Not Installed

- `npm audit`: 0 vulnerabilities
- `cargo audit`: Not installed. Recommend installing (`cargo install cargo-audit`) and running before release.

**Remediation**: `cargo install cargo-audit && cd src-tauri && cargo audit`

### N5. `.gitignore` Coverage Is Good But Missing `.env`

The .gitignore excludes `.claude/`, `backups/`, `STATE.md`, `CLAUDE.md`, `launch.command`, `claudedocs/`, `docs/preaudit/`, `docs/transcripts/`. However, it does not explicitly list `.env` files.

**Remediation**: Add `.env` and `.env.*` to `.gitignore` as a preventive measure, even though no .env files currently exist.

---

## Summary Table

| ID | Severity | Finding | File | Fix Effort |
|----|----------|---------|------|------------|
| C1 | CRITICAL | Shell injection via localStorage voiceBridgePath | src/voice.js:330 | Low |
| W1 | WARNING | /bin/sh args:true in capabilities | capabilities/default.json:47 | Medium |
| W2 | WARNING | bypassPermissions on all Claude sessions | session-lifecycle.js:99 | Low (docs) |
| W3 | WARNING | get_file_size_any has no path restrictions | file_io.rs:131 | Low |
| W4 | WARNING | CSP unsafe-inline for script-src | tauri.conf.json:23 | Medium |
| W5 | WARNING | PII in shipped files (intentional) | index.html, README.md | None |
| N1 | NOTE | DOMPurify properly applied (positive) | dom.js, messages.js | None |
| N2 | NOTE | Unescaped a.id in data attribute | attachments.js:255 | Trivial |
| N3 | NOTE | Path traversal check adequate with canonicalize | file_io.rs:20 | None |
| N4 | NOTE | cargo-audit not installed | -- | Trivial |
| N5 | NOTE | .env not in .gitignore | .gitignore | Trivial |

---

## Secrets Scan Results

- **API keys**: None found in any source file
- **Hardcoded tokens**: None (all `token` references are UI token counters or CSS tokenizers)
- **Private keys / certificates**: None
- **Hardcoded absolute paths to user directories**: None in committed source files (only in .gitignore-excluded files)
- **Git history**: No secrets found in commit diffs for `sk-`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`
- **Deleted sensitive files**: None found in git history

## File Permission Check

No world-writable (777) or group-writable files found outside node_modules and target.

---

## Recommended Pre-Publication Checklist

1. **[MUST]** Fix C1: Sanitize `voiceBridgePath` before shell interpolation
2. **[SHOULD]** Add `.env` / `.env.*` to .gitignore
3. **[SHOULD]** Install and run `cargo audit`
4. **[SHOULD]** Add SECURITY.md documenting the `bypassPermissions` design choice
5. **[SHOULD]** Consider tightening the `/bin/sh` capability args
6. **[NICE]** Escape `a.id` in attachments.js data attributes
7. **[NICE]** Add path validation to `get_file_size_any`
