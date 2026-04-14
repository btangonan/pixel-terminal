// ── Session cards + switching ──────────────────────────────

import { $, esc, showConfirm } from './dom.js';
import { exitHistoryView } from './history.js';
import {
  sessions, sessionLogs,
  getActiveSessionId, setActiveSessionId, syncOmiSessions,
  rollFamiliarBones, incrementFamiliarReroll,
} from './session.js';
import { getNimBalance, spendNim, REROLL_NIM_COST } from './nim.js';
import { renderFrame, EYE_CHARS, DEFAULT_EYE } from './ascii-sprites.js';
import { companionBuddy, saveCommentaryFrequency, reloadBuddy } from './companion.js';
import { killSession, IDLE_STALE_MS } from './session-lifecycle.js';

function getCompactionPct(s) {
  // Prefer authoritative % from statusline sideband (API truth).
  // Falls back to local math when sideband hasn't been read yet.
  if (typeof s._authoritativePct === 'number') return s._authoritativePct;
  if (!s._contextTokens || !s._contextBaseline) return 0;
  const usable = (s._contextWindow || 200_000) - s._contextBaseline;
  if (usable <= 0) return 0;
  const used = Math.max(0, s._contextTokens - s._contextBaseline);
  return Math.min(100, Math.round((used / usable) * 100));
}
import { renderMessageLog, updateWorkingCursor, setPinToBottom } from './messages.js';

// ── Re-roll gate — set > 0 to require tokens; 0 = open ───────────────────────

// ── Familiar Profile Card ─────────────────────────────────

const _RARITY_STARS = {
  common: '★', uncommon: '★★', rare: '★★★', epic: '★★★★', legendary: '★★★★★',
};
const _RARITY_COLORS = {
  common: '#555', uncommon: '#d87756', rare: '#d4a843', epic: '#5cb85c', legendary: '#4fc3f7',
};
const _EYE_LABELS = {
  '·': 'dot', '✦': 'star', '×': 'x', '◉': 'circle', '@': 'at', '°': 'degree',
};

let _profileCardEl = null;
let _profileAnimId = null;
let _oracleCardEl  = null;
let _oracleAnimId  = null;

// ── Shared stat-card builder ─────────────────────────────
// Returns { overlay, card, spritePre, footer } — caller attaches to DOM and wires animation.

function _buildCardContent(opts, onDismiss) {
  const rarity = (opts.rarity ?? 'common').toLowerCase();
  const rarityColor = _RARITY_COLORS[rarity] ?? '#555';
  const stars = _RARITY_STARS[rarity] ?? '★';
  const eyeLabel = _EYE_LABELS[opts.eye] ?? opts.eye;

  const overlay = document.createElement('div');
  overlay.className = 'fc-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) onDismiss(); });

  const card = document.createElement('div');
  card.className = 'fc-card';
  card.style.setProperty('--fc-rarity-color', rarityColor);
  card.style.setProperty('--fc-hue', opts.hue);

  // Header
  const header = document.createElement('div');
  header.className = 'fc-header';
  const nameEl = document.createElement('div');
  nameEl.className = 'fc-species';
  nameEl.textContent = (opts.name ?? opts.species).toUpperCase();
  const rarityEl = document.createElement('div');
  rarityEl.className = 'fc-rarity';
  const starSpan = document.createElement('span');
  starSpan.className = 'fc-rarity-star';
  starSpan.textContent = stars;
  rarityEl.appendChild(starSpan);
  rarityEl.appendChild(document.createTextNode(` ${rarity.toUpperCase()}`));
  const typeEl = document.createElement('div');
  typeEl.className = 'fc-type';
  typeEl.textContent = `TYPE: ${opts.species.toUpperCase()}`;
  header.append(nameEl, rarityEl, typeEl);

  // Body: 2-column (sprite | stats)
  const body = document.createElement('div');
  body.className = 'fc-body';

  const leftCol = document.createElement('div');
  leftCol.className = 'fc-left';
  const spritePre = document.createElement('pre');
  spritePre.className = 'fc-sprite familiar-pre';
  spritePre.style.setProperty('--familiar-hue', opts.hue);
  spritePre.textContent = renderFrame(opts.species, 0, opts.eye, opts.hat).join('\n');
  leftCol.appendChild(spritePre);
  const leftMeta = document.createElement('div');
  leftMeta.className = 'fc-left-meta';
  leftMeta.textContent = `${opts.eye}  ${opts.hat}`;
  leftCol.appendChild(leftMeta);

  const rightCol = document.createElement('div');
  rightCol.className = 'fc-right';
  const statsLabel = document.createElement('div');
  statsLabel.className = 'fc-stats-label';
  statsLabel.textContent = 'POWER RATINGS';
  rightCol.appendChild(statsLabel);

  const statsDiv = document.createElement('div');
  statsDiv.className = 'fc-stats';
  const scale = opts.statScale ?? 1;
  for (const [statName, val] of Object.entries(opts.stats)) {
    const row = document.createElement('div');
    row.className = 'fc-stat-row';
    const label = document.createElement('span');
    label.className = 'fc-stat-name';
    label.textContent = statName;
    const barWrap = document.createElement('div');
    barWrap.className = 'fc-stat-bar';
    const fill = document.createElement('div');
    fill.className = 'fc-stat-fill';
    fill.style.width = `${val * scale}%`;
    barWrap.appendChild(fill);
    const numEl = document.createElement('span');
    numEl.className = 'fc-stat-val';
    numEl.textContent = val;
    row.append(label, barWrap, numEl);
    statsDiv.appendChild(row);
  }
  rightCol.appendChild(statsDiv);

  const rightMeta = document.createElement('div');
  rightMeta.className = 'fc-right-meta';
  rightMeta.textContent = `${opts.species} · ${eyeLabel} eye · ${opts.hat} hat`;
  rightCol.appendChild(rightMeta);

  body.append(leftCol, rightCol);

  // Footer: shiny badge only if actually shiny (re-roll appended by caller if needed)
  const footer = document.createElement('div');
  footer.className = 'fc-footer';
  if (opts.shiny) {
    const shinyBadge = document.createElement('span');
    shinyBadge.className = 'fc-shiny';
    shinyBadge.textContent = '✦ SHINY';
    footer.appendChild(shinyBadge);
  }

  card.append(header, body, footer);
  overlay.appendChild(card);

  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onDismiss(); } };

  return { overlay, card, spritePre, footer, onKey };
}

// ── Familiar Profile Card ────────────────────────────────

export function showFamiliarCard(sessionId) {
  const s = sessions.get(sessionId);
  if (!s?.familiar) return;
  hideFamiliarCard();

  const f = s.familiar;
  const hue = s.familiarHue ?? '#FFDD44';
  const { overlay, spritePre, footer, onKey } = _buildCardContent({
    name: f.name ?? f.species, species: f.species, rarity: f.rarity,
    eye: f.eye, hat: f.hat, shiny: f.shiny, stats: f.stats,
    statScale: 1, hue,
  }, hideFamiliarCard);

  // Re-roll button (familiar-only)
  const rerollSlot = document.createElement('div');
  rerollSlot.className = 'fc-reroll-slot';
  const rerollBtn = document.createElement('button');
  rerollBtn.className = 'fc-reroll-btn';
  rerollBtn.textContent = 'RE-ROLL';
  rerollBtn.addEventListener('click', () => {
    hideFamiliarCard();
    showRerollConfirm(sessionId);
  });
  rerollSlot.appendChild(rerollBtn);
  footer.appendChild(rerollSlot);

  document.body.appendChild(overlay);
  _profileCardEl = overlay;

  let frame = 0;
  _profileAnimId = setInterval(() => {
    frame = (frame + 1) % 3;
    spritePre.textContent = renderFrame(f.species, frame, f.eye, f.hat).join('\n');
  }, 500);

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

// ── Oracle Companion Card ────────────────────────────────

export function showOracleCard(buddy) {
  if (!buddy) return;
  hideOracleCard();

  const eye = EYE_CHARS[buddy.eyes] ?? DEFAULT_EYE;
  const species = buddy.species ?? 'duck';
  const hat = buddy.hat ?? 'none';
  const { overlay, card, spritePre, footer, onKey } = _buildCardContent({
    name: buddy.name ?? species, species, rarity: buddy.rarity ?? 'common',
    eye, hat, shiny: buddy.shiny ?? false, stats: buddy.stats ?? {},
    statScale: 10, hue: '#d87756',
  }, hideOracleCard);

  // ── Commentary frequency buttons ────────────────────────
  const freqRow = document.createElement('div');
  freqRow.className = 'fc-freq-row';
  const freqLabel = document.createElement('span');
  freqLabel.className = 'fc-freq-label';
  freqLabel.textContent = 'COMMENTARY';
  freqRow.appendChild(freqLabel);
  const levels = ['quiet', 'normal', 'chatty'];
  const current = buddy.commentaryFrequency ?? 'normal';
  for (const lvl of levels) {
    const btn = document.createElement('button');
    btn.className = 'fc-freq-btn' + (lvl === current ? ' fc-freq-btn--active' : '');
    btn.textContent = lvl.toUpperCase();
    btn.addEventListener('click', () => {
      freqRow.querySelectorAll('.fc-freq-btn').forEach(b => b.classList.remove('fc-freq-btn--active'));
      btn.classList.add('fc-freq-btn--active');
      saveCommentaryFrequency(lvl);
    });
    freqRow.appendChild(btn);
  }
  footer.appendChild(freqRow);

  // RE-ROLL ORACLE button
  const rerollOracleSlot = document.createElement('div');
  rerollOracleSlot.className = 'fc-reroll-slot';
  const rerollOracleBtn = document.createElement('button');
  rerollOracleBtn.className = 'fc-reroll-btn';
  rerollOracleBtn.textContent = 'RE-ROLL ORACLE';
  rerollOracleBtn.addEventListener('click', () => {
    hideOracleCard();
    showOracleRerollConfirm();
  });
  rerollOracleSlot.appendChild(rerollOracleBtn);
  footer.appendChild(rerollOracleSlot);

  document.body.appendChild(overlay);
  _oracleCardEl = overlay;

  let frame = 0;
  _oracleAnimId = setInterval(() => {
    frame = (frame + 1) % 3;
    spritePre.textContent = renderFrame(species, frame, eye, hat).join('\n');
  }, 500);

  document.addEventListener('keydown', onKey);
  overlay._keyHandler = onKey;
}

export function hideOracleCard() {
  if (_oracleCardEl) {
    if (_oracleCardEl._keyHandler) {
      document.removeEventListener('keydown', _oracleCardEl._keyHandler);
    }
    _oracleCardEl.remove();
    _oracleCardEl = null;
  }
  if (_oracleAnimId !== null) {
    clearInterval(_oracleAnimId);
    _oracleAnimId = null;
  }
}

// ── Re-roll confirm dialog ────────────────────────────────

let _rerollOverlayEl = null;

function _hideRerollConfirm() {
  if (_rerollOverlayEl) {
    if (_rerollOverlayEl._keyHandler) document.removeEventListener('keydown', _rerollOverlayEl._keyHandler);
    _rerollOverlayEl.remove();
    _rerollOverlayEl = null;
  }
}

function showRerollConfirm(sessionId) {
  _hideRerollConfirm();

  const bal  = getNimBalance();
  const cost = REROLL_NIM_COST;

  const overlay = document.createElement('div');
  overlay.className = 'fc-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) _hideRerollConfirm(); });

  const dialog = document.createElement('div');
  dialog.className = 'fc-confirm';

  const _title = document.createElement('div');
  _title.className = 'fc-confirm-title';
  _title.textContent = 'RE-ROLL FAMILIAR?';

  const _rows = document.createElement('div');
  _rows.className = 'fc-confirm-rows';

  const _costRow = document.createElement('div');
  _costRow.className = 'fc-confirm-row';
  const _costLabel = document.createElement('span');
  _costLabel.className = 'fc-confirm-label';
  _costLabel.textContent = 'COST';
  const _costVal = document.createElement('span');
  _costVal.className = 'fc-confirm-val';
  _costVal.textContent = `${cost} @NIM@`;
  _costRow.append(_costLabel, _costVal);

  const _balRow = document.createElement('div');
  _balRow.className = 'fc-confirm-row';
  const _balLabel = document.createElement('span');
  _balLabel.className = 'fc-confirm-label';
  _balLabel.textContent = 'YOUR BALANCE';
  const _balVal = document.createElement('span');
  _balVal.className = 'fc-confirm-val';
  _balVal.textContent = `${bal} @NIM@`;
  _balRow.append(_balLabel, _balVal);

  _rows.append(_costRow, _balRow);

  const _warning = document.createElement('div');
  _warning.className = 'fc-confirm-warning';
  _warning.textContent = 'Your current familiar will be lost forever.';

  const _actions = document.createElement('div');
  _actions.className = 'fc-confirm-actions';
  const _goBtn = document.createElement('button');
  _goBtn.className = 'fc-confirm-btn fc-confirm-btn--go';
  _goBtn.textContent = 'CONFIRM RE-ROLL';
  const _cancelBtn = document.createElement('button');
  _cancelBtn.className = 'fc-confirm-btn fc-confirm-btn--cancel';
  _cancelBtn.textContent = 'CANCEL';
  _actions.append(_goBtn, _cancelBtn);

  dialog.append(_title, _rows, _warning, _actions);

  _cancelBtn.addEventListener('click', _hideRerollConfirm);
  _goBtn.addEventListener('click', () => {
    if (!spendNim(cost)) return; // double-check (balance may have changed)
    const s = sessions.get(sessionId);
    if (!s) { _hideRerollConfirm(); return; }
    const count = incrementFamiliarReroll(s.cwd);
    s.familiar = rollFamiliarBones(s.cwd, count);
    const wrap = document.getElementById(`card-sprite-wrap-${sessionId}`);
    if (wrap) _buildSpriteWrap(wrap, sessionId);
    _hideRerollConfirm();
    showFamiliarCard(sessionId);
  });

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  _rerollOverlayEl = overlay;

  const onKey = e => { if (e.key === 'Escape') _hideRerollConfirm(); };
  document.addEventListener('keydown', onKey);
  overlay._keyHandler = onKey;
}

// ── Oracle Re-roll confirm dialog ─────────────────────────

let _oracleRerollOverlayEl = null;

function _hideOracleRerollConfirm() {
  if (_oracleRerollOverlayEl) {
    if (_oracleRerollOverlayEl._keyHandler) document.removeEventListener('keydown', _oracleRerollOverlayEl._keyHandler);
    _oracleRerollOverlayEl.remove();
    _oracleRerollOverlayEl = null;
  }
}

function showOracleRerollConfirm() {
  _hideOracleRerollConfirm();

  const overlay = document.createElement('div');
  overlay.className = 'fc-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) _hideOracleRerollConfirm(); });

  const dialog = document.createElement('div');
  dialog.className = 'fc-confirm';

  const _title = document.createElement('div');
  _title.className = 'fc-confirm-title';
  _title.textContent = 'RE-ROLL ORACLE?';

  const _warning = document.createElement('div');
  _warning.className = 'fc-confirm-warning';
  _warning.textContent = 'Species and stats will change. Name and personality are preserved.';

  const _actions = document.createElement('div');
  _actions.className = 'fc-confirm-actions';
  const _goBtn = document.createElement('button');
  _goBtn.className = 'fc-confirm-btn fc-confirm-btn--go';
  _goBtn.textContent = 'CONFIRM RE-ROLL';
  const _cancelBtn = document.createElement('button');
  _cancelBtn.className = 'fc-confirm-btn fc-confirm-btn--cancel';
  _cancelBtn.textContent = 'CANCEL';
  _actions.append(_goBtn, _cancelBtn);

  dialog.append(_title, _warning, _actions);

  _cancelBtn.addEventListener('click', _hideOracleRerollConfirm);
  _goBtn.addEventListener('click', async () => {
    _goBtn.disabled = true;
    _goBtn.textContent = 'ROLLING\u2026';
    try {
      const { invoke } = window.__TAURI__.core;
      await invoke('reroll_oracle');
      const freshBuddy = await reloadBuddy();
      _hideOracleRerollConfirm();
      showOracleCard(freshBuddy);
    } catch (e) {
      console.error('[oracle-reroll] failed:', e);
      _goBtn.disabled = false;
      _goBtn.textContent = 'CONFIRM RE-ROLL';
    }
  });

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  _oracleRerollOverlayEl = overlay;

  const onKey = e => { if (e.key === 'Escape') _hideOracleRerollConfirm(); };
  document.addEventListener('keydown', onKey);
  overlay._keyHandler = onKey;
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
        <div class="session-card-tokens-row">
          <div class="compaction-meter" id="card-meter-${id}">
            <div class="compaction-meter-fill" id="card-meter-fill-${id}"></div>
          </div>
          <div class="compaction-pct" id="card-meter-pct-${id}"></div>
        </div>
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

  // Inject ASCII familiar + "about me" overlay into the sprite-wrap
  const wrap = document.getElementById(`card-sprite-wrap-${id}`);
  if (wrap && s.familiar) _buildSpriteWrap(wrap, id);
}

function _buildSpriteWrap(wrap, id) {
  const s = sessions.get(id);
  if (!s?.familiar) return;
  wrap.innerHTML = '';
  wrap.style.setProperty('--familiar-hue', s.familiarHue ?? '#FFDD44');

  const pre = document.createElement('pre');
  pre.className = 'familiar-pre';
  pre.dataset.species = s.familiar.species;
  pre.textContent = renderFrame(s.familiar.species, 0, s.familiar.eye, s.familiar.hat).join('\n');
  wrap.appendChild(pre);

  const viewBtn = document.createElement('button');
  viewBtn.className = 'familiar-view-btn';
  viewBtn.innerHTML = 'about<br>me';
  viewBtn.addEventListener('click', e => { e.stopPropagation(); showFamiliarCard(id); });
  wrap.appendChild(viewBtn);
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

  const meterFill = document.getElementById(`card-meter-fill-${id}`);
  const meterPct = document.getElementById(`card-meter-pct-${id}`);
  if (meterFill) {
    const pct = getCompactionPct(s);
    meterFill.style.width = `${pct}%`;
    if (pct >= 85)      meterFill.style.backgroundColor = '#e05252';
    else if (pct >= 65) meterFill.style.backgroundColor = '#d4a843';
    else                meterFill.style.backgroundColor = '#666666';
    if (meterPct) meterPct.textContent = pct > 0 ? `${pct}%` : '';
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
