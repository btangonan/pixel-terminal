<div align="center">

<img src="src-tauri/icons/icon_master_1024_rounded.png" width="120" alt="Anima" />

# Anima

[![Tauri v2](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri)](https://tauri.app)
[![macOS](https://img.shields.io/badge/macOS-13%2B-000000?logo=apple)](https://www.apple.com/macos/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0--alpha-orange)](https://github.com/btangonan/pixel-terminal/releases)

**Your Claude Code environment, inhabited.**
A native macOS frontend for Claude Code — with a gamified companion, token economy, and cross-session watcher.

</div>

---

Twelve terminal windows. All anonymous. Each one running a different Claude session: refactoring auth, writing tests, debugging a build. Nothing to tell them apart but a number in the title bar.

Anima fixes that. It's a native macOS app that wraps the Claude Code CLI and gives every session a companion — a generated pixel creature with its own name, species, and personality. They watch your work, fire commentary when something's off, and persist across sessions so your projects feel less like ephemeral processes and more like a place where things live.

The name comes from animism. Inhabited spaces teem with activity. Not sacred. Just alive.

<!-- REPLACE: record a 30-45s screen capture showing session start → companion → Vexil bubble → nim tick -->
![Anima demo](docs/assets/demo.gif)

---

## What's in here

**Sessions have faces.**
Open a project and a companion appears — species drawn from a weighted rarity pool, personality seeded from the project path. Rare pulls happen. Two developers on the same codebase won't get the same creature. Each familiar card logs your project's stats: tokens spent, tools used, sessions run.

**Token spend means something.**
The Claude Code weekly limit is easy to treat as a ceiling to avoid. Anima reframes it. Every 1000 tokens earns 1 nim — the in-app currency. Nim funds re-rolls, new companions, cosmetics. Not a limit to dread. A counter to fill — on tokens you'd spend anyway.

**You're not working alone.**
Vexil is the cross-session watcher daemon running in the Rust backend while Claude works. It tracks tool patterns across all active sessions: reads when you're reading too much, spots retry loops before you've noticed them. When it catches you going in circles, something shifts. It's not *I'm stuck*. It's *we're stuck*. That's enough.

*Commentary runs as short background prompts via the Claude CLI — capped at 2 concurrent calls. All processing is local; nothing leaves your machine except the API calls you'd make anyway.*

---

## Why Anima?

**The companion noticed something. Act on it.**
Claude Code's built-in companion shows advice in a bubble you can't touch — screenshot it or retype it by hand. In Anima, companion comments are selectable text. Copy, paste into the session, send. Done.

**Twelve windows. All running. None of them telling you anything.**
Anima's session manager gives each one a face: a sprite that animates when work is happening, a live token counter, a notification when Claude finishes and is waiting on you. You stop babysitting tabs. You start actually knowing what's going on — and so does your companion.

**You attached that file three messages ago. Now you need it again.**
In a terminal, that means finding it, dragging it back, re-attaching. Anima tracks every file you've sent in a session and surfaces it for re-use. Your companion remembers what you handed Claude, even when you've moved on.

**Every session has a story. Anima keeps them all.**
Full chat history for every project, every session — browsable without leaving the app. Good for context. Better when your companion has been watching the whole run and can tell you what you missed.

---

## Features

| | |
|---|---|
| 🐉 **Companion** | Species + personality generated per project. Weighted rarity pool — common to legendary. Persistent across sessions. |
| 🎮 **Nim economy** | 1 nim per 1000 tokens spent. Spend on re-rolls and new characters. Progress, not anxiety. |
| 📋 **Familiar cards** | Each project gets a collectible card: species, rarity, stats, session history. Like a Pokémon card for your codebase. |
| 👁️ **Cross-session watcher** | Rust daemon monitors all active Claude sessions simultaneously. Catches retry loops and read-heavy spirals in real time. |
| 🎙️ **Voice** | Bluetooth mic + push-to-talk. Hands-free Claude. WebSocket bridge, no intermediary. |
| 📜 **Session history** | Full session browser. Replay any past conversation. JSONL-backed, O(1) scan per file. |
| ⚡ **Native** | Tauri v2 + Rust backend. Not Electron. Actual macOS app. |

---

## Screenshots

<!-- REPLACE: take these three screenshots from the running app -->

<div align="center">
<img src="docs/screenshots/session-card.png" width="280" alt="Session with familiar card" />
<img src="docs/screenshots/familiar-card.png" width="280" alt="Familiar card close-up" />
<img src="docs/screenshots/vexil-bubble.png" width="280" alt="Vexil commentary in action" />
</div>

---

## Requirements

- macOS 13 Ventura or later
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js 18+

---

## Quick start

1. Download `Anima.dmg` from [Releases](https://github.com/btangonan/pixel-terminal/releases)
2. Open the app
3. Point it at a project directory and start a session

The companion generates on first session. Nim accrues automatically.

---

## Build from source

<details>
<summary>Expand</summary>

**Prerequisites:** Rust toolchain, Node.js 18+

```bash
git clone https://github.com/btangonan/pixel-terminal
cd pixel-terminal
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

</details>

---

## How it works

Anima is a Tauri v2 desktop app. The frontend is vanilla JS — no framework, no bundler. The Rust backend handles file I/O, path security, companion sync, and the cross-session watcher. A WebSocket bridge handles voice input.

The watcher (`daemon.rs`) is a Tokio async loop that polls Claude Code's session feed, tracks tool sequences across all active sessions, and emits companion commentary via Tauri events when patterns fire. The oracle — the voice behind the companion bubble — is a `claude -p` subprocess with personality context injected from your companion's species and stats.

Full architecture notes: [`docs/architecture.md`](docs/architecture.md)

---

## Contributing

Issues and PRs welcome. See [`.github/ISSUE_TEMPLATE`](.github/ISSUE_TEMPLATE) for bug report and feature request templates.

Alpha software. Solo project. Breaking changes happen.

---

## License

MIT © [Bradley Tangonan](https://github.com/btangonan)
