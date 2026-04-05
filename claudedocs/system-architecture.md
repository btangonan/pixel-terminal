# pixel-terminal — System Architecture
**Last updated**: 2026-04-04

---

## Overview

pixel-terminal is a Tauri desktop app that wraps Claude Code in a custom terminal UI with voice input via Omi pendant or Mac mic. Three processes run concurrently and communicate over stdio and WebSocket.

```
┌─────────────────────────────────────────────────────────────┐
│  pixel-terminal (Tauri)                                      │
│  ┌──────────────┐    Tauri events    ┌────────────────────┐ │
│  │  app.js      │ ◄────────────────► │  ws_bridge.rs      │ │
│  │  (frontend)  │    invoke()        │  (Rust backend)    │ │
│  └──────┬───────┘                    └────────┬───────────┘ │
│         │ stdio JSON                          │ WebSocket    │
│         ▼                                     │ port 9876   │
│  ┌──────────────┐                             │             │
│  │  Claude Code │                             │             │
│  │  (subprocess)│                             │             │
│  └──────────────┘                             │             │
└───────────────────────────────────────────────┼─────────────┘
                                                │
              ┌─────────────────────────────────┘
              │
┌─────────────▼──────────────────────────────────────────────┐
│  OmiWebhook/pixel_voice_bridge.py (Python)                  │
│  BLE mode: Omi pendant → opuslib decode → faster-whisper    │
│  Mic mode: MacBook Pro Microphone → faster-whisper           │
│  tiny.en, int8, VAD filter, 2s chunks                       │
└────────────────────────────────────────────────────────────┘
```

---

## Process Map

| Process | Repo | Launch | Restarts |
|---------|------|--------|----------|
| Tauri app | `pixel-terminal/` | `launch.command` → `npm run tauri dev` | Manual |
| Voice bridge | `OmiWebhook/` | `launch.command` → Terminal tab | Auto (5s retry loop) |
| OmiWebhook (cloud) | `OmiWebhook/` | `launch.command` → `start.sh` | Auto |
| Claude Code | subprocess | Tauri spawns per session | On demand |

**Startup sequence** (`launch.command`):
1. Kill existing instances
2. Open Terminal tab → `start.sh` (OmiWebhook cloud path)
3. Open Terminal tab → poll `nc -z 127.0.0.1 9876` until pixel-terminal WS ready, then `pixel_voice_bridge.py --ble`
4. `npm run tauri dev` in main window

---

## Frontend Modules

| Module | LOC | Responsibility |
|--------|-----|----------------|
| `src/app.js` | ~270 | Bootstrap only — wires all modules, no business logic |
| `src/session.js` | ~200 | Session state, Maps, ANIMALS, SpriteRenderer, identity seq |
| `src/session-lifecycle.js` | ~244 | createSession, spawnClaude, sendMessage, pickFolder |
| `src/events.js` | ~260 | Claude CLI event handler — streaming, tools, status, rate limits |
| `src/messages.js` | ~140 | Message rendering, pushMessage(), scroll, working cursor |
| `src/cards.js` | ~120 | Session card render, setActiveSession, dots animation |
| `src/dom.js` | ~90 | DOM cache ($), esc(), mdParse, toolHint, toolIcon, showConfirm |
| `src/attachments.js` | ~325 | File drag-drop, staging, panel, token pills, context menu |
| `src/voice.js` | ~240 | Voice bridge, PTT, always-on, omi indicator, settings |
| `src/slash-menu.js` | ~180 | Slash command menu, autocomplete, flag tokens |

---

## Claude CLI Subprocess

### Spawn args (`session-lifecycle.js: spawnClaude`)
```javascript
[
  '-p',                           // pipeline/non-interactive mode
  '--input-format',  'stream-json',
  '--output-format', 'stream-json',
  '--verbose',                    // emits low-level streaming events (content_block_delta etc.)
  '--permission-mode', 'bypassPermissions',  // allows Bash + all tools — required for tool execution
]
// read-only sessions add: '--disallowed-tools', 'Edit,Write,MultiEdit,NotebookEdit,Bash'
```

**CRITICAL**: `acceptEdits` does NOT allow Bash in `-p` pipeline mode. Claude silently can't execute shell commands → gives hedged non-answers. `bypassPermissions` is required for Claude to run code, matching interactive terminal behavior. GUI wrapper is safe: user sees all tool rows in the UI.

### Stdin/Stdout Protocol
- **Input**: newline-delimited JSON `{"type":"user","message":{"role":"user","content":"..."}}`
- **Content** can be string (plain text) or array (multimodal with image base64 for attachments)
- **Output**: newline-delimited JSON events (see Event Types below)

### Event Types (stream-json --verbose)

Low-level streaming (arrive incrementally as Claude generates):

| Event | When | Handler |
|-------|------|---------|
| `content_block_start` | Start of text or tool_use block | Show tool row immediately (input TBD); init stream state for text |
| `content_block_delta` | Each text token | Append to `_streamText`; coalesced DOM update via rAF at ~60fps |
| `content_block_stop` | End of block | Cancel pending rAF; markdown-render final text; clear stream state |

High-level aggregated (arrive after all block_stop events):

| Event | When | Handler |
|-------|------|---------|
| `assistant` | Full response assembled | Skip text if already streamed (`_didStreamText`); backfill tool hints; update token counters |
| `user` | Tool result returned | Update `tool_status` glyph (… → ✓); decrement `toolPending` |
| `result` | Turn complete | Add to token count; debounce 400ms → idle |
| `system` | Init / model announcement | Show "Ready · model" label; flush `_pendingMsg` |
| `rate_limit_event` | API rate limited | Flash badge 'waiting' for 3s (CLI retries automatically — no permanent log entry) |

### Streaming Text Pipeline
```
API tokens → CLI writes content_block_delta lines → Tauri Shell read task
  → IPC (~1-5ms) → JS stdout callback → line buffer → handleEvent()
  → _streamText += delta.text (memory, instant)
  → rAF scheduled (first time per frame only)
  → requestAnimationFrame fires → bubble.textContent = _streamText (DOM, 60fps)
  → content_block_stop → cancelAnimationFrame → mdParse → bubble.innerHTML
```

vs terminal:
```
API tokens → CLI stdout → PTY → terminal emulator → screen (~0ms overhead)
```

IPC overhead: ~1-5ms per chunk, imperceptible at 50-100 tokens/sec. Perceptual parity achieved.

---

## Oracle (Pre-Session Chat)

A persistent `claude` subprocess that handles the Vexil chat bubble before any session is open. Spawned once at `vexil_master.py` startup — stays alive all day.

### Why persistent
Previous design called `subprocess.run(['claude', '-p', ...])` per query — 5–10s cold start every time. Persistent process amortizes startup cost: first response ~2–3s, subsequent ~1–2s (API latency only).

### Spawn args (`vexil_master.py: call_claude_oracle`)
```python
['claude', '-p', '--bare', '--model', 'claude-sonnet-4-6']   # sessions open
['claude', '-p', '--bare', '--model', 'claude-haiku-4-5-20251001']  # no sessions
```

**`-p` plain-text mode is required.** Stream-json flags (`--input-format/output-format stream-json`) are session-mode invocation — they require a running Claude Code parent process for auth. The Python daemon is external to Claude Code and cannot provide that context. Plain-text `-p` uses a lighter auth path that works from any process.

**`--bare` is required.** Without it, the default Claude Code system prompt bleeds into oracle responses, overriding the Vexil persona.

**NOT a persistent process.** One subprocess per query. Latency: ~2-5s (API only after subprocess spawn). Persistent process was attempted and abandoned — see auth constraint above.

### Message flow
```
voice.js submit()
  → invoke('write_file_as_text', ORACLE_QUERY_PATH)   # write query JSON to /tmp/oracle_query.json

vexil_master.py main loop (1s poll)
  → detects oracle_query.json mtime change
  → spawns _oracle_worker thread (non-blocking)
    → builds context blob (persona + sessions + live_ctx)
    → stdin.write({"type":"user","message":{"role":"user","content":"..."}}\n)
    → stdin.flush()
    → oracle_reader_thread accumulates content_block_delta text
    → result event fires → text_queue.put(reply)
    → _oracle_worker reads from queue (30s timeout)
    → appends {"type":"oracle_response", "req_id":..., "msg":...} to OUT_PATH

companion.js pollMasterOut() (1.5s poll)
  → reads new lines from vexil_master_out.jsonl
  → routes oracle_response entries to voice.js listener
  → voice.js renders reply in oracle chat log
```

### Token accumulation behavior
The persistent process holds conversation history natively — context window grows with each exchange. Cost per query increases over a long session. Resets on daemon restart or process crash (health check in main loop auto-respawns).

| Condition | Token cost |
|-----------|-----------|
| Query 1–3 | ~400–600 input tokens |
| Query 10+ | grows as history accumulates |
| Process respawn | resets to baseline |

**No-sessions path** always uses `claude-sonnet-4-6` (previous design used Haiku when no sessions open — cost regression accepted for architectural simplicity).

### Cross-references
- `scripts/vexil_master.py` — `_spawn_oracle_process()`, `_oracle_reader_thread_fn()`, `_oracle_worker()`
- `src/voice.js` — `initOraclePreChat()`, `ORACLE_QUERY_PATH`, oracle response listener
- `src/companion.js` — `pollMasterOut()`, oracle_response routing

---

## Session Model

```
sessions: Map<id, Session>
  Session {
    id: string          — UUID
    cwd: string         — project directory
    name: string        — basename of cwd
    charIndex: number   — ANIMALS[] index for sprite
    child: ChildProcess — Claude Code subprocess (Tauri Shell)
    status: 'idle'|'working'|'waiting'|'error'
    toolPending: {}     — { [toolId]: true } for in-flight tools
    readOnly: bool      — disables write/bash tools
    unread: bool        — badge unread messages when not active
    tokens: number      — cumulative session tokens
    _liveTokens: number — tokens in current turn (reset on result)
    _dotsPhase: 0-3     — animation frame for working badge dots
    _pendingMsg: string — message queued before system/init fires
    _idleTimer: id      — debounce timer for idle transition
    _rateLimitTimer: id — timer for rate_limit badge flash
    // Streaming state (per content block, cleared on block_stop):
    _streamText: string     — accumulated text for current block
    _streamMsg: Message     — message object being updated
    _streamEl: Element      — DOM element anchor for direct updates
    _streamRafId: number    — pending rAF id (cancel on block_stop)
    _didStreamText: bool    — skip text push in 'assistant' handler
    _streamedToolIds: Set   — skip tool push in 'assistant' handler
  }

sessionLogs: Map<id, { messages: Message[] }>
  Message types: 'user' | 'claude' | 'tool' | 'system-msg' | 'error' | 'warn'
```

---

## File Attachments (`src/attachments.js`)

### Drop Pipeline
```
OS file drop → tauri://drag-drop event (NOT HTML5 dragover/drop — Tauri intercepts)
  → stageFilePath(sessionId, path)
  → isImage? invoke('read_file_as_base64') : invoke('read_file_as_text')
  → resizeImageBase64(b64, mimeType)   — canvas resize to max 1568px, JPEG 0.85
  → store as { id, name, path, mimeType, data, isImage, status:'staged' }
  → renderAttachmentTokens()   — pill badges above textarea
  → renderAttachmentPanel()    — sidebar ATTACHMENTS section
```

**Why Rust invoke for file reading**: Tauri shell allowlist only permits `claude` and `test` commands — `cat`, `base64` etc. are blocked. `read_file_as_base64` and `read_file_as_text` are Tauri commands in `lib.rs` using `std::fs`.

**Why 1568px resize**: Raw 4K screenshot = ~11MB base64 → API rate limits. After canvas resize = ~200-400KB (25-50× smaller). Matches Claude CLI's own behavior.

### On Send (multimodal content)
```javascript
// Plain text: content = "string"
// With attachments: content = [{type:'text', text:'...'}, {type:'image', source:{type:'base64',...}}, ...]
```

### Drag sources
- **OS → app**: `tauri://drag-drop` event only (HTML5 events blocked by Tauri for OS drops)
- **Panel re-drag**: HTML5 `dragover`/`drop` with `application/x-pixel-attachment` dataTransfer (internal, works normally)

---

## Message Flow

```
User types → Enter → sendMessage(id, text)
  → expandSlashCommand(raw)          — expand /commands via read_slash_command_content invoke
  → getStagedAttachments(id)         — build multimodal content array if attachments exist
  → child.write(JSON + "\n")         — stdio to Claude Code
  → Claude Code stdout events → handleEvent() → pushMessage() / streaming update → DOM
```

---

## Voice Flow

```
omi:command Tauri event
  payload.type === 'transcript'
    → omiConnected && omiListening → appendVoiceLog()
  payload.type === 'prompt'
    → omiListening guard → sendMessage(targetId, text)
  payload.type === 'switch'
    → setActiveSession(targetId)
```

---

## Backend (ws_bridge.rs)

### OmiBridgeState
```rust
struct OmiBridgeState {
    clients:         Mutex<Vec<UnboundedSender<String>>>,  // all WS clients
    voice_ready_count: AtomicU32,
    muted:           Arc<AtomicBool>,
    always_on:       Arc<AtomicBool>,
}
```

Multi-client broadcast: each WS connection gets a `spawn`ed write task with its own `UnboundedSender`. Dead senders pruned on each broadcast via `retain(is_open())`.

**ws_bridge.rs is voice-only** — it has NO involvement in Claude CLI stdout. The CLI subprocess communicates purely through Tauri Shell `Command.create` stdout callbacks.

### Tauri Commands (lib.rs)
| Command | Args | Effect |
|---------|------|--------|
| `read_file_as_base64` | `path: String` | Read file → inline base64 encoder → String |
| `read_file_as_text` | `path: String` | Read file as UTF-8 text |
| `read_slash_commands` | — | Scan `~/.claude/commands/` → [{name, description}] |
| `read_slash_command_content` | `name: String` | Return body of slash command file (frontmatter stripped) |
| `set_omi_listening` | `enabled: bool` | Broadcast mute/unmute to voice bridge |
| `set_voice_mode` | `mode: String` | Broadcast always_on/trigger_mode |
| `ptt_start` / `ptt_release` | — | Broadcast PTT start/stop |
| `switch_voice_source` | `source: String` | Broadcast source switch (ble/mic) |
| `sync_omi_sessions` | sessions, active | Broadcast state_sync to voice bridge clients |

---

## State (localStorage)

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `pixel-terminal-identity-seq-v8` | JSON | — | Animal/hue cycle index for session IDs |
| `sidebar-session-list-h` | number | — | Persisted sidebar session-list panel height |

Note: `omiListening` and `alwaysOn` are removed on DOMContentLoaded (one-time cleanup) — they were previously persisted but caused stale state on restart.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Enter | Send message |
| Shift+Enter | Newline in input |
| Escape | Cancel active Claude operation (kills subprocess, restarts) |
| Cmd/Ctrl+1–5 | Switch to session N |
| Space (hold, empty input) | PTT: activate always-on + pulsing indicator |
| Space (release) | PTT: fire buffer via `ptt_release` |

---

## UI Layout

```
┌─────────────────────────────────────────────────────┐
│ [drag region / titlebar]                             │
├──────────────┬──────────────────────────────────────┤
│  SESSIONS    │  [message-log]                        │
│  ──────────  │   msg.user / msg.claude /             │
│  [session    │   msg.tool / msg.system-msg           │
│   cards]     │   [working-cursor] (streaming)        │
│  ────────── ◄│► [sidebar-resize handle]              │
│  VOICE LOG   │  [input-bar]                          │
│  ──────────  │   [attachment-tokens] (pill badges)   │
│  [voice-log  │   [textarea] [▶] [●] [⚙]             │
│   entries]   │                                       │
│  ATTACHMENTS │                                       │
│  ──────────  │                                       │
│  [att-items] │                                       │
└──────────────┴──────────────────────────────────────┘
```

---

## Voice Bridge (pixel_voice_bridge.py)

### Modes
| Mode | Trigger | Timeout | End marker |
|------|---------|---------|-----------|
| Trigger | "hey pixel" + variants | 8s | "full stop" / "over" |
| Always-on | immediate | 3s silence | "full stop" / "over" |
| PTT | `always_on` msg on keydown | fires on `ptt_release` | — |

### Trigger Pattern
```python
PIXEL_TRIGGER_PATTERN = re.compile(
    r"\b(hey|hay|he|here)\W+(pixel|picks?e?l|pistol|pizel|picks?\s+[ao]ll?)\b",
    re.IGNORECASE,
)
```

### BLE Mode
- Library: `bleak 3.0.1` + `opuslib 3.0.1` (requires `brew install opus`)
- Service: `19B10000-E8F2-537E-4F6C-D104768A1214`
- Encoding: Opus, 3-byte header per packet, `frame_size=960`, 16kHz mono
- **Limit**: Omi firmware `CONFIG_BT_MAX_CONN=1` — phone app must be fully quit first

---

## Known Gotchas

1. **bypassPermissions required for tool execution**: `acceptEdits` does NOT allow Bash in `-p` pipeline mode. Claude gives hedged non-answers instead of running code. Always use `bypassPermissions` for non-read-only sessions.

2. **Tauri OS drops are not HTML5**: `dragover`/`drop` events do NOT fire for files dragged from Finder. Must use `listen('tauri://drag-drop')`. HTML5 DnD still works for internal re-drag (panel items).

3. **File reading needs Rust invoke**: Tauri shell allowlist only allows `claude` + `test`. Use `read_file_as_base64` / `read_file_as_text` Tauri commands (lib.rs) for file access.

4. **ws_bridge.rs is voice-only**: Never modify ws_bridge to relay Claude CLI output. The CLI subprocess stdout goes through Tauri Shell's `cmd.stdout.on('data')` callback directly.

5. **streaming rAF race**: `content_block_stop` MUST cancel `_streamRafId` before the markdown render. If the rAF fires after `innerHTML` is set, it overwrites markdown with plain text.

6. **Image resize prevents rate limits**: Raw 4K = ~11MB base64 → API 429. Canvas resize to 1568px JPEG 0.85 → ~200-400KB. Always resize before staging images.

7. **BLE connection order matters**: ws_bridge must be listening on port 9876 before voice bridge scans. `launch.command` enforces this with `nc -z` poll loop.

8. **BlackHole 2ch as default audio input**: macOS may route system default to BlackHole virtual device. Voice bridge enumerates by device name to avoid this.

9. **Omi BLE one-client limit**: phone Omi app holds the BLE slot. Must fully quit (not background) before Mac can connect.

10. **tokio write_task abort**: must `let _ = write_task.await` after `write_task.abort()` before checking `is_closed()` — abort is cooperative, not immediate.

11. **PTT with 2s chunks**: if user holds Space for <2s, buffer is empty. `_fire()` no-ops. User needs to hold ~2s minimum.

12. **rate_limit_event is transient**: CLI retries automatically. Flash badge 3s only — do NOT log as a permanent message (looks like an error).
