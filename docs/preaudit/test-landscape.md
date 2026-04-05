# Test Landscape

## Test Framework
None. No Jest, Vitest, Playwright, Rust #[test], or other framework present.

## Existing Test Coverage
### test_auto.cjs (220 LOC)
- Type: Bespoke smoke test (Node.js, CJS)
- Coverage: Structural/static assertions only
  - File existence checks
  - JSON parse validation (capabilities)
  - Source code pattern matching (grep-style checks)
  - No behavioral tests, no render tests, no IPC tests

### Checks present in test_auto.cjs
- /bin/test executable exists
- .pixel-terminal sentinel exists
- capabilities.json parses, spawn entries correct
- Deleted dead files (main.js, sprites/) confirmed absent
- app.js structural patterns (scheduleScroll, DocumentFragment, etc.)
- styles.css patterns (.msg-new, @keyframes fadeIn)
- Omi toggle checks (pattern)

### What's NOT tested
- Session spawn/kill lifecycle (behavioral)
- Claude stdout stream parsing
- Tauri IPC commands (read_file, write_file, send_signal)
- Voice WebSocket bridge
- Companion buddy.json load / render
- History scan / load
- Nim balance accrual
- Familiar card generation

## CI/CD
No .github/workflows found. No CI configuration of any kind.

## Manual Test Process
- launch.command script → runs app + daemon + tees to /tmp/pixel-terminal.log
- TEST_CHECKLIST.md (manual QA checklist present — 35 items)
- No automated regression gate

## Summary
Testing relies entirely on manual QA + one structural smoke test.
Zero behavioral coverage. Zero CI. Regressions go undetected until manual review.
