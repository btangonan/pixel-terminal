# Error Surface Analysis

## Rust Backend (lib.rs, ws_bridge.rs)
- **Pattern**: `Result<T, String>` with `.map_err(|e| e.to_string())?`
- **Quality**: Good — errors propagate to JS as rejected promises
- **Gaps**: `unwrap_or_default()` used for HOME env var (silent fallback, not logged)
- **WS Bridge**: bind failure → `eprintln!` + return (no Tauri event emitted to UI)

## JavaScript Frontend
### Silent swallows (high risk)
```
catch (_) {}   — used 10+ times across session-lifecycle.js, session.js, events.js, app.js
```
Specific cases:
- `src/session-lifecycle.js:111` — JSON.parse errors on Claude stdout silently dropped
- `src/session-lifecycle.js:161,172,227,286,313` — child.kill() failures all silent
- `src/session.js:248` — ws_bridge connection failure silent

### Logged errors
- `src/session-lifecycle.js:148,417,486` — `catch (err)` with `console.error`
- `src/session.js:224` — `console.warn('isSelfDirectory check failed', e)`

### Error propagation to UI
- Status changes (`setStatus`) used to signal error states to the session card
- No toast/alert system for error visibility to the user

## No Retry Logic
- Claude subprocess exits → session marked error/idle, no auto-retry
- WebSocket voice disconnects → no reconnect loop (client must reconnect manually)

## No Structured Error Format
- No Problem+JSON or similar
- Errors are plain strings from Rust or silent catch in JS

## Summary
| Layer | Error Quality |
|-------|--------------|
| Rust commands | Score 2 — Result<T,String>, propagates to JS |
| JS catch coverage | Score 1 — present but mostly silent |
| Error visibility to user | Score 1 — status text only, no structured UX |
| Retry/backoff | Score 0 — none |
| Idempotency | Score 0 — none |
