# STATE.md — Working State (re-read after compaction)
## Updated: 2026-03-27

### Active Work
- Fixing token over-count: cache_read_input_tokens causes exponential accumulation

### Key IDs
- Collection: pixel_terminal (gemini-memory)
- Tauri commands: read_slash_commands, read_slash_command_content

### Decisions This Session
- slash command expansion via read_slash_command_content Rust cmd
- unknown slash command: warn-msg type (orange), block send
- cache tokens: cache_read must NOT be counted — causes double-count every turn (in progress fix)
- font sizes: 12px messages, 11px code/tools
- CSS spacing: p:last-child, pre, ol/ul:last-child margin-bottom:0

### Blockers
- None

### Last Session Snapshot
Date: 2026-03-27
Open actions:
- [ ] Test in tauri dev: slash expansion, unknown command warn, token count, spacing
Decisions: 20 | Fixes: 24
Next: → fix cache_read token double-count, then npm run tauri dev smoke test
