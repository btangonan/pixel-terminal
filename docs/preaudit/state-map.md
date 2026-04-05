# State & Persistence Map

## In-Memory (Lost on Crash)
- `sessions: Map<id, SessionObj>` — active session state (src/session.js)
  - child process ref, status, tokens, messages array
  - Cleared on app close — no crash recovery
- Voice state (src/voice.js): `voiceMode`, `isPTTHeld`, `voiceSource` vars

## localStorage (Persisted, Browser-scoped)
| Key | Purpose | File |
|-----|---------|------|
| `pixel-terminal-nim` | Nim token balance | src/nim.js |
| `voiceSource` | Voice source preference (mic/omi) | src/voice.js |
| `familiar-reroll-{path}` | Reroll count per project | src/session.js |
| `sidebar-session-list-h` | Sidebar panel height | src/app.js |

## File-Based Persistence (Durable)
| Path | Read/Write | Purpose |
|------|-----------|---------|
| `~/.claude/projects/*/sessions/*.jsonl` | Read-only | Claude session history |
| `~/.config/pixel-terminal/buddy.json` | Read (write via script) | Companion identity |
| `/tmp/vexil_feed.jsonl` | Write (append) | Daemon trigger feed |
| `/tmp/vexil_lint.json` | Read (poll) | Lint violations for companion |
| `/tmp/pixel-terminal.log` | Write (tee) | Live debug log |

## WebSocket (Transient)
- `ws://127.0.0.1:9876` — voice client connections, state not persisted

## Key Gaps
1. **No session crash recovery** — if app crashes mid-session, in-progress Claude output is lost
2. **Nim balance in localStorage** — can be lost if browser storage is cleared; no server backup
3. **No idempotency** on session spawn — double-spawn possible if UI fires twice
4. **/tmp paths** — cleared on reboot; daemon state not persisted across reboots
