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
    <div id="btn-clear-voice-log"></div>
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

async function loadVoice() {
  mountMinimalDOM();
  const domMod = await import('../src/dom.js');
  domMod.initDOM();
  const mod = await import('../src/voice.js?t=' + Math.random());
  return mod;
}

beforeEach(() => {
  vi.clearAllMocks();
  _mockInvoke.mockResolvedValue(null);
});

afterEach(() => {
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

// ── Oracle pre-chat visibility ───────────────────────────────────────────────

function oraclePreChat() {
  return document.getElementById('oracle-pre-chat');
}

function setActiveVoiceTab(tab) {
  document.querySelectorAll('.voice-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.vtab === tab);
  });
}

function addVoiceTabs(active = 'vexil') {
  document.body.insertAdjacentHTML('beforeend', `
    <button class="voice-tab" data-vtab="vexil"></button>
    <button class="voice-tab" data-vtab="files"></button>
  `);
  setActiveVoiceTab(active);
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

test('oracle pre-chat keeps hidden on init when on non-vexil tab', async () => {
  await clearActiveSession();
  const mod = await loadVoice();

  document.addEventListener('pixel:vexil-tab-changed', () => addVoiceTabs('files'), { once: true });
  mod.initVoice();

  expect(oraclePreChat().classList.contains('hidden')).toBe(true);
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

test('pixel:session-changed adds hidden to oracle pre-chat when session is active', async () => {
  await clearActiveSession();
  const mod = await loadVoice();
  mod.initVoice();

  await setActiveSession();
  document.dispatchEvent(new CustomEvent('pixel:session-changed', { detail: { id: 'test-session' } }));

  expect(oraclePreChat().classList.contains('hidden')).toBe(true);
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
  addVoiceTabs('vexil');
  addHybridPanel(true);
  mod.initVoice();
  expect(oraclePreChat().classList.contains('hidden')).toBe(false);

  document.getElementById('vexil-panel').classList.remove('hybrid-split');
  document.dispatchEvent(new CustomEvent('pixel:hybrid-toggle', { detail: { enabled: false } }));
  expect(oraclePreChat().classList.contains('hidden')).toBe(true);

  await clearActiveSession();
  setActiveVoiceTab('vexil');
  document.dispatchEvent(new CustomEvent('pixel:hybrid-toggle', { detail: { enabled: false } }));
  expect(oraclePreChat().classList.contains('hidden')).toBe(false);
});
