# Audit — Vexil Oracle Voice Fix + Sprite Spec Alignment
**Date**: 2026-04-04 | **Branch**: feat/familiar-card-phase2
**Scope**: Session changes (vexil oracle rewrite, voice.js scroll) + sprite implementation vs. spec
**Method**: 8-stage analysis + Stage 9 Gemini two-pass adversarial (gemini-3.1-pro-preview)
**Source material**: buddy-sprites-implementation-brief.md, 20260403_research_claude-buddy-ascii-sprites.md

---

## Stage 8 — Maturity Scores

| Dimension | Score | Evidence |
|---|---|---|
| LOC Discipline | 3 | Modular additions, no file bloated |
| Validation Coverage | 2 | No schema on `oracle_query.json`; graceful `.get()` defaults |
| Secrets Hygiene | 3 | `load_claude_companion()` returns only `data.get('companion', {})` — API key at root never extracted |
| State & Persistence | 2 | `_session_convo` bounded at 4 entries per session; no cleanup by session count |
| Errors/Retry | 3 | Timeouts and subprocess errors handled; `load_claude_companion()` try/except already present |
| Testing | 1 | No tests added for oracle persona/context changes |

---

## Top Findings

### 🔴 CRITICAL — renderFrame line-drop: per-frame vs. all-frames (spec deviation)
**File**: `src/ascii-sprites.js:132–153`
**Spec** (from sprites.ts source, both research docs):
> "Drop line 0 if ALL frames have blank line 0 (no hat, no effects)"

**Implementation** (line 147–150): drops line 0 if the **current frame's** line 0 is blank — per-frame check, not all-frames.

**Impact**: 7 species have action-frame (frame 2) decorations on line 0:
- Dragon `~    ~`, Octopus `o`, Ghost `~  ~`, Capybara `~  ~`, Robot `*`, Mushroom `. o  .`, Cactus raised arms
- For these species: idle→action animation toggles between 4 lines (blank line 0 dropped) and 5 lines (decoration kept). The `<pre>` element changes height by one line, causing layout jitter.

**Fix** (one-liner in `renderFrame`):
```javascript
// Replace per-frame check with all-frames check:
const allFramesBlankLine0 = speciesFrames.every(f => f[0].trim() === '');
if (noHat && allFramesBlankLine0) {
  lines = lines.slice(1);
}
```
Both Gemini Pass 1 and Pass 2 AGREE this is correct. Corroborated by spec.

---

### 🟡 WARNING — Path traversal in `_read_file_context` uses `str.startswith()`
**File**: `scripts/vexil_master.py:283`
```python
if cwd and not str(p).startswith(str(Path(cwd).resolve())):
```
`str.startswith('/foo/bar')` permits `/foo/bar_baz/` — directory name collision bypass.
**Fix**: `if cwd and not p.is_relative_to(Path(cwd).resolve()):` (Python 3.9+)
Corroborated by both Gemini passes independently.

---

### 🟡 WARNING — `generate-buddy.js` rollStat comment vs. code mismatch
**File**: `scripts/generate-buddy.js` (~line 52)
- Comment: "roll 3d10, keep weighted result" + "weighted toward extremes"
- Code: rolls 2d10, averages → triangular (center-heavy) distribution
- Stat generation produces different distribution than documented. Not a crash, but stats skewed toward middle, not extremes.

---

### 🟡 WARNING — File rotation inode check missing
**File**: `scripts/vexil_master.py` (main poll loop)
Rotation detected by size decrease only. If a new file reaches the same or larger size between 1s poll intervals, rotation is missed — daemon reads garbage or skips events.
**Fix**: Compare `os.stat(FEED_PATH).st_ino` between polls.

---

### 🔴 CRITICAL (pre-existing, not this session) — `attachments.js` reads file before size check
**File**: `src/attachments.js` (~line 87)
```javascript
const raw = await invoke('read_file_as_base64', { path });
```
No file size check before reading. A 2GB video dragged into chat allocates ~2.6GB base64 in the V8 heap → crash.
**Fix**: `get_file_metadata` → check `< 20MB` before `read_file_as_base64`.
Flagged by Gemini Pass 1 + Pass 2. Pre-existing (not introduced this session).

---

## Session Changes Assessment (Oracle Voice Fix)

All oracle changes are **SOUND**:

| Change | Assessment |
|---|---|
| `call_claude_oracle` loads `load_claude_companion()` personality | ✅ Correct — matches what `build_persona()` does for commentary |
| Removes "Only reference what you were told" hedge | ✅ Correct — was causing confused, epistemically timid responses |
| `_session_convo` rolling buffer (4 turns, under `_activity_lock`) | ✅ Thread-safe under CPython GIL + explicit lock |
| `recent_convo` injected into oracle prompt | ✅ Gives oracle context for "is this right?" queries |
| `--max-tokens 50` (oracle) / `60` (commentary) | ✅ Hard limit backstop for "Under 15 words" soft instruction |
| `requestAnimationFrame` scroll fix in `voice.js` | ✅ Correct fix for layout reflow race |

---

## Stage 9 — Adversarial Cross-Model Review

### Agreed (high-confidence)
- renderFrame per-frame line-drop bug is real — both passes agree
- str.startswith() path traversal — corroborated independently
- Validation score 2, Testing score 1 — confirmed
- attachments.js OOM risk — both passes flag independently

### Contested
- **Gemini DISAGREE: Secrets Hygiene Score 3** → Claude rebuttal: `load_claude_companion()` returns `data.get('companion', {})` only — API key at root is never extracted. Score 3 confirmed.

### Gemini-only new findings (add to backlog)
- `generate-buddy.js` rollStat 2d10/triangular vs. 3d10/extremes | WARNING
- `app.js` setInterval over unbounded sessions Map | NOTE
- File rotation inode | WARNING
- `attachments.js` OOM | CRITICAL (pre-existing)

---

## Action Items

| Priority | File | Fix |
|---|---|---|
| 🔴 Ship with next PR | `src/ascii-sprites.js:147` | Replace per-frame with all-frames line-drop check |
| 🔴 Ship with next PR | `src/attachments.js` | File size check before read_file_as_base64 |
| 🟡 PR #3 | `scripts/vexil_master.py:283` | `is_relative_to()` for cwd check |
| 🟡 PR #3 | `scripts/vexil_master.py` | inode check for feed rotation |
| 🟡 Backlog | `scripts/generate-buddy.js` | Fix rollStat to match intended distribution |
