// ── Session cards + switching ──────────────────────────────

import { $, esc, showConfirm } from './dom.js';
import { exitHistoryView } from './history.js';
import {
  sessions, sessionLogs,
  getActiveSessionId, setActiveSessionId, formatTokens, syncOmiSessions
} from './session.js';
import { renderFrame } from './ascii-sprites.js';
import { killSession, IDLE_STALE_MS } from './session-lifecycle.js';
import { renderMessageLog, updateWorkingCursor, setPinToBottom } from './messages.js';

// ── Familiar Profile Card ─────────────────────────────────

const _RARITY_STARS = {
  common: '★', uncommon: '★★', rare: '★★★', epic: '★★★★', legendary: '★★★★★',
};
const _RARITY_COLORS = {
  common: '#555', uncommon: '#4caf50', rare: '#4fc3f7', epic: '#ce93d8', legendary: '#ffd700',
};
const _EYE_LABELS = {
  '·': 'dot', '✦': 'star', '×': 'x', '◉': 'circle', '@': 'at', '°': 'degree',
};

let _profileCardEl = null;
let _profileAnimId = null;

export function showFamiliarCard(sessionId) {
  const s = sessions.get(sessionId);
  if (!s?.familiar) return;
  hideFamiliarCard();

  const f = s.familiar;
  const rarityColor = _RARITY_COLORS[f.rarity] ?? '#555';
  const stars = _RARITY_STARS[f.rarity] ?? '★';
  const eyeLabel = _EYE_LABELS[f.eye] ?? f.eye;
  const hue = s.familiarHue ?? '#FFDD44';

  // ── Overlay
  const overlay = document.createElement('div');
  overlay.className = 'fc-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) hideFamiliarCard(); });

  // ── Card
  const card = document.createElement('div');
  card.className = 'fc-card';
  card.style.setProperty('--fc-rarity-color', rarityColor);
  card.style.setProperty('--fc-hue', hue);

  // Header: species name left, rarity right
  const header = document.createElement('div');
  header.className = 'fc-header';

  const nameEl = document.createElement('div');
  nameEl.className = 'fc-species';
  nameEl.textContent = f.species.toUpperCase();

  const rarityEl = document.createElement('div');
  rarityEl.className = 'fc-rarity';
  rarityEl.textContent = `${stars} ${f.rarity.toUpperCase()}`;

  header.appendChild(nameEl);
  header.appendChild(rarityEl);

  // Body: 2-column (sprite | stats)
  const body = document.createElement('div');
  body.className = 'fc-body';

  // Left column: sprite + meta
  const leftCol = document.createElement('div');
  leftCol.className = 'fc-left';

  const spritePre = document.createElement('pre');
  spritePre.className = 'fc-sprite familiar-pre';
  spritePre.style.setProperty('--familiar-hue', hue);
  spritePre.textContent = renderFrame(f.species, 0, f.eye, f.hat).join('\n');
  leftCol.appendChild(spritePre);

  const leftMeta = document.createElement('div');
  leftMeta.className = 'fc-left-meta';
  leftMeta.textContent = `${f.eye}  ${f.hat}`;
  leftCol.appendChild(leftMeta);

  // Right column: stats
  const rightCol = document.createElement('div');
  rightCol.className = 'fc-right';

  const statsLabel = document.createElement('div');
  statsLabel.className = 'fc-stats-label';
  statsLabel.textContent = 'POWER RATINGS';
  rightCol.appendChild(statsLabel);

  const statsDiv = document.createElement('div');
  statsDiv.className = 'fc-stats';

  for (const [statName, val] of Object.entries(f.stats)) {
    const row = document.createElement('div');
    row.className = 'fc-stat-row';

    const label = document.createElement('span');
    label.className = 'fc-stat-name';
    label.textContent = statName;

    const barWrap = document.createElement('div');
    barWrap.className = 'fc-stat-bar';
    const fill = document.createElement('div');
    fill.className = 'fc-stat-fill';
    fill.style.width = `${val}%`;
    barWrap.appendChild(fill);

    const numEl = document.createElement('span');
    numEl.className = 'fc-stat-val';
    numEl.textContent = val;

    row.appendChild(label);
    row.appendChild(barWrap);
    row.appendChild(numEl);
    statsDiv.appendChild(row);
  }
  rightCol.appendChild(statsDiv);

  const rightMeta = document.createElement('div');
  rightMeta.className = 'fc-right-meta';
  rightMeta.textContent = `${f.species} · ${eyeLabel} eye · ${f.hat} hat`;
  rightCol.appendChild(rightMeta);

  body.appendChild(leftCol);
  body.appendChild(rightCol);

  // Footer: shiny badge + Phase 3 re-roll slot
  const footer = document.createElement('div');
  footer.className = 'fc-footer';

  const shinyBadge = document.createElement('span');
  shinyBadge.className = f.shiny ? 'fc-shiny fc-shiny--active' : 'fc-shiny';
  shinyBadge.textContent = '✦ SHINY';
  footer.appendChild(shinyBadge);

  // Phase 3 slot: add re-roll button + credit display here (1-file change)
  const rerollSlot = document.createElement('div');
  rerollSlot.className = 'fc-reroll-slot';
  footer.appendChild(rerollSlot);

  // Assemble
  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(footer);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  _profileCardEl = overlay;

  // Animate sprite at 500ms (~2 FPS)
  let frame = 0;
  _profileAnimId = setInterval(() => {
    frame = (frame + 1) % 3;
    spritePre.textContent = renderFrame(f.species, frame, f.eye, f.hat).join('\n');
  }, 500);

  // Escape to close
  const onKey = e => { if (e.key === 'Escape') hideFamiliarCard(); };
  document.addEventListener('keydown', onKey);
  overlay._keyHandler = onKey;
}

export function hideFamiliarCard() {
  if (_profileCardEl) {
    if (_profileCardEl._keyHandler) {
      document.removeEventListener('keydown', _profileCardEl._keyHandler);
    }
    _profileCardEl.remove();
    _profileCardEl = null;
  }
  if (_profileAnimId !== null) {
    clearInterval(_profileAnimId);
    _profileAnimId = null;
  }
}

// ─────────────────────────────────────────────────────────

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

  // View button (shown on hover — reveals profile card)
  if (s.familiar) {
    const viewBtn = document.createElement('button');
    viewBtn.className = 'familiar-view-btn';
    viewBtn.textContent = 'VIEW';
    viewBtn.title = 'View familiar profile';
    viewBtn.addEventListener('click', e => {
      e.stopPropagation();
      showFamiliarCard(id);
    });
    card.querySelector('.session-card-top').appendChild(viewBtn);
  }

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

  // Inject ASCII familiar into the sprite-wrap
  const wrap = document.getElementById(`card-sprite-wrap-${id}`);
  if (wrap && s.familiar) {
    wrap.style.setProperty('--familiar-hue', s.familiarHue ?? '#FFDD44');
    const pre = document.createElement('pre');
    pre.className = 'familiar-pre';
    pre.dataset.species = s.familiar.species;
    pre.textContent = renderFrame(s.familiar.species, 0, s.familiar.eye, s.familiar.hat).join('\n');
    wrap.appendChild(pre);
  }
}

export function updateFamiliarDisplay(id, frameIdx) {
  const s = sessions.get(id);
  if (!s?.familiar) return;
  const wrap = document.getElementById(`card-sprite-wrap-${id}`);
  const pre = wrap?.querySelector('.familiar-pre');
  if (!pre) return;
  pre.textContent = renderFrame(s.familiar.species, frameIdx, s.familiar.eye, s.familiar.hat).join('\n');
}

export function updateSessionCard(id) {
  const s = sessions.get(id);
  if (!s) return;

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
