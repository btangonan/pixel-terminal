// Exercises: /Users/bradleytangonan/Projects/pixel-terminal/src/voice.js (PTT keydown/keyup wiring)
//            /Users/bradleytangonan/Projects/pixel-terminal/src-tauri/src/ws_bridge.rs (replay contract)
// Failure trigger: re-introducing `if (!omiConnected) return` in the PTT keydown handler
//                  silently drops keypresses while STT is briefly disconnected, which defeats
//                  the ptt_active replay path in OmiBridgeState.send_initial_client_state.
// Mocked boundaries (only): Tauri core/event APIs (not present in JSDOM)

import { beforeEach, afterEach, test, expect, vi } from 'vitest';

const _tauriListeners = {};
const _mockInvoke = vi.fn().mockResolvedValue(null);

window.__TAURI__ = {
  shell: { Command: { create: vi.fn().mockReturnValue({
    stdout: { on: vi.fn() }, stderr: { on: vi.fn() },
    on: vi.fn(), spawn: vi.fn().mockResolvedValue({ write: vi.fn(), kill: vi.fn(), pid: 1 }),
    execute: vi.fn().mockResolvedValue({}),
  })}},
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

const _originalWebSocket = globalThis.WebSocket;
class StubWebSocket {
  constructor() { this.readyState = 0; }
  send() {}
  close() { this.readyState = 3; }
}

function mountDOM() {
  document.body.innerHTML = `
    <div id="vexil-panel">
      <div id="voice-log-header">
        <div id="voice-log-tabs">
          <button class="voice-tab active" id="vexil-tab-btn" data-vtab="vexil">ORACLE</button>
          <button class="voice-tab" data-vtab="files">FILES</button>
        </div>
        <button id="btn-clear-voice-log"></button>
      </div>
      <button id="omi-indicator"></button>
      <div id="vexil-bio"><div id="vexil-ascii"></div>
        <div class="vexil-bio-text"><div class="vexil-bio-name"></div><div class="vexil-bio-type"></div></div>
      </div>
      <div id="voice-log" class="hidden"></div>
      <div id="oracle-chat-log"></div>
      <div id="vexil-log"></div>
      <div id="oracle-pre-chat" class="hidden"><input id="oracle-input" /><button id="oracle-send"></button></div>
      <div id="attachments-panel" class="hidden"></div>
    </div>
    <button id="always-on-btn"></button>
    <div id="settings-panel" class="hidden"></div>
    <button id="settings-btn"></button>
    <button id="voice-source-ble"></button>
    <button id="voice-source-mic"></button>
  `;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  _mockInvoke.mockResolvedValue(null);
  globalThis.WebSocket = StubWebSocket;
  for (const k of Object.keys(_tauriListeners)) delete _tauriListeners[k];
});

afterEach(() => {
  globalThis.WebSocket = _originalWebSocket;
  document.body.innerHTML = '';
});

async function bootVoice() {
  mountDOM();
  const domMod = await import('../src/dom.js');
  domMod.initDOM();
  const voiceMod = await import('../src/voice.js?t=' + Math.random());
  voiceMod.initVoice();
  return voiceMod;
}

function fireFnKey(eventType) {
  const ev = new KeyboardEvent(eventType, { key: 'Fn', code: 'Fn', bubbles: true });
  document.dispatchEvent(ev);
}

// ── PTT replay contract: keydown invokes ptt_start regardless of omi state ────

test('PTT keydown invokes ptt_start even when omi is NOT connected (replay contract)', async () => {
  await bootVoice();
  // Default state: omiConnected = false, omiListening = true (no omi:connected ever fired)
  expect(_mockInvoke).not.toHaveBeenCalledWith('ptt_start');

  fireFnKey('keydown');

  expect(_mockInvoke).toHaveBeenCalledWith('ptt_start');
});

test('PTT keyup invokes ptt_release after a keydown while disconnected', async () => {
  await bootVoice();

  fireFnKey('keydown');
  fireFnKey('keyup');

  expect(_mockInvoke).toHaveBeenCalledWith('ptt_start');
  expect(_mockInvoke).toHaveBeenCalledWith('ptt_release');
});

test('PTT keydown still works after a connect → disconnect cycle (real flap scenario)', async () => {
  await bootVoice();

  // Sidecar connects, then disconnects — the live-log flapping pattern
  _tauriListeners['omi:connected']?.({ payload: {} });
  _tauriListeners['omi:disconnected']?.({ payload: {} });

  _mockInvoke.mockClear();
  fireFnKey('keydown');

  expect(_mockInvoke).toHaveBeenCalledWith('ptt_start');
});

test('keydown auto-repeat does not double-invoke ptt_start', async () => {
  await bootVoice();

  fireFnKey('keydown');
  fireFnKey('keydown');
  fireFnKey('keydown');

  const startCalls = _mockInvoke.mock.calls.filter(c => c[0] === 'ptt_start');
  expect(startCalls).toHaveLength(1);
});

test('non-PTT keys do not invoke ptt_start', async () => {
  await bootVoice();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));
  expect(_mockInvoke).not.toHaveBeenCalledWith('ptt_start');
});
