# Anima v0.2 Roadmap — Companion & Permission System

**Status**: Planning | **Target**: After v0.1.0-alpha validation
**Prerequisite**: v0.1.0-alpha shipped, oracle persistent subprocess stable, buddy_traits() fallback proven

---

## 1. Oracle Personality Re-Roll

**Problem**: Users can't change their oracle companion's personality without manually editing buddy.json or having Claude Code's /buddy synced. New users get a functional but generic fallback.

**Solution**: Nim-gated re-roll that generates a new personality via the oracle subprocess.

### Design

```
User clicks RE-ROLL PERSONALITY on companion profile card
  → confirm dialog (shows nim cost + warning)
    → oracle LLM call: "Generate a 1-sentence personality for a {voice} {species}
       with high {peak_stat}. Be creative and specific. No generic descriptions."
      → write new personality to buddy.json
        → oracle picks it up on next query (per-query context injection)
```

### Implementation

| File | Change |
|------|--------|
| `src/cards.js` | Add "RE-ROLL PERSONALITY" button to companion profile card (separate from familiar re-roll) |
| `src/companion.js` | `rerollOraclePersonality()` — invokes `oracle_query` with personality generation prompt, writes result to buddy.json |
| `src/nim.js` | Add `ORACLE_REROLL_NIM_COST` constant (suggest: 500 nim — personality is high-value) |
| `src-tauri/src/commands/oracle.rs` | No change needed — personality already read per-query from buddy.json |

### UX

- Button text: `RE-ROLL VOICE` (not "personality" — users think in terms of how it sounds)
- Confirm dialog shows: current personality preview, nim cost, "This changes how your companion speaks"
- After re-roll: show new personality in companion bio, flash the oracle tab

### Open Questions

- Should re-roll preserve species/stats/name? **Yes** — only personality text changes.
- Can you preview before committing? **Stretch** — show 3 candidates, pick one. Costs more nim.
- History of past personalities? **Defer** — not needed for v0.2.

---

## 2. "Sync from Claude Code" Revert

**Problem**: After re-rolling in Anima, users may want their official Claude Code /buddy personality back.

**Solution**: One-click sync button that re-reads `~/.claude.json companion.personality` and overwrites buddy.json.

### Design

```
User clicks SYNC FROM CLAUDE CODE on companion profile card
  → read ~/.claude.json companion.personality
    → if exists: write to buddy.json, show "Synced: {preview}"
    → if missing: show "No Claude Code buddy found — use RE-ROLL VOICE instead"
```

### Implementation

| File | Change |
|------|--------|
| `src/cards.js` | Add "SYNC" button next to RE-ROLL VOICE (smaller, secondary style) |
| `src/companion.js` | `syncFromClaudeCode()` — reads ~/.claude.json, extracts companion.personality, writes to buddy.json |

### UX

- Button text: `SYNC` with tooltip "Restore personality from Claude Code /buddy"
- No nim cost — this is a revert, not a roll
- Disabled + greyed if ~/.claude.json has no companion field

---

## 3. MCP Permission Gate (Restored)

**Problem**: v0.1 uses `bypassPermissions` — all tools auto-approved. Users have no visibility into what Claude is doing. Acceptable for alpha testers, not for general release.

**Solution**: Restore the MCP permission gate with proper Tauri resource bundling.

### What was removed (and why)

In v0.1 we removed `anima_gate.py` + `--permission-prompt-tool` because:
- Hardcoded dev path (`~/Projects/pixel-terminal/src-tauri/mcp/anima_gate.py`)
- Required Python3 on user's machine
- MCP server startup race condition caused session crashes
- File-based IPC polling added latency

### v0.2 Approach

| Problem | Fix |
|---------|-----|
| Hardcoded path | Bundle `anima_gate.py` as Tauri resource, resolve at runtime via `app.path().resource_dir()` |
| Python3 dependency | Rewrite gate in Rust as embedded MCP stdio server (eliminates external runtime entirely) |
| Race condition | Add retry logic: if `--permission-prompt-tool` fails, retry spawn after 2s delay for MCP server init |
| File IPC latency | Keep current architecture — 300ms poll is acceptable for permission prompts |

### Implementation (Rust-native gate — preferred)

Instead of Python3 + anima_gate.py, build the MCP stdio server directly in Rust:

| File | Change |
|------|--------|
| `src-tauri/src/commands/mcp_gate.rs` | New file: minimal MCP stdio server (JSON-RPC 2.0, tools/call handler) |
| `src-tauri/src/commands/daemon.rs` | Spawn Rust MCP gate binary alongside daemon |
| `src/session-lifecycle.js` | Re-add `--permission-prompt-tool mcp__anima__approve` to spawn args |
| `src/companion.js` | Re-add session-scoped gate polling for approval dialog |

### Key constraint

`--permission-prompt-tool` is the ONLY programmatic permission path for CLI stream-json mode. Stream-json does NOT emit permission events on stdout. stdin only accepts `{type:"user", message:{...}}` — no control/permission response format exists. This was confirmed via research + Gemini adversarial review.

### Approval Dialog

The approval dialog UI (`#approval-overlay`) is already built and in the DOM. It just needs the polling loop reconnected.

---

## 4. Familiar-Aware Oracle

**Problem**: The oracle companion and session familiars are completely disconnected. The oracle doesn't know which familiar is in the active session.

**Solution**: Inject active session's familiar info into oracle context.

### Design

Add to `build_oracle_system()` context:
```
Active session familiar: Legendary axolotl "Nixwort" (chaos 9/10, shiny)
```

The oracle can then reference the familiar naturally: *"Your legendary axolotl project is burning through tokens faster than its chaos stat suggests."*

### Implementation

| File | Change |
|------|--------|
| `src/session-lifecycle.js` | Pass active session's `familiar` data in `oracle_query` invoke |
| `src-tauri/src/commands/oracle.rs` | Add `familiar` field to `oracle_query` params, inject into context string |

### Scope

- v0.2: Oracle mentions familiar by name/species in responses (context injection only)
- v0.3+: Familiar stats affect oracle behavior (high-chaos familiar → more opinionated responses)

---

## 5. Proactive Commentary Performance

**Problem**: Proactive commentary spawns a new `claude -p` subprocess per call (~7-8s cold start). Direct messages use the persistent OraclePool (~1.8s).

**Solution**: Evaluate routing proactive commentary through a second persistent subprocess.

### Why NOT through OraclePool

Proactive commentary injects daemon pattern data (tool sequences, error counts, JSON structures) into the prompt. If routed through the same OraclePool used for direct messages, this internal data pollutes the conversational context — the oracle starts referencing daemon internals in user-facing responses.

### Approach

| Option | Tradeoff |
|--------|----------|
| **Second persistent subprocess** | Clean separation, ~1.8s proactive comments, doubles memory (~50MB) |
| **OraclePool with context isolation** | Share subprocess but flush/reset context between proactive and direct calls. Risky — stream-json doesn't support context reset. |
| **Keep cold-start** | Simple, no risk. Accept 7-8s latency for proactive comments. They're background — user isn't waiting. |

**Recommendation**: Keep cold-start for v0.2. Proactive comments are ambient — the user isn't waiting for them. The 7-8s latency is acceptable since they appear asynchronously in the ORACLE tab. Revisit if users complain.

---

## Priority Order

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| P0 | Oracle personality re-roll | 1 day | High — every user wants to customize their companion |
| P1 | Sync from Claude Code revert | 0.5 day | Medium — safety net for re-roll |
| P2 | MCP permission gate (Rust) | 2-3 days | High — required for public release beyond alpha |
| P3 | Familiar-aware oracle | 0.5 day | Medium — delight factor, connects the two layers |
| P4 | Proactive performance | Defer | Low — current latency is acceptable for ambient comments |

---

## Architecture Summary

```
                    ┌─────────────────────────────┐
                    │     Claude Code /buddy       │
                    │  ~/.claude.json companion{}  │
                    └──────────┬──────────────────┘
                               │ sync_buddy()
                               ▼
                    ┌─────────────────────────────┐
                    │        buddy.json            │
                    │  name, personality, species,  │
                    │  voice, stats, rarity, ...    │
                    └──────┬──────────┬───────────┘
                           │          │
              ┌────────────┘          └────────────┐
              ▼                                    ▼
   ┌──────────────────┐                ┌──────────────────┐
   │  Oracle Companion │                │  buddy_traits()   │
   │  (persistent      │                │  fallback for     │
   │   subprocess)     │                │  new users        │
   │                   │                └──────────────────┘
   │  Direct messages  │
   │  + Proactive      │
   │  commentary       │
   └──────────────────┘

   ┌──────────────────────────────────────────────┐
   │            Session Familiars                   │
   │  rollFamiliarBones(projectPath, rerollCount)   │
   │  Per-project · re-rollable · nim-gated         │
   │  Cosmetic — does NOT affect oracle             │
   │  (v0.2: oracle becomes aware of active one)    │
   └──────────────────────────────────────────────┘
```

---

## Non-Goals for v0.2

- Familiar trading / sharing between users
- Familiar evolution / leveling
- Multiple oracle companions (only one voice)
- Personality drift from usage patterns (interesting but complex — v0.3+)
- Integration with community tools (BuddyBoard, any-buddy)
