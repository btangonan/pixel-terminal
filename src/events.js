// ── Event handler + status ─────────────────────────────────

import { $ } from './dom.js';
import { sessions, sessionLogs, getActiveSessionId } from './session.js';
import { pushMessage, updateWorkingCursor } from './messages.js';
import { updateSessionCard } from './cards.js';

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

      const texts = blocks.filter(b => b.type === 'text').map(b => b.text);
      if (texts.length) pushMessage(id, { type: 'claude', text: texts.join('\n') });

      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const input = typeof b.input === 'object'
            ? JSON.stringify(b.input, null, 2)
            : String(b.input || '');
          if (!isInternalTool(b.name)) {
            pushMessage(id, { type: 'tool', toolName: b.name, toolId: b.id, input, result: null });
          }
          s.toolPending[b.id] = true;
        }
      }
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
          delete s.toolPending[b.tool_use_id];
        }
      }
      break;
    }

    case 'result': {
      // Prefer result.usage (per-turn total); fall back to live tokens already shown
      const u = event.usage || s._lastMsgUsage;
      if (u) s.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
      else s.tokens += s._liveTokens; // result.usage absent and no assistant usage either
      s._liveTokens = 0;
      s._lastMsgUsage = null;
      // Debounce: Claude may immediately start another turn after result.
      // Wait 400ms before going idle so the cursor doesn't flicker between turns.
      clearTimeout(s._idleTimer);
      s._idleTimer = setTimeout(() => {
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
        pushMessage(id, { type: 'system-msg', text: `Ready \u00b7 ${event.model || 'claude'}` });
        // After ESC restart, always go idle regardless of status.
        // Otherwise: don't clobber 'working' if user queued a message before init.
        if (s._restarting || s.status !== 'working') setStatus(id, 'idle');
        s._restarting = false;
        // Flush message queued before Claude was ready.
        // pushMessage here so it appears AFTER "Ready" in the log.
        if (s._pendingMsg && s.child) {
          const { expandSlashCommand } = _eventDeps;
          const { warnIfUnknownCommand } = _eventDeps;
          const msg = s._pendingMsg;
          s._pendingMsg = null;
          if (warnIfUnknownCommand(id, msg)) break;
          pushMessage(id, { type: 'user', text: msg }); // show original
          expandSlashCommand(msg).then(expanded => {
            if (!s.child) return;
            return s.child.write(JSON.stringify({ type: 'user', message: { role: 'user', content: expanded } }) + '\n');
          }).catch(() => {
            pushMessage(id, { type: 'error', text: 'Failed to send \u2014 please resend your message' });
            setStatus(id, 'idle');
          });
        }
      }
      break;

    case 'rate_limit_event':
      // CLI retries automatically — don't add a permanent log entry (looks like an error).
      // Flash badge to 'waiting' for 3s so there's ambient feedback without alarming the user.
      setStatus(id, 'waiting');
      clearTimeout(s._rateLimitTimer);
      s._rateLimitTimer = setTimeout(() => {
        if (s.status === 'waiting') setStatus(id, 'working');
      }, 3000);
      break;
  }
}

// Deps injected from app.js to break circular import with session-lifecycle
let _eventDeps = { expandSlashCommand: null, warnIfUnknownCommand: null };
export function setEventDeps(deps) { _eventDeps = deps; }
