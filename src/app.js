/**
 * Pixel Terminal — app.js
 * Uses Tauri global APIs (withGlobalTauri: true), no bundler needed.
 *
 * Globals available:
 *   window.__TAURI__.shell.Command
 *   window.__TAURI__.dialog.open
 *   window.marked  (from marked.umd.js)
 */

'use strict';

// ── Tauri + marked globals ─────────────────────────────────

const { Command } = window.__TAURI__.shell;
const { open: openDialog } = window.__TAURI__.dialog;
const { parse: mdParse } = window.marked;
window.marked.setOptions({ breaks: true, gfm: true });

// ── Sprite data (inlined — eliminates all load/protocol issues) ──────────
const SPRITE_DATA = {
  'cat': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBTgApxcIv/x8Qe7fooAJ5fI//stS/+DaBiG8YeCfpgZ+PggwMiAA4AUGzjYgNnPnzwH05IykgwXDhxh+P7tDU596PqR9YIAqfopsf9a1UQGrbZ8uBiMj6yfBZ8hIItBlsIcTw5A1gvzCLGAUvujjq1mQI4EEB8dMGHTCEsqIIvXlyvAHQNjE0qGMHmQepjlIDbMI8TqJ9d+GEBOObgCkQndYhBGTiIWucfBBu0PywOzQQBXEkTXD1IP0gfSD9NLin5y7SclAJmw5TmYJaD8Bgs5x1WTGF7euYvXcnT9IPUgfcTkX2raT0oAMmEzDGaguIoy3PEgDLKAlFIcpB85+ZGjn1z7iQ1AJnyGwDSDQpDUAmyg9RMbgEzoGmGKYJpJBYNJPzEByISeZJABSNMyq1Bw0gFhEBsXGOr6RwHDCAUAGpNqzZQe1mUAAAAASUVORK5CYII=',
  'rabbit': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA9klEQVR4nGNgGAWjYBQgA04ukf8gjItPKiBVP7XtJwSYsAmeW90AthgXn1RAqn5K7Cc1AJmIdRQpltMyxqgdgCz4DCI16YIsggGj0AaKA4EeAcmCLvD92xtGkOOX5DrDxa4dOkyUYUahiAAgRz+l9pMTgEz4JGMm70WhCTkchsnRT6n9yO4ARQQoAGEYXwAy4TMMlKSNeP3ANDlgoPUTE4CM+JIPLBmCDECOWWLAQOqH6dWys2XgOC/I8MPwPTh7YjODCV3g+tYp4FIcOQ+C2MQWSAOtHwRAKQYUaKCkf+7zJpyexwlAlsEcgsweKfpHwShgGDkAAJoz5Ga0OakEAAAAAElFTkSuQmCC',
  'penguin': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA/ElEQVR4nGNgGAWjYEQDRlwSnFwi/5H537+9wamWFoAa9pNtBieXyH9Vq7j/r9++hGN0w4gxAxmTqpca9pNtBieXCFwDjCbFAZR6gFL7STGDCZ8hjx5fZXg/M5ThYo0WA6ng2OZuBjlZbTAbRpMKKLEfmxkgTFRAclIpBkH4VpsdGNMzBZFiBhMDjYCVbymYFkxfDcb0BCCPyhh4gVMhDIBSIbZCkIlhhAMmXKGHDkBipCZDcgCl9pOqnwmbIU8ubCNKjBoOoLb9pOpnQhfA11ggtiFBiQcotZ9U/Sy4FG/1eQCvvkiphkCWgGIam35SWnPk2k8t/aOAYYQAAGGKGJY9IlqWAAAAAElFTkSuQmCC',
  'crab': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA60lEQVR4nGNgGAWjYBSMgmEEOLlE/oMwseJMlBpAbUCJ/SD5OWoyOOVBcuhmsOAyIOUWw//v394w4hPH5QgQja4Glzi17ScVMGETTLn1hCgxdABzKHpI4xLHBci1H90t2NhEBcAcLMkIX9KitgcotZ8U/UzYBEGOffT4Kjzfgdj09ACl9lOkn5NL5P9SA4P/MBqZTUwhBFP3+u1LMI3MJtUMUu0nRz8TuuZjvhrg0ALRMIAsRsgRIHWg2JaT1QbTyGxCsUCp/eToZyHkGbAB6gjDCAGQJVabb8BpXGLEAHLsp6b+UTAKGIY/AADH7fC4BIq4LgAAAABJRU5ErkJggg==',
  'rat': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBSMZMCIS4KTS+Q/jP392xtGXGK0AJTaTYp+FnwGFdrpgun+Q5f/o/Fp7glK7CZFPyMhT2gLCaOIXX33lqjYB+lFtxSZT0wskms3KfqZiDFstrUoCk0MAFkE8uiuK88YQA4BYRCbGM9TajcpepmIMWj1R1YGNx0pMA2KReSkjAxKVSz+gzA5DqHUbmypD1kvLsCI7gEQ3X3nBCO2ZLR4Zi6DUWgDzhh0lDX8v//xeUaQOSAzYPpBjkAG2FIBpXZj039udQNDbPpk4rOQo6wh2BDkWAQZZCKj/r/Kw/E/odBHj32YXhi+vnUKTjMotRuXfpBekBm49DMhc0zY2RmwxQIsBkFsfA4B6QM5AOQYEA0KbVCog/SDML4YpNRuXPpBAGQGIf1wgOwBWAiCaGQ2A5GAVP2U2k1Nt4+CUcAwMgAAymMvotX5iBgAAAAASUVORK5CYII=',
  'seal': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAAxklEQVR4nGNgGAWjYBSMghEMGAkp4OQS+Y/M//7tDUE91DSDUvsJ6WckpLmitwlFrKO4jmQPkGsGpfYTo5+JGINAmpBpcgAlZtBSLxNyaMGSCzIbBPYd3cGwY/MuMI0L4NNPjBm0sp8YvWAA0tA4fdp/ZBpZHFmMXP34zKCH/dj0M2LLM7B8AuL7ZSQzaKnKE5UHh6J+JnRDrt1+yAAyBJtmYsBQ08+ILgDTCAMFsaEMTtYeYDYoH4HY+Erhoa5/FIwChpEFAKM3JDuNyYkcAAAAAElFTkSuQmCC',
  'snake': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABHUlEQVR4nGNgGOGAkWEYAk4ukf/I/O/f3jCOmADg5BL5X6iTznDs4zUGK34tMH3y8WGcgcCEyxBkTK5DyDWDUvv7r8wEex5G4wOMlIYgLg+Qawal9sP0wwDJ7ueEhnqVWTUKTZRmKphBTfuJ0c+ETRAWgrCYIAdQYgal9sNi+/72GPLcz0lCCNLCDGrZ/+JgAXkp4DulIUihGdSwHwYI6WciZAChUhQXAIU6yAOTSrlJLkSpYT+x+lmQOdiSCiwEkeVweWag9WMzB1k/Nn1MyJpAhQ4o1kAYPQTNZW3BhRKIxubQgdaPbg42/dj0MWILNRhAdggMgJI0qIGBHpoDrR+bOcj6celjxGYIPkeBACmNksGkn9xyaBQwDGMAAKNsPyaqyIfWAAAAAElFTkSuQmCC'
};

// ── SpriteRenderer ─────────────────────────────────────────
// CSS background-image + RAF. No canvas. No image load events.
// Sheet 64x16 displayed at 128x32 (2x). backgroundPosition shifts per frame.

const ANIMALS = ['cat', 'rabbit', 'penguin', 'crab', 'rat', 'seal', 'snake'];

class SpriteRenderer {
  constructor(el, charIndex) {
    this.el = el;
    this._frameIdx = 0;
    this._status = 'idle';
    this._raf = null;
    this._lastTs = 0;
    this._FPS = 6;

    const animal = ANIMALS[charIndex % ANIMALS.length];
    const data = SPRITE_DATA[animal];

    el.style.width = '40px';
    el.style.height = '40px';
    el.style.flexShrink = '0';
    el.style.backgroundImage = "url('" + data + "')";
    el.style.backgroundSize = '160px 40px';
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundPosition = '0 0';
    el.style.imageRendering = 'pixelated';
    // Loop starts only when setStatus transitions to an active state
  }

  setStatus(status) {
    if (this._status === status) return;
    const wasInactive = this._status === 'idle' || this._status === 'error';
    this._status = status;
    this._frameIdx = 0;
    this._lastTs = 0; // reset so first frame of new state doesn't skip delay
    this.el.style.backgroundPosition = '0 0'; // snap to frame 0 immediately
    this._FPS = status === 'working' ? 3 : status === 'waiting' ? 2 : 3;
    // Restart loop when transitioning from a paused (idle/error) state
    const isInactive = status === 'idle' || status === 'error';
    if (wasInactive && !isInactive && !this._raf) this._startLoop();
  }

  _startLoop() {
    const loop = (ts) => {
      // Self-cancel when idle/error — don't keep spinning at 60fps doing nothing
      if (this._status === 'idle' || this._status === 'error') {
        this._raf = null;
        return;
      }
      this._raf = requestAnimationFrame(loop);
      if (ts - this._lastTs >= 1000 / this._FPS) {
        this._frameIdx = (this._frameIdx + 1) % 4;
        this.el.style.backgroundPosition = (-this._frameIdx * 40) + 'px 0';
        this._lastTs = ts;
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  destroy() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }
}

// ── Self-directory detection ────────────────────────────────
// Walks upward from cwd checking for .pixel-terminal sentinel file.
// Prevents Claude sessions from editing Pixel Terminal's own source files.

async function isSelfDirectory(cwd) {
  let dir = cwd.replace(/\/$/, ''); // strip trailing slash
  for (let i = 0; i < 10; i++) {
    try {
      const cmd = Command.create('test', ['-f', dir + '/.pixel-terminal']);
      const out = await cmd.execute();
      if (out.code === 0) return true;
    } catch (err) { console.warn('isSelfDirectory check failed:', err); }
    const parent = dir.replace(/\/[^/]+$/, '') || '/';
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

// ── Session counter (for charIndex sprite rotation) ────────

let sessionCounter = 0;

// ── Session state ──────────────────────────────────────────

/** @type {Map<string, Session>} */
const sessions = new Map();

/** @type {Map<string, {messages: Object[]}>} */
const sessionLogs = new Map();

/** @type {Map<string, SpriteRenderer>} — one renderer per session card */
const spriteRenderers = new Map();

let activeSessionId = null;

// ── Session lifecycle ──────────────────────────────────────

async function createSession(cwd, opts = {}) {
  const id    = crypto.randomUUID();
  const name  = cwd.split('/').pop() || cwd;
  const charIndex = sessionCounter % ANIMALS.length;
  sessionCounter++;

  sessionLogs.set(id, { messages: [] });

  /** @type {Session} */
  const session = {
    id, cwd, name, charIndex,
    status: 'idle',
    child: null,
    toolPending: {},
    readOnly: !!opts.readOnly
  };
  sessions.set(id, session);

  renderSessionCard(id);
  setActiveSession(id);
  const modeLabel = opts.readOnly ? ' (read-only)' : '';
  pushMessage(id, { type: 'system-msg', text: `Starting in ${cwd}${modeLabel}…` });

  try {
    // Tauri v2: attach listeners to the Command BEFORE spawn.
    // ChildProcess (returned by spawn) only has write() + kill() — no stdout/stderr.
    const claudeArgs = [
      '-p',
      '--input-format',  'stream-json',
      '--output-format', 'stream-json',
      '--verbose',        // required by Claude when using --print + stream-json
      '--permission-mode', 'acceptEdits',
    ];
    if (opts.readOnly) claudeArgs.push('--disallowed-tools', 'Edit,Write,MultiEdit,NotebookEdit,Bash');
    const cmd = Command.create('claude', claudeArgs, { cwd });

    // Line buffer: stdout arrives in chunks — accumulate until newline before parsing.
    let _buf = '';
    cmd.stdout.on('data', (chunk) => {
      _buf += chunk;
      const lines = _buf.split('\n');
      _buf = lines.pop(); // last element may be incomplete — hold it
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleEvent(id, JSON.parse(line));
        } catch (_) {
          // Discard unparseable lines — verbose noise, not user-facing content
        }
      }
    });

    cmd.stderr.on('data', (line) => {
      if (line && line.trim()) pushMessage(id, { type: 'error', text: `[stderr] ${line.trim()}` });
    });

    cmd.on('close', (data) => {
      // Tauri v2 close payload: { code: number|null, signal: number|null }
      const code = (typeof data === 'object' && data !== null) ? data.code : data;
      setStatus(id, code === 0 ? 'idle' : 'error');
      pushMessage(id, { type: 'system-msg', text: `Session ended (exit ${code})` });
    });

    const child = await cmd.spawn();
    session.child = child;

  } catch (err) {
    pushMessage(id, { type: 'error', text: `Failed to start Claude Code: ${err}` });
    setStatus(id, 'error');
  }

  return id;
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

  if (activeSessionId === id) {
    const remaining = [...sessions.keys()];
    if (remaining.length > 0) setActiveSession(remaining[remaining.length - 1]);
    else {
      activeSessionId = null;
      showEmptyState();
    }
  }
}

async function sendMessage(id, text) {
  const s = sessions.get(id);
  if (!s || !s.child || !text.trim()) return;

  pushMessage(id, { type: 'user', text: text.trim() });
  setStatus(id, 'working');

  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text.trim() }
  }) + '\n';

  await s.child.write(line);
}

// ── Event handler ──────────────────────────────────────────

function handleEvent(id, event) {
  const s = sessions.get(id);
  if (!s) return;

  switch (event.type) {

    case 'assistant': {
      // Cancel any pending idle debounce — Claude is still going
      clearTimeout(s._idleTimer);
      const blocks = event.message?.content || [];

      const texts = blocks.filter(b => b.type === 'text').map(b => b.text);
      if (texts.length) pushMessage(id, { type: 'claude', text: texts.join('\n') });

      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const input = typeof b.input === 'object'
            ? JSON.stringify(b.input, null, 2)
            : String(b.input || '');
          pushMessage(id, { type: 'tool', toolName: b.name, toolId: b.id, input, result: null });
          s.toolPending[b.id] = true;
        }
      }
      setStatus(id, 'working');
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
            if (activeSessionId === id) {
              // Targeted update: swap just the status glyph instead of rebuilding all messages
              const log = document.getElementById('message-log');
              const toolEl = log?.querySelector(`[data-tool-id="${b.tool_use_id}"]`);
              if (toolEl) {
                toolEl.querySelector('.tool-status').textContent = '✓';
                if (!toolEl.querySelector('.tool-result')) toolEl.appendChild(makeResultEl(resultText));
              }
            }
          }
          delete s.toolPending[b.tool_use_id];
        }
      }
      break;
    }

    case 'result':
      // Debounce: Claude may immediately start another turn after result.
      // Wait 400ms before going idle so the cursor doesn't flicker between turns.
      clearTimeout(s._idleTimer);
      s._idleTimer = setTimeout(() => setStatus(id, 'idle'), 400);
      break;

    case 'system':
      if (event.subtype === 'init') {
        pushMessage(id, { type: 'system-msg', text: `Ready · ${event.model || 'claude'}` });
        setStatus(id, 'idle');
      }
      break;

    case 'rate_limit_event':
      pushMessage(id, { type: 'system-msg', text: `Rate limited — retrying…` });
      break;
  }
}

// ── Status ─────────────────────────────────────────────────

function setStatus(id, status) {
  const s = sessions.get(id);
  if (!s || s.status === status) return;
  s.status = status;
  updateSessionCard(id);
  if (activeSessionId === id) updateWorkingCursor(status);
}

function updateWorkingCursor(status) {
  const log = document.getElementById('message-log');
  if (!log) return;
  let cur = document.getElementById('working-cursor');
  if (status === 'working' || status === 'waiting') {
    if (!cur) {
      cur = document.createElement('div');
      cur.id = 'working-cursor';
      const label = status === 'waiting' ? 'waiting' : 'working';
      cur.innerHTML = `<span class="cursor-blink">▋</span> ${label}…`;
      log.appendChild(cur);
      scheduleScroll();
    }
  } else {
    cur?.remove();
  }
}

// ── Message log ────────────────────────────────────────────

// rAF-coalesced scroll — multiple messages in one frame trigger only one reflow
let _scrollPending = false;
function scheduleScroll() {
  if (_scrollPending) return;
  _scrollPending = true;
  requestAnimationFrame(() => {
    _scrollPending = false;
    const log = document.getElementById('message-log');
    if (log) log.scrollTop = log.scrollHeight;
  });
}

function pushMessage(id, msg) {
  const data = sessionLogs.get(id);
  if (!data) return;
  data.messages.push(msg);
  if (activeSessionId === id) {
    const log = document.getElementById('message-log');
    if (log) {
      // Insert BEFORE the working cursor so cursor stays at bottom
      const cursor = document.getElementById('working-cursor');
      const el = createMsgEl(msg);
      el.classList.add('msg-new');
      if (cursor) log.insertBefore(el, cursor);
      else log.appendChild(el);
      scheduleScroll();
    }
  }
}

function renderMessageLog(id) {
  const log = document.getElementById('message-log');
  if (!log) return;
  log.innerHTML = ''; // cursor gets wiped here — restore below
  const data = sessionLogs.get(id);
  if (data) {
    // DocumentFragment: build all elements off-DOM, single reflow on append
    const frag = document.createDocumentFragment();
    for (const msg of data.messages) frag.appendChild(createMsgEl(msg));
    log.appendChild(frag);
  }
  // Always restore cursor to match current session status
  const s = sessions.get(id);
  if (s && (s.status === 'working' || s.status === 'waiting')) {
    updateWorkingCursor(s.status);
  }
  scheduleScroll();
}

// Extract human-readable text from a tool result (plain string or JSON content array)
function extractResultText(raw) {
  const s = String(raw);
  try {
    const parsed = JSON.parse(s);
    // Agent / MCP tools return an array of content blocks: [{type:'text', text:'...'}]
    if (Array.isArray(parsed)) {
      return parsed
        .filter(b => b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        // Strip metadata-only blocks (agentId, <usage>, duration_ms)
        .filter(t => !/^agentId:|^<usage>/.test(t.trimStart()))
        .join('\n').trim() || s;
    }
    // Plain object — use first string value if unambiguous
    if (typeof parsed === 'object' && parsed !== null) {
      const vals = Object.values(parsed).filter(v => typeof v === 'string');
      if (vals.length === 1) return vals[0];
    }
  } catch (_) {}
  return s;
}

// Render tool result content — truncated to 30 lines to keep UI scannable
function makeResultEl(text) {
  const out = document.createElement('div');
  out.className = 'tool-result';
  const content = extractResultText(text);
  const lines = content.split('\n');
  const MAX = 30;
  const visible = lines.slice(0, MAX).join('\n');
  const overflow = lines.length - MAX;
  out.textContent = overflow > 0 ? visible + `\n… ${overflow} more lines` : visible;
  return out;
}

function createMsgEl(msg) {
  const el = document.createElement('div');
  el.className = `msg ${msg.type}`;

  if (msg.type === 'user') {
    el.innerHTML = `<div class="msg-bubble">${esc(msg.text)}</div>`;

  } else if (msg.type === 'claude') {
    // Cache parsed HTML — msg.text is immutable after creation
    if (!msg._html) {
      const normalized = msg.text.replace(/\n\n(?=[ \t]*(?:\d+[.)]\s|[-*+]\s))/g, '\n');
      msg._html = mdParse(normalized);
    }
    el.innerHTML = `<div class="msg-bubble">${msg._html}</div>`;
    // Orange for the last paragraph regardless of trailing hr/empty nodes
    const paras = el.querySelectorAll('.msg-bubble p');
    if (paras.length) paras[paras.length - 1].style.color = '#e8820c';

  } else if (msg.type === 'tool') {
    const icon = toolIcon(msg.toolName);
    // Cache hint — msg.input is immutable after creation
    if (msg._hint === undefined) msg._hint = toolHint(msg.toolName, msg.input);
    const hint = msg._hint;
    const hasResult = msg.result !== null && msg.result !== undefined;
    const status = hasResult ? '✓' : '…';
    el.dataset.toolId = msg.toolId;
    el.innerHTML = `<div class="tool-line">${icon} <span class="tool-name">${esc(msg.toolName)}</span>${hint ? ` <span class="tool-hint">${esc(hint)}</span>` : ''} <span class="tool-status">${status}</span></div>`;
    if (hasResult) el.appendChild(makeResultEl(msg.result));

  } else if (msg.type === 'system-msg') {
    el.innerHTML = `<div class="system-label">${esc(msg.text)}</div>`;

  } else if (msg.type === 'error') {
    el.innerHTML = `<div class="error-msg">${esc(msg.text)}</div>`;
  }

  return el;
}

// ── Session cards ──────────────────────────────────────────

function renderSessionCard(id) {
  const s = sessions.get(id);
  if (!s) return;

  const card = document.createElement('div');
  card.className = 'session-card';
  card.id = `card-${id}`;
  card.innerHTML = `
    <div class="session-card-top">
      <div class="sprite-wrap" id="card-sprite-wrap-${id}"></div>
      <div class="session-card-info">
        <div class="session-card-name">${esc(s.name)}</div>
      </div>
      <span class="card-badge" id="card-status-${id}"></span>
    </div>
    <button class="session-card-kill" title="Kill session" data-id="${id}">✕</button>
  `;

  card.addEventListener('click', (e) => {
    if (e.target.closest('.session-card-kill')) return;
    setActiveSession(id);
  });
  card.querySelector('.session-card-kill').addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await showConfirm(`Terminate "${s.name}"? This will end the session.`);
    if (ok) killSession(id);
  });
  document.getElementById('session-list').appendChild(card);

  // Attach sprite renderer to the wrap div
  const wrap = document.getElementById(`card-sprite-wrap-${id}`);
  spriteRenderers.set(id, new SpriteRenderer(wrap, s.charIndex));
}

function updateSessionCard(id) {
  const s = sessions.get(id);
  if (!s) return;

  spriteRenderers.get(id)?.setStatus(s.status);

  const statusEl = document.getElementById(`card-status-${id}`);
  if (statusEl) {
    // Show IDLE badge only when idle; working/waiting/error = sprite speaks
    statusEl.textContent = s.status === 'idle' ? 'IDLE' : s.status === 'error' ? 'ERR' : '';
    statusEl.className = `card-badge ${s.status}`;
    statusEl.style.display = (s.status === 'idle' || s.status === 'error') ? '' : 'none';
  }

  const card = document.getElementById(`card-${id}`);
  if (card) card.classList.toggle('active', activeSessionId === id);
}

// ── Session switching ──────────────────────────────────────

function setActiveSession(id) {
  const prev = activeSessionId;
  activeSessionId = id;
  if (prev && prev !== id) updateSessionCard(prev);
  updateSessionCard(id);
  showChatView();
  renderMessageLog(id);
  const s = sessions.get(id);
  if (s) updateWorkingCursor(s.status);
  document.getElementById('msg-input')?.focus();
}

// ── View helpers ───────────────────────────────────────────

function showEmptyState() {
  document.getElementById('msg-input').disabled = true;
  document.getElementById('btn-send').disabled = true;
  document.getElementById('message-log').innerHTML = '';
}

function showChatView() {
  document.getElementById('msg-input').disabled = false;
  document.getElementById('btn-send').disabled = false;
}

// ── Util ───────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toolIcon(name = '') {
  return '·';
}

function toolHint(name, inputStr) {
  try {
    const obj = JSON.parse(inputStr);
    const n = name.toLowerCase();
    // File/path tools
    if (obj.file_path) return obj.file_path.replace(/.*\//, '');
    if (obj.path) return obj.path.replace(/.*\//, '');
    if (obj.pattern) return obj.pattern;
    if (obj.command) return String(obj.command).slice(0, 60);
    // Memory tools
    if (obj.query_texts) return obj.query_texts[0]?.slice(0, 50);
    if (obj.collection && obj.documents) return obj.collection;
    // Web
    if (obj.url) return obj.url.replace(/^https?:\/\//, '').slice(0, 50);
    if (obj.query) return String(obj.query).slice(0, 50);
    // Figma
    if (obj.node_id) return `node:${obj.node_id}`;
    if (obj.name) return String(obj.name).slice(0, 50);
    // Generic: first string value
    const first = Object.values(obj).find(v => typeof v === 'string');
    return first ? first.slice(0, 50) : '';
  } catch (_) {
    return String(inputStr || '').slice(0, 50);
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ── Confirm modal ──────────────────────────────────────────

function showConfirm(message, okLabel = 'terminate') {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay');
    document.getElementById('confirm-msg').textContent = message;
    document.getElementById('confirm-ok').textContent = okLabel;
    overlay.classList.remove('hidden');

    function onOk()    { cleanup(); resolve(true);  }
    function onCancel(){ cleanup(); resolve(false); }
    function onKey(e)  {
      if (e.key === 'Enter')  { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }

    function cleanup() {
      overlay.classList.add('hidden');
      document.getElementById('confirm-ok').removeEventListener('click', onOk);
      document.getElementById('confirm-cancel').removeEventListener('click', onCancel);
      window.removeEventListener('keydown', onKey);
    }

    document.getElementById('confirm-ok').addEventListener('click', onOk);
    document.getElementById('confirm-cancel').addEventListener('click', onCancel);
    window.addEventListener('keydown', onKey);
  });
}

// ── Folder picker ──────────────────────────────────────────

async function pickFolder() {
  try {
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

// ── Bootstrap ──────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {

  // Sidebar resize
  const sidebar = document.getElementById('sidebar');
  const resizeHandle = document.getElementById('sidebar-resize');
  let _resizing = false, _resizeStartX = 0, _resizeStartW = 0;
  let _resizeRafId = null, _resizeW = 0;
  resizeHandle.addEventListener('mousedown', (e) => {
    _resizing = true;
    _resizeStartX = e.clientX;
    _resizeStartW = sidebar.offsetWidth;
    resizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!_resizing) return;
    _resizeW = Math.max(80, Math.min(320, _resizeStartW + (e.clientX - _resizeStartX)));
    if (!_resizeRafId) {
      _resizeRafId = requestAnimationFrame(() => {
        sidebar.style.width = _resizeW + 'px';
        _resizeRafId = null;
      });
    }
  });
  window.addEventListener('mouseup', () => {
    if (!_resizing) return;
    _resizing = false;
    // Flush any pending RAF and apply the final width immediately
    if (_resizeRafId) { cancelAnimationFrame(_resizeRafId); _resizeRafId = null; sidebar.style.width = _resizeW + 'px'; }
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  document.getElementById('btn-new-session').addEventListener('click', pickFolder);
  showEmptyState(); // input disabled until first session opens

  document.getElementById('btn-send').addEventListener('click', () => {
    const input = document.getElementById('msg-input');
    const text = input.value;
    if (!text.trim() || !activeSessionId) return;
    input.value = '';
    input.style.height = ''; // reset to rows="1" — avoids WebKit scrollHeight=0 collapse
    sendMessage(activeSessionId, text);
  });

  document.getElementById('msg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('btn-send').click(); }
  });

  document.getElementById('msg-input').addEventListener('input', (e) => autoResize(e.target));

  // Esc — cancel active Claude operation
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeSessionId) {
      const s = sessions.get(activeSessionId);
      if (s && s.child && (s.status === 'working' || s.status === 'waiting')) {
        e.preventDefault();
        try { s.child.kill(); } catch (_) {}
        s.child = null;
        pushMessage(activeSessionId, { type: 'system-msg', text: 'Interrupted' });
        clearTimeout(s._idleTimer);
        setStatus(activeSessionId, 'error');
      }
    }
  });

  // Cmd+1-5 to switch sessions
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '5') {
      e.preventDefault();
      const ids = [...sessions.keys()];
      const target = ids[parseInt(e.key) - 1];
      if (target) setActiveSession(target);
    }
  });

  // Window close (red X) — HTML confirm modal
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  let _forceClose = false;
  appWindow.onCloseRequested(async (event) => {
    if (_forceClose) return;
    event.preventDefault();
    const count = sessions.size;
    const msg = count > 0
      ? `Close Pixel Terminal? ${count} session${count > 1 ? 's' : ''} will be terminated.`
      : 'Close Pixel Terminal?';
    const ok = await showConfirm(msg);
    if (ok) {
      _forceClose = true;
      for (const [id] of sessions) {
        try { sessions.get(id)?.child?.kill(); } catch (_) {}
      }
      appWindow.close();
    }
  });
});
