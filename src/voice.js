// ── Voice bridge (Omi + PTT + always-on + settings) ────────

import { $ } from './dom.js';
import { sessions, getActiveSessionId } from './session.js';
import { sendMessage } from './session-lifecycle.js';
import { pushMessage } from './messages.js';
import { setActiveSession } from './cards.js';
import { getLintLogForSession, clearLintLog, setVexilLogListener, setOracleResponseListener, companionBuddy } from './companion.js';
import { clearSentAttachments } from './attachments.js';
import { createTTSPlayer } from './tts-player.js';

const { Command } = window.__TAURI__.shell;
const { invoke } = window.__TAURI__.core;
const { listen: tauriListen } = window.__TAURI__.event;

// ── State ──────────────────────────────────────────────────
let omiConnected = false;
let omiListening = true; // always start listening
let voiceSource = localStorage.getItem('voiceSource') || 'mic';
let alwaysOn = false;
let pttActive = false;
let settingsOpen = false;

// ── TTS player (lazy, created on first successful oracle response) ──────────
let _ttsPlayer = null;
let _ttsInflightReqId = null;

function _ttsEnabled() {
  // Default off — user opts in via localStorage. Keeps first-run silent.
  return localStorage.getItem('ttsEnabled') === '1';
}

async function _ensureTTSPlayer() {
  if (_ttsPlayer) return _ttsPlayer;
  const wsUrl = localStorage.getItem('ttsBridgeUrl') || 'ws://127.0.0.1:9877';
  _ttsPlayer = createTTSPlayer({ wsUrl, sessionId: `anima-${Date.now()}` });
  try {
    await _ttsPlayer.connect();
  } catch (err) {
    console.warn('[voice] tts connect failed:', err);
    _ttsPlayer = null;
    return null;
  }
  return _ttsPlayer;
}

export async function playTTS(text) {
  if (!_ttsEnabled() || !text) return;
  const player = await _ensureTTSPlayer();
  if (!player) return;
  // Cancel any in-flight speech before starting new — avoids overlap.
  if (_ttsInflightReqId) player.cancel(_ttsInflightReqId);
  _ttsInflightReqId = player.speak(text, {
    onDone: () => { _ttsInflightReqId = null; },
    onError: (err) => {
      console.warn('[voice] tts speak failed:', err);
      _ttsInflightReqId = null;
    },
  });
}

export function cancelTTS() {
  if (_ttsPlayer && _ttsInflightReqId) {
    _ttsPlayer.cancel(_ttsInflightReqId);
    _ttsInflightReqId = null;
  }
}

// ── Public getters ─────────────────────────────────────────
export function isSettingsOpen() { return settingsOpen; }
export function setSettingsOpen(val) { settingsOpen = val; }

// ── Voice log ──────────────────────────────────────────────
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
  entry.innerHTML = `<span class="ts">${escapeHtml(ts || '')}</span>${dispatched ? ': ' : ''}${escapeHtml(text)}`;
  $.voiceLog.appendChild(entry);
  while ($.voiceLog.children.length > MAX_VOICE_LOG) $.voiceLog.removeChild($.voiceLog.firstChild);
  $.voiceLog.scrollTop = $.voiceLog.scrollHeight;
}

// ── Vexil chat log ─────────────────────────────────────────

let _vexilTabActive = true;  // VEXIL is the default visible tab

const STATE_CLASS = {
  blocked:        'vexil-entry--blocked',
  needs_approval: 'vexil-entry--blocked',
  warn:           'vexil-entry--warn',
  ops:            'vexil-entry--ops',
  vexil:          'vexil-entry--buddy',
};

function fmtTs(ts) {
  const m = String(ts).match(/(\d{1,2}:\d{2})/);
  return m ? `[${m[1]}]` : `[${ts}]`;
}

function renderVexilLog(entries) {
  if (!$.vexilLog) return;
  $.vexilLog.innerHTML = entries.map(e => {
    const cls = STATE_CLASS[e.state] ?? '';
    const hasSend = (e.state !== 'ops' && e.msg);
    const sendCls = hasSend ? ' has-send' : '';
    const dataMsg = hasSend ? ` data-msg="${escapeHtml(e.msg).replace(/"/g, '&quot;')}"` : '';
    const overlay = hasSend ? `<div class="send-overlay"><button>SEND TO CLAUDE \u2192</button></div>` : '';
    return `<div class="vexil-entry ${cls}${sendCls}"${dataMsg}><span class="vexil-ts">${escapeHtml(fmtTs(e.ts))}</span>${escapeHtml(e.msg)}${overlay}</div>`;
  }).join('');
  // Oldest first in array — scroll to bottom so latest is visible (matches session log flow)
  $.vexilLog.scrollTop = $.vexilLog.scrollHeight;
}

function initVexilTabs() {
  const tabs = document.querySelectorAll('.voice-tab');

  function showTab(target) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.vtab === target));
    _vexilTabActive = target === 'vexil';
    if ($.voiceLog)        $.voiceLog.classList.toggle('hidden',        target !== 'voice');
    if ($.vexilLog)        $.vexilLog.classList.toggle('hidden',        target !== 'vexil');
    if ($.attachmentsPanel) $.attachmentsPanel.classList.toggle('hidden', target !== 'files');
    const bio = document.getElementById('vexil-bio');
    if (bio) bio.classList.toggle('hidden', target !== 'vexil');
    const header = document.getElementById('voice-log-header');
    if (header) header.classList.toggle('oracle-active', target === 'vexil');
    // Only re-render lint log when a session is active — pre-session oracle content must not be wiped
    if (target === 'vexil' && sessions.size > 0) renderVexilLog(getLintLogForSession(getActiveSessionId()));
    document.dispatchEvent(new CustomEvent('pixel:vexil-tab-changed', { detail: { tab: target } }));
  }

  tabs.forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.vtab)));

  // Initialize to BUDDY tab (matches active class in HTML)
  showTab('vexil');

  // When user switches session, flip buddy log to that session's entries
  document.addEventListener('pixel:session-changed', (e) => {
    if (_vexilTabActive) renderVexilLog(getLintLogForSession(e.detail.id));
    const bio = document.getElementById('vexil-bio');
    if (bio) bio.classList.toggle('hidden', !_vexilTabActive);
  });

  // Tab-aware CLR
  $.btnClearVoiceLog?.addEventListener('click', () => {
    const active = document.querySelector('.voice-tab.active')?.dataset.vtab;
    if (active === 'vexil') {
      clearLintLog(getActiveSessionId());
      renderVexilLog([]);
    } else if (active === 'files') {
      clearSentAttachments();
    } else {
      if ($.voiceLog) $.voiceLog.innerHTML = '';
    }
  }, true);  // capture phase

  // Event delegation: only the button inside send-overlay triggers send
  $.vexilLog?.addEventListener('click', (e) => {
    const btn = e.target.closest('.send-overlay button');
    if (!btn) return;
    const entry = btn.closest('.has-send');
    if (!entry) return;
    const msg = entry.dataset.msg;
    const sid = getActiveSessionId();
    if (sid && msg) sendMessage(sid, msg);
  });
}

// ── Indicator updates ──────────────────────────────────────
function _omiIndicatorUpdate() {
  if (!$.omiIndicator) return;
  $.omiIndicator.classList.remove('connected');
  if (omiConnected) {
    $.omiIndicator.classList.add('connected');
    $.omiIndicator.title = 'Voice connected \u2014 click for settings (fn = push to talk)';
  } else {
    $.omiIndicator.title = 'Voice bridge disconnected \u2014 click for settings';
  }
}

function _showDotStatus(msg) {
  if (!$.omiIndicator) return;
  const prev = $.omiIndicator.title;
  $.omiIndicator.title = msg;
  setTimeout(() => { $.omiIndicator.title = prev; }, 2500);
}

function _alwaysOnUpdate() {
  if (!$.alwaysOnBtn) return;
  if (alwaysOn) {
    $.alwaysOnBtn.classList.add('active');
    $.alwaysOnBtn.title = 'Always-on mic active \u2014 click to return to trigger mode (Ctrl+Shift+A)';
  } else {
    $.alwaysOnBtn.classList.remove('active');
    $.alwaysOnBtn.title = 'Always-on mic off \u2014 no "hey pixel" needed when on (Ctrl+Shift+A)';
  }
}

function _pttIndicatorUpdate() {
  if (!$.omiIndicator) return;
  if (pttActive) {
    $.omiIndicator.classList.add('ptt');
  } else {
    $.omiIndicator.classList.remove('ptt');
  }
}

function _settingsUpdate() {
  if (!$.settingsPanel) return;
  $.settingsPanel.classList.toggle('hidden', !settingsOpen);
  $.settingsBtn?.classList.toggle('open', settingsOpen);
  $.voiceSourceBle?.classList.toggle('active', voiceSource === 'ble');
  $.voiceSourceMic?.classList.toggle('active', voiceSource === 'mic');
}

export { _settingsUpdate as settingsUpdate };

// ── Actions ────────────────────────────────────────────────
function toggleOmiListening() {
  omiListening = !omiListening;
  _omiIndicatorUpdate();
  invoke('set_omi_listening', { enabled: omiListening }).catch(e => console.warn('[voice] set_omi_listening failed:', e));
}

function toggleAlwaysOn() {
  alwaysOn = !alwaysOn;
  _alwaysOnUpdate();
  invoke('set_voice_mode', { mode: alwaysOn ? 'always_on' : 'trigger_mode' }).catch(e => console.warn('[voice] set_voice_mode failed:', e));
}

function _isPttKey(e) {
  return e.key === 'Fn' || e.code === 'Fn' || e.code === 'AltRight';
}

function _switchVoiceSource(source) {
  voiceSource = source;
  localStorage.setItem('voiceSource', voiceSource);
  _settingsUpdate();
  _omiIndicatorUpdate();
  const label = source === 'ble' ? 'BLE pendant' : 'Mac mic';
  appendVoiceLog(`Switching to ${label} \u2014 reconnecting...`, new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}), false);
  invoke('switch_voice_source', { source }).catch(e => console.warn('[voice] switch_voice_source failed:', e));
}

function resolveSession(ref) {
  if (ref == null) return getActiveSessionId();
  if (typeof ref === 'number') {
    const keys = [...sessions.keys()];
    return keys[ref - 1] || getActiveSessionId();
  }
  const needle = String(ref).toLowerCase();
  for (const [id, s] of sessions) {
    if (s.name.toLowerCase().includes(needle)) return id;
  }
  return getActiveSessionId();
}

// ── Oracle pre-session chat ────────────────────────────────

function initOraclePreChat() {
  const wrap  = $.oraclePreChat;
  const input = $.oracleInput;
  if (!wrap || !input) return;

  let _reqId = Date.now(); // timestamp-based start prevents cross-session req_id=1 collision
  let _pendingReqId  = null;
  let _pendingMsg    = '';   // user message awaiting oracle response (for history)
  let _thinkingEl    = null;
  let _history       = [];  // [{role, content}] rolling last 6

  function setVisible() {
    wrap.classList.add('hidden');
  }

  const _oracleChatLog = document.getElementById('oracle-chat-log');
  function appendEntry(text, cls) {
    if (!_oracleChatLog) return null;
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    _oracleChatLog.appendChild(el);
    _oracleChatLog.scrollTop = _oracleChatLog.scrollHeight;
    return el;
  }

  // Core oracle query — shared by typed input and voice PTT.
  async function submitToOracle(text) {
    if (!text || _pendingReqId !== null) return;

    appendEntry(text, 'oracle-user-msg');
    _thinkingEl = appendEntry('· · ·', 'oracle-thinking');

    const reqId = ++_reqId;
    _pendingReqId = reqId;
    _pendingMsg = text;

    document.body.dataset.oracleThinking = '1';
    document.dispatchEvent(new CustomEvent('oracle:thinking'));

    try {
      const resp = await invoke('oracle_query', {
        message: text,
        history: _history.slice(-6),
        reqId: reqId,
        sessions: [...sessions.values()].map(s => ({ name: s.name, cwd: s.cwd })),
      });
      if (_thinkingEl) { _thinkingEl.remove(); _thinkingEl = null; }
      _pendingReqId = null;

      const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const el = document.createElement('div');
      el.className = 'vexil-entry vexil-entry--buddy has-send';
      el.dataset.msg = resp.msg;
      el.innerHTML = `<span class="vexil-ts">[${ts}]</span>${escapeHtml(resp.msg)}<div class="send-overlay"><button>SEND TO CLAUDE \u2192</button></div>`;
      el.querySelector('.send-overlay button').addEventListener('click', (ev) => {
        ev.stopPropagation();
        const sid = getActiveSessionId();
        if (sid) sendMessage(sid, resp.msg);
      });
      _oracleChatLog?.appendChild(el);
      if (_oracleChatLog) requestAnimationFrame(() => { _oracleChatLog.scrollTop = _oracleChatLog.scrollHeight; });

      // Optional voice output — no-op unless ttsEnabled=1 in localStorage.
      playTTS(resp.msg);

      _history.push({ role: 'user', content: _pendingMsg });
      _history.push({ role: 'oracle', content: resp.msg });
      if (_history.length > 6) _history = _history.slice(-6);
    } catch (_) {
      if (_thinkingEl) { _thinkingEl.remove(); _thinkingEl = null; }
      _pendingReqId = null;
      appendEntry('(oracle unreachable)', 'oracle-thinking');
    } finally {
      delete document.body.dataset.oracleThinking;
      document.dispatchEvent(new CustomEvent('oracle:idle'));
    }
  }

  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await submitToOracle(text);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  $.oracleSend?.addEventListener('click', submit);

  document.addEventListener('pixel:session-changed', setVisible);
  document.addEventListener('pixel:vexil-tab-changed', setVisible);
  setVisible();

  // Post intro once — only after companion is ready AND a session is active
  return { submitToOracle };
}

// ── Init (called once from bootstrap) ──────────────────────
export function initVoice() {
  // Check if voice bridge is already connected (handles page reload)
  invoke('get_voice_status').then(connected => {
    if (connected) {
      omiConnected = true;
      _omiIndicatorUpdate();
    }
  }).catch(e => console.warn('[voice] get_voice_status failed:', e));

  // Omi indicator click — launch voice bridge if not connected
  $.omiIndicator?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (omiConnected) {
      _showDotStatus('Voice bridge connected');
    } else {
      _showDotStatus('Starting mic…');
      const home = await window.__TAURI__.path.homeDir();
      const bridgePath = localStorage.getItem('voiceBridgePath');
      if (!bridgePath) {
        _showDotStatus('Set voiceBridgePath in Settings');
        return;
      }
      // Validate path: reject shell metacharacters to prevent injection
      if (/[;&|`$(){}[\]!#~]/.test(bridgePath)) {
        _showDotStatus('Invalid bridge path');
        return;
      }
      Command.create('sh', ['-c', `cd '${bridgePath.replace(/'/g, "'\\''")}' && source venv/bin/activate && python3 pixel_voice_bridge.py`]).execute().catch(() => {
        _showDotStatus('Could not start voice bridge');
      });
    }
  });

  // Ctrl+Shift+O — toggle listening
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'O') {
      e.preventDefault();
      toggleOmiListening();
    }
  });

  // submitToOracle is bound after initOraclePreChat() runs below.
  // Declared here so the omi:command closure can reference it.
  let submitToOracle = null;

  // Omi command events
  tauriListen('omi:command', (event) => {
    const { type, text, session, ts, dispatched } = event.payload;
    if (type === 'transcript') {
      if (omiConnected && omiListening) appendVoiceLog(text, ts, dispatched);
      return;
    }
    if (!omiListening) return;
    if (type === 'prompt') {
      // Voice input → Oracle (Vexil) by default, not the active Claude Code session.
      if (submitToOracle) submitToOracle(text);
      return;
    }
    const targetId = resolveSession(session ?? null);
    if (!targetId) return;
    if (type === 'switch') {
      setActiveSession(targetId);
    } else if (type === 'list_sessions') {
      const lines = [...sessions.entries()]
        .map(([_, s], i) => `${i + 1}. ${s.name} [${s.status}]`)
        .join('\n');
      pushMessage(getActiveSessionId(), { type: 'system-msg', text: `Omi sessions:\n${lines}` });
    }
  });

  // CLR handled by initVexilTabs (tab-aware, capture phase)

  // Connection events
  tauriListen('omi:connected', () => {
    omiConnected = true;
    _omiIndicatorUpdate();
    invoke('set_omi_listening', { enabled: omiListening }).catch(e => console.warn('[voice] set_omi_listening failed:', e));
    invoke('set_voice_mode', { mode: alwaysOn ? 'always_on' : 'trigger_mode' }).catch(e => console.warn('[voice] set_voice_mode failed:', e));
  });

  tauriListen('omi:disconnected', () => {
    omiConnected = false;
    _omiIndicatorUpdate();
  });

  // Always-on toggle
  $.alwaysOnBtn?.addEventListener('click', toggleAlwaysOn);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      toggleAlwaysOn();
    }
  });
  _alwaysOnUpdate();

  // PTT (push-to-talk)
  document.addEventListener('keydown', (e) => {
    if (!_isPttKey(e)) return;
    if (pttActive) return;
    if (!omiConnected) return;
    pttActive = true;
    invoke('ptt_start').catch(e => console.warn('[voice] ptt_start failed:', e));
    _pttIndicatorUpdate();
  });
  document.addEventListener('keyup', (e) => {
    if (!_isPttKey(e)) return;
    if (!pttActive) return;
    pttActive = false;
    invoke('ptt_release').catch(e => console.warn('[voice] ptt_release failed:', e));
    _pttIndicatorUpdate();
  });

  // Settings panel
  $.settingsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsOpen = !settingsOpen;
    _settingsUpdate();
  });
  document.addEventListener('click', () => {
    if (settingsOpen) { settingsOpen = false; _settingsUpdate(); }
  });
  $.settingsPanel?.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  $.voiceSourceBle?.addEventListener('click', () => _switchVoiceSource('ble'));
  $.voiceSourceMic?.addEventListener('click', () => _switchVoiceSource('mic'));
  _settingsUpdate();

  // Vexil chat log tab
  initVexilTabs();
  setVexilLogListener(renderVexilLog);

  // Oracle pre-session chat — capture submitToOracle for voice PTT routing
  ({ submitToOracle } = initOraclePreChat());
}
