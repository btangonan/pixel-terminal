// ── Session cards + switching ──────────────────────────────

import { $, esc, showConfirm } from './dom.js';
import { exitHistoryView } from './history.js';
import {
  sessions, sessionLogs, spriteRenderers, SpriteRenderer,
  getActiveSessionId, setActiveSessionId, formatTokens, syncOmiSessions
} from './session.js';
import { killSession, IDLE_STALE_MS } from './session-lifecycle.js';
import { renderMessageLog, updateWorkingCursor, setPinToBottom } from './messages.js';

export function renderSessionCard(id) {
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
    <button class="session-card-kill" title="Kill session" data-id="${id}">\u2715</button>
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

  const wrap = document.getElementById(`card-sprite-wrap-${id}`);
  spriteRenderers.set(id, new SpriteRenderer(wrap, s.charIndex));
}

export function updateSessionCard(id) {
  const s = sessions.get(id);
  if (!s) return;

  spriteRenderers.get(id)?.setStatus(s.status);

  const statusEl = document.getElementById(`card-status-${id}`);
  if (statusEl) {
    const isStale = s.status === 'idle'
      && id !== getActiveSessionId()
      && (Date.now() - (s.lastActivityAt ?? Date.now())) > IDLE_STALE_MS;

    if (s.unread) {
      statusEl.textContent = 'NEW';
      statusEl.className = 'card-badge unread';
    } else if (isStale) {
      statusEl.textContent = '\u2296';  // ⊖ stale idle indicator
      statusEl.className = 'card-badge stale';
    } else {
      const label = { idle: 'IDLE', error: 'ERR', working: '.'.repeat(s._dotsPhase || 0), waiting: '\u00b7\u00b7\u00b7' }[s.status] ?? '\u00b7\u00b7\u00b7';
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
  if (card) card.classList.toggle('active', getActiveSessionId() === id);
}

export function setActiveSession(id) {
  exitHistoryView();
  const prev = getActiveSessionId();
  setActiveSessionId(id);
  setPinToBottom(true);
  const viewedSession = sessions.get(id);
  if (viewedSession) viewedSession.unread = false;
  if (prev && prev !== id) updateSessionCard(prev);
  updateSessionCard(id);
  showChatView();
  renderMessageLog(id);
  const s = sessions.get(id);
  if (s) {
    updateWorkingCursor(s.status);
    document.body.classList.remove('no-session-active');
    $.sessionPrompt?.classList.add('hidden');
  } else {
    showEmptyState();
  }
  $.inputField?.focus();
  syncOmiSessions();
  document.dispatchEvent(new CustomEvent('pixel:session-changed', { detail: { id } }));
}

export function showEmptyState() {
  $.messageLog.querySelectorAll('.msg, .working-cursor, .msg-new').forEach(el => el.remove());
  document.body.classList.add('no-session-active');
  $.sessionPrompt?.classList.remove('hidden');
}

export function showChatView() {
  // intentionally no-op — never disable controls in a terminal app
}
