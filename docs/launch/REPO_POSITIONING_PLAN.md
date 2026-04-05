# Repo Positioning + Launch Plan — pixel-terminal
**Date**: 2026-04-04 | Method: parallel agents + sequential thinking | Depth: standard

---

## Research Brief

```
Sources: 3 parallel agents, 3 web searches, 6 repo reads
═══════════════════════════════════════════════════════════
```

### Key Findings

**1. The ecosystem ceiling is real but reachable** — Confidence: HIGH
Cline: 59.9K stars. Open Interpreter: 63K. awesome-claude-code: 36.5K.
These are the benchmarks. They all share three things: demo GIF above the fold,
sub-10-word value prop, working install in under 2 minutes.
Source: github.com/cline/cline, github.com/openinterpreter/open-interpreter

**2. Your closest competitor is animation-only** — Confidence: HIGH
`pixel-agents` (pablodelucca) exists — pixel art office animation, VS Code extension,
moderate Reddit traction. But it has no persona system, no economy, no gameplay,
no daemon watcher. It's a screensaver, not a game.
Source: github.com/pablodelucca/pixel-agents, r/ClaudeCode

**3. The three things that make repos go viral** — Confidence: HIGH
1. Demo GIF/screenshot in the first screenful — no scrolling required
2. Value prop in ≤10 words — "what is this" answered instantly
3. Working quick start in under 2 minutes — tested on a fresh machine
Source: dev.to/belal_zahran/the-github-readme-template-that-gets-stars

**4. HN beats ProductHunt for dev tools** — Confidence: HIGH
Real data (Watermelon launch): HN = 50+ stars, 100+ installs.
ProductHunt = 10 stars, 30 installs. More qualified audience.
Source: medium.com/@baristaGeek/lessons-launching-a-developer-tool

**5. awesome-claude-code is the highest-leverage single action** — Confidence: HIGH
36.5K stars. PR to add pixel-terminal puts it in front of every Claude developer
browsing for tools. Free. Targets the exact audience. Takes 10 minutes.
Source: github.com/hesreallyhim/awesome-claude-code

**6. GitHub Releases are mandatory for desktop apps** — Confidence: HIGH
Without a .dmg download, the install story is "clone, npm install, cargo tauri dev" —
that loses 90% of potential users who won't build from source.

---

## Positioning

### One-liner (settled)
> **"A macOS Claude Code terminal with a gamified companion, token economy, and cross-session watcher."**

### What pixel-terminal has that nothing else does
| Feature | pixel-terminal | pixel-agents | Cline | Open Interpreter |
|---------|---------------|-------------|-------|-----------------|
| Companion with personality + species | ✅ | ❌ | ❌ | ❌ |
| Token economy (nim currency) | ✅ | ❌ | ❌ | ❌ |
| Collectible familiar cards per project | ✅ | ❌ | ❌ | ❌ |
| Cross-session watcher daemon | ✅ | ❌ | ❌ | ❌ |
| Voice integration (Omi) | ✅ | ❌ | ❌ | ❌ |
| Tauri v2 (not Electron) | ✅ | ❌ | ❌ | ❌ |
| Pixel art animations | ✅ | ✅ | ❌ | ❌ |

### Target audience
Individual developers who use Claude Code daily and want their environment to feel alive.
NOT enterprise. NOT model-agnostic. Claude-specific and proud of it.

---

## Plan

### Phase 0 — Prerequisites (do before going public)
**Gate: repo cannot be public until these are done.**

| Task | File | Why |
|------|------|-----|
| Merge security PR (path allowlist, XSS, CSP) | lib.rs, cards.js, tauri.conf.json | Can't have CRITICALs in a public repo |
| Add src-tauri/target/ to .gitignore | .gitignore | 11K build artifacts not in git |
| Verify LICENSE exists (MIT) | LICENSE | Required for community adoption |

---

### Phase 1 — Repo Professionalization

**Files to create:**

#### `README.md` — full rewrite
Structure (exact order — do not deviate):
```
1. Logo (anima ASCII / app icon)
2. Title + badges (Tauri v2 | macOS | MIT | version)
3. ONE-LINER — "A macOS Claude Code terminal with a gamified companion,
               token economy, and cross-session watcher."
4. DEMO GIF — 30-45 seconds (see Phase 2)
5. FEATURE GRID (3 columns, emoji + label + 1-line description):
   🎮 Gamified      — Nim currency accrues from token spend. Spend on re-rolls.
   🐉 Companion     — Species-generated personality. Watches every session.
   📊 Familiar Cards — Each project gets a unique collectible card with rarity + stats.
   🎙️ Voice         — Omi pendant + PTT. Hands-free Claude.
   📜 History       — Session timeline, full replay, semantic search.
   ⚡ Native        — Tauri v2 + Rust. Not Electron. Actual macOS app.
6. SCREENSHOTS (3): session card view | familiar card | vexil bubble
7. REQUIREMENTS: macOS 13+, Claude Code CLI, Node.js 18+
8. QUICK START (≤3 steps):
   - Download .dmg from Releases
   - Open app
   - Point to a project directory
9. BUILD FROM SOURCE (collapsible <details> block)
10. Architecture (2-paragraph prose, link to docs/architecture.md)
11. CONTRIBUTING (link to CONTRIBUTING.md)
12. LICENSE
```

#### `.github/ISSUE_TEMPLATE/bug_report.md`
Standard: steps to reproduce, expected vs actual, macOS version, Claude Code version.

#### `.github/ISSUE_TEMPLATE/feature_request.md`
Standard: what problem does it solve, describe the solution, alternatives considered.

#### `.github/PULL_REQUEST_TEMPLATE.md`
Standard: what changed, why, how to test, screenshots if UI change.

#### `docs/architecture.md`
Brief: Tauri v2 shell → Rust IPC commands → vanilla JS webview → WebSocket voice bridge.
Link from README "How It Works" section.

---

### Phase 2 — Demo Assets

**Demo GIF (most important single asset):**
Record a 30-45 second screen capture showing:
1. App opens, empty state with anima logo watermark
2. New session spawns → session card appears with familiar animation
3. A Claude response streams in with markdown rendering
4. Familiar card flips (if interaction shows it) OR vexil bubble fires commentary
5. Nim counter ticks up

Tools: QuickTime → export → convert with `ffmpeg` or `giphy capture`.
Target: ≤5MB GIF or MP4 (GitHub renders both in README).

**3 static screenshots:**
- `docs/screenshots/session-card.png` — session list with familiar + card
- `docs/screenshots/familiar-card.png` — full familiar card close-up
- `docs/screenshots/vexil-bubble.png` — vexil commentary bubble in action

---

### Phase 3 — GitHub Release

```bash
npm run tauri build          # produces .app + .dmg in src-tauri/target/release/bundle/
```

Create GitHub Release `v0.1.0-alpha`:
- Tag: `v0.1.0-alpha`
- Title: "Pixel Terminal v0.1.0-alpha — First public release"
- Attach: `Pixel Claude.dmg`
- Release notes: list the 6 features from the README feature grid
- Mark as pre-release (alpha is honest)

---

### Phase 4 — Launch (in order)

**Step 1 — awesome-claude-code PR (do immediately after release)**
Submit PR to `hesreallyhim/awesome-claude-code` to add pixel-terminal.
Category: "Desktop Apps" or "GUI Wrappers".
Entry: `[pixel-terminal](https://github.com/btangonan/pixel-terminal) — Gamified macOS Claude Code terminal with companion, nim economy, and cross-session watcher daemon.`

**Step 2 — r/ClaudeCode post**
Title: "I built a gamified Claude Code terminal — each project gets a pixel companion with its own personality and rarity"
Include: demo GIF directly in post body. Link to GitHub.

**Step 3 — Show HN**
Title: `Show HN: Pixel Terminal – Claude Code with a gamified companion and cross-session watcher`
Body: 3 sentences. What it is, what makes it different, where to get it.
Post Tuesday–Thursday 9am–noon US ET for best visibility.

**Step 4 — r/rust**
Angle: "I built a macOS desktop app with Tauri v2 — here's what I learned about
WKWebView, vanilla JS without a bundler, and testing on macOS"
This targets a different audience (tech stack curious, not Claude-specific).

**Step 5 — r/ClaudeAI**
Broader Claude community. Same post as r/ClaudeCode.

---

### What NOT to do
- Don't launch on ProductHunt first (HN gives more qualified installs per visit)
- Don't make it model-agnostic to get more stars — Claude-specific is the identity
- Don't remove the pixel art aesthetic to look "more professional" — that IS the differentiation
- Don't wait for perfect — ship v0.1.0-alpha with known limitations disclosed

---

## Milestone Gates

```
Phase 0 complete (security merged, .gitignore clean, LICENSE present)
    ↓
Phase 1 complete (README written, .github/ templates, docs/architecture.md)
    ↓
Phase 2 complete (demo GIF recorded, 3 screenshots taken)
    ↓
Phase 3 complete (v0.1.0-alpha release with .dmg attached)
    ↓
Phase 4: awesome-claude-code PR → r/ClaudeCode → Show HN → r/rust → r/ClaudeAI
```

**Do not skip gates.** A public repo with no demo GIF and no release binary
will get no traction regardless of how good the code is.

---

## Sources
- [Cline GitHub](https://github.com/cline/cline) — 59.9K stars, positioning reference
- [Open Interpreter](https://github.com/openinterpreter/open-interpreter) — 63K stars
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — 36.5K stars, submission target
- [pixel-agents](https://github.com/pablodelucca/pixel-agents) — closest competitor
- [README that gets stars](https://dev.to/belal_zahran/the-github-readme-template-that-gets-stars-used-by-top-repos-4hi7)
- [HN vs ProductHunt launch data](https://medium.com/@baristaGeek/lessons-launching-a-developer-tool-on-hacker-news-vs-product-hunt-and-other-channels-27be8784338b)
