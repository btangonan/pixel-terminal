# Session Checkpoint — pixel-terminal
**Date**: 2026-03-31

## Decisions Made
- Claude CLI -p mode disables all built-in commands; stream-json stdin only supports type:user
- Built-in commands reimplemented as frontend handlers (BUILTIN_COMMANDS map)
- /plan and /review as prompt-inject .md files in ~/.claude/commands/
- Voice source defaults to Mac mic (not BLE); BLE only on explicit selection
- Omi indicator: gray=disconnected, blue=connected; source buttons white active state
- Top bar height 28→34px; empty state two lines with text-mid 0.65 opacity

## Fixes Applied
- Icon RGBA build error: cargo clean resolved stale proc-macro cache
- Voice bridge not connecting on reload: added get_voice_status Tauri command for startup sync
- Voice bridge launch from UI: gray dot click launches bridge directly

## Progress
- 6 built-in slash commands: /clear, /cost, /help, /compact, /model, /effort
- 2 prompt-injectable commands: /plan, /review
- Voice bridge end-to-end: default mic, auto-fallback, startup sync, UI launch

## Memories Logged
- 2 new → pixel_terminal
- 1 new → claude_global_knowledge
- 7 logged earlier in session → pixel_terminal

## Next Session Suggested Start
→ Test built-in commands in pixel-terminal, then Production PATH fix
