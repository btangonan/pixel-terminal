// ── Session History ─────────────────────────────────────────
// Browse, search, and view past Claude Code sessions from JSONL files.
// Read-only. Reuses createMsgEl() from messages.js for rendering.

import { $, esc } from './dom.js';
import { formatTokens } from './session.js';
import { renderFrame } from './ascii-sprites.js';

const { invoke } = window.__TAURI__.core;

// DI — set by app.js via setHistoryDeps()
let _deps = {
  renderMessageLog: null,
  createMsgEl: null,
  sessions: null,
  getActiveSessionId: null,
};

export function setHistoryDeps(deps) {
  _deps = { ..._deps, ...deps };
}

// ── State ───────────────────────────────────────────────────
let _entries = [];       // cached scan results (SessionHistoryEntry[])
let _filtered = [];      // after search filter
let _activeId = null;    // session_id of currently viewed history entry
let _cachedMsgs = {};    // session_id → SessionHistoryMessage[] (avoid re-fetch)
let _scrollPos = {};     // session_id → scrollTop (persist across tab switches)
let _scannedCwd = null;  // cwd last scanned (to avoid duplicate scans)
let _searchTimer = null;
let _findOpen = false;
let _tabHandlerRegistered = false;
// In-log find state
let _findRanges = [];    // Range[] — all matches within #message-log
let _findIdx = -1;       // currently highlighted match index
let _findLastQuery = ''; // last searched query (detect change → rebuild ranges)

export function isHistoryActive() { return _activeId !== null; }

// ── Public API ──────────────────────────────────────────────

export function initHistory() {
  // Tab click — single delegated handler on container (idempotent)
  if (!_tabHandlerRegistered) {
    _tabHandlerRegistered = true;
    const tabContainer = document.getElementById('session-tabs');
    if (tabContainer) {
      tabContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.session-tab');
        if (!btn) return;
        const tab = btn.dataset.tab;
        if (tab === 'hist') showHistoryTab();
        else showLiveTab();
      });
    }
  }

  // Sidebar search input
  if ($.historySearch) {
    $.historySearch.addEventListener('input', (e) => {
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => filterHistory(e.target.value.trim()), 300);
    });
  }

  // Save scroll position while browsing history
  if ($.messageLog) {
    $.messageLog.addEventListener('scroll', () => {
      if (_activeId) _scrollPos[_activeId] = $.messageLog.scrollTop;
    });
  }

  // Find bar wiring — search only triggers on Enter or button click, never on input event
  if ($.historyFindInput) {
    $.historyFindInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runFind(e.shiftKey); }
      if (e.key === 'Escape') { e.preventDefault(); hideHistoryFind(); }
    });
  }
  if ($.historyFindNext) $.historyFindNext.addEventListener('click', () => runFind(false));
  if ($.historyFindPrev) $.historyFindPrev.addEventListener('click', () => runFind(true));
  if ($.historyFindClose) $.historyFindClose.addEventListener('click', hideHistoryFind);
}

/** Scan history for the given project cwd. Idempotent — skips if already scanned. */
export async function scanHistory(cwd) {
  if (_scannedCwd === cwd) return;
  _scannedCwd = cwd;

  try {
    const raw = await invoke('scan_session_history', { projectPath: cwd });
    // Filter out sessions currently live
    const liveIds = new Set(_deps.sessions ? [..._deps.sessions.keys()] : []);
    _entries = raw.filter(e => !liveIds.has(e.session_id));
    _filtered = _entries;
    renderHistoryList(_filtered);
  } catch (err) {
    console.error('[history] scan failed:', err);
  }
}

/** Force a re-scan (refresh button, or after a session ends). */
export async function refreshHistory(cwd) {
  _scannedCwd = null;
  await scanHistory(cwd);
}

export function showHistoryTab() {
  document.querySelectorAll('.session-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === 'hist');
  });
  $.sessionList?.classList.add('hidden');
  $.sessionSearchWrap?.classList.add('hidden');
  $.historyView?.classList.remove('hidden');

  // Show the active live session card at the top of the history view
  showLiveSessionPin();

  // Re-render list so pinned card reflects current active state
  renderHistoryList(_filtered);

  // If a history session was loaded before, restore it with saved scroll position
  if (_activeId && _cachedMsgs[_activeId]) {
    renderHistoryMessages(_cachedMsgs[_activeId], /* restoreScroll= */ true);
  }
}

function _teardownLivePin() {
  const wrap = document.getElementById('history-live-sprite');
  if (wrap) wrap.innerHTML = '';
}

/** Render the active live session's card at the top of #history-current. */
function showLiveSessionPin() {
  if (!$.historyCurrent) return;
  const activeId = _deps.getActiveSessionId?.();
  const s = activeId ? _deps.sessions?.get(activeId) : null;
  if (!s) {
    $.historyCurrent.innerHTML = '';
    $.historyCurrent.classList.add('hidden');
    return;
  }

  // Clean up previous sprite renderer
  _teardownLivePin();

  $.historyCurrent.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'session-card active';
  card.style.cursor = 'pointer';
  card.innerHTML = `
    <div class="session-card-top">
      <div class="sprite-wrap" id="history-live-sprite"></div>
      <div class="session-card-info">
        <div class="session-card-name">${esc(s.name)}</div>
        <div class="session-card-tokens">${formatTokens(s.tokens + (s._liveTokens || 0))}</div>
      </div>
      <span class="card-badge working">LIVE</span>
    </div>
  `;
  card.addEventListener('click', () => showLiveTab());
  $.historyCurrent.appendChild(card);
  $.historyCurrent.classList.remove('hidden');

  // Inject ASCII familiar into history live pin
  const wrap = document.getElementById('history-live-sprite');
  if (wrap && s.familiar) {
    wrap.style.setProperty('--familiar-hue', s.familiarHue ?? '#FFDD44');
    const pre = document.createElement('pre');
    pre.className = 'familiar-pre';
    pre.textContent = renderFrame(s.familiar.species, 0, s.familiar.eye, s.familiar.hat).join('\n');
    wrap.appendChild(pre);
  }
}

export function showLiveTab() {
  // Save scroll position before leaving history view
  if (_activeId && $.messageLog) {
    _scrollPos[_activeId] = $.messageLog.scrollTop;
  }

  document.querySelectorAll('.session-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === 'live');
  });
  $.historyView?.classList.add('hidden');
  $.historySearchWrap?.classList.add('hidden');
  $.sessionList?.classList.remove('hidden');

  // Close find bar if open
  hideHistoryFind();

  // Restore live session log without clearing history state
  const liveId = _deps.getActiveSessionId?.();
  if (liveId && _deps.renderMessageLog) {
    _deps.renderMessageLog(liveId);
  }
  // Re-enable input
  if ($.inputField) {
    $.inputField.disabled = false;
    $.inputField.placeholder = 'Message Claude Code...';
  }
  if ($.btnSend) $.btnSend.disabled = false;

  // Clean up live pin sprite renderer
  _teardownLivePin();
}

/** Called when user clicks a live session card — fully exits history mode. */
export function exitHistoryView() {
  // Clean up loaded history session state (only when a session was actually loaded)
  if (_activeId) {
    if ($.messageLog) _scrollPos[_activeId] = $.messageLog.scrollTop;
    _activeId = null;

    hideHistoryFind();

    if ($.inputField) {
      $.inputField.disabled = false;
      $.inputField.placeholder = 'Message Claude Code...';
    }
    if ($.btnSend) $.btnSend.disabled = false;

    document.querySelectorAll('.history-card').forEach(c => c.classList.remove('active'));
  }

  // Always clear #history-current (live pin or viewed session) and switch to LIVE tab
  if ($.historyCurrent) {
    $.historyCurrent.innerHTML = '';
    $.historyCurrent.classList.add('hidden');
  }
  _teardownLivePin();

  document.querySelectorAll('.session-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === 'live');
  });
  $.historyView?.classList.add('hidden');
  $.sessionList?.classList.remove('hidden');

  // Restore the live session's message log
  const activeId = _deps.getActiveSessionId?.();
  if (activeId && _deps.renderMessageLog) {
    _deps.renderMessageLog(activeId);
  }
}

// ── Find in history ──────────────────────────────────────────

export function showHistoryFind() {
  if (!_activeId) return;
  _findOpen = true;
  $.historyFind?.classList.remove('hidden');
  if ($.historyFindInput) {
    $.historyFindInput.value = '';
    $.historyFindInput.focus();
  }
  if ($.historyFindStatus) $.historyFindStatus.textContent = '';
  _findRanges = [];
  _findIdx = -1;
  _findLastQuery = '';
}

function hideHistoryFind() {
  if (!_findOpen) return;
  _findOpen = false;
  $.historyFind?.classList.add('hidden');
  window.getSelection()?.removeAllRanges();
  _findRanges = [];
  _findIdx = -1;
  _findLastQuery = '';
}

function runFind(backwards) {
  const query = $.historyFindInput?.value?.trim() || '';
  if (!query) {
    window.getSelection()?.removeAllRanges();
    if ($.historyFindStatus) $.historyFindStatus.textContent = '';
    return;
  }

  // Rebuild range list whenever query changes
  if (query !== _findLastQuery) {
    _findRanges = buildFindRanges(query);
    _findLastQuery = query;
    _findIdx = backwards ? _findRanges.length - 1 : 0;
  } else if (_findRanges.length) {
    _findIdx = backwards
      ? (_findIdx - 1 + _findRanges.length) % _findRanges.length
      : (_findIdx + 1) % _findRanges.length;
  }

  if (!_findRanges.length) {
    window.getSelection()?.removeAllRanges();
    if ($.historyFindStatus) $.historyFindStatus.textContent = 'not found';
    return;
  }

  // Highlight current match
  const range = _findRanges[_findIdx];
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  // Scroll the matched node into view within #message-log
  const node = range.startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  if ($.historyFindStatus) {
    $.historyFindStatus.textContent = `${_findIdx + 1} / ${_findRanges.length}`;
  }
}

/** Walk text nodes inside #message-log and collect all case-insensitive match Ranges. */
function buildFindRanges(query) {
  if (!$.messageLog || !query) return [];
  const ranges = [];
  const q = query.toLowerCase();
  const walker = document.createTreeWalker($.messageLog, NodeFilter.SHOW_TEXT, null);

  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.toLowerCase();
    let start = 0;
    let idx;
    while ((idx = text.indexOf(q, start)) !== -1) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + q.length);
      ranges.push(range);
      start = idx + q.length;
    }
  }
  return ranges;
}

// ── Rendering ───────────────────────────────────────────────

function renderHistoryList(entries) {
  if (!$.historyList) return;
  $.historyList.innerHTML = '';

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'no past sessions';
    $.historyList.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const entry of entries) {
    const card = createHistoryCard(entry);
    if (entry.session_id === _activeId) card.classList.add('active');
    frag.appendChild(card);
  }
  $.historyList.appendChild(frag);
}

/** Show the currently-viewed history session in the stable #history-current element.
 *  This element is separate from #history-list so renderHistoryList never wipes it. */
function showCurrentHistoryCard(entry) {
  if (!$.historyCurrent) return;
  $.historyCurrent.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'history-pin-label';
  label.textContent = 'VIEWING';

  const card = createHistoryCard(entry);
  card.classList.add('active', 'pinned');
  card.prepend(label);

  $.historyCurrent.appendChild(card);
  $.historyCurrent.classList.remove('hidden');
}

function createHistoryCard(entry) {
  const card = document.createElement('div');
  card.className = 'history-card';
  card.dataset.sessionId = entry.session_id;

  const name = entry.slug
    || (entry.first_user_message ? entry.first_user_message.slice(0, 42) : null)
    || (entry.session_id.slice(0, 8) + '…');

  const date = entry.timestamp_start ? formatDate(entry.timestamp_start) : '';
  const preview = entry.first_user_message ? entry.first_user_message.slice(0, 80) : '';
  const size = formatSize(entry.file_size);

  card.innerHTML = `
    <div class="history-card-name">${escHtml(name)}</div>
    <div class="history-card-meta">
      <span class="history-card-date">${escHtml(date)}</span>
      <span class="history-card-size">${escHtml(size)}</span>
    </div>
    ${preview ? `<div class="history-card-preview">${escHtml(preview)}</div>` : ''}
  `;

  card.addEventListener('click', () => loadHistorySession(entry, card));
  return card;
}

// ── Load full session ────────────────────────────────────────

async function loadHistorySession(entry, cardEl) {
  if (_activeId === entry.session_id) return;

  // Save scroll of previously loaded session
  if (_activeId && $.messageLog) {
    _scrollPos[_activeId] = $.messageLog.scrollTop;
  }

  // Mark loading
  document.querySelectorAll('.history-card').forEach(c => c.classList.remove('active'));
  cardEl.classList.add('active', 'loading');

  try {
    let messages = _cachedMsgs[entry.session_id];
    if (!messages) {
      messages = await invoke('load_session_history', { filePath: entry.file_path });
      _cachedMsgs[entry.session_id] = messages;
    }

    _activeId = entry.session_id;

    // Show in stable #history-current element (survives list re-renders)
    showCurrentHistoryCard(entry);

    // Disable input
    if ($.inputField) {
      $.inputField.disabled = true;
      $.inputField.placeholder = 'read-only history';
    }
    if ($.btnSend) $.btnSend.disabled = true;

    // Close find bar when switching sessions
    hideHistoryFind();

    // Render — new session load always goes to bottom (no saved position yet)
    renderHistoryMessages(messages, /* restoreScroll= */ false);

  } catch (err) {
    console.error('[history] load failed:', err);
    cardEl.classList.remove('loading');
    _activeId = null;
  }
}

function renderHistoryMessages(messages, restoreScroll = false) {
  if (!$.messageLog || !_deps.createMsgEl) return;
  $.messageLog.innerHTML = '';

  const frag = document.createDocumentFragment();
  for (const m of messages) {
    const msg = convertMsg(m);
    if (msg) frag.appendChild(_deps.createMsgEl(msg));
  }
  $.messageLog.appendChild(frag);

  // Restore scroll position or go to bottom
  requestAnimationFrame(() => {
    if (restoreScroll && _activeId && _scrollPos[_activeId] != null) {
      $.messageLog.scrollTop = _scrollPos[_activeId];
    } else {
      $.messageLog.lastElementChild?.scrollIntoView({ block: 'end' });
    }
  });
}

function convertMsg(m) {
  switch (m.msg_type) {
    case 'user':
      return m.text ? { type: 'user', text: m.text } : null;
    case 'claude':
      return m.text ? { type: 'claude', text: m.text } : null;
    case 'tool':
      return {
        type: 'tool',
        toolName: m.tool_name || '',
        toolId: m.tool_id || '',
        input: m.tool_input || '',
        result: '—',  // history: mark as complete
      };
    default:
      return null;
  }
}

// ── Sidebar search ───────────────────────────────────────────

function filterHistory(query) {
  if (!query) {
    _filtered = _entries;
  } else {
    const q = query.toLowerCase();
    _filtered = _entries.filter(e =>
      (e.slug && e.slug.toLowerCase().includes(q)) ||
      (e.first_user_message && e.first_user_message.toLowerCase().includes(q)) ||
      (e.timestamp_start && formatDate(e.timestamp_start).toLowerCase().includes(q))
    );
  }
  renderHistoryList(_filtered);
}

// ── Utilities ────────────────────────────────────────────────

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch (_) {
    return iso || '';
  }
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
