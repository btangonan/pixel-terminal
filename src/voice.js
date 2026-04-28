// ── Voice bridge (Omi + PTT + always-on + settings) ────────

import { $ } from './dom.js';
import { sessions, getActiveSessionId } from './session.js';
import { sendMessage } from './session-lifecycle.js';
import { pushMessage } from './messages.js';
import { setActiveSession } from './cards.js';
import { getLintLogForSession, setVexilLogListener, setOracleResponseListener, companionBuddy } from './companion.js';
import { createTTSPlayer } from './tts-player.js';

const { invoke } = window.__TAURI__.core;
const { listen: tauriListen } = window.__TAURI__.event;

// ── State ──────────────────────────────────────────────────
let omiConnected = false;
let omiListening = true; // always start listening
let voiceSource = localStorage.getItem('voiceSource') || 'mic';
let alwaysOn = false;
let pttActive = false;
let settingsOpen = false;
// Re-entry guard: blocks concurrent start_voice_sidecar calls. A double-click on
// the omi indicator (or onboarding-then-tab) used to spawn two parallel sidecar
// pairs that fought for ws://127.0.0.1:9876 and broke the oracle pipeline.
let _voiceStartInFlight = false;

// ── TTS player (lazy, created on first successful oracle response) ──────────
let _ttsPlayer = null;
let _ttsInflightReqId = null;

// Strip non-speech markdown but PRESERVE single-asterisk *stage directions*
// so the TTS path can route them to a dramatic (slower) prosody.
// Bold (**...**) collapses to its inner text. Code/links/headings stripped.
function sanitizeForTTSPreserveStage(text) {
  return text
    .replace(/['']/g, "'").replace(/[""]/g, '"')
    .replace(/\*\*(.+?)\*\*/gs, '$1')              // **bold** → keep text
    .replace(/__(.+?)__/gs, '$1')                  // __bold__ → keep text
    .replace(/```[\s\S]*?```/g, '')                // code blocks → remove
    .replace(/`([^`]+)`/g, '$1')                   // `inline` → keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')       // [label](url) → keep label
    .replace(/^#{1,6}\s+/gm, '')                   // ## Header → strip hashes
    .replace(/^[-=]{3,}$/gm, '')                   // horizontal rules → remove
    .replace(/[^a-zA-Z0-9À-ɏ\s.,!?:;'"—–…%$/*\-]/g, ' ')  // keep * for staging
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeForTTS(text) {
  // Legacy: full strip including stage directions. Kept for callers that
  // don't want segmented prosody. Not used by the oracle path anymore.
  return sanitizeForTTSPreserveStage(text)
    .replace(/\*[^*\n]*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Split Vexil reply into segments: { text, stage }. Stage segments get
// slower prosody server-side. Empty segments are dropped.
export function parseVexilSpeechSegments(text) {
  const cleaned = sanitizeForTTSPreserveStage(text);
  const segments = [];
  const re = /\*([^*\n]+?)\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    if (m.index > last) {
      const t = cleaned.slice(last, m.index).trim();
      if (t) segments.push({ text: t, stage: false });
    }
    const stageText = m[1].trim();
    if (stageText) segments.push({ text: stageText, stage: true });
    last = m.index + m[0].length;
  }
  if (last < cleaned.length) {
    const t = cleaned.slice(last).trim();
    if (t) segments.push({ text: t, stage: false });
  }
  return segments;
}

// Render Vexil text for the chat panel: italicize *stage directions*,
// bold **text**, and keep raw asterisks OUT of the visible output.
export function renderVexilText(text) {
  // Escape HTML first (XSS safety), then run the markdown transforms on
  // the escaped string. Asterisks are not HTML-special so they survive.
  const escaped = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return escaped
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g, '<em class="vexil-stage">$1</em>');
}

function _ttsEnabled() {
  // Default ON — user can opt out by setting ttsEnabled='0' in localStorage.
  // Was previously default-OFF, which silently swallowed every Vexil response
  // even though the TTS pipeline was wired correctly.
  const stored = localStorage.getItem('ttsEnabled');
  return stored !== '0';
}

async function _ensureTTSPlayer() {
  // Detect a dead cached player (e.g. TTS server was restarted underneath us
  // — the old WebSocket closed and state went to 'idle' or 'error'). Recreate
  // instead of returning the corpse, otherwise speak() fails with
  // "tts-player not ready (state=idle)" forever until app reload.
  if (_ttsPlayer) {
    const s = _ttsPlayer.getState ? _ttsPlayer.getState() : null;
    if (s && s !== 'ready' && s !== 'connecting' && s !== 'handshaking') {
      try { _ttsPlayer.disconnect?.(); } catch (_) {}
      _ttsPlayer = null;
      _ttsInflightReqId = null;
    } else {
      return _ttsPlayer;
    }
  }
  const wsUrl = 'ws://127.0.0.1:9877';
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

// Piper TTS voices (rhasspy/piper). Each is a separate ONNX model under
// ~/.cache/piper-voices/. Add more via:
//   curl -L -o ~/.cache/piper-voices/<voice>.onnx \
//     https://huggingface.co/rhasspy/piper-voices/resolve/main/<lang>/<lang>_<region>/<name>/<quality>/<voice>.onnx
// Pick via UI dropdown OR window.vexilVoice('en_US-amy-medium').
// User-approved final set (2026-04-25). Other voices were stripped at user
// request. To re-add later, re-list the ID + ensure the voice file is on
// disk (Piper: ~/.cache/piper-voices/<id>.onnx; Kokoro: voices-v1.0.bin).
const VEXIL_VOICES = [
  'en_GB-alba-medium',                  // UK female (default)
  'en_GB-northern_english_male-medium', // UK male
  'am_onyx',                            // US male (Kokoro)
];
const DEFAULT_VEXIL_VOICE = 'en_GB-alba-medium';

function _selectedVoice() {
  const stored = localStorage.getItem('vexilVoice') || DEFAULT_VEXIL_VOICE;
  return VEXIL_VOICES.includes(stored) ? stored : DEFAULT_VEXIL_VOICE;
}

export function getAvailableVoices() { return VEXIL_VOICES.slice(); }
export function setVexilVoice(v) {
  if (!VEXIL_VOICES.includes(v)) {
    console.warn(`[voice] unknown voice "${v}". Available:`, VEXIL_VOICES);
    return false;
  }
  localStorage.setItem('vexilVoice', v);
  console.log(`[voice] vexil voice set to: ${v}`);
  return true;
}

export async function playTTS(text) {
  if (!_ttsEnabled() || !text) return;
  // *stage directions* are rendered italic in chat but NOT spoken.
  // sanitizeForTTS strips them; segments path is no longer used.
  const clean = sanitizeForTTS(text);
  if (!clean) return;
  const player = await _ensureTTSPlayer();
  if (!player) return;
  if (_ttsInflightReqId) player.cancel(_ttsInflightReqId);
  _ttsInflightReqId = player.speak(clean, {
    voice: _selectedVoice(),
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

  const row = document.createElement('div');
  row.className = dispatched ? 'voice-entry voice-entry--final' : 'voice-entry voice-entry--partial';
  const stamp = ts || new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  row.textContent = `[${stamp}] ${text}`;
  $.voiceLog.appendChild(row);

  while ($.voiceLog.children.length > MAX_VOICE_LOG) {
    $.voiceLog.firstElementChild?.remove();
  }
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
  const oracleChatLog = document.getElementById('oracle-chat-log');
  const oraclePreChat = document.getElementById('oracle-pre-chat');
  const clrBtn = document.getElementById('btn-clear-voice-log');

  function showTab(target) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.vtab === target));
    _vexilTabActive = target === 'vexil';
    if ($.voiceLog)        $.voiceLog.classList.toggle('hidden',        target !== 'voice');
    if ($.vexilLog)        $.vexilLog.classList.toggle('hidden',        target !== 'vexil');
    if ($.attachmentsPanel) $.attachmentsPanel.classList.toggle('hidden', target !== 'files');
    // oracle-chat-log + pre-chat input belong to the ORACLE tab only — without these toggles
    // the FILES tab still showed chat content underneath the (empty) attachments panel.
    if (oracleChatLog)  oracleChatLog.classList.toggle('hidden',  target !== 'vexil');
    if (oraclePreChat)  oraclePreChat.classList.toggle('hidden',  target !== 'vexil');
    // CLR clears the oracle/voice log — only meaningful while ORACLE tab is active.
    if (clrBtn)         clrBtn.classList.toggle('hidden',         target !== 'vexil');
    const bio = document.getElementById('vexil-bio');
    if (bio) bio.classList.toggle('hidden', target !== 'vexil');
    // Only re-render lint log when a session is active — pre-session oracle content must not be wiped
    if (target === 'vexil' && sessions.size > 0) renderVexilLog(getLintLogForSession(getActiveSessionId()));
    document.dispatchEvent(new CustomEvent('pixel:vexil-tab-changed', { detail: { tab: target } }));
  }

  tabs.forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.vtab)));

  // Initialize to the oracle state even when the legacy tab controls are absent.
  showTab('vexil');

  // When user switches session, flip buddy log to that session's entries
  document.addEventListener('pixel:session-changed', (e) => {
    if (_vexilTabActive) renderVexilLog(getLintLogForSession(e.detail.id));
    const bio = document.getElementById('vexil-bio');
    if (bio) bio.classList.toggle('hidden', !_vexilTabActive);
  });

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
  const prev = omiListening;
  omiListening = !omiListening;
  _omiIndicatorUpdate();
  invoke('set_omi_listening', { enabled: omiListening }).catch(e => {
    console.warn('[voice] set_omi_listening failed:', e);
    omiListening = prev;
    _omiIndicatorUpdate();
    _showDotStatus('Listening toggle failed');
  });
}

function toggleAlwaysOn() {
  const prev = alwaysOn;
  alwaysOn = !alwaysOn;
  _alwaysOnUpdate();
  invoke('set_voice_mode', { mode: alwaysOn ? 'always_on' : 'trigger_mode' }).catch(e => {
    console.warn('[voice] set_voice_mode failed:', e);
    alwaysOn = prev;
    _alwaysOnUpdate();
    _showDotStatus('Voice mode toggle failed');
  });
}

function _isPttKey(e) {
  return e.key === 'Fn' || e.code === 'Fn' || e.code === 'AltRight';
}

function _switchVoiceSource(source) {
  const prev = voiceSource;
  voiceSource = source;
  localStorage.setItem('voiceSource', voiceSource);
  _settingsUpdate();
  _omiIndicatorUpdate();
  const label = source === 'ble' ? 'BLE pendant' : 'Mac mic';
  appendVoiceLog(`Switching to ${label} \u2014 reconnecting...`, new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}), false);
  invoke('switch_voice_source', { source }).catch(e => {
    console.warn('[voice] switch_voice_source failed:', e);
    voiceSource = prev;
    localStorage.setItem('voiceSource', voiceSource);
    _settingsUpdate();
    _omiIndicatorUpdate();
    appendVoiceLog(`Voice source switch failed; restored ${prev === 'ble' ? 'BLE pendant' : 'Mac mic'}.`, new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}), false);
  });
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

  function setVisible(e) {
    const isHybrid = document.getElementById('vexil-panel')?.classList.contains('hybrid-split');
    if (isHybrid) {
      wrap.classList.remove('hidden');
      return;
    }
    const tab = e?.detail?.tab ?? document.querySelector('.voice-tab.active')?.dataset.vtab ?? 'vexil';
    // Show oracle input whenever the ORACLE/Vexil tab is visible.
    wrap.classList.toggle('hidden', tab !== 'vexil');
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
      el.innerHTML = `<span class="vexil-ts">[${ts}]</span>${renderVexilText(resp.msg)}<div class="send-overlay"><button>SEND TO CLAUDE \u2192</button></div>`;
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
  document.addEventListener('pixel:hybrid-toggle', setVisible);
  setVisible();

  // Post intro once — only after companion is ready AND a session is active
  return { submitToOracle };
}

// ── Init (called once from bootstrap) ──────────────────────
export function initVoice() {
  // Console helper so the user can switch voices live without DevTools digging:
  //   vexilVoice()           → list all 9
  //   vexilVoice('serena')   → switch to serena (effective on next reply)
  //   vexilVoice('current')  → show current
  if (typeof window !== 'undefined') {
    window.vexilVoice = (name) => {
      if (name === undefined) {
        console.log('available:', VEXIL_VOICES);
        console.log('current:', _selectedVoice());
        return VEXIL_VOICES;
      }
      if (name === 'current') return _selectedVoice();
      return setVexilVoice(name);
    };
  }

  // Check if voice bridge is already connected (handles page reload)
  invoke('get_voice_status').then(connected => {
    if (connected) {
      omiConnected = true;
      _omiIndicatorUpdate();
    }
  }).catch(e => console.warn('[voice] get_voice_status failed:', e));

  // Omi indicator click — start sidecars via Tauri invoke
  async function startVoiceSidecar() {
    if (_voiceStartInFlight) {
      _showDotStatus('Voice starting...');
      return null;
    }
    _voiceStartInFlight = true;
    _showDotStatus('Starting voice...');
    try {
      const status = await invoke('start_voice_sidecar', { source: voiceSource });
      if (status?.sttPortOpen || status?.stt_running || status?.sttRunning) {
        _showDotStatus('Voice starting...');
      } else {
        _showDotStatus('Voice sidecar started');
      }
      // Open the mic gate — STT bridge blocks on start_capture before touching sounddevice.
      await invoke('start_voice_capture').catch(e => console.warn('[voice] start_voice_capture failed:', e));
      // Optimistically show connected — omi:connected arrives later when bridge sends voice_ready.
      omiConnected = true;
      _omiIndicatorUpdate();
      return status;
    } catch (err) {
      console.warn('[voice] start_voice_sidecar failed:', err);
      // Still open the mic gate — a manually-started bridge may already be connected.
      invoke('start_voice_capture').catch(() => {});
      _showDotStatus(String(err).includes('9876') ? 'Voice port unavailable' : 'Could not start voice');
      return null;
    } finally {
      _voiceStartInFlight = false;
    }
  }

  $.omiIndicator?.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Confirm the LOCAL anima-stt sidecar is actually alive before treating the
    // indicator as connected. omiConnected can be stale if the sidecar crashed
    // after handshake; in that case the user clicks expecting a restart.
    let sttRunning = false;
    try {
      const health = await invoke('voice_sidecar_health');
      sttRunning = !!(health?.stt_running || health?.sttRunning);
    } catch (_) { /* fall through and try start */ }
    if (omiConnected && sttRunning) {
      _showDotStatus('Voice bridge connected');
      return;
    }
    await startVoiceSidecar();
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
  let lastVoiceSubmit = { text: '', at: 0 };

  function submitVoiceText(text) {
    const clean = String(text || '').trim();
    if (!clean || !submitToOracle) return;
    const now = Date.now();
    if (clean === lastVoiceSubmit.text && now - lastVoiceSubmit.at < 1500) return;
    lastVoiceSubmit = { text: clean, at: now };
    submitToOracle(clean);
  }

  // Omi command events
  tauriListen('omi:command', (event) => {
    const { type, text, session, ts, dispatched } = event.payload;
    if (type === 'transcript') {
      if (omiConnected && omiListening) appendVoiceLog(text, ts, dispatched);
      if (omiListening && dispatched) submitVoiceText(text);
      return;
    }
    if (!omiListening) return;
    if (type === 'prompt') {
      // Voice input → Oracle (Vexil) by default, not the active Claude Code session.
      submitVoiceText(text);
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

  // Sidecar lifecycle events
  tauriListen('voice:started', (event) => {
    _showDotStatus(`${event.payload.service.toUpperCase()} started`);
  });
  tauriListen('voice:stopped', () => {
    omiConnected = false;
    _omiIndicatorUpdate();
  });
  tauriListen('voice:crashed', (event) => {
    console.warn('[voice] sidecar crashed:', event.payload);
    _showDotStatus(`${event.payload.service.toUpperCase()} restarted`);
  });
  tauriListen('voice:port_unavailable', (event) => {
    _showDotStatus(`Port ${event.payload.port} unavailable`);
  });
  tauriListen('voice:permission_denied', () => {
    _showDotStatus('Microphone permission needed');
  });

  // Connection events
  tauriListen('omi:connected', () => {
    omiConnected = true;
    _omiIndicatorUpdate();
    invoke('set_omi_listening', { enabled: omiListening }).catch(e => console.warn('[voice] set_omi_listening failed:', e));
    if (alwaysOn) {
      invoke('set_voice_mode', { mode: 'always_on' }).catch(e => console.warn('[voice] set_voice_mode failed:', e));
    }
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
  // Do NOT gate on omiConnected: ws_bridge stores ptt_active in OmiBridgeState
  // and replays ptt_start to pixel_voice_bridge clients on (re)connect, so a
  // keydown fired while STT is briefly disconnected is preserved through the
  // sidecar's reconnect cycle. Gating here silently drops the keypress and
  // defeats the replay path. Bridge no-ops when zero clients are registered.
  document.addEventListener('keydown', (e) => {
    if (!_isPttKey(e)) return;
    if (pttActive) return;
    pttActive = true;
    invoke('js_log', { msg: `[voice] PTT keydown — invoking ptt_start (key=${e.key} code=${e.code})` }).catch(() => {});
    invoke('ptt_start')
      .then(() => invoke('js_log', { msg: '[voice] ptt_start invoke RESOLVED' }).catch(() => {}))
      .catch(err => invoke('js_log', { msg: `[voice] ptt_start invoke REJECTED: ${err}` }).catch(() => {}));
    _pttIndicatorUpdate();
  });
  document.addEventListener('keyup', (e) => {
    if (!_isPttKey(e)) return;
    if (!pttActive) return;
    pttActive = false;
    invoke('js_log', { msg: `[voice] PTT keyup — invoking ptt_release` }).catch(() => {});
    invoke('ptt_release')
      .then(() => invoke('js_log', { msg: '[voice] ptt_release invoke RESOLVED' }).catch(() => {}))
      .catch(err => invoke('js_log', { msg: `[voice] ptt_release invoke REJECTED: ${err}` }).catch(() => {}));
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
