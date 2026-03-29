// ── Session lifecycle ──────────────────────────────────────

import { $, showConfirm } from './dom.js';
import {
  sessions, sessionLogs, spriteRenderers, SpriteRenderer,
  getNextIdentity, getActiveSessionId, setActiveSessionId,
  syncOmiSessions, IDENTITY_SEQ_KEY
} from './session.js';

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

  spawnClaude(id); // fire-and-forget — all handling is callback-based
  _deps.setStatus(id, 'waiting'); // static "waiting…" during init — no rotating words until user sends
  syncOmiSessions();
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
      '--permission-mode', 'acceptEdits',
    ];
    if (s.readOnly) claudeArgs.push('--disallowed-tools', 'Edit,Write,MultiEdit,NotebookEdit,Bash');
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
  if (!_deps.slashCommands.length) return false;
  const m = text.match(/^\/([^\s\/]+)/);
  if (!m) return false;
  const name = m[1];
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


async function sendMessage(id, text) {
  const s = sessions.get(id);
  if (!s || !text.trim()) return;

  const raw = text.trim();

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

  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: expanded }
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
  } catch (err) {
    console.error('Folder picker error:', err);
  }
}

export { createSession, spawnClaude, killSession, sendMessage, expandSlashCommand, warnIfUnknownCommand, pickFolder };
