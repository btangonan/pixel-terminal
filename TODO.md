# TODO — pixel-terminal

## This Week
- [ ] Live fresh-clone test on a clean macOS box (or fresh user account) before sending Anthropic tester the link — `git clone → git lfs pull → nvm use → npm install → npm run tauri dev`; confirm it boots end-to-end with no missing prereqs (from /checkpoint --retro 2026-04-28, context: PR #20 merged + docs updated; tester-ready claim needs live confirmation)
- [ ] Investigate `memory_lint.py` blocking `mcp__gemini-memory__memory_add` with valid `type` field — error fires only from MCP hook stdin path; standalone invocation passes (from /checkpoint --retro 2026-04-28, context: blocked all checkpoint memory writes this session)
- [ ] Bundled `anima-stt` rebuild with `mlx_whisper` baked into PyInstaller spec — unblocks packaged-app voice path; currently skip-by-default (from /checkpoint --retro 2026-04-28, context: deferred from PR #20 hardening)
- [ ] Production PATH fix — when packaging .app for Dock launch, implement `get_shell_path()` Rust command (`$SHELL -l -c 'printf "%s" "$PATH"'`), cache result, pass to all `Command.create('claude')` spawns. ~15 lines: one Tauri command in lib.rs + one cached invoke in session-lifecycle.js. (from /checkpoint 2026-03-30, context: dev mode inherits PATH fine; production .app gets minimal PATH and Claude subprocess can't find homebrew/pyenv/nvm)
- [ ] Per-animal hue subsets — implement ANIMAL_HUES map in `getNextIdentity()` so each animal type uses a constrained hue range (context: auto-recovered from prior sessions)

## Backlog
- [ ] Full A/B parity test — drop image, ask dimensions → verify instant answer with zero Bash commands (pre-computed metadata fix)
- [ ] Image resize quality — currently JPEG 0.85 always; consider keeping PNG for screenshots with text (low priority)
