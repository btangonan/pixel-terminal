/**
 * Pixel Terminal — app.js (bootstrap)
 * Wires all modules together. No business logic lives here.
 */

import { $, initDOM, autoResize, showConfirm } from './dom.js';
import {
  sessions, getActiveSessionId, IDENTITY_SEQ_KEY, SPRITE_DATA, FAMILIAR_SPECIES
} from './session.js';
import { renderFrame } from './ascii-sprites.js';
import {
  spawnClaude, sendMessage, pickFolder,
  expandSlashCommand, warnIfUnknownCommand, interruptSession, setLifecycleDeps
} from './session-lifecycle.js';
import { pushMessage, updateWorkingCursor, setPinToBottom, renderMessageLog, createMsgEl } from './messages.js';
import { handleEvent, setStatus, setEventDeps } from './events.js';
import { renderSessionCard, updateSessionCard, setActiveSession, showEmptyState, updateFamiliarDisplay } from './cards.js';
import { initVoice, isSettingsOpen, setSettingsOpen, settingsUpdate, cancelTTS } from './voice.js';
import { initOnboarding } from './onboarding.js';
import { initBargeIn } from './bargein.js';
import { initUISplit } from './ui-split.js';
import { initAttachments } from './attachments.js';
import {
  loadSlashCommands, getSlashCommands, showSlashMenu, hideSlashMenu,
  moveSlashSelection, getSlashToken, getFlagToken,
  acceptActiveSlashItem, getSlashActiveIdx
} from './slash-menu.js';
import { setHistoryDeps, initHistory, scanHistory, exitHistoryView, isHistoryActive, showHistoryFind } from './history.js';
import { initCompanion } from './companion.js';
import { initSettingsUI } from './settings-ui.js';



// ── Wire cross-module deps ────────────────────────────────
setLifecycleDeps({
  renderSessionCard,
  updateSessionCard,
  setActiveSession,
  pushMessage,
  setStatus,
  handleEvent,
  updateWorkingCursor,
  showEmptyState,
  get slashCommands() { return getSlashCommands(); },
  hideSlashMenu,
  exitHistoryView,
  scanHistory,
});

setEventDeps({
  expandSlashCommand,
  warnIfUnknownCommand,
});

setHistoryDeps({
  renderMessageLog,
  createMsgEl,
  sessions,
  getActiveSessionId,
});

// ── Bootstrap ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  initDOM();

  // One-time cleanup: remove stale flags that shouldn't persist across sessions
  localStorage.removeItem('alwaysOn');
  localStorage.removeItem('omiListening');
  localStorage.setItem(IDENTITY_SEQ_KEY, JSON.stringify({ idx: Math.floor(Math.random() * 1000) }));

  loadSlashCommands();
  initVoice();
  initBargeIn();
  initUISplit();
  // Wire barge-in → TTS cancel. Follow-up from PR-B/PR-C cross-merge.
  document.addEventListener('pixel:bargein', () => { try { cancelTTS(); } catch {} });
  initAttachments({ getActiveSessionId });
  initHistory();

  // First-run voice setup wizard — no-ops if already completed.
  initOnboarding();

  // P2.A — load persisted ANIMA_PERMISSION_MODE (bypass|default|gated). Defaults to bypass
  // until P2.G validation completes; P2.H settings UI writes this file.
  try {
    const { invoke } = window.__TAURI__.core;
    const raw = await invoke('read_file_as_text', {
      path: '~/.config/pixel-terminal/settings.json',
    });
    const cfg = JSON.parse(raw || '{}');
    if (cfg && typeof cfg.permissionMode === 'string') {
      window.__ANIMA_PERMISSION_MODE__ = cfg.permissionMode;
    }
  } catch { /* no settings file yet — bypass remains the default */ }

  // P2.H — wire Settings UI (reflects hydrated mode, writes back on user click)
  initSettingsUI();

  // Sync buddy.json from ~/.claude.json before companion loads so the companion
  // reads up-to-date species/rarity/stats on first render (replaces bun sync_real_buddy.ts)
  try {
    const { invoke } = window.__TAURI__.core;
    const result = await invoke('sync_buddy');
    invoke('js_log', { msg: `[sync-buddy] ${result.message}` }).catch(() => {});
  } catch (e) {
    console.warn('[sync-buddy] invoke failed:', e);
  }

  initCompanion();

  // Sync oracle pre-chat height to match input-bar exactly
  function syncOracleHeight() {
    const inputBar = document.getElementById('input-bar');
    const oraclePreChat = document.getElementById('oracle-pre-chat');
    if (inputBar && oraclePreChat) {
      oraclePreChat.style.height = inputBar.offsetHeight + 'px';
    }
  }
  requestAnimationFrame(syncOracleHeight);
  window.addEventListener('resize', syncOracleHeight);

  // Animate working badge + familiar frames every 400ms
  setInterval(() => {
    sessions.forEach((s, id) => {
      if (s.status === 'working' && !s.unread) {
        s._dotsPhase = (s._dotsPhase + 1) % 4;
        const el = document.getElementById(`card-status-${id}`);
        if (el) el.textContent = '.'.repeat(s._dotsPhase);
        // Advance familiar frame animation
        s._familiarFrame = ((s._familiarFrame ?? 0) + 1) % 3;
        updateFamiliarDisplay(id, s._familiarFrame);
      }
    });
  }, 400);

  // Refresh stale idle badges every 60s (threshold is 15min, so 60s granularity is fine)
  setInterval(() => {
    sessions.forEach((_, id) => updateSessionCard(id));
  }, 60_000);

  // Open links in system browser
  $.messageLog.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    if (!href.startsWith('https://') && !href.startsWith('http://')) return;
    e.preventDefault();
    window.__TAURI__.opener.openUrl(href);
  });

  // Track scroll position
  $.messageLog.addEventListener('scroll', () => {
    setPinToBottom($.messageLog.scrollTop + $.messageLog.clientHeight >= $.messageLog.scrollHeight - 40);
  });

  // ── Sidebar resize ──────────────────────────────────────
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
    if (_resizeRafId) { cancelAnimationFrame(_resizeRafId); _resizeRafId = null; sidebar.style.width = _resizeW + 'px'; }
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // Sidebar vertical resize (session panel / voice log)
  const sessionList = $.sessionPanel;
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
  const _savedH = localStorage.getItem('sidebar-session-list-h');
  if (_savedH) { sessionList.style.flex = 'none'; sessionList.style.height = _savedH + 'px'; }


  // ── Button wiring ───────────────────────────────────────
  $.btnNewSession.addEventListener('click', pickFolder);
  $.sessionPromptGotIt.addEventListener('click', () => $.sessionPrompt.classList.add('hidden'));

  // Search button — toggles search in current tab context
  function filterSessionCards(query) {
    const q = query.toLowerCase();
    $.sessionList?.querySelectorAll('.session-card').forEach(card => {
      const name = card.querySelector('.session-card-name')?.textContent?.toLowerCase() || '';
      card.style.display = q && !name.includes(q) ? 'none' : '';
    });
  }
  $.btnSearch?.addEventListener('click', () => {
    const historyVisible = !$.historyView?.classList.contains('hidden');
    if (historyVisible) {
      const hWrap = $.historySearchWrap;
      if (!hWrap) return;
      if (hWrap.classList.contains('hidden')) {
        hWrap.classList.remove('hidden');
        $.historySearch?.focus();
      } else {
        hWrap.classList.add('hidden');
        if ($.historySearch) {
          $.historySearch.value = '';
          $.historySearch.dispatchEvent(new Event('input'));
        }
      }
      return;
    } else {
      const wrap = $.sessionSearchWrap;
      if (!wrap) return;
      const isHidden = wrap.classList.contains('hidden');
      if (isHidden) {
        wrap.classList.remove('hidden');
        $.sessionSearch?.focus();
      } else {
        wrap.classList.add('hidden');
        if ($.sessionSearch) $.sessionSearch.value = '';
        filterSessionCards('');
      }
    }
  });
  $.sessionSearch?.addEventListener('input', (e) => {
    filterSessionCards(e.target.value.trim());
  });
  $.sessionSearch?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $.sessionSearchWrap?.classList.add('hidden');
      $.sessionSearch.value = '';
      filterSessionCards('');
      $.inputField?.focus();
    }
  });
  $.historySearch?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $.historySearchWrap?.classList.add('hidden');
      $.historySearch.value = '';
      $.historySearch.dispatchEvent(new Event('input'));
    }
  });

  // ASCII familiar — walks left↔right in the "START HERE" banner
  const _walkerEl = $.sessionPromptWalker;
  const _walkerSpecies = FAMILIAR_SPECIES[Math.floor(Math.random() * FAMILIAR_SPECIES.length)];
  let _walkerFrame = 0, _walkerX = 0, _walkerDir = 1, _walkerTick = 0;
  if (_walkerEl) {
    _walkerEl.textContent = renderFrame(_walkerSpecies, 0, 'o', 'none').join('\n');
    _walkerEl.style.transform = 'scaleX(-1)'; // start facing right (sprites default to facing left)
    setInterval(() => {
      _walkerFrame = (_walkerFrame + 1) % 3;
      _walkerEl.textContent = renderFrame(_walkerSpecies, _walkerFrame, 'o', 'none').join('\n');
      const track = _walkerEl.parentElement;
      const maxX = Math.max(0, track.offsetWidth - _walkerEl.offsetWidth);
      _walkerX += _walkerDir * 8;
      if (_walkerX >= maxX) { _walkerX = maxX; _walkerDir = -1; _walkerEl.style.transform = 'scaleX(1)';  }
      if (_walkerX <= 0)    { _walkerX = 0;    _walkerDir =  1; _walkerEl.style.transform = 'scaleX(-1)'; }
      _walkerEl.style.left = _walkerX + 'px';
      _walkerTick++;
      if (_walkerTick % 2 === 0) $.btnNewSession?.classList.toggle('plus-inverted');
    }, 320);
  }

  function positionSessionPrompt() {
    const sidebar = $.sidebar.getBoundingClientRect();
    const header  = $.sidebarHeader.getBoundingClientRect();
    $.sessionPrompt.style.top   = header.bottom + 'px';
    $.sessionPrompt.style.left  = sidebar.left + 'px';
    $.sessionPrompt.style.width = sidebar.width + 'px';
  }

  showEmptyState();
  positionSessionPrompt();
  new ResizeObserver(() => positionSessionPrompt()).observe($.sidebar);

  $.btnSend.addEventListener('click', () => {
    const text = $.inputField.value;
    if (!text.trim() || !getActiveSessionId()) return;
    $.inputField.value = '';
    $.inputField.style.height = '';
    setPinToBottom(true);
    hideSlashMenu();
    sendMessage(getActiveSessionId(), text);
  });

  // ── Input handling ──────────────────────────────────────
  $.inputField.addEventListener('keydown', (e) => {
    const menuVisible = !$.slashMenu.classList.contains('hidden');
    if (menuVisible) {
      if (e.key === 'ArrowDown')  { e.preventDefault(); moveSlashSelection(1); return; }
      if (e.key === 'ArrowUp')    { e.preventDefault(); moveSlashSelection(-1); return; }
      if (e.key === 'Tab') { e.preventDefault(); acceptActiveSlashItem(); return; }
      if (e.key === 'Enter' && !e.shiftKey && getSlashActiveIdx() >= 0) {
        e.preventDefault(); acceptActiveSlashItem(); return;
      }
      if (e.key === 'Escape') { e.preventDefault(); hideSlashMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = $.inputField.value;
      if (!text.trim() || !getActiveSessionId()) return;
      $.inputField.value = '';
      $.inputField.style.height = '';
      setPinToBottom(true);
      hideSlashMenu();
      sendMessage(getActiveSessionId(), text);
    }
  });

  $.inputField.addEventListener('input', (e) => {
    autoResize(e.target);
    const token = getSlashToken(e.target) || getFlagToken(e.target);
    if (token) { showSlashMenu(token); } else { hideSlashMenu(); }
  });

  // Click outside slash menu
  document.addEventListener('mousedown', (e) => {
    if (!$.slashMenu.classList.contains('hidden') &&
        !$.slashMenu.contains(e.target) && e.target !== $.inputField) {
      hideSlashMenu();
    }
  });

  // ── Keyboard shortcuts ──────────────────────────────────
  // Esc — cancel active Claude operation
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$.slashMenu.classList.contains('hidden')) return;
    if (!$.confirmOverlay?.classList.contains('hidden')) return;
    if (isSettingsOpen()) { setSettingsOpen(false); settingsUpdate(); return; }
    if (getActiveSessionId()) {
      const s = sessions.get(getActiveSessionId());
      if (s && s.child && (s.status === 'working' || s.status === 'waiting')) {
        e.preventDefault();
        // Kill + respawn with --continue. SIGINT doesn't work in stream-json mode
        // (it terminates the process instead of canceling the turn).
        clearTimeout(s._idleTimer);
        pushMessage(getActiveSessionId(), { type: 'system-msg', text: 'Interrupted — reconnecting…' });
        setStatus(getActiveSessionId(), 'waiting');
        interruptSession(getActiveSessionId());
      }
    }
  });

  // Cmd+F — find in history (only when a history session is loaded)
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f' && isHistoryActive()) {
      e.preventDefault();
      showHistoryFind();
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

  // ── Window close ────────────────────────────────────────
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  let _forceClose = false;
  appWindow.onCloseRequested(async (event) => {
    if (_forceClose) return;
    event.preventDefault();
    const count = sessions.size;
    const msg = count > 0
      ? `Close Anima? ${count} session${count > 1 ? 's' : ''} will be terminated.`
      : 'Close Anima?';
    const ok = await showConfirm(msg);
    if (ok) {
      _forceClose = true;
      for (const [id] of sessions) {
        try { sessions.get(id)?.child?.kill(); } catch (_) {}
      }
      appWindow.close();
    }
  });

  // ── About dialog ────────────────────────────────────────
  const { listen: tauriListen } = window.__TAURI__.event;
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
