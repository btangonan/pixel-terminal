// ── Session lifecycle ──────────────────────────────────────

import { $, showConfirm } from './dom.js';
import {
  sessions, sessionLogs, spriteRenderers, SpriteRenderer,
  getNextIdentity, getActiveSessionId, setActiveSessionId,
  syncOmiSessions, IDENTITY_SEQ_KEY
} from './session.js';
import { getStagedAttachments, markAttachmentsSent } from './attachments.js';
import { getSlashCommands, isBuiltinCommand } from './slash-menu.js';

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


async function createSession(cwd, opts = {}) {
  const id    = crypto.randomUUID();
  const name  = cwd.split('/').pop() || cwd;
  const { animalIndex: charIndex } = getNextIdentity();

  sessionLogs.set(id, { messages: [] });

  /** @type {Session} */
  const session = {
    id, cwd, name, charIndex,
    status: 'idle',
    child: null,
    toolPending: {},
    readOnly: !!opts.readOnly,
    unread: false,
    tokens: 0,
    _liveTokens: 0,
    _dotsPhase: 0,
    _pendingMsg: null,
  };
  sessions.set(id, session);

  _deps.renderSessionCard(id);
  _deps.setActiveSession(id);
  const modeLabel = opts.readOnly ? ' (read-only)' : '';
  _deps.pushMessage(id, { type: 'system-msg', text: `Starting in ${cwd}${modeLabel}…` });
  _deps.pushMessage(id, { type: 'system-msg', text: 'Awaiting instructions' });

  spawnClaude(id); // fire-and-forget — all handling is callback-based
  _deps.setStatus(id, 'waiting'); // static "waiting…" during init — no rotating words until user sends
  syncOmiSessions();
  if (_deps.scanHistory) _deps.scanHistory(cwd);
  return id;
}

// Spawn (or re-spawn) the Claude CLI process for an existing session.

async function spawnClaude(id) {
  const s = sessions.get(id);
  if (!s) return;
  try {
    const claudeArgs = [
      '-p',
      '--input-format',  'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
    ];
    if (s.readOnly) claudeArgs.push('--disallowed-tools', 'Edit,Write,MultiEdit,NotebookEdit,Bash');
    if (s._modelOverride) claudeArgs.push('--model', s._modelOverride);
    if (s._effortOverride) claudeArgs.push('--effort', s._effortOverride);
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
      if (line && line.trim()) _deps.pushMessage(id, { type: 'error', text: `[stderr] ${line.trim()}` });
    });

    cmd.on('close', (data) => {
      const code = (typeof data === 'object' && data !== null) ? data.code : data;
      s.child = null;
      if (s._interrupting) {
        // Intentional ESC interrupt — suppress error status and "Session ended" message.
        // spawnClaude() already called; this close event is the killed process finishing.
        s._interrupting = false;
        return;
      }
      _deps.setStatus(id, code === 0 ? 'idle' : 'error');
      _deps.pushMessage(id, { type: 'system-msg', text: `Session ended (exit ${code})` });
    });

    const child = await cmd.spawn();
    s.child = child;
    s.toolPending = {};
    // _pendingMsg is flushed in system/init handler — Claude only reads stdin after that event

  } catch (err) {
    _deps.pushMessage(id, { type: 'error', text: `Failed to start Claude Code: ${err}` });
    _deps.setStatus(id, 'error');
  }
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.child?.kill(); } catch (_) {}

  spriteRenderers.get(id)?.destroy();
  spriteRenderers.delete(id);

  sessions.delete(id);
  sessionLogs.delete(id);
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
    if (s.child) { try { s.child.kill(); } catch (_) {} s.child = null; }
    spawnClaude(id);
    _deps.pushMessage(id, { type: 'system-msg', text: `Switched to ${args.trim()}. Session restarted.` });
  },

  effort: async (id, args) => {
    const s = sessions.get(id);
    if (!s || !args) {
      _deps.pushMessage(id, { type: 'system-msg', text: 'Usage: /effort <low|medium|high|max>' });
      return;
    }
    s._effortOverride = args.trim();
    if (s.child) { try { s.child.kill(); } catch (_) {} s.child = null; }
    spawnClaude(id);
    _deps.pushMessage(id, { type: 'system-msg', text: `Effort set to ${args.trim()}. Session restarted.` });
  },
};

// Send a message directly to Claude without slash expansion or builtin check (used by /compact)
async function sendMessageDirect(id, text) {
  const s = sessions.get(id);
  if (!s?.child) return;
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
    // Process still spawning — queue until system/init fires.
    // Don't _pushMessage yet — show it after "Ready" so log order is correct.
    s._pendingMsg = raw;
    _deps.setStatus(id, 'working'); // badge reacts immediately
    return;
  }

  const expanded = await expandSlashCommand(raw);
  _deps.pushMessage(id, { type: 'user', text: raw }); // show original in log
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


// ── Folder picker ──────────────────────────────────────────

async function pickFolder() {
  try {
    const { isSelfDirectory } = await import('./session.js');
    const dir = await openDialog({ directory: true, multiple: false, title: 'Choose Project Folder' });
    if (!dir) return;
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

export { createSession, spawnClaude, killSession, sendMessage, expandSlashCommand, warnIfUnknownCommand, pickFolder };
