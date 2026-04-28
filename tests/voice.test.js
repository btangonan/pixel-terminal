/**
 * voice.test.js
 *
 * Tests for voice.js exported API surface.
 * Most of voice.js is event wiring and DOM manipulation; tests here cover
 * the exported state getters/setters and the parts of initVoice that
 * are observable without a real Tauri process.
 */
import { beforeEach, afterEach, test, expect, vi } from 'vitest';

// ── Tauri shim ────────────────────────────────────────────────────────────────

const _tauriListeners = {};
const _mockInvoke = vi.fn().mockResolvedValue(null);
const _originalWebSocket = globalThis.WebSocket;
const _originalAudioContext = window.AudioContext;
const _originalWebkitAudioContext = window.webkitAudioContext;

window.__TAURI__ = {
  shell: {
    Command: {
      create: vi.fn().mockReturnValue({
        stdout: { on: vi.fn() }, stderr: { on: vi.fn() },
        on: vi.fn(), spawn: vi.fn().mockResolvedValue({ write: vi.fn(), kill: vi.fn(), pid: 1 }),
        execute: vi.fn().mockResolvedValue({}),
      }),
    },
  },
  core: { invoke: _mockInvoke },
  path: { homeDir: vi.fn().mockResolvedValue('/Users/testuser') },
  dialog: { open: vi.fn() },
  event: {
    listen: vi.fn().mockImplementation(async (event, handler) => {
      _tauriListeners[event] = handler;
      return () => {};
    }),
  },
};

// ── Module loader ─────────────────────────────────────────────────────────────

function mountMinimalDOM() {
  document.body.innerHTML = `
    <div id="voice-log"></div>
    <div id="vexil-log"></div>
    <div id="attachments-panel"></div>
    <div id="omi-indicator"></div>
    <button id="always-on-btn"></button>
    <div id="settings-panel" class="hidden"></div>
    <button id="settings-btn"></button>
    <button id="voice-source-ble"></button>
    <button id="voice-source-mic"></button>
    <div id="oracle-pre-chat" class="hidden"></div>
    <input id="oracle-input" />
    <button id="oracle-send"></button>
    <div id="oracle-chat-log"></div>
    <div id="vexil-bio" class="hidden">
      <span class="vexil-bio-name"></span>
      <span class="vexil-bio-type"></span>
    </div>
  `;
}

class MockAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._channel = new Float32Array(length);
  }
  copyToChannel(samples, channel, offset) {
    this._channel.set(samples, offset || 0);
  }
}

class MockAudioNode {
  constructor(ctx) {
    this._ctx = ctx;
    this.buffer = null;
  }
  connect() {}
  start(at) {
    this._ctx._started.push({ at, duration: this.buffer?.duration ?? 0 });
  }
}

class MockGainNode {
  constructor() {
    this.gain = { value: 1 };
  }
  connect() {}
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    this._started = [];
    MockAudioContext.instances.push(this);
  }
  createBuffer(channels, length, sampleRate) {
    return new MockAudioBuffer(channels, length, sampleRate);
  }
  createBufferSource() {
    return new MockAudioNode(this);
  }
  createGain() {
    return new MockGainNode();
  }
  close() {
    this.state = 'closed';
  }
}
MockAudioContext.instances = [];

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    MockWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
  _open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }
  _message(payload) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
  }
}
MockWebSocket.instances = [];

function installWSAndAudioMocks() {
  globalThis.WebSocket = MockWebSocket;
  window.AudioContext = MockAudioContext;
  window.webkitAudioContext = MockAudioContext;
}

async function flushAsync(times = 4) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function loadVoice() {
  mountMinimalDOM();
  const domMod = await import('../src/dom.js');
  domMod.initDOM();
  const mod = await import('../src/voice.js?t=' + Math.random());
  return mod;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  _mockInvoke.mockResolvedValue(null);
  MockWebSocket.instances.length = 0;
  MockAudioContext.instances.length = 0;
  for (const k of Object.keys(_tauriListeners)) delete _tauriListeners[k];
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.WebSocket = _originalWebSocket;
  window.AudioContext = _originalAudioContext;
  window.webkitAudioContext = _originalWebkitAudioContext;
  document.body.innerHTML = '';
  import('../src/session.js').then(m => {
    m.sessions.clear();
    m.setActiveSessionId(null);
  });
});

// ── isSettingsOpen / setSettingsOpen ──────────────────────────────────────────

test('isSettingsOpen returns false by default', async () => {
  const mod = await loadVoice();
  expect(mod.isSettingsOpen()).toBe(false);
});

test('setSettingsOpen toggles the value', async () => {
  const mod = await loadVoice();
  mod.setSettingsOpen(true);
  expect(mod.isSettingsOpen()).toBe(true);
  mod.setSettingsOpen(false);
  expect(mod.isSettingsOpen()).toBe(false);
});

// ── initVoice: does not throw ─────────────────────────────────────────────────

test('initVoice completes without throwing', async () => {
  const mod = await loadVoice();
  expect(() => mod.initVoice()).not.toThrow();
});

test('initVoice calls get_voice_status on startup', async () => {
  const mod = await loadVoice();
  _mockInvoke.mockClear();
  mod.initVoice();
  await Promise.resolve();
  const calls = _mockInvoke.mock.calls.map(c => c[0]);
  expect(calls).toContain('get_voice_status');
});

// ── omi:connected event ───────────────────────────────────────────────────────

test('omi:connected event updates indicator title', async () => {
  const mod = await loadVoice();
  mod.initVoice();
  await Promise.resolve();

  const indicator = document.getElementById('omi-indicator');
  expect(indicator).toBeTruthy();

  // Fire the omi:connected event
  if (_tauriListeners['omi:connected']) {
    _tauriListeners['omi:connected']({});
    await Promise.resolve();
    expect(indicator.title).toContain('Voice connected');
  }
});

test('omi:connected does not broadcast default trigger_mode to STT sidecar', async () => {
  const mod = await loadVoice();
  mod.initVoice();
  await Promise.resolve();
  _mockInvoke.mockClear();

  _tauriListeners['omi:connected']?.({});

  expect(_mockInvoke).toHaveBeenCalledWith('set_omi_listening', { enabled: true });
  expect(_mockInvoke).not.toHaveBeenCalledWith('set_voice_mode', { mode: 'trigger_mode' });
});

test('omi:disconnected event updates indicator title', async () => {
  const mod = await loadVoice();
  mod.initVoice();
  await Promise.resolve();

  const indicator = document.getElementById('omi-indicator');

  if (_tauriListeners['omi:connected']) _tauriListeners['omi:connected']({});
  if (_tauriListeners['omi:disconnected']) {
    _tauriListeners['omi:disconnected']({});
    await Promise.resolve();
    expect(indicator.title).toContain('disconnected');
  }
});

test('omi:command transcript entries render in the voice log', async () => {
  const mod = await loadVoice();
  mod.initVoice();
  await Promise.resolve();

  _tauriListeners['omi:connected']?.({});
  _tauriListeners['omi:command']?.({
    payload: {
      type: 'transcript',
      text: 'testing the microphone',
      ts: '12:34:56',
      dispatched: false,
    },
  });

  expect(document.getElementById('voice-log').textContent).toContain('testing the microphone');
});

test('dispatched transcript is submitted to oracle', async () => {
  const mod = await loadVoice();
  _mockInvoke.mockResolvedValue({ msg: 'oracle response' });
  mod.initVoice();
  await Promise.resolve();
  _mockInvoke.mockClear();

  _tauriListeners['omi:connected']?.({});
  _tauriListeners['omi:command']?.({
    payload: {
      type: 'transcript',
      text: 'open the active project',
      ts: '12:34:56',
      dispatched: true,
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(_mockInvoke).toHaveBeenCalledWith('oracle_query', expect.objectContaining({
    message: 'open the active project',
  }));
});

test('full voice transcript flow logs, submits to oracle, renders reply, and starts TTS', async () => {
  installWSAndAudioMocks();
  localStorage.setItem('ttsEnabled', '1');
  const mod = await loadVoice();
  _mockInvoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'oracle_query') {
      expect(args).toMatchObject({
        message: 'summarize the current terminal state',
        history: [],
        sessions: [],
      });
      expect(args.reqId).toEqual(expect.any(Number));
      return { msg: 'Oracle reply: no active session yet.' };
    }
    return null;
  });

  mod.initVoice();
  await flushAsync();
  _mockInvoke.mockClear();

  _tauriListeners['omi:connected']?.({});
  _tauriListeners['omi:command']?.({
    payload: {
      type: 'transcript',
      text: 'summarize the current terminal state',
      ts: '09:10:11',
      dispatched: true,
    },
  });

  await flushAsync();

  expect(document.getElementById('voice-log').textContent)
    .toContain('[09:10:11] summarize the current terminal state');
  expect(_mockInvoke).toHaveBeenCalledWith('oracle_query', expect.objectContaining({
    message: 'summarize the current terminal state',
  }));

  const oracleLog = document.getElementById('oracle-chat-log');
  expect(oracleLog.querySelector('.oracle-user-msg')?.textContent)
    .toBe('summarize the current terminal state');
  const reply = oracleLog.querySelector('.vexil-entry--buddy');
  expect(reply?.textContent).toContain('Oracle reply: no active session yet.');
  expect(reply?.dataset.msg).toBe('Oracle reply: no active session yet.');

  const ws = MockWebSocket.instances.find((socket) => socket.url === 'ws://127.0.0.1:9877');
  expect(ws, 'oracle response should create the TTS websocket').toBeTruthy();
  ws._open();
  expect(ws.sent[0]).toMatchObject({ type: 'hello', protocol: 'voice/v1', role: 'tts-consumer' });
  ws._message({ type: 'ready', sample_rate: 24000, channels: 1, encoding: 'pcm_s16le' });
  await flushAsync();
  expect(ws.sent.find((frame) => frame.type === 'speak')).toMatchObject({
    text: 'Oracle reply: no active session yet.',
    voice: 'en_GB-alba-medium',
  });
});

test('oracle reply from typed pre-chat renders as a sendable UI entry', async () => {
  localStorage.setItem('ttsEnabled', '0');
  const mod = await loadVoice();
  _mockInvoke.mockImplementation(async (cmd) => {
    if (cmd === 'oracle_query') return { msg: '<b>render safely</b>' };
    return null;
  });
  mod.initVoice();
  await flushAsync();

  const input = document.getElementById('oracle-input');
  input.value = 'render the voice model response';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flushAsync();

  const oracleLog = document.getElementById('oracle-chat-log');
  const reply = oracleLog.querySelector('.vexil-entry--buddy.has-send');
  expect(reply).toBeTruthy();
  expect(reply.dataset.msg).toBe('<b>render safely</b>');
  expect(reply.innerHTML).toContain('&lt;b&gt;render safely&lt;/b&gt;');
  expect(reply.querySelector('.send-overlay button')?.textContent).toContain('SEND TO CLAUDE');
});

test('voice:stopped sidecar disconnect clears connected state and suppresses transcript log rendering', async () => {
  const mod = await loadVoice();
  mod.initVoice();
  await flushAsync();

  const indicator = document.getElementById('omi-indicator');
  _tauriListeners['omi:connected']?.({});
  expect(indicator.classList.contains('connected')).toBe(true);

  _tauriListeners['voice:stopped']?.({});
  expect(indicator.classList.contains('connected')).toBe(false);
  expect(indicator.title).toContain('disconnected');

  _tauriListeners['omi:command']?.({
    payload: {
      type: 'transcript',
      text: 'do not render while sidecar is stopped',
      ts: '10:00:00',
      dispatched: false,
    },
  });
  expect(document.getElementById('voice-log').textContent).not.toContain('do not render');
});

test('voice:permission_denied surfaces microphone permission status without invoking oracle', async () => {
  vi.useFakeTimers();
  const mod = await loadVoice();
  mod.initVoice();
  await flushAsync();
  _mockInvoke.mockClear();

  const indicator = document.getElementById('omi-indicator');
  const previous = indicator.title;
  _tauriListeners['voice:permission_denied']?.({});

  expect(indicator.title).toBe('Microphone permission needed');
  expect(_mockInvoke).not.toHaveBeenCalledWith('oracle_query', expect.anything());

  vi.advanceTimersByTime(2500);
  expect(indicator.title).toBe(previous);
});

test('oracle timeout rejection removes thinking state and renders unreachable status', async () => {
  localStorage.setItem('ttsEnabled', '0');
  const mod = await loadVoice();
  _mockInvoke.mockImplementation(async (cmd) => {
    if (cmd === 'oracle_query') throw new Error('timeout');
    return null;
  });
  const idleSpy = vi.fn();
  document.addEventListener('oracle:idle', idleSpy);
  mod.initVoice();
  await flushAsync();

  _tauriListeners['omi:command']?.({
    payload: {
      type: 'transcript',
      text: 'this oracle call times out',
      ts: '11:22:33',
      dispatched: true,
    },
  });
  await flushAsync();

  expect(document.body.dataset.oracleThinking).toBeUndefined();
  expect(idleSpy).toHaveBeenCalledTimes(1);
  expect(document.getElementById('oracle-chat-log').textContent).toContain('(oracle unreachable)');
});

test('voice source switch BLE reverts to mic when IPC fails', async () => {
  localStorage.setItem('voiceSource', 'mic');
  const mod = await loadVoice();
  _mockInvoke.mockImplementation(async (cmd) => {
    if (cmd === 'switch_voice_source') throw new Error('BLE unavailable');
    return null;
  });
  mod.initVoice();
  await flushAsync();
  _mockInvoke.mockClear();

  document.getElementById('settings-btn').click();
  document.getElementById('voice-source-ble').click();
  expect(localStorage.getItem('voiceSource')).toBe('ble');
  expect(document.getElementById('voice-source-ble').classList.contains('active')).toBe(true);

  await flushAsync();

  expect(_mockInvoke).toHaveBeenCalledWith('switch_voice_source', { source: 'ble' });
  expect(localStorage.getItem('voiceSource')).toBe('mic');
  expect(document.getElementById('voice-source-mic').classList.contains('active')).toBe(true);
  expect(document.getElementById('voice-log').textContent).toContain('Voice source switch failed; restored Mac mic.');
});

// ── Oracle pre-chat visibility ───────────────────────────────────────────────

function oraclePreChat() {
  return document.getElementById('oracle-pre-chat');
}

function addHybridPanel(enabled = false) {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="vexil-panel" class="${enabled ? 'hybrid-split' : ''}"></div>`
  );
}

async function clearActiveSession() {
  const session = await import('../src/session.js');
  session.setActiveSessionId(null);
}

async function setActiveSession(id = 'test-session') {
  const session = await import('../src/session.js');
  session.setActiveSessionId(id);
}

test('oracle pre-chat has hidden removed on init when on vexil tab with no session', async () => {
  await clearActiveSession();
  const mod = await loadVoice();

  mod.initVoice();

  expect(oraclePreChat().classList.contains('hidden')).toBe(false);
});

test('vexil bio is visible on init when legacy voice tabs are absent', async () => {
  await clearActiveSession();
  const mod = await loadVoice();

  mod.initVoice();

  expect(document.getElementById('vexil-bio').classList.contains('hidden')).toBe(false);
});

test('pixel:vexil-tab-changed with files tab adds hidden to oracle pre-chat', async () => {
  await clearActiveSession();
  const mod = await loadVoice();
  mod.initVoice();

  document.dispatchEvent(new CustomEvent('pixel:vexil-tab-changed', { detail: { tab: 'files' } }));

  expect(oraclePreChat().classList.contains('hidden')).toBe(true);
});

test('pixel:vexil-tab-changed with vexil tab and no session removes hidden from oracle pre-chat', async () => {
  await clearActiveSession();
  const mod = await loadVoice();
  mod.initVoice();

  oraclePreChat().classList.add('hidden');
  document.dispatchEvent(new CustomEvent('pixel:vexil-tab-changed', { detail: { tab: 'vexil' } }));

  expect(oraclePreChat().classList.contains('hidden')).toBe(false);
});

test('pixel:session-changed keeps oracle pre-chat visible when session is active', async () => {
  await clearActiveSession();
  const mod = await loadVoice();
  mod.initVoice();

  await setActiveSession();
  document.dispatchEvent(new CustomEvent('pixel:session-changed', { detail: { id: 'test-session' } }));

  expect(oraclePreChat().classList.contains('hidden')).toBe(false);
});

test('pixel:hybrid-toggle with enabled true removes hidden even if session exists', async () => {
  await setActiveSession();
  const mod = await loadVoice();
  addHybridPanel(false);
  mod.initVoice();

  oraclePreChat().classList.add('hidden');
  document.getElementById('vexil-panel').classList.add('hybrid-split');
  document.dispatchEvent(new CustomEvent('pixel:hybrid-toggle', { detail: { enabled: true } }));

  expect(oraclePreChat().classList.contains('hidden')).toBe(false);
});

test('pixel:hybrid-toggle with enabled false re-evaluates normal oracle pre-chat visibility', async () => {
  await setActiveSession();
  const mod = await loadVoice();
  addHybridPanel(true);
  mod.initVoice();
  expect(oraclePreChat().classList.contains('hidden')).toBe(false);

  document.getElementById('vexil-panel').classList.remove('hybrid-split');
  document.dispatchEvent(new CustomEvent('pixel:hybrid-toggle', { detail: { enabled: false } }));
  expect(oraclePreChat().classList.contains('hidden')).toBe(false);

  await clearActiveSession();
  document.dispatchEvent(new CustomEvent('pixel:hybrid-toggle', { detail: { enabled: false } }));
  expect(oraclePreChat().classList.contains('hidden')).toBe(false);
});

// ── Regression: TTS default-ON ────────────────────────────────────────────────
//
// Today's bug: _ttsEnabled() defaulted to FALSE, so playTTS() early-returned
// for every Vexil response. Even after we replaced the broken stub backend with
// real Qwen, no audio reached the user. Default must be ON; opt-out only via
// localStorage.ttsEnabled === '0'.

test('playTTS speaks by default when ttsEnabled localStorage is unset (regression: silent Vexil)', async () => {
  installWSAndAudioMocks();
  localStorage.removeItem('ttsEnabled');
  const mod = await loadVoice();
  mod.initVoice();
  await flushAsync();

  MockWebSocket.instances.length = 0;
  mod.playTTS('Hello from the oracle.');
  await flushAsync();

  // playTTS only opens a WebSocket when _ttsEnabled() returns true.
  // Default (localStorage unset) must speak.
  const ws = MockWebSocket.instances.find((s) => s.url === 'ws://127.0.0.1:9877');
  expect(ws, 'default-ON: TTS websocket should be created when ttsEnabled is unset').toBeTruthy();
});

test('playTTS does NOT speak when ttsEnabled is explicitly disabled (opt-out path)', async () => {
  installWSAndAudioMocks();
  localStorage.setItem('ttsEnabled', '0');
  const mod = await loadVoice();
  mod.initVoice();
  await flushAsync();

  MockWebSocket.instances.length = 0;
  mod.playTTS('Should be silent.');
  await flushAsync();

  const ws = MockWebSocket.instances.find((s) => s.url === 'ws://127.0.0.1:9877');
  expect(ws, 'opt-out: ttsEnabled=0 must prevent TTS websocket creation').toBeUndefined();
});

test('playTTS speaks when ttsEnabled is explicitly enabled', async () => {
  installWSAndAudioMocks();
  localStorage.setItem('ttsEnabled', '1');
  const mod = await loadVoice();
  mod.initVoice();
  await flushAsync();

  MockWebSocket.instances.length = 0;
  mod.playTTS('Explicit ON.');
  await flushAsync();

  const ws = MockWebSocket.instances.find((s) => s.url === 'ws://127.0.0.1:9877');
  expect(ws, 'explicit ON: TTS websocket should be created').toBeTruthy();
});

// ── Regression: omi-indicator click checks sidecar health ─────────────────────
//
// Today's bug: click handler early-returned when omiConnected was true (e.g.
// because the OmiWebhook cloud bridge briefly connected) without checking
// whether the LOCAL anima-stt sidecar was actually running. User clicks expecting
// a restart, gets nothing. Fix: invoke voice_sidecar_health and only early-return
// if BOTH omiConnected AND stt_running.

test('omi-indicator click invokes voice_sidecar_health before deciding to start', async () => {
  const mod = await loadVoice();
  mod.initVoice();
  await Promise.resolve();
  _mockInvoke.mockClear();
  _mockInvoke.mockImplementation(async (cmd) => {
    if (cmd === 'voice_sidecar_health') return { stt_running: false, tts_running: false, stt_port_open: false, tts_port_open: false };
    return null;
  });

  document.getElementById('omi-indicator').click();
  // Allow the async click handler to resolve.
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));

  const calls = _mockInvoke.mock.calls.map(c => c[0]);
  expect(calls).toContain('voice_sidecar_health');
});

test('omi-indicator click triggers start_voice_sidecar when health says STT not running', async () => {
  const mod = await loadVoice();
  mod.initVoice();
  await Promise.resolve();

  // Simulate prior omi:connected event flipping omiConnected=true (stale state).
  _tauriListeners['omi:connected']?.({});
  await Promise.resolve();

  _mockInvoke.mockClear();
  _mockInvoke.mockImplementation(async (cmd) => {
    if (cmd === 'voice_sidecar_health') return { stt_running: false };
    return null;
  });

  document.getElementById('omi-indicator').click();
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));

  const calls = _mockInvoke.mock.calls.map(c => c[0]);
  expect(calls).toContain('start_voice_sidecar');
});

test('omi-indicator click DOES NOT restart when omi connected AND stt actually running', async () => {
  const mod = await loadVoice();
  mod.initVoice();
  await Promise.resolve();

  _tauriListeners['omi:connected']?.({});
  await Promise.resolve();

  _mockInvoke.mockClear();
  _mockInvoke.mockImplementation(async (cmd) => {
    if (cmd === 'voice_sidecar_health') return { stt_running: true };
    return null;
  });

  document.getElementById('omi-indicator').click();
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));

  const calls = _mockInvoke.mock.calls.map(c => c[0]);
  expect(calls).toContain('voice_sidecar_health');
  expect(calls).not.toContain('start_voice_sidecar');
});
