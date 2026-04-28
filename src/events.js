// ── Event handler + status ─────────────────────────────────

import { $, mdParse, toolHint } from './dom.js';
import { sessions, sessionLogs, getActiveSessionId } from './session.js';
import { pushMessage, updateWorkingCursor, updateCursorPhase, scheduleScroll } from './messages.js';
import { updateSessionCard } from './cards.js';
import { pxLog } from './logger.js';
import { addToVexilLog, getBuddyTrigger, triggerAsciiAction } from './companion.js';
import { accrueNimForSession } from './nim.js';
import { sendMessage, writeTaskLedger } from './session-lifecycle.js';
import { classifyHookEvent } from './hook-events.js';

// ── Model context window sizes (tokens) ───────────────────────────────
// Opus 4.7, Opus 4.6, and Sonnet 4.6 run at 1M tokens (Claude Code GA
// Mar 2026). Older 4.5/3.x models still cap at 200K. These match terminal
// statusline semantics — divide usage by the model's actual window.
// Live query alternative: GET https://api.anthropic.com/v1/models/{id} → max_input_tokens
const MODEL_CONTEXT = {
  'claude-opus-4-7':      1_000_000,
  'claude-opus-4-6':      1_000_000,
  'claude-sonnet-4-6':    1_000_000,
  'claude-haiku-4-5':     200_000,
  'claude-sonnet-4-5':    200_000,
  'claude-opus-4-5':      200_000,
  'claude-3-5-sonnet':    200_000,
  'claude-3-5-haiku':     200_000,
  'claude-3-opus':        200_000,
};
function getContextWindow(model) {
  if (!model || model === 'unknown') return 200_000;
  if (MODEL_CONTEXT[model]) return MODEL_CONTEXT[model];
  const prefix = Object.keys(MODEL_CONTEXT).find(k => model.startsWith(k));
  if (prefix) return MODEL_CONTEXT[prefix];
  pxLog('WARN', `Unknown model "${model}" — defaulting to 200K context window`);
  return 200_000;
}

// ── Context sideband reader (authoritative % from JSONL usage data) ──
// context-sideband.sh hook (PostToolUse) extracts last assistant usage from
// the JSONL transcript and writes {"pct","window","tokens","ts"} per turn.
// Works in -p mode (unlike statusline, which is interactive-only).
async function readContextSideband(sessionId) {
  try {
    const path = `~/.local/share/pixel-terminal/sessions/${sessionId}/context_status.json`;
    const raw = await window.__TAURI__?.core?.invoke('read_file_as_text', { path });
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// Read sideband and update session state + card. Called from tool_result AND turn-end idle timer.
function refreshContextSideband(id) {
  const s = sessions.get(id);
  if (!s) return;
  readContextSideband(id).then(sb => {
    if (!sb || typeof sb.pct !== 'number') {
      pxLog('CTX', `id:${id.slice(0,8)} sideband:none`);
      return;
    }
    const localPct = (s._contextTokens && s._contextBaseline)
      ? Math.min(100, Math.round(
          Math.max(0, s._contextTokens - s._contextBaseline)
          / Math.max(1, (s._contextWindow || 200_000) - s._contextBaseline) * 100))
      : 0;
    const isJSONL = sb.source === 'jsonl';
    // Protect against stale JSONL: accept a DECREASE only if compaction fired,
    // or the window size changed (e.g. hook fixed to use 1M for Opus 4.7
    // instead of stale 200K — sb.window != cached _contextWindow).
    const windowChanged = sb.window && s._contextWindow && sb.window !== s._contextWindow;
    if (isJSONL && typeof s._authoritativePct === 'number'
        && sb.pct < s._authoritativePct
        && !s._compactionDetected
        && !windowChanged) {
      pxLog('CTX', `id:${id.slice(0,8)} JSONL ${sb.pct}% < current ${s._authoritativePct}% — skipped`);
      return;
    }
    s._authoritativePct = sb.pct;
    if (sb.window) s._contextWindow = sb.window;
    pxLog('CTX', `id:${id.slice(0,8)} sideband${isJSONL ? '[jsonl]' : '[statusline]'}:${sb.pct}% local:${localPct}%`);
    if (sb.pct >= 85 && !s._compactionWarned) {
      appendVexilFeed({ type: 'compaction_imminent', session_id: id.slice(0, 8), pct: sb.pct, context_tokens: s._contextTokens, source: 'sideband' });
      s._compactionWarned = true;
    }
    updateSessionCard(id);
  }).catch(err => pxLog('CTX', `id:${id.slice(0,8)} sideband error: ${err?.message || err}`));
}

// ── Vexil Master feed (proactive cross-session commentary) ──────────────
const VEXIL_FEED_PATH = '~/.local/share/pixel-terminal/vexil_feed.jsonl';
function appendVexilFeed(entry) {
  const line = JSON.stringify({ ...entry, ts: Date.now() });
  window.__TAURI__?.core?.invoke('append_line_to_file', { path: VEXIL_FEED_PATH, line }).catch(() => {});
}

// Tools that are Claude Code internal scaffolding — never show in UI
const INTERNAL_TOOLS = new Set([
  'ToolSearch','TodoWrite','TodoRead','AskUserQuestion',
  'TaskCreate','TaskUpdate','TaskList','TaskGet','TaskStop','TaskOutput',
  'ExitPlanMode','EnterPlanMode','NotebookEdit',
  'RemoteTrigger','CronCreate','CronDelete','CronList',
  'ListMcpResourcesTool','ReadMcpResourceTool',
  'EnterWorktree','ExitWorktree',
]);
function isInternalTool(name) {
  return INTERNAL_TOOLS.has(name);
}
function isFeedVisible(name) {
  // MCP tools are real user activity — emit to feed for daemon commentary.
  // Only truly internal tools (task management, plan mode, etc.) are hidden from feed.
  return !INTERNAL_TOOLS.has(name);
}

export function setStatus(id, status) {
  const s = sessions.get(id);
  if (!s || s.status === status) return;
  if (status === 'working') s._dotsPhase = 0; // always start from "" on new working transition
  s.status = status;
  updateSessionCard(id);
  if (getActiveSessionId() === id) updateWorkingCursor(status);
}

export function handleEvent(id, event) {
  const s = sessions.get(id);
  if (!s) return;

  switch (event.type) {

    // ── Low-level streaming events (--verbose / stream-json) ──────────────
    // These fire incrementally as Claude generates. We stream text live and
    // show tool invocations immediately. The high-level 'assistant' event
    // arrives later with the full aggregated content — we use it only for
    // final state (usage, tool inputs) and skip anything already rendered.

    case 'content_block_start': {
      // Cancel idle timer — Claude is actively generating, don't fire turn_complete mid-stream
      clearTimeout(s._idleTimer);
      const blk = event.content_block;
      if (blk?.type === 'text') {
        // Prepare per-block stream state; message pushed on first delta
        s._streamText = '';
        s._streamMsg = null;
        s._streamEl = null;
        s._workingPhase = 'writing';
        updateCursorPhase('writing');
      } else if (blk?.type === 'tool_use') {
        triggerAsciiAction();
        pxLog('TOOL', `id:${id.slice(0,8)} ${blk.name}`);
        if (!isInternalTool(blk.name)) {
          // Show tool name immediately — input arrives later via 'assistant'
          const toolMsg = { type: 'tool', toolName: blk.name, toolId: blk.id, input: '', result: null };
          pushMessage(id, toolMsg);
          if (!s._streamedToolIds) s._streamedToolIds = new Set();
          s._streamedToolIds.add(blk.id);
          s.toolPending[blk.id] = true;
        }
        // Show tool name as phase hint (strip mcp__ prefix for readability)
        const shortName = blk.name.replace(/^mcp__\w+__/, '').replace(/_/g, ' ');
        s._workingPhase = shortName;
        updateCursorPhase(shortName);
        // tool_use fed to Vexil Master in the 'assistant' event backfill — where
        // toolHint() has the full input. Content is useless without context.
      }
      break;
    }

    case 'content_block_delta': {
      const delta = event.delta;
      if (delta?.type !== 'text_delta' || !delta.text) break;
      // Capture TTFT on first text delta of this turn
      if (s._turnStart && s._ttft === null) {
        s._ttft = Date.now() - s._turnStart;
      }
      s._streamText = (s._streamText || '') + delta.text;
      s._turnText = (s._turnText || '') + delta.text;
      // Mark text as streamed regardless of vexil — prevents assistant event from
      // double-accumulating _turnText for vexil turns (break fires before DOM push path)
      s._didStreamText = true;

      if (s._vexilTurn) break; // suppress session log for vexil-addressed turns

      if (!s._streamMsg) {
        // First delta — create the message and capture its DOM element
        s._streamMsg = { type: 'claude', text: s._streamText };
        s._streamEl = pushMessage(id, s._streamMsg);
      } else {
        // Accumulate in memory at full API speed.
        // Coalesce DOM writes at ~60fps — same pattern terminal emulators use.
        // Without this: O(n) textContent= on every delta, style recalc every time.
        s._streamMsg.text = s._streamText;
        s._streamMsg._html = null; // invalidate markdown cache
        if (!s._streamRafId) {
          s._streamRafId = requestAnimationFrame(() => {
            s._streamRafId = null;
            if (!s._streamMsg) return; // block_stop already fired
            let bubble = s._streamEl?.querySelector('.msg-bubble');
            if (!bubble && getActiveSessionId() === id) {
              const msgs = $.messageLog?.querySelectorAll('.msg.claude');
              if (msgs?.length) { s._streamEl = msgs[msgs.length - 1]; bubble = s._streamEl.querySelector('.msg-bubble'); }
            }
            if (bubble) { bubble.textContent = s._streamMsg.text; scheduleScroll(); }
          });
        }
      }
      setStatus(id, 'working');
      break;
    }

    case 'content_block_stop': {
      // Cancel any pending rAF flush — we're about to do a full markdown render anyway
      if (s._streamRafId) { cancelAnimationFrame(s._streamRafId); s._streamRafId = null; }

      // Log completed text block
      if (s._streamText) {
        const preview = s._streamText.replace(/\n/g, ' ').slice(0, 120);
        pxLog('TEXT', `id:${id.slice(0,8)} "${preview}${s._streamText.length > 120 ? '…' : ''}"`);
      }

      // Phase reverts to 'thinking' between blocks
      s._workingPhase = 'thinking';
      updateCursorPhase('thinking');

      // Block complete — re-render streamed text with full markdown
      if (s._streamMsg && s._streamEl) {
        const bubble = s._streamEl.querySelector('.msg-bubble');
        if (bubble) {
          s._streamMsg._html = mdParse(s._streamMsg.text);
          bubble.innerHTML = s._streamMsg._html;
          const paras = bubble.querySelectorAll('p');
          if (paras.length) paras[paras.length - 1].style.color = '#d97857';
        }
      }
      // Clear per-block state; _didStreamText and _streamedToolIds persist until 'assistant'
      s._streamText = null;
      s._streamMsg = null;
      s._streamEl = null;
      break;
    }

    // ── High-level aggregated event (fires after all content_block_stop) ──

    case 'assistant': {
      // Cancel any pending idle debounce — Claude is still going
      clearTimeout(s._idleTimer);
      if (event.message?.usage) {
        s._lastMsgUsage = event.message.usage;
        const u = event.message.usage;
        // Only count input+output — cache_read recurs every turn (already-counted context),
        // causing exponential inflation. cache_creation has the same problem.
        s._liveTokens = (u.input_tokens || 0) + (u.output_tokens || 0);

    // Context window fill (all three fields are additive)
    s._contextTokens = (u.input_tokens || 0)
      + (u.cache_read_input_tokens || 0)
      + (u.cache_creation_input_tokens || 0);

    // Capture baseline on first turn (system prompt + scaffolding)
    if (!s._contextBaseline && s._contextTokens > 0) {
      s._contextBaseline = s._contextTokens;
    }
    // Update bar immediately — don't wait for turn_complete + sideband
    updateSessionCard(id);
      }
      const blocks = event.message?.content || [];

      // Skip text push if already streamed incrementally via content_block_delta
      // Also skip entirely for vexil-addressed turns (goes to VEXIL tab at REPLY time)
      if (!s._didStreamText) {
        const texts = blocks.filter(b => b.type === 'text').map(b => b.text);
        if (texts.length) {
          // Always accumulate _turnText — daemon needs it regardless of vexil routing
          s._turnText = (s._turnText || '') + texts.join('\n');
          if (!s._vexilTurn) {
            pushMessage(id, { type: 'claude', text: texts.join('\n') });
          }
        }
      }
      s._didStreamText = false;

      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const input = typeof b.input === 'object'
            ? JSON.stringify(b.input, null, 2)
            : String(b.input || '');
          // Feed emission: ALL non-internal tools including MCP — daemon needs this for commentary
          if (isFeedVisible(b.name)) {
            const hint = toolHint(b.name, input);
            let filePath = null;
            try { const inp = JSON.parse(input); filePath = inp.file_path || inp.path || null; } catch (_) {}
            if (hint) {
              pxLog('TOOL-IN', `id:${id.slice(0,8)} ${b.name} → ${hint.slice(0,80)}`);
              s._workingPhase = hint; updateCursorPhase(hint);
            }
            appendVexilFeed({ type: 'tool_use', session_id: id.slice(0, 8), tool: b.name, hint: (hint || '').slice(0, 120), file: filePath, cwd: s.cwd });
          }
          // Sequential thinking: surface reasoning steps in session log
          if (b.name === 'mcp__sequential-thinking__sequentialthinking') {
            s._seqThinkCount = (s._seqThinkCount || 0) + 1;
            const inp = typeof b.input === 'object' ? b.input : {};
            const thought = inp.thought || inp.title || `step ${s._seqThinkCount}`;
            const stepLabel = `reasoning · ${thought}`;
            pxLog('SEQ-THINK', `id:${id.slice(0,8)} step:${s._seqThinkCount} thought:${thought.slice(0,60)}`);
            // Each step gets its own message line
            const el = pushMessage(id, { type: 'seq-think', text: stepLabel });
            if (!s._seqThinkEl) s._seqThinkEl = el;  // track first for completion marker
          }
          // UI display: hide MCP + internal tools from message log
          if (!isInternalTool(b.name)) {
            if (s._streamedToolIds?.has(b.id)) {
              // Already shown — backfill real input and re-render hint in DOM
              const data = sessionLogs.get(id);
              const toolMsg = data
                ? data.messages.findLast(m => m.type === 'tool' && m.toolId === b.id)
                : null;
              if (toolMsg) {
                toolMsg.input = input;
                toolMsg._hint = undefined; // force recompute
                if (getActiveSessionId() === id) {
                  const toolEl = $.messageLog?.querySelector(`[data-tool-id="${b.id}"]`);
                  if (toolEl) {
                    const hintEl = toolEl.querySelector('.tool-hint');
                    if (hintEl) { hintEl.textContent = hint || ''; }
                    else if (hint) {
                      const span = document.createElement('span');
                      span.className = 'tool-hint';
                      span.textContent = hint;
                      toolEl.querySelector('.tool-status')?.before(span);
                    }
                  }
                }
              }
            } else {
              pushMessage(id, { type: 'tool', toolName: b.name, toolId: b.id, input, result: null });
            }
          }
          s.toolPending[b.id] = true;
          s.lastActivityAt = Date.now();
          s._turnToolCount = (s._turnToolCount || 0) + 1;
          // Count every tool call for activity tick — including MCP/internal.
          // type:'tool_any' is counter-only; daemon doesn't pattern-match on it.
          appendVexilFeed({ type: 'tool_any', session_id: id.slice(0, 8) });
          // Task ledger: capture tool calls for compaction recovery
          if (s._taskLedger) {
            let filePath = null;
            try { const inp = typeof b.input === 'object' ? b.input : JSON.parse(b.input || '{}'); filePath = inp.file_path || inp.path || inp.command?.slice(0, 80) || ''; } catch (_) {}
            s._taskLedger.tools.push({ name: b.name, path: filePath || '' });
            if (s._taskLedger.tools.length > 30) s._taskLedger.tools.shift();
          }
        }
      }
      // Flush task ledger to disk after processing all tool calls in this event
      if (s._taskLedger && s._taskLedger.tools.length > 0) writeTaskLedger(id, s._taskLedger);
      s._streamedToolIds = null;

      setStatus(id, 'working'); // no-op if already working — so always refresh card for live tokens
      updateSessionCard(id);
      break;
    }

    case 'user': {
      const blocks = event.message?.content || [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const resultText = typeof b.content === 'string'
            ? b.content
            : JSON.stringify(b.content);
          const data = sessionLogs.get(id);
          // tool_use always precedes tool_result — scan from end, no reverse copy needed
          const toolMsg = data
            ? data.messages.findLast(m => m.type === 'tool' && m.toolId === b.tool_use_id)
            : null;
          if (toolMsg) {
            toolMsg.result = resultText;
            if (getActiveSessionId() === id) {
              // Targeted update: swap just the status glyph instead of rebuilding all messages
              const toolEl = $.messageLog?.querySelector(`[data-tool-id="${b.tool_use_id}"]`);
              if (toolEl) {
                toolEl.querySelector('.tool-status').textContent = '\u2713';
              }
            }
          }
          const preview = resultText.replace(/\n/g, ' ').slice(0, 100);
          const toolName = toolMsg?.toolName || b.tool_use_id?.slice(0,8);
          pxLog('RESULT', `id:${id.slice(0,8)} ${toolName} → "${preview}${resultText.length > 100 ? '…' : ''}"`);
          if (b.is_error) {
            appendVexilFeed({ type: 'tool_error', session_id: id.slice(0, 8), tool: toolName, error: preview });
          }
          delete s.toolPending[b.tool_use_id];
          // PostToolUse hook has written the sideband by the time tool_result arrives — read it now
          // so the context % appears on the first tool call rather than waiting for turn end.
          refreshContextSideband(id);
          // Flush pre-tool text from vexil turns — only post-tool text is companion voice.
          // "vexil explain X" → Claude reads file (tool_result fires here) → reply is voice.
          // "vexil run /dream" → dream completes (tool_result) → "DREAM COMPLETE" text → NOT voice.
          // Resetting here means only the synthesis *after* tool completion survives into BUDDY routing.
          if (s._vexilTurn) s._turnText = '';
        }
      }
      break;
    }

    case 'result': {
      s._workingPhase = null;
      // Prefer result.usage (per-turn total); fall back to live tokens already shown
      const u = event.usage || s._lastMsgUsage;
      if (u) s.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
      else s.tokens += s._liveTokens; // result.usage absent and no assistant usage either
      accrueNimForSession(s); // award nim for newly-spent tokens

      // Accumulate output tokens for perf (multiple result events per user turn)
      if (u?.output_tokens) s._perfOutTokens = (s._perfOutTokens || 0) + u.output_tokens;
      // Feed token bloat signal to Vexil Master
      const _turnTok = u ? (u.input_tokens || 0) + (u.output_tokens || 0) : s._liveTokens;
      if (_turnTok > 80000) {
        appendVexilFeed({ type: 'token_bloat', session_id: id.slice(0, 8), tokens: _turnTok });
      }
      if (event.subtype === 'rate_limit') s._hitRateLimit = true;

      // Compaction detection: track token changes for 30% drop (recovery trigger).
      // Warning logic moved to idle timer — uses sideband for authoritative %.
      if (s._contextTokens && s._contextBaseline) {
        // Detect compaction: context dropped significantly (resets warning)
        if (s._prevContextTokens && s._contextTokens < s._prevContextTokens * 0.7) {
          s._compactionWarned = false;
          s._contextBaseline = s._contextTokens; // re-baseline after compaction
          s._compactionDetected = true;  // flag for inline recovery fallback
          s._authoritativePct = null;    // stale — sideband will refresh
          appendVexilFeed({
            type: 'compaction_detected',
            session_id: id.slice(0, 8),
            before: s._prevContextTokens,
            after: s._contextTokens,
          });
        }
        s._prevContextTokens = s._contextTokens;
      }

      s._liveTokens = 0;
      s._lastMsgUsage = null;
      // Debounce: Claude may immediately start another turn after result.
      // Wait 400ms before going idle so the cursor doesn't flicker between turns.
      clearTimeout(s._idleTimer);
      s._idleTimer = setTimeout(() => {
        // ── Perf instrumentation (fires once per complete exchange) ──
        if (s._turnStart) {
          const total = Date.now() - s._turnStart;
          const outTok = s._perfOutTokens || 0;
          const tokPerSec = total > 0 ? Math.round(outTok / (total / 1000)) : 0;
          const ttft = s._ttft || null;
          const entry = { ttft, total, tokPerSec, rateLimited: s._hitRateLimit || false, ts: Date.now() };
          if (!s._perfHistory) s._perfHistory = [];
          s._perfHistory.push(entry);
          if (s._perfHistory.length > 50) s._perfHistory.shift();
          const parts = [];
          if (ttft) parts.push(`${(ttft/1000).toFixed(1)}s TTFT`);
          parts.push(`${(total/1000).toFixed(1)}s total`);
          if (tokPerSec > 0) parts.push(`${tokPerSec} tok/s`);
          pxLog('REPLY', `id:${id.slice(0,8)} ${parts.join(' · ')}${s._hitRateLimit ? ' ⚡rate-limited' : ''}`);
          pushMessage(id, { type: 'system-msg', text: parts.join(' · ') });
          // Route vexil-addressed replies to VEXIL tab only.
          // Guard: verify _lastUserMsg actually started with 'vexil ' — prevents
          // state leaks where _vexilTurn is true but the triggering message wasn't vexil.
          const confirmedVexil = s._confirmedVexil && s._vexilTurn;
          pxLog('VEXIL', `id:${id.slice(0,8)} turn:${s._vexilTurn} confirmed:${confirmedVexil} lastMsg:"${(s._lastUserMsg||'').slice(0,40)}" textLen:${s._turnText?.length ?? 0}`);
          if (confirmedVexil && s._turnText) {
            addToVexilLog('vexil', s._turnText.replace(/\n/g, ' ').slice(0, 240));
          }
          s._turnStart = null;
          s._ttft = null;
          s._hitRateLimit = false;
          s._perfOutTokens = 0;
        }
        // Always emit turn_complete — daemon records all turns for oracle context.
        // Commentary eligibility is decided by daemon richness gate, not tool_count.
        if (s._turnText || s._turnToolCount > 0) {
          appendVexilFeed({
            type:       'turn_complete',
            session_id: id.slice(0, 8),
            tool_count: s._turnToolCount,
            turn_text:  (s._turnText || '').slice(-500),
            user_msg:   (s._lastUserMsg || '').trim().replace(/\n/g, ' ').slice(0, 200),
          });
        }
        // Task ledger: capture last assistant output for compaction recovery
        if (s._taskLedger && s._turnText) {
          s._taskLedger.lastText = s._turnText.slice(-800);
          writeTaskLedger(id, s._taskLedger);
        }
        // ── Sideband context calibration (turn-end refresh — catches any missed tool_result reads) ──
        refreshContextSideband(id);
        // Always reset vexil state — must not bleed into next turn
        s._turnText = '';
        s._lastUserMsg = '';
        s._vexilTurn = false;
        s._confirmedVexil = false;
        s._turnToolCount = 0;
        if (s._seqThinkEl) {
          const label = s._seqThinkEl.querySelector('.seq-think-label');
          if (label) {
            label.innerHTML = `✓ reasoned · ${s._seqThinkCount} step${s._seqThinkCount > 1 ? 's' : ''}`;
            label.classList.add('seq-think-done');
          }
        }
        s._seqThinkCount = 0;
        s._seqThinkEl = null;
        // ── Inline compaction recovery (fallback when hooks don't fire) ──
        if (s._compactionDetected && s.child) {
          s._compactionDetected = false;
          const ledger = s._taskLedger || {};
          const parts = ['[Context was compressed. Task recovery (inline fallback):'];
          if (ledger.userPrompt) parts.push(`Original request: ${ledger.userPrompt}`);
          if (ledger.tools?.length) {
            const recent = ledger.tools.slice(-10).map(t => `${t.name}: ${t.path}`).join(', ');
            parts.push(`Recent tools: ${recent}`);
          }
          if (ledger.lastText) parts.push(`Last output: ${ledger.lastText.slice(-400)}`);
          parts.push('Resume from where you left off. Do NOT re-read files already processed.]');
          const recovery = parts.join('\n');
          pxLog('RECOVERY', `id:${id.slice(0,8)} inline fallback — hooks did not handle compaction`);
          pushMessage(id, { type: 'system-msg', text: 'Sending recovery prompt (hook fallback)...' });
          const line = JSON.stringify({ type: 'user', message: { role: 'user', content: recovery } }) + '\n';
          s.child.write(line).catch(e => pxLog('WARN', `recovery write failed: ${e}`));
          setStatus(id, 'working');  // recovery prompt triggers a new turn
        } else {
          setStatus(id, 'idle');
        }
        if (getActiveSessionId() !== id) {
          s.unread = true;
          updateSessionCard(id);
        }
      }, 400);
      break;
    }

    case 'system':
      if (event.subtype === 'init') {
        s.model = event.model || 'unknown';
        s._contextWindow = getContextWindow(s.model);
        pxLog('READY', `id:${id.slice(0,8)} model:${s.model} ctx:${s._contextWindow}`);
        // Poll for the statusline's initial context write. Statusline fires at session start
        // but races with system.init — poll every 100ms, accept only fresh data (< 5s old).
        // Stops as soon as a real value lands or a turn completes first.
        ;(function pollInitialCtx(attempts) {
          if (typeof s._authoritativePct === 'number') return;
          if (attempts <= 0) return;
          readContextSideband(id).then(sb => {
            if (typeof s._authoritativePct === 'number') return;
            if (sb && typeof sb.pct === 'number') {
              const age = sb.ts ? Date.now() - new Date(sb.ts).getTime() : Infinity;
              if (age < 5000) {
                s._authoritativePct = sb.pct;
                if (sb.window) s._contextWindow = sb.window;
                pxLog('CTX', `id:${id.slice(0,8)} sideband-init:${sb.pct}% age:${Math.round(age)}ms`);
                updateSessionCard(id);
                return;
              }
            }
            setTimeout(() => pollInitialCtx(attempts - 1), 100);
          }).catch(() => setTimeout(() => pollInitialCtx(attempts - 1), 100));
        }(40));
        pushMessage(id, { type: 'system-msg', text: `Ready \u00b7 ${s.model}` });
        // After ESC restart, always go idle regardless of status.
        // Otherwise: don't clobber 'working' if user queued a message before init.
        if (s._restarting || s.status !== 'working') setStatus(id, 'idle');
        s._restarting = false;
        // Flush messages queued before Claude was ready.
        // pushMessage here so they appear AFTER "Ready" in the log.
        if (s._pendingQueue?.length && s.child) {
          const queue = s._pendingQueue.splice(0);
          (async () => {
            for (const item of queue) {
              const msg  = typeof item === 'object' ? item.text : item;
              const shown = typeof item === 'object' && item.shown;
              await sendMessage(id, msg, { skipPushMessage: shown });
            }
          })();
        }
      }
      // Hook lifecycle events (from --include-hook-events).
      // Classification happens in src/hook-events.js (pure function, unit-testable
      // via tests/hook_event_contract.test.js). This block applies the resulting
      // action plan as side effects against the current session.
      try {
        const plan = classifyHookEvent(event, { isInternalTool });
        for (const log of plan.logs) {
          pxLog(log.tag, `id:${id.slice(0,8)} ${log.text}`);
        }
        for (const render of plan.renders) {
          pushMessage(id, render);
        }
        if (plan.stateUpdates) Object.assign(s, plan.stateUpdates);
        if (plan.updateCard) updateSessionCard(id);
      } catch (err) {
        pxLog('HOOK-ERROR', `id:${id.slice(0,8)} hook:${event.hook_event || '?'} ${err?.message || err}`);
      }
      break;

    case 'rate_limit_event':
      s._hitRateLimit = true;
      s._rateLimitCount = (s._rateLimitCount || 0) + 1;
      pxLog('RATE-LIMIT', `id:${id.slice(0,8)} hit #${s._rateLimitCount} — CLI retrying automatically`);
      appendVexilFeed({ type: 'rate_limit', session_id: id.slice(0, 8), retry: s._rateLimitCount });
      break;

    default:
      // Log unknown event types so we can discover buddy/companion events
      pxLog('UNKNOWN-EVENT', `id:${id.slice(0,8)} type:${event.type} keys:${Object.keys(event).join(',')}`);
      break;
  }
}

// Deps injected from app.js to break circular import with session-lifecycle
let _eventDeps = { expandSlashCommand: null, warnIfUnknownCommand: null };
export function setEventDeps(deps) { _eventDeps = deps; }
