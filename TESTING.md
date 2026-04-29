# Testing Anima

A one-page guide for clone-and-test. Targets a fresh Mac (macOS 13+) with no prior Anima setup.

## Prerequisites

- macOS 13 Ventura or later, Apple Silicon
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude login`)
- Node.js 20 LTS — pinned by `.nvmrc`; `nvm use` after cloning. Node 22+ trips [vitest #8757](https://github.com/vitest-dev/vitest/issues/8757); workaround in the test-suite section below.
- [Git LFS](https://git-lfs.com) (`brew install git-lfs`) — required at clone time
- Rust toolchain (`rustup`) — required for `npm run tauri dev` (the steps below) and for `cargo test`
- Xcode Command Line Tools (`xcode-select --install`) — required for the macOS link step in any Tauri build

## Clone and run

```bash
git clone https://github.com/btangonan/anima
cd anima
git lfs install && git lfs pull
nvm use
npm install
npm run tauri dev
```

The app launches in dev mode. First-run onboarding appears once; you can dismiss it (skip voice) and proceed straight to the main UI.

## What works without any extra setup

- Multi-session sidebar (click `+` to start a session against any local project)
- Companion (familiar) with chat bubble — starts a project session, asks questions, gets answers
- Oracle re-rolls (click the eye icon)
- Slash menu (`/`)
- Nim economy (accrues from token usage)
- History panel (toggle from the sidebar)
- Settings panel (UI tab)
- Vexil commentary daemon (background)

## What's deliberately optional

Live voice (STT/TTS). The default build runs in text mode — voice indicator stays gray. The bundled `anima-stt` PyInstaller is shipped via Git LFS but **disabled by default** because it's missing `mlx_whisper`; set `ANIMA_SKIP_BUNDLED_STT=0` to opt in once the binary stabilises. To run live voice today, point an external WebSocket STT bridge at `ws://127.0.0.1:9876` before launching Anima — there's no public turnkey bridge in this repo yet.

If you click the voice indicator with no bridge running, Anima shows "Voice unavailable — text mode active" and continues. No crash, no retry storm.

## Run the test suite

```bash
npm run test:all
```

Expected on a clean clone:

- **JS (Vitest)**: 250 passed / 6 skipped (28 files)
- **Rust (cargo test)**: 231 passed (13 binaries)

The skipped tests are platform-specific (WebKit harness) or opt-in soak/PTY suites.

If you see `localStorage.clear is not a function` failures, your Node is 22+ and you need the vitest #8757 workaround. Either `nvm use` (picks up `.nvmrc` → Node 20, no flag needed) or run `NODE_OPTIONS=--no-webstorage npm test`. The flag is only valid on Node 22+; do not export it on Node 20.

## Known limitations

- **Bundled voice STT** is opt-in only and currently broken (missing `mlx_whisper`); the kill switch defaults skip-on. This is tracked separately and does not affect the rest of the app.
- **macOS Gatekeeper**: a release build (`npm run tauri build`) is currently unsigned. Dev mode (`npm run tauri dev`) doesn't trigger Gatekeeper.
- **Voice CI native lane** runs only on push to `main`/`release/*` because it requires Apple Silicon arm64. PRs trigger the mocked Linux lane only.

## Reporting issues

If something breaks, please include:

- macOS version
- Node version (`node --version`)
- Output of `npm run test:all`
- Console logs from `npm run tauri dev` (the Tauri window's DevTools — Cmd+Option+I)
