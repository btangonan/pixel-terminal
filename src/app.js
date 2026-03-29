/**
 * Pixel Terminal — app.js
 * Uses Tauri global APIs (withGlobalTauri: true), no bundler needed.
 *
 * Globals available:
 *   window.__TAURI__.shell.Command
 *   window.__TAURI__.dialog.open
 *   window.marked  (from marked.umd.js)
 */

import { $, initDOM, esc, autoResize, mdParse, toolIcon, toolHint, showConfirm } from './dom.js';
import {
  sessions, sessionLogs, spriteRenderers, SpriteRenderer,
  getNextIdentity, getActiveSessionId, setActiveSessionId,
  syncOmiSessions, formatTokens, IDENTITY_SEQ_KEY, isSelfDirectory
} from './session.js';
import {
  createSession, spawnClaude, killSession, sendMessage,
  expandSlashCommand, pickFolder, setLifecycleDeps
} from './session-lifecycle.js';

// ── Tauri globals ──────────────────────────────────────────

const { Command } = window.__TAURI__.shell;
const { invoke } = window.__TAURI__.core;


// activeSessionId: local alias backed by getter/setter in session.js
let activeSessionId = null;
function _syncActiveSessionId() { activeSessionId = getActiveSessionId(); }

// ── Event handler ──────────────────────────────────────────

function handleEvent(id, event) {
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
            if (activeSessionId === id) {
              // Targeted update: swap just the status glyph instead of rebuilding all messages
              const toolEl = $.messageLog?.querySelector(`[data-tool-id="${b.tool_use_id}"]`);
              if (toolEl) {
                toolEl.querySelector('.tool-status').textContent = '✓';
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
        if (activeSessionId !== id) {
          s.unread = true;
          updateSessionCard(id);
        }
      }, 400);
      break;
    }

    case 'system':
      if (event.subtype === 'init') {
        pushMessage(id, { type: 'system-msg', text: `Ready · ${event.model || 'claude'}` });
        // After ESC restart, always go idle regardless of status.
        // Otherwise: don't clobber 'working' if user queued a message before init.
        if (s._restarting || s.status !== 'working') setStatus(id, 'idle');
        s._restarting = false;
        // Flush message queued before Claude was ready.
        // pushMessage here so it appears AFTER "Ready" in the log.
        if (s._pendingMsg && s.child) {
          const msg = s._pendingMsg;
          s._pendingMsg = null;
          if (warnIfUnknownCommand(id, msg)) break;
          pushMessage(id, { type: 'user', text: msg }); // show original
          expandSlashCommand(msg).then(expanded => {
            if (!s.child) return;
            return s.child.write(JSON.stringify({ type: 'user', message: { role: 'user', content: expanded } }) + '\n');
          }).catch(() => {
            pushMessage(id, { type: 'error', text: 'Failed to send — please resend your message' });
            setStatus(id, 'idle');
          });
        }
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
  if (status === 'working') s._dotsPhase = 0; // always start from "" on new working transition
  s.status = status;
  updateSessionCard(id);
  if (activeSessionId === id) updateWorkingCursor(status);
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

const WORKING_MSGS = [
  'thinking', 'scheming', 'deliberating', 'gallivanting', 'pondering',
  'contemplating', 'ruminating', 'cogitating', 'hypothesizing', 'spelunking',
  'wrangling', 'untangling', 'cross-referencing', 'noodling', 'vibing',
  'consulting the void', 'reading the entrails', 'asking nicely',
  'summoning context', 'doing its thing',
];
let _workingTimer = null;
let _workingMsgIdx = 0;

function updateWorkingCursor(status) {
  if (!$.messageLog) return;
  let cur = document.getElementById('working-cursor');
  if (status === 'working') {
    if (!cur) {
      cur = document.createElement('div');
      cur.id = 'working-cursor';
      $.messageLog.appendChild(cur);
      scheduleScroll();
    }
    // Build cursor structure once, update text node only — avoid innerHTML re-parsing every 3s
    if (!cur.firstChild) {
      const glyph = document.createElement('span');
      glyph.className = 'cursor-blink';
      glyph.textContent = '▋';
      cur.appendChild(glyph);
      cur.appendChild(document.createTextNode(''));
    }
    const textNode = cur.lastChild;
    const setMsg = () => {
      textNode.textContent = ' ' + WORKING_MSGS[_workingMsgIdx++ % WORKING_MSGS.length] + '…';
    };
    setMsg();
    clearInterval(_workingTimer);
    _workingTimer = setInterval(setMsg, 3000);
  } else {
    clearInterval(_workingTimer);
    _workingTimer = null;
    cur?.remove();
  }
}

// ── Message log ────────────────────────────────────────────

// rAF-coalesced scroll — only scrolls if user hasn't manually scrolled up
let _scrollPending = false;
let _pinToBottom = true; // false when user scrolls up; restored when user scrolls back down or sends a message

function scheduleScroll(force = false) {
  if (!force && !_pinToBottom) return;
  if (_scrollPending) return;
  _scrollPending = true;
  requestAnimationFrame(() => {
    _scrollPending = false;
    if ($.messageLog) $.messageLog.lastElementChild?.scrollIntoView({ block: 'end' });
  });
}

function pushMessage(id, msg) {
  const data = sessionLogs.get(id);
  if (!data) return;
  data.messages.push(msg);
  if (activeSessionId === id) {
    if ($.messageLog) {
      // Insert BEFORE the working cursor so cursor stays at bottom
      const cursor = document.getElementById('working-cursor');
      const el = createMsgEl(msg);
      el.classList.add('msg-new');
      if (cursor) $.messageLog.insertBefore(el, cursor);
      else $.messageLog.appendChild(el);
      scheduleScroll();
    }
  }
}

function renderMessageLog(id) {
  if (!$.messageLog) return;
  $.messageLog.innerHTML = ''; // cursor gets wiped here — restore below
  const data = sessionLogs.get(id);
  if (data) {
    // DocumentFragment: build all elements off-DOM, single reflow on append
    const frag = document.createDocumentFragment();
    for (const msg of data.messages) frag.appendChild(createMsgEl(msg));
    $.messageLog.appendChild(frag);
  }
  // Always restore cursor to match current session status
  const s = sessions.get(id);
  if (s && s.status === 'working') {
    updateWorkingCursor(s.status);
  }
  scheduleScroll();
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

  } else if (msg.type === 'system-msg') {
    el.innerHTML = `<div class="system-label">${esc(msg.text)}</div>`;

  } else if (msg.type === 'error') {
    el.innerHTML = `<div class="error-msg">${esc(msg.text)}</div>`;
  } else if (msg.type === 'warn') {
    el.innerHTML = `<div class="warn-msg">${esc(msg.text)}</div>`;
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
        <div class="session-card-tokens" id="card-tokens-${id}"></div>
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
  $.sessionList.appendChild(card);

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
    if (s.unread) {
      statusEl.textContent = 'NEW';
      statusEl.className = 'card-badge unread';
    } else {
      const label = { idle: 'IDLE', error: 'ERR', working: '.'.repeat(s._dotsPhase || 0), waiting: '···' }[s.status] ?? '···';
      statusEl.textContent = label;
      statusEl.className = `card-badge ${s.status}`;
    }
    statusEl.style.display = '';
  }

  const tokensEl = document.getElementById(`card-tokens-${id}`);
  if (tokensEl) {
    tokensEl.textContent = formatTokens(s.tokens + (s._liveTokens || 0));
  }

  const card = document.getElementById(`card-${id}`);
  if (card) card.classList.toggle('active', activeSessionId === id);
}

// ── Session switching ──────────────────────────────────────

function setActiveSession(id) {
  const prev = activeSessionId;
  activeSessionId = id;
  setActiveSessionId(id);
  _pinToBottom = true;
  const viewedSession = sessions.get(id);
  if (viewedSession) viewedSession.unread = false;
  if (prev && prev !== id) updateSessionCard(prev);
  updateSessionCard(id);
  showChatView();
  renderMessageLog(id);
  const s = sessions.get(id);
  if (s) updateWorkingCursor(s.status);
  $.inputField?.focus();
  syncOmiSessions();
}

// ── View helpers ───────────────────────────────────────────

function showEmptyState() {
  $.messageLog.innerHTML = '';
}

function showChatView() {
  // intentionally no-op — never disable controls in a terminal app
}



// ── Slash command / flag autocomplete menu ──────────────────

let _slashCommands = [];    // loaded once on startup
let _slashActiveIdx = -1;   // keyboard-highlighted row
let _activeToken   = null;  // token that opened the menu

const FLAG_ITEMS = [
  { name: 'seq',        description: 'sequential-thinking MCP — structured multi-step reasoning' },
  { name: 'think',      description: 'pause and reason carefully before responding' },
  { name: 'think-hard', description: '--think + --seq combined' },
  { name: 'ultrathink', description: '--think-hard + explicit plan before acting' },
  { name: 'uc',         description: 'ultra-compressed output' },
  { name: 'no-mcp',     description: 'disable all MCP servers' },
  { name: 'grade',      description: 'grade current plan (use with /sm:introspect)' },
  { name: 'quick',      description: 'fast bootstrap — skip memory queries' },
  { name: 'cold',       description: 'fresh start, skip project memory' },
  { name: 'retro',      description: 'end-of-session retro (use with /checkpoint)' },
  { name: 'dry-run',    description: 'show what would happen without writing' },
  { name: 'state-only', description: 'write STATE.md only (use with /checkpoint)' },
  { name: 'brief',      description: 'meeting/pitch brief mode (use with /research)' },
];

async function loadSlashCommands() {
  try {
    _slashCommands = await invoke('read_slash_commands');
  } catch (_) {
    _slashCommands = [];
  }
}

function showSlashMenu(token) {
  _activeToken = token;
  const menu = $.slashMenu;
  const q = token.query.toLowerCase();

  let matches, prefix;
  if (token.type === 'flag') {
    matches = FLAG_ITEMS.filter(f =>
      f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)
    );
    prefix = '--';
  } else {
    matches = _slashCommands.filter(c =>
      c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    );
    prefix = '/';
  }

  if (!matches.length) { hideSlashMenu(); return; }

  // Position flush against the top of the input bar, right of the sidebar
  const inputBar = $.inputBar;
  const sidebar  = $.sidebar;
  const rect = inputBar.getBoundingClientRect();
  menu.style.bottom = (window.innerHeight - rect.top) + 'px';
  menu.style.left   = (sidebar.offsetWidth + 1) + 'px'; // +1 for resize handle

  _slashActiveIdx = -1;
  menu.innerHTML = matches.map((c, i) =>
    `<div class="slash-item" data-idx="${i}" data-name="${esc(c.name)}">` +
    `<span class="slash-item-name">${prefix}${esc(c.name)}</span>` +
    `<span class="slash-item-desc">${esc(c.description)}</span>` +
    `</div>`
  ).join('');

  menu.querySelectorAll('.slash-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // don't blur input
      acceptSlashItem(el.dataset.name);
    });
  });

  menu.classList.remove('hidden');
}

function hideSlashMenu() {
  $.slashMenu.classList.add('hidden');
  _slashActiveIdx = -1;
}

function moveSlashSelection(delta) {
  const menu = $.slashMenu;
  const items = menu.querySelectorAll('.slash-item');
  if (!items.length) return;
  items[_slashActiveIdx]?.classList.remove('active');
  _slashActiveIdx = Math.max(0, Math.min(items.length - 1, _slashActiveIdx + delta));
  const active = items[_slashActiveIdx];
  active.classList.add('active');
  active.scrollIntoView({ block: 'nearest' });
}

// Returns { start, end, query, type:'slash' } for a /word at cursor, or null.
// Only matches if / is at start of input or preceded by a space (not mid-URL).
function getSlashToken(input) {
  const val = input.value;
  const pos = input.selectionStart;
  let slashPos = -1;
  for (let i = pos - 1; i >= 0; i--) {
    if (val[i] === '/') {
      if (i === 0 || val[i - 1] === ' ') { slashPos = i; break; }
    } else if (val[i] === ' ') {
      break;
    }
  }
  if (slashPos === -1) return null;
  const query = val.slice(slashPos + 1, pos);
  if (query.includes(' ')) return null;
  return { start: slashPos, end: pos, query, type: 'slash' };
}

// Returns { start, end, query, type:'flag' } for a --word at cursor, or null.
// Only matches if -- is at start of input or preceded by a space.
function getFlagToken(input) {
  const val = input.value;
  const pos = input.selectionStart;
  if (pos < 2) return null;
  let dashPos = -1;
  for (let i = pos - 1; i >= 1; i--) {
    if (val[i] === '-' && val[i - 1] === '-') {
      if (i - 1 === 0 || val[i - 2] === ' ') { dashPos = i - 1; break; }
    } else if (val[i] === ' ') {
      break;
    }
  }
  if (dashPos === -1) return null;
  const query = val.slice(dashPos + 2, pos);
  if (query.includes(' ') || query.startsWith('-')) return null;
  return { start: dashPos, end: pos, query, type: 'flag' };
}

function acceptSlashItem(name) {
  const input = $.inputField;
  const token = _activeToken;
  const prefix = token?.type === 'flag' ? '--' : '/';
  if (token) {
    const val = input.value;
    const newVal = val.slice(0, token.start) + prefix + name + ' ' + val.slice(token.end);
    input.value = newVal;
    const newPos = token.start + prefix.length + name.length + 1;
    input.setSelectionRange(newPos, newPos);
  } else {
    input.value = prefix + name + ' ';
  }
  input.focus();
  hideSlashMenu();
  autoResize(input);
}

function acceptActiveSlashItem() {
  const menu = $.slashMenu;
  const items = menu.querySelectorAll('.slash-item');
  const idx = _slashActiveIdx >= 0 ? _slashActiveIdx : 0;
  if (items[idx]) acceptSlashItem(items[idx].dataset.name);
}

// ── Bootstrap ──────────────────────────────────────────────

// Wire lifecycle deps — these functions are defined below in this file
// and in modules that haven't loaded yet. The setLifecycleDeps call
// happens synchronously before any async operations.
setLifecycleDeps({
  renderSessionCard,
  setActiveSession,
  pushMessage,
  setStatus,
  handleEvent,
  updateWorkingCursor,
  showEmptyState,
  get slashCommands() { return _slashCommands; },
  hideSlashMenu,
});

window.addEventListener('DOMContentLoaded', () => {
  initDOM();

  // One-time cleanup: remove stale flags that shouldn't persist across sessions
  localStorage.removeItem('alwaysOn');
  localStorage.removeItem('omiListening');
  localStorage.removeItem(IDENTITY_SEQ_KEY); // reset sprite sequence on each app launch

  loadSlashCommands();

  // Animate working badge: per-session phase cycles "" "." ".." "..." every 400ms
  setInterval(() => {
    sessions.forEach((s, id) => {
      if (s.status === 'working' && !s.unread) {
        s._dotsPhase = (s._dotsPhase + 1) % 4;
        const el = document.getElementById(`card-status-${id}`);
        if (el) el.textContent = '.'.repeat(s._dotsPhase);
      }
    });
  }, 400);

  // Open links in system browser — prevent Tauri webview from navigating away
  $.messageLog.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    e.preventDefault();
    window.__TAURI__.opener.openUrl(href);
  });

  // Track whether user has scrolled up — suppress auto-scroll if so
  $.messageLog.addEventListener('scroll', () => {
    _pinToBottom = $.messageLog.scrollTop + $.messageLog.clientHeight >= $.messageLog.scrollHeight - 40;
  });

  // Sidebar resize
  const sidebar = $.sidebar;
  const resizeHandle = $.sidebarResize;
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
    _resizeW = Math.max(80, Math.min(340, _resizeStartW + (e.clientX - _resizeStartX)));
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

  // Sidebar vertical resize (session list ↕ voice log)
  const sessionList = $.sessionList;
  const hResizeHandle = $.sidebarHResize;
  let _hResizing = false, _hStartY = 0, _hStartH = 0;
  let _hRafId = null, _hH = 0;
  hResizeHandle.addEventListener('mousedown', (e) => {
    _hResizing = true;
    _hStartY = e.clientY;
    _hStartH = sessionList.offsetHeight;
    hResizeHandle.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!_hResizing) return;
    const sidebarH = sidebar.offsetHeight;
    _hH = Math.max(60, Math.min(sidebarH - 120, _hStartH + (e.clientY - _hStartY)));
    if (!_hRafId) {
      _hRafId = requestAnimationFrame(() => {
        sessionList.style.flex = 'none';
        sessionList.style.height = _hH + 'px';
        _hRafId = null;
      });
    }
  });
  window.addEventListener('mouseup', () => {
    if (!_hResizing) return;
    _hResizing = false;
    if (_hRafId) { cancelAnimationFrame(_hRafId); _hRafId = null; sessionList.style.height = _hH + 'px'; }
    hResizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('sidebar-session-list-h', _hH);
  });
  // Restore saved height
  const _savedH = localStorage.getItem('sidebar-session-list-h');
  if (_savedH) { sessionList.style.flex = 'none'; sessionList.style.height = _savedH + 'px'; }

  $.btnNewSession.addEventListener('click', pickFolder);
  showEmptyState(); // input disabled until first session opens

  $.btnSend.addEventListener('click', () => {
    const input = $.inputField;
    const text = input.value;
    if (!text.trim() || !activeSessionId) return;
    input.value = '';
    input.style.height = ''; // reset to rows="1" — avoids WebKit scrollHeight=0 collapse
    _pinToBottom = true;
    hideSlashMenu();
    sendMessage(activeSessionId, text);
  });

  $.inputField.addEventListener('keydown', (e) => {
    const menuVisible = !$.slashMenu.classList.contains('hidden');
    if (menuVisible) {
      if (e.key === 'ArrowDown')  { e.preventDefault(); moveSlashSelection(1); return; }
      if (e.key === 'ArrowUp')    { e.preventDefault(); moveSlashSelection(-1); return; }
      if (e.key === 'Tab') {
        e.preventDefault(); acceptActiveSlashItem(); return;
      }
      if (e.key === 'Enter' && !e.shiftKey && _slashActiveIdx >= 0) {
        // Only accept if user explicitly navigated to an item with arrow keys
        e.preventDefault(); acceptActiveSlashItem(); return;
      }
      if (e.key === 'Escape')     { e.preventDefault(); hideSlashMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = $.inputField.value;
      if (!text.trim() || !activeSessionId) return;
      $.inputField.value = '';
      $.inputField.style.height = '';
      _pinToBottom = true;
      hideSlashMenu();
      sendMessage(activeSessionId, text);
    }
  });

  $.inputField.addEventListener('input', (e) => {
    autoResize(e.target);
    const token = getSlashToken(e.target) || getFlagToken(e.target);
    if (token) {
      showSlashMenu(token);
    } else {
      hideSlashMenu();
    }
  });

  // Click outside slash menu → close it
  document.addEventListener('mousedown', (e) => {
    if (!$.slashMenu.classList.contains('hidden') &&
        !$.slashMenu.contains(e.target) && e.target !== $.inputField) {
      hideSlashMenu();
    }
  });

  // Esc — cancel active Claude operation
  // Guards (in priority order): slash menu, confirm modal, settings panel
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$.slashMenu.classList.contains('hidden')) return; // slash menu: handled by its own listener
    if (!$.confirmOverlay?.classList.contains('hidden')) return; // confirm modal: has its own Esc handler
    if (settingsOpen) { settingsOpen = false; _settingsUpdate(); return; } // close settings panel, don't kill Claude
    if (activeSessionId) {
      const s = sessions.get(activeSessionId);
      if (s && s.child && (s.status === 'working' || s.status === 'waiting')) {
        e.preventDefault();
        s._interrupting = true;
        try { s.child.kill(); } catch (_) {}
        s.child = null;
        clearTimeout(s._idleTimer);
        pushMessage(activeSessionId, { type: 'system-msg', text: 'Interrupted — restarting…' });
        setStatus(activeSessionId, 'waiting');
        s._restarting = true;
        spawnClaude(activeSessionId);
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

  // ── Omi voice bridge ───────────────────────────────────────
  // Listens for voice commands from OmiWebhook via the Rust WebSocket bridge.
  // "hey pixel, <text> full stop" → sendMessage to targeted session.
  // Dot = clickable toggle. Green=listening, amber=muted, gray=disconnected.

  const { listen: tauriListen } = window.__TAURI__.event;

  let omiConnected = false;
  let omiListening = true; // always start listening — don't restore mute from storage
  // voiceSource declared here so _omiIndicatorUpdate can read it
  let voiceSource = localStorage.getItem('voiceSource') || 'ble';

  function _omiIndicatorUpdate() {
    if (!$.omiIndicator) return;
    $.omiIndicator.classList.remove('connected');
    if (omiConnected) {
      $.omiIndicator.classList.add('connected');
      $.omiIndicator.title = 'Omi connected — click for settings (fn = push to talk)';
    } else {
      $.omiIndicator.title = 'Omi voice bridge disconnected — click for settings';
    }
  }

  function toggleOmiListening() {
    omiListening = !omiListening;
    _omiIndicatorUpdate();
    try { invoke('set_omi_listening', { enabled: omiListening }); } catch (_) {}
  }

  $.omiIndicator?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (omiConnected) {
      // Already connected — flash status
      _showDotStatus('Voice bridge connected');
    } else {
      // Launch the voice bridge via launch.command
      const home = await window.__TAURI__.path.homeDir();
      const script = `${home}Projects/pixel-terminal/launch.command`;
      Command.create('open', [script]).execute().catch(() => {
        _showDotStatus('Run launch.command to connect');
      });
    }
  });

  function _showDotStatus(msg) {
    if (!$.omiIndicator) return;
    const prev = $.omiIndicator.title;
    $.omiIndicator.title = msg;
    setTimeout(() => { $.omiIndicator.title = prev; }, 2500);
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'O') {
      e.preventDefault();
      toggleOmiListening();
    }
  });

  function resolveSession(ref) {
    if (ref == null) return activeSessionId;
    if (typeof ref === 'number') {
      const keys = [...sessions.keys()];
      return keys[ref - 1] || activeSessionId;
    }
    const needle = String(ref).toLowerCase();
    for (const [id, s] of sessions) {
      if (s.name.toLowerCase().includes(needle)) return id;
    }
    return activeSessionId;
  }

  tauriListen('omi:command', (event) => {
    const { type, text, session, ts, dispatched } = event.payload;

    // Transcript events only show in voice log when bridge is connected (green dot)
    if (type === 'transcript') {
      if (omiConnected && omiListening) appendVoiceLog(text, ts, dispatched);
      return;
    }

    if (!omiListening) return;  // JS-side mute guard — commands only

    const targetId = resolveSession(session ?? null);
    if (!targetId) return;
    if (type === 'prompt') {
      sendMessage(targetId, text);
    } else if (type === 'switch') {
      setActiveSession(targetId);
    } else if (type === 'list_sessions') {
      const lines = [...sessions.entries()]
        .map(([_, s], i) => `${i + 1}. ${s.name} [${s.status}]`)
        .join('\n');
      pushMessage(activeSessionId, { type: 'system-msg', text: `Omi sessions:\n${lines}` });
    }
  });

  // ── Voice log (transcript sidebar) ────────────────────────
  const MAX_VOICE_LOG = 200;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function appendVoiceLog(text, ts, dispatched) {
    if (!$.voiceLog || !text) return;
    const entry = document.createElement('div');
    entry.className = 'voice-entry' + (dispatched ? ' dispatched' : '');
    entry.innerHTML = `<span class="ts">${escapeHtml(ts || '')}</span>${dispatched ? '▶ ' : ''}${escapeHtml(text)}`;
    $.voiceLog.appendChild(entry);
    while ($.voiceLog.children.length > MAX_VOICE_LOG) $.voiceLog.removeChild($.voiceLog.firstChild);
    $.voiceLog.scrollTop = $.voiceLog.scrollHeight;
  }

  $.btnClearVoiceLog?.addEventListener('click', () => {
    if ($.voiceLog) $.voiceLog.innerHTML = '';
  });

  tauriListen('omi:connected', () => {
    omiConnected = true;
    _omiIndicatorUpdate();
    // Re-send current mute state so a reconnecting OmiWebhook stays in sync
    try { invoke('set_omi_listening', { enabled: omiListening }); } catch (_) {}
    // Always sync voice mode on reconnect (trigger_mode unless OPEN was clicked this session)
    try { invoke('set_voice_mode', { mode: alwaysOn ? 'always_on' : 'trigger_mode' }); } catch (_) {}
  });

  tauriListen('omi:disconnected', () => {
    omiConnected = false;
    _omiIndicatorUpdate();
  });

  // ── Always-on mic toggle ───────────────────────────────────
  // When active, pixel_voice_bridge skips "hey pixel" trigger —
  // every transcribed utterance (3s silence timeout) is sent as a command.

  let alwaysOn = false; // PTT-only: never restore always-on from storage — fn key is the activation path

  function _alwaysOnUpdate() {
    if (!$.alwaysOnBtn) return;
    if (alwaysOn) {
      $.alwaysOnBtn.classList.add('active');
      $.alwaysOnBtn.title = 'Always-on mic active — click to return to trigger mode (Ctrl+Shift+A)';
    } else {
      $.alwaysOnBtn.classList.remove('active');
      $.alwaysOnBtn.title = 'Always-on mic off — no "hey pixel" needed when on (Ctrl+Shift+A)';
    }
  }

  function toggleAlwaysOn() {
    alwaysOn = !alwaysOn;
    _alwaysOnUpdate();
    try { invoke('set_voice_mode', { mode: alwaysOn ? 'always_on' : 'trigger_mode' }); } catch (_) {}
  }

  $.alwaysOnBtn?.addEventListener('click', toggleAlwaysOn);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      toggleAlwaysOn();
    }
  });

  _alwaysOnUpdate(); // restore persisted state on load

  // ── fn key PTT (push-to-talk) ────────────────────────────────────────────
  // Hold fn → bridge starts transcribing (ptt_start). Dot pulses.
  // Release fn → bridge fires gathered buffer immediately (ptt_release).
  // Right Option (AltRight) is a fallback if fn is intercepted by macOS.
  // PTT is independent of alwaysOn — does not modify that flag.
  let pttActive = false;

  function _isPttKey(e) {
    return e.key === 'Fn' || e.code === 'Fn' || e.code === 'AltRight';
  }

  function _pttIndicatorUpdate() {
    if (!$.omiIndicator) return;
    if (pttActive) {
      $.omiIndicator.classList.add('ptt');
    } else {
      $.omiIndicator.classList.remove('ptt');
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!_isPttKey(e)) return;
    if (pttActive) return;     // already recording
    if (!omiConnected) return; // no bridge
    pttActive = true;
    try { invoke('ptt_start'); } catch (_) {}
    _pttIndicatorUpdate();
  });

  document.addEventListener('keyup', (e) => {
    if (!_isPttKey(e)) return;
    if (!pttActive) return;
    pttActive = false;
    try { invoke('ptt_release'); } catch (_) {}
    _pttIndicatorUpdate();
  });

  // ── Voice settings panel ────────────────────────────────────────────────
  let settingsOpen = false;

  function _settingsUpdate() {
    if (!$.settingsPanel) return;
    $.settingsPanel.classList.toggle('hidden', !settingsOpen);
    $.settingsBtn?.classList.toggle('open', settingsOpen);
    $.voiceSourceBle?.classList.toggle('active', voiceSource === 'ble');
    $.voiceSourceMic?.classList.toggle('active', voiceSource === 'mic');
  }

  $.settingsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsOpen = !settingsOpen;
    _settingsUpdate();
  });

  document.addEventListener('click', () => {
    if (settingsOpen) { settingsOpen = false; _settingsUpdate(); }
  });

  $.settingsPanel?.addEventListener('click', (e) => {
    e.stopPropagation(); // prevent panel click from closing itself
  });

  function _switchVoiceSource(source) {
    voiceSource = source;
    localStorage.setItem('voiceSource', voiceSource);
    _settingsUpdate();
    _omiIndicatorUpdate();  // refresh dot color (blue=BLE, green=mic)
    const label = source === 'ble' ? 'BLE pendant' : 'Mac mic';
    appendVoiceLog(`Switching to ${label} — reconnecting...`, new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}), false);
    try { invoke('switch_voice_source', { source }); } catch (_) {}
  }

  $.voiceSourceBle?.addEventListener('click', () => _switchVoiceSource('ble'));
  $.voiceSourceMic?.addEventListener('click', () => _switchVoiceSource('mic'));

  _settingsUpdate(); // restore persisted state on load

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

  // About dialog — triggered by Rust menu event
  $.aboutClose?.addEventListener('click', () => {
    $.aboutOverlay?.classList.add('hidden');
  });
  $.aboutOverlay?.addEventListener('click', (e) => {
    if (e.target === $.aboutOverlay) $.aboutOverlay.classList.add('hidden');
  });
  tauriListen('show-about', () => {
    $.aboutOverlay?.classList.remove('hidden');
  });
});
