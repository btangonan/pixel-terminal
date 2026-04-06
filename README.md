<h1 align="center">
    <img src="graphics/00_logo/anima_wordmark_ascii.png" alt="Anima" width="400">
</h1>

<h2 align="center" style="padding-bottom: 20px;">
  Your Claude Code environment, inhabited.
</h2>

<div align="center" style="margin-top: 25px;">

[![Tauri v2](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&style=flat)](https://tauri.app)
[![macOS](https://img.shields.io/badge/macOS-13%2B-000000?logo=apple&style=flat)](https://www.apple.com/macos/)
[![license](https://img.shields.io/github/license/btangonan/anima?color=0183ff&style=flat)](LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0--alpha-orange?style=flat)](https://github.com/btangonan/anima/releases)

</div>

<div align="center">
<a href="https://github.com/btangonan/anima/releases">📦 Releases</a> • <a href="https://github.com/btangonan/anima/discussions">💬 Discussions</a> • <a href="https://github.com/btangonan/anima/issues">🐛 Issues</a> • <a href="CONTRIBUTING.md">🤝 Contributing</a>
</div>

<br/>

Claude Code ships with a basic buddy — an ASCII creature that hatches in your terminal, watches you work, and occasionally drops a line in a speech bubble. It's charming. It's also limited: the buddy can't see across sessions, can't remember what happened last time, its commentary comes from a small model working with a 5,000-character window, and the speech bubble text can't be copied or pasted back into your session.

Anima turns your Claude buddy into an oracle — a cross-session code supervisor running the full Claude model, inside a native macOS app. It watches tool patterns across every active session, catches retry loops and read-heavy spirals before you've noticed them, and surfaces observations you can select and paste straight into the conversation.

Each project folder also gets its own familiar — an ASCII companion that animates while Claude is working, so you can see at a glance which sessions are done and waiting on you. Every 1,000 tokens earns 1 nim — spend it to re-roll for a new species, rarity, and personality.

The name comes from animism. Not sacred. Just alive.

![Anima demo](graphics/02_gifs/00_git-ready/anima-demo.gif)

## Features

- **One project, one companion** — every project gets a unique familiar generated from a weighted rarity pool. Two developers on the same codebase won't get the same creature.
- **Nim token economy** — 1 nim per 1000 tokens spent. Spend on re-rolls and new characters. Progress, not anxiety.
- **Collectible familiar cards** — each project gets a stat card: species, rarity, power ratings, session history. Like a Pokémon card for your codebase.
- **Cross-session watcher** — Rust daemon monitors all active Claude sessions simultaneously. Catches retry loops and read-heavy spirals in real time.
- **Oracle commentary** — companion fires contextual observations in a speech bubble. Selectable text — copy and paste into the session.
- **Voice input** — Bluetooth mic + push-to-talk. Hands-free Claude via WebSocket bridge.
- **Session history** — full session browser. Replay any past conversation. JSONL-backed.
- **Native performance** — Tauri v2 + Rust backend. Not Electron. Actual macOS app.

## How it looks

![Sessions and companions](graphics/02_gifs/00_git-ready/anima_a.gif)

**Sessions have faces.** Open a project and a companion appears — species drawn from a weighted rarity pool, personality seeded from the project path. Rare pulls happen.

![Familiar cards and economy](graphics/02_gifs/00_git-ready/anima_b.gif)

**Token spend means something.** Every 1000 tokens earns 1 nim. Nim funds re-rolls, new companions, cosmetics. Not a limit to dread. A counter to fill.

![Watcher commentary](graphics/02_gifs/00_git-ready/anima_c-1.gif)

**You're not working alone.** The watcher daemon tracks tool patterns across all active sessions. When it catches you going in circles, the companion says something. It's not *I'm stuck*. It's *we're stuck*.

![Multi-session workflow](graphics/02_gifs/00_git-ready/anima_d.gif)

*Commentary runs as short background prompts via the Claude CLI — capped at 2 concurrent calls. All processing is local; nothing leaves your machine except the API calls you'd make anyway.*

<div align="center">
<img src="graphics/01_ui/anima_stat-card.png" alt="Familiar stat card" width="420">
<img src="graphics/01_ui/anima_oracle-chat.png" alt="Oracle commentary" width="280">
</div>

## Requirements

- macOS 13 Ventura or later
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js 18+

## Getting Started

1. Download `Anima.dmg` from [Releases](https://github.com/btangonan/anima/releases)
2. Open the app
3. Point it at a project directory and start a session

The companion generates on first session. Nim accrues automatically.

### Build from source

```bash
git clone https://github.com/btangonan/anima
cd anima
npm install
npm run tauri dev
```

Production build:

```bash
npm run tauri build
# Output: src-tauri/target/release/bundle/
```

Rust tests:

```bash
cd src-tauri && cargo test
```

## How It Works

Anima is a Tauri v2 desktop app. The frontend is vanilla JS — no framework, no bundler. The Rust backend handles file I/O, path security, companion sync, and the cross-session watcher. A WebSocket bridge handles voice input.

The watcher (`daemon.rs`) is a Tokio async loop that polls Claude Code's session feed, tracks tool sequences across all active sessions, and emits companion commentary via Tauri events when patterns fire. The oracle — the voice behind the companion bubble — is a `claude -p` subprocess with personality context injected from your companion's species and stats.

Full architecture notes: [`docs/architecture.md`](docs/architecture.md)

## Contributing

Issues and PRs welcome. See [`.github/ISSUE_TEMPLATE`](.github/ISSUE_TEMPLATE) for bug report and feature request templates.

Alpha software. Solo project. Breaking changes happen.

## License

MIT © [Bradley Tangonan](https://github.com/btangonan)
