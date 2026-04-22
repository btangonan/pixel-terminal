// ── Session lifecycle ──────────────────────────────────────

import { $, showConfirm } from './dom.js';
import {
  sessions, sessionLogs,
  rollFamiliarBones, assignFamiliarHue, releaseFamiliarHue,
  getActiveSessionId, setActiveSessionId,
  syncOmiSessions, getFamiliarRerollCount,
} from './session.js';
import { getBuddyTrigger, addToVexilLog } from './companion.js';
import { getStagedAttachments, markAttachmentsSent, cleanupSession as cleanupAttachments, initSession as initAttachmentSession } from './attachments.js';
import { getSlashCommands, isBuiltinCommand, loadSlashCommands } from './slash-menu.js';
import { pxLog } from './logger.js';

const { Command } = window.__TAURI__.shell;
const { open: openDialog } = window.__TAURI__.dialog;
const { invoke } = window.__TAURI__.core;

// Shell-safe single-quote escaping for sh -c argument passing.
// 'foo' → 'foo', "it's" → 'it'"'"'s'
function shEsc(s) { return "'" + s.replace(/'/g, "'\\''" ) + "'"; }

// ── Task ledger: writes rolling task state to disk so hooks can read it ──
// PreCompact hook snapshots this; PostCompact hook injects it as recovery context.
// Uses Tauri's write_file_as_text command (creates parent dirs, handles ~ expansion).
function writeTaskLedger(sessionId, ledger) {
  const path = `~/.local/share/pixel-terminal/sessions/${sessionId}/task_ledger.json`;
  invoke('write_file_as_text', { path, content: JSON.stringify(ledger) }).catch(() => {});
}

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
    _spawning: false,
    _perfHistory: [],     // rolling perf stats per turn
    _turnStart: null,     // timestamp when message sent to stdin
    _ttft: null,          // time to first token (ms)
    lastActivityAt: Date.now(),  // updated on tool_any + sendMessage; drives idle badge
    _taskLedger: { userPrompt: '', tools: [], lastText: '' },
  };
  sessions.set(id, session);
  initAttachmentSession(id);

  // Pre-load context window size from project-scoped file (window size only).
  if (cwd) {
    const encoded = cwd.replace(/^\//, '').replace(/\//g, '-');
    try {
      const raw = await window.__TAURI__?.core?.invoke('read_file_as_text', {
        path: `~/.local/share/pixel-terminal/projects/-${encoded}/last_context.json`
      });
      if (raw) {
        const sb = JSON.parse(raw);
        if (sb.window) session._contextWindow = sb.window;
      }
    } catch { /* file absent on first-ever project launch */ }
  }

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
  if (!s || s._spawning) return;
  s._spawning = true;
  // Refresh slash commands from disk — picks up new commands added since startup
  loadSlashCommands().catch(e => pxLog('WARN', 'slash cmd load: ' + e));
  pxLog('SPAWN', `id:${id.slice(0,8)} cwd:${s.cwd} model:${s._modelOverride||'default'} effort:${s._effortOverride||'default'} continue:${!!s._interrupted}`);
  try {
    // ANIMA_PERMISSION_MODE selects the permission strategy:
    //   bypass (default) — --permission-mode bypassPermissions (current shipped behavior)
    //   gated            — --strict-mcp-config + per-session MCP gate via
    //                      --permission-prompt-tool mcp__anima_<sid8>__approve (P2.A)
    //   default          — falls through to bypass (P2.H flips the default after P2.G validation)
    const permissionMode = (window.__ANIMA_PERMISSION_MODE__ || 'bypass').toLowerCase();

    // P2.G — fail-closed supervisor. Before spawning in `gated` mode, check
    // whether the circuit breaker has tripped for this session (≥3 gate
    // crashes in the last 60s). If open, downshift to `--permission-mode
    // default` — NOT bypassPermissions. User must explicitly re-opt into
    // gated after fixing the underlying gate fault.
    let circuitOpen = false;
    let backoffMs = 0;
    if (permissionMode === 'gated') {
      try {
        const snap = await invoke('supervisor_circuit_state', { sessionId: id });
        circuitOpen = !!snap?.open;
        backoffMs = Math.max(0, snap?.backoffMs ?? 0);
      } catch (_) { /* missing state = closed */ }
    }
    if (backoffMs > 0) {
      pxLog('P2G', `id:${id.slice(0,8)} supervisor backoff ${backoffMs}ms before respawn`);
      await new Promise(r => setTimeout(r, backoffMs));
    }

    const claudeArgs = [
      '-p',
      '--input-format',  'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-hook-events',
    ];

    // Record which permission strategy this spawn actually used so the close
    // handler can attribute crashes correctly (only gated-mode crashes feed
    // the circuit breaker).
    let spawnMode = 'bypass';

    if (permissionMode === 'gated' && !circuitOpen) {
      try {
        const bin = await invoke('resolve_gate_binary');
        const info = await invoke('write_mcp_config', {
          sessionId: id,
          gateCommand: bin.command,
          gateArgs: bin.args,
        });
        claudeArgs.push(
          '--permission-mode', 'default',
          '--mcp-config', info.path,
          '--permission-prompt-tool', info.toolFlag,
        );
        spawnMode = 'gated';
        pxLog('P2A', `gated id:${id.slice(0,8)} flag=${info.toolFlag} engine=${bin.engine}`);
      } catch (err) {
        pxLog('P2A', `gate setup failed — falling back to bypass: ${err}`);
        claudeArgs.push('--permission-mode', 'bypassPermissions');
      }
    } else if (permissionMode === 'gated' && circuitOpen) {
      // Fail-closed fallback: CLI prompts instead of MCP gate. Red banner
      // tells the user why every tool call is now asking in-terminal.
      claudeArgs.push('--permission-mode', 'default');
      spawnMode = 'degraded';
      pxLog('P2G', `id:${id.slice(0,8)} circuit OPEN — downshift to --permission-mode default`);
      _deps.pushMessage(id, {
        type: 'error',
        text: 'permission gate degraded; running in CLI default-prompt mode — every tool will prompt in CLI. Re-enable gated mode from Settings after investigating the gate fault.',
      });
    } else {
      claudeArgs.push('--permission-mode', 'bypassPermissions');
    }
    s._spawnMode = spawnMode;
    // Inject compaction-resilience guidance (helps Claude recover after context compression).
    // Text is compiled into the Rust binary — works on any install/fork location.
    try {
      const guidancePath = await invoke('write_system_guidance');
      claudeArgs.push('--append-system-prompt-file', guidancePath);
    } catch (e) { pxLog('WARN', `system guidance unavailable: ${e}`); }
    if (s._interrupted) { claudeArgs.push('--continue'); s._interrupted = false; }
    if (s.readOnly) claudeArgs.push('--disallowed-tools', 'Edit,Write,MultiEdit,NotebookEdit,Bash');
    if (s._modelOverride) claudeArgs.push('--model', s._modelOverride);
    if (s._effortOverride) claudeArgs.push('--effort', s._effortOverride);
    if (s._fallbackModel) claudeArgs.push('--fallback-model', s._fallbackModel);
    // Spawn claude via login shell so PATH resolution finds any install location.
    // `exec` replaces sh with claude for proper signal propagation and PID tracking.
    const shCmd = `exec claude ${claudeArgs.map(shEsc).join(' ')}`;
    const cmd = Command.create('sh', ['-lc', shCmd], { cwd: s.cwd, env: { ANIMA_SESSION: id } });

    let _buf = '';
    cmd.stdout.on('data', (chunk) => {
      _buf += chunk;
      const lines = _buf.split('\n');
      _buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { _deps.handleEvent(id, JSON.parse(line)); } catch (e) { pxLog('WARN', `stdout parse: ${e?.message ?? e}`); }
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
        pxLog('CRASH', `id:${id.slice(0,8)} exit:${code} mode:${s._spawnMode} — restarting`);
        // P2.G — only gated-mode crashes count toward the gate-circuit breaker.
        // Bypass/degraded crashes are unrelated to the MCP gate lifecycle.
        if (s._spawnMode === 'gated') {
          invoke('supervisor_record_gate_crash', { sessionId: id })
            .then((snap) => {
              pxLog('P2G', `id:${id.slice(0,8)} crashes=${snap?.crashes ?? '?'} open=${!!snap?.open}`);
            })
            .catch((e) => pxLog('WARN', `supervisor_record_gate_crash failed: ${e}`));
        }
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
    if (sessions.get(id) !== s) { child.kill(); s._spawning = false; return; } // session deleted during spawn
    s.child = child;
    s._spawning = false;
    s.toolPending = {};

  } catch (err) {
    s._spawning = false;
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
  // Never block — unknown /commands pass through to Claude as text.
  // Claude Code CLI handles native commands (/init, /mcp, /doctor, etc.)
  // and Claude interprets custom ones from CLAUDE.md instructions.
  return false;
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
    // Reset compaction state — new process starts fresh
    s._contextTokens = 0;
    s._contextBaseline = null;
    s._authoritativePct = null;
    s._prevContextTokens = null;
    s._compactionWarned = false;
    s._compactionDetected = false;
    s.tokens = 0;
    s._liveTokens = 0;
    // Repaint card immediately so context meter resets to 0%
    if (_deps.updateSessionCard) _deps.updateSessionCard(id);
    // Use _interrupting so close handler suppresses ERR status
    s._interrupting = true;
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

function isReadyForInput(s) {
  return !!(s.child && !s._interrupting && !s._spawning);
}

// Send a message directly to Claude without slash expansion or builtin check (used by /compact)
async function sendMessageDirect(id, text) {
  const s = sessions.get(id);
  if (!s || !isReadyForInput(s)) return;
  s._workingPhase = 'thinking';
  s._turnStart = Date.now();
  s._ttft = null;
  s._vexilTurn = false;   // direct sends (e.g. /compact) are never vexil turns
  s._lastUserMsg = text;
  _deps.setStatus(id, 'working');
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
  try { await s.child.write(line); } catch (e) { pxLog('WARN', `child write failed: ${e}`); _deps.setStatus(id, 'idle'); }
}

async function sendMessage(id, text, opts = {}) {
  const s = sessions.get(id);
  if (!s || !text.trim()) return;

  const raw = text.trim();

  // Check built-in commands first
  const builtinMatch = raw.match(/^\/(\w[\w-]*)(?:\s+([\s\S]*))?$/);
  if (builtinMatch && BUILTIN_COMMANDS[builtinMatch[1]]) {
    if (!opts.skipPushMessage) _deps.pushMessage(id, { type: 'user', text: raw });
    await BUILTIN_COMMANDS[builtinMatch[1]](id, builtinMatch[2]);
    return;
  }

  if (warnIfUnknownCommand(id, raw)) return;

  if (!isReadyForInput(s)) {
    // No live process — show message immediately so it's not invisible to the user,
    // queue for delivery once the process is ready.
    if (!opts.skipPushMessage) _deps.pushMessage(id, { type: 'user', text: raw });
    s._pendingQueue.push({ text: raw, shown: true });
    _deps.setStatus(id, 'working');
    // Auto-respawn with --continue to preserve conversation context.
    if (!s._spawning && !s._interrupting) {
      s._interrupted = true;
      spawnClaude(id);
    }
    return;
  }

  const expanded = await expandSlashCommand(raw);
  pxLog('MSG→', `id:${id.slice(0,8)} "${raw.slice(0, 80)}${raw.length > 80 ? '…' : ''}"`);
  s._lastUserMsg = raw;  // captured for vexil routing in events.js
  // Task ledger: capture user prompt for compaction recovery
  s._taskLedger.userPrompt = raw.slice(0, 500);
  writeTaskLedger(id, s._taskLedger);
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
  const isVexilTurn = afterTrigger !== null && !afterTrigger.startsWith('/');

  // ── Oracle bypass: vexil-addressed messages go through a dedicated Claude subprocess
  // instead of the main session stdin. This prevents mid-turn swallowing when the main
  // session is busy (agents running, tool calls in progress). Each vexil message gets
  // its own immediate response via the oracle_query Tauri command.
  if (isVexilTurn) {
    if (!opts.skipPushMessage) _deps.pushMessage(id, { type: 'user', text: raw });
    pxLog('VEXIL-ORACLE', `id:${id.slice(0,8)} bypassing main stdin → oracle_query`);
    // Build conversation history from session log — gives oracle same depth as native buddy.
    // Extract user/claude message pairs, cap at last 20 turns to stay within subprocess token budget.
    const logData = sessionLogs.get(id);
    const history = [];
    if (logData?.messages) {
      for (const m of logData.messages) {
        if (m.type === 'user' && m.text)  history.push({ role: 'user', content: m.text.slice(0, 500) });
        if (m.type === 'claude' && m.text) history.push({ role: 'oracle', content: m.text.slice(0, 1000) });
      }
    }
    // Keep last 40 entries (~20 turns) — enough for full conversational context
    const recentHistory = history.slice(-40);
    // Fire and forget — don't block the input or set session to working.
    // The oracle response goes directly to the VEXIL log tab.
    (async () => {
      document.dispatchEvent(new CustomEvent('oracle:thinking'));
      try {
        const resp = await invoke('oracle_query', {
          message: raw,
          history: recentHistory,
          reqId: Date.now(),
          sessions: [...sessions.values()].map(ss => ({ name: ss.name, cwd: ss.cwd })),
        });
        if (resp?.msg) {
          addToVexilLog('vexil', resp.msg);
          pxLog('VEXIL-ORACLE', `id:${id.slice(0,8)} reply: "${resp.msg.slice(0, 80)}"`);
        }
      } catch (err) {
        pxLog('VEXIL-ORACLE', `id:${id.slice(0,8)} oracle failed: ${err}`);
      } finally {
        document.dispatchEvent(new CustomEvent('oracle:idle'));
      }
    })();
    return;
  }

  s._vexilTurn = false;
  s._confirmedVexil = false;
  if (!opts.skipPushMessage) _deps.pushMessage(id, { type: 'user', text: raw });
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
        content[0].text += `\n\n[Attached image: ${att.name}${dimStr}${att.path ? ` | path: ${att.path}` : ' | source: clipboard'}]`;
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
        "This is Anima's own source directory.\nEditing files here will crash all running sessions.\nProceed in read-only mode?",
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

export { createSession, spawnClaude, killSession, interruptSession, sendMessage, expandSlashCommand, warnIfUnknownCommand, pickFolder, writeTaskLedger };
