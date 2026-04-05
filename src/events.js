// ── Event handler + status ─────────────────────────────────

import { $, mdParse, toolHint } from './dom.js';
import { sessions, sessionLogs, getActiveSessionId } from './session.js';
import { pushMessage, updateWorkingCursor, updateCursorPhase, scheduleScroll } from './messages.js';
import { updateSessionCard } from './cards.js';
import { pxLog } from './logger.js';
import { addToVexilLog, getBuddyTrigger, triggerAsciiAction } from './companion.js';
import { accrueNimForSession } from './nim.js';

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
  return name.startsWith('mcp__') || INTERNAL_TOOLS.has(name);
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
          if (!isInternalTool(b.name)) {
            // Compute hint + file path for ALL non-internal tools — feed needs this for proactive commentary
            const hint = toolHint(b.name, input);
            let filePath = null;
            try { const inp = JSON.parse(input); filePath = inp.file_path || inp.path || null; } catch (_) {}
            if (hint) {
              pxLog('TOOL-IN', `id:${id.slice(0,8)} ${b.name} → ${hint.slice(0,80)}`);
              s._workingPhase = hint; updateCursorPhase(hint);
            }
            // Always feed tool_use with context — daemon needs this for pattern detection
            appendVexilFeed({ type: 'tool_use', session_id: id.slice(0, 8), tool: b.name, hint: (hint || '').slice(0, 120), file: filePath, cwd: s.cwd });

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
        }
      }
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
        // Always emit turn_complete — daemon uses tool_count to gate commentary,
        // but needs all turns (including pure-chat) for oracle conversation context.
        if (s._turnText || s._turnToolCount > 0) {
          appendVexilFeed({
            type:       'turn_complete',
            session_id: id.slice(0, 8),
            tool_count: s._turnToolCount,
            turn_text:  (s._turnText || '').slice(-500),
            user_msg:   (s._lastUserMsg || '').trim().replace(/\n/g, ' ').slice(0, 200),
          });
        }
        // Always reset vexil state — must not bleed into next turn
        s._turnText = '';
        s._lastUserMsg = '';
        s._vexilTurn = false;
        s._confirmedVexil = false;
        s._turnToolCount = 0;
        setStatus(id, 'idle');
        if (getActiveSessionId() !== id) {
          s.unread = true;
          updateSessionCard(id);
        }
      }, 400);
      break;
    }

    case 'system':
      if (event.subtype === 'init') {
        pxLog('READY', `id:${id.slice(0,8)} model:${event.model || 'unknown'}`);
        pushMessage(id, { type: 'system-msg', text: `Ready \u00b7 ${event.model || 'claude'}` });
        // After ESC restart, always go idle regardless of status.
        // Otherwise: don't clobber 'working' if user queued a message before init.
        if (s._restarting || s.status !== 'working') setStatus(id, 'idle');
        s._restarting = false;
        // Flush messages queued before Claude was ready.
        // pushMessage here so they appear AFTER "Ready" in the log.
        if (s._pendingQueue?.length && s.child) {
          const { expandSlashCommand, warnIfUnknownCommand } = _eventDeps;
          const queue = s._pendingQueue.splice(0);
          (async () => {
            for (const msg of queue) {
              if (warnIfUnknownCommand(id, msg)) continue;
              const isVexil = msg.toLowerCase().startsWith(getBuddyTrigger());
              pushMessage(id, { type: 'user', text: msg }); // always show user message in session log
              try {
                const expanded = await expandSlashCommand(msg);
                if (!s.child) break;
                s._turnStart = Date.now();
                s._ttft = null;
                s._hitRateLimit = false;
                s._vexilTurn = isVexil;
                s._lastUserMsg = msg;
                await s.child.write(JSON.stringify({ type: 'user', message: { role: 'user', content: expanded } }) + '\n');
              } catch (_) {
                pushMessage(id, { type: 'error', text: 'Failed to send \u2014 please resend your message' });
                setStatus(id, 'idle');
                break;
              }
            }
          })();
        }
      }
      break;

    case 'rate_limit_event':
      s._hitRateLimit = true;
      s._rateLimitCount = (s._rateLimitCount || 0) + 1;
      pxLog('RATE-LIMIT', `id:${id.slice(0,8)} hit #${s._rateLimitCount} — CLI retrying automatically`);
      pushMessage(id, { type: 'system-msg', text: s._rateLimitCount > 1
        ? `\u29d6 rate limited \u00d7${s._rateLimitCount} \u00b7 retrying\u2026`
        : '\u29d6 rate limited \u00b7 retrying\u2026' });
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
