// ── Session lifecycle ──────────────────────────────────────

import { $, showConfirm } from './dom.js';
import {
  sessions, sessionLogs,
  rollFamiliarBones, assignFamiliarHue, releaseFamiliarHue,
  getActiveSessionId, setActiveSessionId,
  syncOmiSessions, getFamiliarRerollCount,
} from './session.js';
import { getBuddyTrigger } from './companion.js';
import { getStagedAttachments, markAttachmentsSent, cleanupSession as cleanupAttachments } from './attachments.js';
import { getSlashCommands, isBuiltinCommand } from './slash-menu.js';
import { pxLog } from './logger.js';

const { Command } = window.__TAURI__.shell;
const { open: openDialog } = window.__TAURI__.dialog;
const { invoke } = window.__TAURI__.core;

// Forward declarations — set by app.js bootstrap to break circular deps
let _deps = {
  renderSessionCard: null,
  setActiveSession: null,
  pushMessage: null,
  setStatus: null,
  handleEvent: null,
  updateWorkingCursor: null,
  showEmptyState: null,
  slashCommands: [],
  hideSlashMenu: null,
  exitHistoryView: null,
  scanHistory: null,
};

export function setLifecycleDeps(deps) {
  _deps = deps;
}


function createSession(cwd, opts = {}) {
  const id   = crypto.randomUUID();
  const name = cwd ? cwd.split('/').pop() || cwd : 'untitled';

  // Deterministic familiar from project path — same project always rolls same bones.
  // Bones are never stored; always recomputed. Hue is ephemeral (resets on restart).
  const familiar    = rollFamiliarBones(cwd, getFamiliarRerollCount(cwd));
  const familiarHue = assignFamiliarHue(cwd || id, id);

  sessionLogs.set(id, { messages: [] });

  /** @type {Session} */
  const session = {
    id, cwd, name, familiar, familiarHue, _familiarFrame: 0,
    status: 'idle',
    child: null,
    toolPending: {},
    readOnly: !!opts.readOnly,
    unread: false,
    tokens: 0,
    _nimTokensAccrued: 0,  // tracks tokens already converted to nim (prevents double-award)
    _liveTokens: 0,
    _dotsPhase: 0,
    _pendingQueue: [],
    _perfHistory: [],     // rolling perf stats per turn
    _turnStart: null,     // timestamp when message sent to stdin
    _ttft: null,          // time to first token (ms)
    lastActivityAt: Date.now(),  // updated on tool_any + sendMessage; drives idle badge
  };
  sessions.set(id, session);

  _deps.renderSessionCard(id);
  _deps.setActiveSession(id);
  const modeLabel = opts.readOnly ? ' (read-only)' : '';
  _deps.pushMessage(id, { type: 'system-msg', text: `Starting in ${cwd}${modeLabel}…` });
  _deps.pushMessage(id, { type: 'system-msg', text: 'Loading\u2026' });

  spawnClaude(id); // fire-and-forget — all handling is callback-based
  _deps.setStatus(id, 'waiting'); // static "waiting…" during init — no rotating words until user sends
  syncOmiSessions();
  if (_deps.scanHistory && cwd) _deps.scanHistory(cwd);
  return id;
}

// Spawn (or re-spawn) the Claude CLI process for an existing session.

async function spawnClaude(id) {
  const s = sessions.get(id);
  if (!s) return;
  pxLog('SPAWN', `id:${id.slice(0,8)} cwd:${s.cwd} model:${s._modelOverride||'default'} effort:${s._effortOverride||'default'} continue:${!!s._interrupted}`);
  try {
    const claudeArgs = [
      '-p',
      '--input-format',  'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
    ];
    if (s._interrupted) { claudeArgs.push('--continue'); s._interrupted = false; }
    if (s.readOnly) claudeArgs.push('--disallowed-tools', 'Edit,Write,MultiEdit,NotebookEdit,Bash');
    if (s._modelOverride) claudeArgs.push('--model', s._modelOverride);
    if (s._effortOverride) claudeArgs.push('--effort', s._effortOverride);
    if (s._fallbackModel) claudeArgs.push('--fallback-model', s._fallbackModel);
    const cmd = Command.create('claude', claudeArgs, { cwd: s.cwd });

    let _buf = '';
    cmd.stdout.on('data', (chunk) => {
      _buf += chunk;
      const lines = _buf.split('\n');
      _buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { _deps.handleEvent(id, JSON.parse(line)); } catch (_) {}
      }
    });

    cmd.stderr.on('data', (line) => {
      if (line && line.trim()) {
        pxLog('STDERR', line.trim().slice(0, 120));
        _deps.pushMessage(id, { type: 'error', text: `[stderr] ${line.trim()}` });
      }
    });

    cmd.on('close', (data) => {
      const code = (typeof data === 'object' && data !== null) ? data.code : data;
      if (s._interrupting) {
        // Intentional ESC interrupt — suppress error status and "Session ended" message.
        // New process already spawning via interruptSession; don't null s.child.
        s._interrupting = false;
        return;
      }
      s.child = null;
      if (code !== 0 && !s._manualClose) {
        pxLog('CRASH', `id:${id.slice(0,8)} exit:${code} — restarting`);
        s._interrupted = true;
        _deps.pushMessage(id, { type: 'system-msg', text: `Process crashed (exit ${code}) \u2014 restarting\u2026` });
        spawnClaude(id);
        return;
      }
      s._manualClose = false;
      pxLog('CLOSE', `id:${id.slice(0,8)} exit:${code}`);
      _deps.setStatus(id, code === 0 ? 'idle' : 'error');
      _deps.pushMessage(id, { type: 'system-msg', text: `Session ended (exit ${code})` });
    });

    const child = await cmd.spawn();
    s.child = child;
    s.toolPending = {};

  } catch (err) {
    _deps.pushMessage(id, { type: 'error', text: `Failed to start Claude Code: ${err}` });
    _deps.setStatus(id, 'error');
  }
}

function interruptSession(id) {
  const s = sessions.get(id);
  if (!s || !s.child || s._interrupting) return;
  pxLog('ESC', `id:${id.slice(0,8)}`);
  s._interrupting = true;   // tells close handler to suppress "Session ended"
  s._interrupted = true;    // tells spawnClaude to add --continue
  s._restarting = true;     // tells init handler to go idle (no pending msg to flush)
  try { s.child.kill(); } catch (_) {}
  // Eager respawn: start --continue immediately so Claude warms up with full context
  // while user thinks. By the time they type, s.child is ready → fast response.
  spawnClaude(id);
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  pxLog('KILL', `id:${id.slice(0,8)} cwd:${s.cwd}`);
  s._manualClose = true;
  try { s.child?.kill(); } catch (_) {}

  if (s.cwd) releaseFamiliarHue(s.cwd, id);

  sessions.delete(id);
  sessionLogs.delete(id);
  cleanupAttachments(id);
  document.getElementById(`card-${id}`)?.remove();

  if (getActiveSessionId() === id) {
    const remaining = [...sessions.keys()];
    if (remaining.length > 0) _deps.setActiveSession(remaining[remaining.length - 1]);
    else {
      setActiveSessionId(null);
      _deps.showEmptyState();
    }
  }
  syncOmiSessions();
}


function warnIfUnknownCommand(id, text) {
  const m = text.match(/^\/([^\s\/]+)/);
  if (!m) return false;
  const name = m[1];
  if (isBuiltinCommand(name)) return false;
  if (_deps.slashCommands.find(c => c.name === name)) return false;
  _deps.pushMessage(id, { type: 'warn', text: `Unknown command: /${name}` });
  return true;
}

async function expandSlashCommand(text) {
  const m = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!m) return text;
  const [, cmdName, args = ''] = m;
  if (!_deps.slashCommands.find(c => c.name === cmdName)) return text;
  try {
    const body = await invoke('read_slash_command_content', { name: cmdName });
    if (!body) return text;
    return args.trim() ? body + '\n\nARGUMENTS: ' + args.trim() : body;
  } catch (_) {
    return text;
  }
}


// ── Built-in commands (handled locally, never sent to Claude) ──
const BUILTIN_COMMANDS = {
  clear: async (id) => {
    const s = sessions.get(id);
    if (!s) return;
    const log = document.getElementById('message-log');
    if (log) log.querySelectorAll('.msg').forEach(m => m.remove());
    const sl = sessionLogs.get(id);
    if (sl) sl.messages = [];
    s._manualClose = true;
    if (s.child) { try { s.child.kill(); } catch (_) {} s.child = null; }
    spawnClaude(id);
    _deps.pushMessage(id, { type: 'system-msg', text: 'Session cleared.' });
  },

  cost: async (id) => {
    const s = sessions.get(id);
    if (!s) return;
    _deps.pushMessage(id, { type: 'system-msg',
      text: `Tokens: ${(s.tokens || 0).toLocaleString()} in / ${(s._liveTokens || 0).toLocaleString()} out` });
  },

  perf: async (id) => {
    const s = sessions.get(id);
    if (!s) return;
    const h = s._perfHistory || [];
    if (h.length === 0) {
      _deps.pushMessage(id, { type: 'system-msg', text: 'No perf data yet — send a message first.' });
      return;
    }
    const med = arr => { const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; };
    const ttfts = h.map(x => x.ttft).filter(Boolean);
    const totals = h.map(x => x.total).filter(Boolean);
    const tps = h.map(x => x.tokPerSec).filter(Boolean);
    const lines = [
      `Performance (last ${h.length} turns):`,
      ttfts.length ? `  TTFT:     ${med(ttfts).toFixed(0)}ms median` : '',
      totals.length ? `  Total:    ${(med(totals)/1000).toFixed(1)}s median` : '',
      tps.length ? `  Speed:    ${med(tps).toFixed(0)} tok/s median` : '',
      `  Rate lim: ${h.filter(x => x.rateLimited).length}/${h.length} turns`,
      '',
      'Last 5:',
      ...h.slice(-5).map((t, i) =>
        `  ${i+1}. ${t.ttft ? t.ttft+'ms' : '—'} TTFT · ${t.total ? (t.total/1000).toFixed(1)+'s' : '—'} · ${t.tokPerSec ? t.tokPerSec+' tok/s' : '—'}${t.rateLimited ? ' ⚡' : ''}`
      ),
    ].filter(Boolean);
    _deps.pushMessage(id, { type: 'system-msg', text: lines.join('\n') });
  },

  help: async (id) => {
    const cmds = getSlashCommands().map(c => `/${c.name} — ${c.description}`);
    _deps.pushMessage(id, { type: 'system-msg', text: `Available commands:\n${cmds.join('\n')}` });
  },

  compact: async (id) => {
    _deps.pushMessage(id, { type: 'system-msg', text: 'Compacting — asking Claude to summarize…' });
    sendMessageDirect(id, 'Summarize our conversation so far in 3-5 bullet points. Be specific about files changed, decisions made, and current state. Output ONLY the summary, no preamble.');
  },

  model: async (id, args) => {
    const s = sessions.get(id);
    if (!s || !args) {
      _deps.pushMessage(id, { type: 'system-msg', text: 'Usage: /model <name> (e.g., sonnet, opus, haiku)' });
      return;
    }
    s._modelOverride = args.trim();
    s._interrupted = true;  // preserve conversation context via --continue
    s._interrupting = true; // tell close handler this kill is intentional (not a crash)
    s._restarting = true;   // tell init handler to go idle (no pending msg to flush)
    if (s.child) { try { s.child.kill(); } catch (_) {} }
    spawnClaude(id);
    _deps.pushMessage(id, { type: 'system-msg', text: `Switched to ${args.trim()}. Context preserved.` });
  },

  fallback: async (id, args) => {
    const s = sessions.get(id);
    if (!s) return;
    if (!args || args.trim() === 'off') {
      s._fallbackModel = null;
      _deps.pushMessage(id, { type: 'system-msg', text: 'Fallback model disabled.' });
    } else {
      s._fallbackModel = args.trim();
      _deps.pushMessage(id, { type: 'system-msg', text: `Fallback model set to ${args.trim()}. Takes effect next turn.` });
    }
  },

  effort: async (id, args) => {
    const s = sessions.get(id);
    if (!s || !args) {
      _deps.pushMessage(id, { type: 'system-msg', text: 'Usage: /effort <low|medium|high|max>' });
      return;
    }
    s._effortOverride = args.trim();
    s._interrupted = true;  // preserve conversation context via --continue
    s._interrupting = true; // tell close handler this kill is intentional (not a crash)
    s._restarting = true;   // tell init handler to go idle (no pending msg to flush)
    if (s.child) { try { s.child.kill(); } catch (_) {} }
    spawnClaude(id);
    _deps.pushMessage(id, { type: 'system-msg', text: `Effort set to ${args.trim()}. Context preserved.` });
  },
};

// Send a message directly to Claude without slash expansion or builtin check (used by /compact)
async function sendMessageDirect(id, text) {
  const s = sessions.get(id);
  if (!s?.child) return;
  s._workingPhase = 'thinking';
  s._turnStart = Date.now();
  s._ttft = null;
  s._vexilTurn = false;   // direct sends (e.g. /compact) are never vexil turns
  s._lastUserMsg = text;
  _deps.setStatus(id, 'working');
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
  try { await s.child.write(line); } catch (_) { _deps.setStatus(id, 'idle'); }
}

async function sendMessage(id, text) {
  const s = sessions.get(id);
  if (!s || !text.trim()) return;

  const raw = text.trim();

  // Check built-in commands first
  const builtinMatch = raw.match(/^\/(\w[\w-]*)(?:\s+([\s\S]*))?$/);
  if (builtinMatch && BUILTIN_COMMANDS[builtinMatch[1]]) {
    _deps.pushMessage(id, { type: 'user', text: raw });
    await BUILTIN_COMMANDS[builtinMatch[1]](id, builtinMatch[2]);
    return;
  }

  if (warnIfUnknownCommand(id, raw)) return;

  if (!s.child) {
    // Process still spawning — queue until Claude's stdin is ready.
    // Claude 2.1.x does not emit system/init proactively; it emits it only after
    // receiving the first stdin message. So messages sent after s.child is set go
    // directly to Claude's stdin, which triggers system/init before Claude responds.
    // Don't _pushMessage yet — show it after "Ready" so log order is correct.
    s._pendingQueue.push(raw);
    _deps.setStatus(id, 'working'); // badge reacts immediately
    return;
  }

  const expanded = await expandSlashCommand(raw);
  pxLog('MSG→', `id:${id.slice(0,8)} "${raw.slice(0, 80)}${raw.length > 80 ? '…' : ''}"`);
  s._lastUserMsg = raw;  // captured for vexil routing in events.js
  const trigger = getBuddyTrigger();           // e.g. "vexil "
  const triggerName = trigger.trim();           // e.g. "vexil"
  // Escape any regex special chars in buddy name (e.g. "Mr. Robot", "C++")
  const triggerEscaped = triggerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lowerRaw = raw.toLowerCase();
  // Match "vexil <message>" (start) OR "hey vexil" / "vexil?" (word anywhere)
  const startsWithTrigger = lowerRaw.startsWith(trigger);
  const containsTrigger   = !startsWithTrigger && new RegExp(`\\b${triggerEscaped}\\b`).test(lowerRaw);
  const afterTrigger = startsWithTrigger ? raw.slice(trigger.length).trimStart()
                      : containsTrigger  ? raw
                      : null;
  // Vexil turn only for conversational messages — not slash command invocations (skill output stays in session log)
  s._vexilTurn = afterTrigger !== null && !afterTrigger.startsWith('/');
  // Precompute confirmedVexil so events.js doesn't re-parse the same text
  s._confirmedVexil = s._vexilTurn;
  _deps.pushMessage(id, { type: 'user', text: raw }); // always show user message in session log
  s._workingPhase = 'thinking';
  _deps.setStatus(id, 'working');

  // Build content: string for plain text, array for multimodal (with attachments)
  const staged = getStagedAttachments(id);
  let content;
  if (staged.length === 0) {
    content = expanded;
  } else {
    content = [{ type: 'text', text: expanded }];
    for (const att of staged) {
      if (att.isImage) {
        // Include original dimensions and path in the message.
        // Dimensions are pre-computed from the canvas before resize — they are the REAL file dimensions.
        // The base64 preview is resized to ≤1568px so Claude should NOT infer dimensions from the blob.
        // Path is included for tool use (read file, further analysis) but macOS filenames may contain
        // Unicode spaces (U+202F narrow no-break space in "10:45 AM") — use glob/find if direct open fails.
        const dimStr = (att.originalWidth && att.originalHeight)
          ? ` | original dimensions: ${att.originalWidth}×${att.originalHeight}px`
          : '';
        content[0].text += `\n\n[Attached image: ${att.name}${dimStr} | path: ${att.path}]`;
        content.push({ type: 'image', source: { type: 'base64', media_type: att.mimeType, data: att.data } });
      } else {
        content.push({ type: 'text', text: `\n\n[Attached file: ${att.name} | path: ${att.path}]\n${att.data}` });
      }
    }
    markAttachmentsSent(id);
  }

  s._turnStart = Date.now();
  s.lastActivityAt = Date.now();
  s._ttft = null;
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content }
  }) + '\n';
  try {
    await s.child.write(line);
  } catch (err) {
    _deps.pushMessage(id, { type: 'error', text: 'Send failed — please retry' });
    _deps.setStatus(id, 'idle');
  }
}


// ── Session health ─────────────────────────────────────────

const IDLE_STALE_MS    = 15 * 60 * 1000;  // 15 min without activity → stale
const SESSION_WARN_AT  = 5;               // warn when opening session N+1

export function getStaleSessionIds() {
  const now = Date.now();
  const activeId = getActiveSessionId();
  return [...sessions.entries()]
    .filter(([id, s]) =>
      id !== activeId &&
      s.status === 'idle' &&
      (now - (s.lastActivityAt ?? now)) > IDLE_STALE_MS
    )
    .map(([id]) => id);
}

export { IDLE_STALE_MS };

// ── Folder picker ──────────────────────────────────────────

async function pickFolder() {
  try {
    const { isSelfDirectory } = await import('./session.js');
    const dir = await openDialog({ directory: true, multiple: false, title: 'Choose Project Folder' });
    if (!dir) return;
    // Creation gate — offer to close idle sessions before adding another
    if (sessions.size >= SESSION_WARN_AT) {
      const staleIds = getStaleSessionIds();
      if (staleIds.length > 0) {
        const staleMin = Math.round(IDLE_STALE_MS / 60000);
        const ok = await showConfirm(
          `${sessions.size} sessions open, ${staleIds.length} idle >${staleMin}min.\nClose idle sessions before opening a new one?`,
          'close idle + open'
        );
        if (ok) staleIds.forEach(id => killSession(id));
        // always proceed regardless — "cancel" = open anyway
      }
    }

    if (await isSelfDirectory(dir)) {
      const proceed = await showConfirm(
        "This is Pixel Terminal's own source directory.\nEditing files here will crash all running sessions.\nProceed in read-only mode?",
        'proceed read-only'
      );
      if (!proceed) return;
      await createSession(dir, { readOnly: true });
    } else {
      await createSession(dir);
    }
    // Guard: macOS dialog focus restoration can fire spurious click events
    // on the adjacent HISTORY tab button, switching back to history view.
    // Re-assert LIVE tab after pending events settle.
    setTimeout(() => {
      if (sessions.size > 0) {
        document.getElementById('session-list')?.classList.remove('hidden');
        document.getElementById('history-view')?.classList.add('hidden');
        document.querySelectorAll('.session-tab').forEach(b => {
          b.classList.toggle('active', b.dataset.tab === 'live');
        });
      }
    }, 50);
  } catch (err) {
    console.error('Folder picker error:', err);
  }
}

export { createSession, spawnClaude, killSession, interruptSession, sendMessage, expandSlashCommand, warnIfUnknownCommand, pickFolder };
