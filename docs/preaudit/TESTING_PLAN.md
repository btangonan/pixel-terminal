# Testing Implementation Plan — pixel-terminal
**Date**: 2026-04-04 | **Grade**: B → A (post-introspect)

---

## Context

Tauri v2 macOS desktop app. Vanilla JS frontend (ES modules, no bundler). Rust backend.
- Current state: 0/3 testing maturity, one smoke test (`test_auto.cjs`), no CI, no framework
- macOS WKWebView has no native WebDriver support — tauri-driver E2E is unavailable on macOS
- Stack confirmed by research: **Vitest + jsdom** for JS, **cargo test + tauri::test** for Rust

---

## Audit Risks to Test Against (Priority Order)

From `docs/preaudit/PRE_AUDIT_SUMMARY.md`:

| # | Risk | File | Severity |
|---|------|------|----------|
| 1 | `send_signal(pid, signal)` — no PID allowlist | `src-tauri/src/lib.rs:488` | CRITICAL |
| 2 | Unrestricted file read/write IPC — no path sandbox | `src-tauri/src/lib.rs:32,39,45,54` | CRITICAL |
| 3 | `cards.js:225` XSS via unescaped innerHTML + CSP=null | `src/cards.js` | CRITICAL |
| 4 | `mdParse` XSS defense — DOMPurify on LLM stream | `src/dom.js:8` | HIGH (verify it works) |
| 5 | `/tmp` symlink attack in vexil daemon | `scripts/vexil_master.py` | CRITICAL |

---

## What NOT to Do First (Introspect Finding)

**Do not start with nim.js and encode_base64.**
Those are the safest, most trivially correct functions in the codebase. Testing them produces
a green checkmark that implies safety where safety gaps actually exist. Availability bias
made them feel like the right start — they're not.

---

## Correct Sequence

### Phase 1 — Security Fix + Tests Together (highest priority)
Ship the audit PR 1 security fixes *with* tests that validate the constraints.
Tests and fix ship together — regression-proof from day one.

**Files to change:**
- `src-tauri/src/lib.rs` — add path allowlist to file IPC commands + `#[cfg(test)]` module
- `src-tauri/Cargo.toml` — add `features = ["test"]` to tauri dep, tokio dev-dep
- `src-tauri/tauri.conf.json` — set minimal CSP
- `src/cards.js:225` — replace `dialog.innerHTML` with safe DOM construction

**Rust tests to write (validates the security fix, not just happy paths):**
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_file_rejects_path_traversal() {
        let result = read_file_as_text("../../../etc/passwd".to_string());
        assert!(result.is_err(), "path traversal should be rejected");
    }

    #[test]
    fn test_write_file_rejects_system_paths() {
        let result = write_file_as_text("/etc/hosts".to_string(), "evil".to_string());
        assert!(result.is_err(), "writes outside allowed paths should be rejected");
    }

    #[test]
    fn test_path_allowlist_accepts_valid_project_path() {
        // Should NOT error on valid allowed prefix
        // (use a /tmp test file within allowed range)
    }
}
```

**Cargo.toml additions:**
```toml
[dependencies]
tauri = { version = "2", features = ["test"] }

[dev-dependencies]
tokio = { version = "1", features = ["rt", "macros"] }
```

---

### Phase 2 — Vitest Setup + XSS Defense Tests
**Files to change:**
- `package.json` — add vitest, jsdom, @tauri-apps/api devDeps; add `"test": "vitest run"` script
- `vite.config.js` (NEW) — minimal config: `{ test: { globals: true, environment: 'jsdom' } }`
- `src/dom.js` — **REFACTOR REQUIRED FIRST**: move `window.marked.parse.bind(...)` inside
  `mdParse()` instead of module scope. Otherwise the import throws in jsdom (window.marked
  is undefined at module load time) and ALL dom.js tests fail — including esc() and toolHint().
- `tests/dom.test.js` (NEW) — after dom.js refactor, this is the highest-value JS test:

```js
// The one test worth writing — validates primary XSS defense layer
test('mdParse strips script tags from LLM output', () => {
  const result = mdParse('<script>alert(1)</script>hello');
  expect(result).not.toContain('<script>');
  expect(result).toContain('hello');
});

test('esc() escapes HTML special chars', () => {
  expect(esc('<b>&"')).toBe('&lt;b&gt;&amp;&quot;');
});

test('esc(null) does not throw', () => {
  expect(() => esc(null)).not.toThrow();
});

test('toolHint extracts file_path from JSON', () => {
  expect(toolHint('Read', '{"file_path":"/foo/bar.js"}')).toBe('bar.js');
});

test('toolHint returns truncated string on non-JSON', () => {
  expect(toolHint('x', 'not json')).toBe('not json');
});
```

- `tests/nim.test.js` (NEW) — useful but not urgent:

```js
test('getNimBalance returns 0 when empty', ...);
test('addNim(0) is a no-op', ...);
test('spendNim(0) always returns true', ...);
test('spendNim deducts when affordable', ...);
test('spendNim returns false when insufficient', ...);
test('accrueNimForSession earns nim per 1000 tokens', ...);
```

---

### Phase 3 — CI (stretch goal)
- `.github/workflows/test.yml` — run `cargo test` + `npm test` on push to main/feat branches
- Linux runner required for any WebDriver tests in future

---

## Setup Commands

```bash
# JS testing
npm i -D vitest jsdom @tauri-apps/api

# Rust testing (no install needed — cargo test is built in)
# Just update Cargo.toml as above

# Run tests
npm test                          # Vitest
cd src-tauri && cargo test        # Rust
node test_auto.cjs                # Existing smoke test
```

---

## Key Insight from Introspect

> "Testing currency math does not make the app more secure."
> The audit found 5 CRITICALs. Test the fixes for those first.
> A test that would catch a regression in something dangerous
> is worth more than 8 tests on something that already works.

**The single most valuable test to write:**
```js
test('mdParse strips script injection from LLM output', ...)
```
This validates the primary XSS defense layer. More valuable than all nim tests combined.
