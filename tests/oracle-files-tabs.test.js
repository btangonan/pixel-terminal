// Exercises: /Users/bradleytangonan/Projects/pixel-terminal/src/index.html (tab markup) +
//            /Users/bradleytangonan/Projects/pixel-terminal/src/voice.js (initVexilTabs / showTab)
// Failure trigger: removing the #voice-log-header tab strip from index.html, or breaking
//                  voice.js's tab-switch wiring so clicking ORACLE/FILES no longer toggles
//                  the oracle-chat-log / vexil-log / attachments-panel visibility.
// Mocked boundaries (only): Tauri shell/core/event APIs (not present in JSDOM)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INDEX_HTML_PATH = resolve(__dirname, '..', 'src', 'index.html');

// ── Tauri shim (voice.js imports require window.__TAURI__) ────────────────────

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

const _originalWebSocket = globalThis.WebSocket;
class StubWebSocket {
  constructor() { this.readyState = 0; }
  send() {}
  close() { this.readyState = 3; }
}

function mountTabStripDOM() {
  document.body.innerHTML = `
    <div id="vexil-panel">
      <div id="voice-log-header">
        <div id="voice-log-tabs">
          <button class="voice-tab active" id="vexil-tab-btn" data-vtab="vexil">ORACLE</button>
          <button class="voice-tab" data-vtab="files">FILES</button>
        </div>
        <button id="btn-clear-voice-log" title="Clear log">CLR</button>
      </div>
      <button id="omi-indicator"></button>
      <div id="vexil-bio" class="vexil-bio">
        <div id="vexil-ascii"></div>
        <div class="vexil-bio-text">
          <div class="vexil-bio-name"></div>
          <div class="vexil-bio-type"></div>
        </div>
      </div>
      <div id="voice-log" class="hidden"></div>
      <div id="oracle-chat-log"></div>
      <div id="vexil-log"></div>
      <div id="oracle-pre-chat" class="hidden">
        <input id="oracle-input" />
        <button id="oracle-send"></button>
      </div>
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

// ── Structural test: tab strip MUST exist in production index.html ────────────

test('production index.html ships the ORACLE/FILES tab strip inside #vexil-panel', () => {
  const html = readFileSync(INDEX_HTML_PATH, 'utf8');

  expect(html).toContain('id="voice-log-header"');
  expect(html).toContain('id="voice-log-tabs"');
  expect(html).toMatch(/data-vtab="vexil"[^>]*>ORACLE</);
  expect(html).toMatch(/data-vtab="files"[^>]*>FILES</);
  expect(html).toContain('id="btn-clear-voice-log"');
});

test('tab strip lives inside #vexil-panel (not orphaned)', () => {
  const html = readFileSync(INDEX_HTML_PATH, 'utf8');
  const panelStart = html.indexOf('id="vexil-panel"');
  const panelEnd = html.indexOf('</div>', html.indexOf('id="attachments-panel"'));
  const headerIdx = html.indexOf('id="voice-log-header"');

  expect(panelStart).toBeGreaterThan(-1);
  expect(headerIdx).toBeGreaterThan(panelStart);
  expect(headerIdx).toBeLessThan(panelEnd);
});

// ── Runtime test: clicking FILES/ORACLE toggles visibility correctly ──────────

test('clicking FILES tab hides oracle log and shows attachments panel', async () => {
  mountTabStripDOM();
  const domMod = await import('../src/dom.js');
  domMod.initDOM();
  const voiceMod = await import('../src/voice.js?t=' + Math.random());
  voiceMod.initVoice();

  const oracleLog = document.getElementById('oracle-chat-log');
  const vexilLog = document.getElementById('vexil-log');
  const attachmentsPanel = document.getElementById('attachments-panel');
  const filesTab = document.querySelector('[data-vtab="files"]');
  const oracleTab = document.querySelector('[data-vtab="vexil"]');

  expect(filesTab).not.toBeNull();
  expect(oracleTab).not.toBeNull();
  expect(attachmentsPanel.classList.contains('hidden')).toBe(true);

  filesTab.click();

  expect(filesTab.classList.contains('active')).toBe(true);
  expect(oracleTab.classList.contains('active')).toBe(false);
  expect(attachmentsPanel.classList.contains('hidden')).toBe(false);
  expect(vexilLog.classList.contains('hidden')).toBe(true);
});

test('clicking ORACLE tab restores oracle view and hides attachments', async () => {
  mountTabStripDOM();
  const domMod = await import('../src/dom.js');
  domMod.initDOM();
  const voiceMod = await import('../src/voice.js?t=' + Math.random());
  voiceMod.initVoice();

  const filesTab = document.querySelector('[data-vtab="files"]');
  const oracleTab = document.querySelector('[data-vtab="vexil"]');
  const attachmentsPanel = document.getElementById('attachments-panel');
  const vexilLog = document.getElementById('vexil-log');

  filesTab.click();
  expect(attachmentsPanel.classList.contains('hidden')).toBe(false);

  oracleTab.click();

  expect(oracleTab.classList.contains('active')).toBe(true);
  expect(filesTab.classList.contains('active')).toBe(false);
  expect(attachmentsPanel.classList.contains('hidden')).toBe(true);
  expect(vexilLog.classList.contains('hidden')).toBe(false);
});

test('hybrid-toggle button is NOT injected by tab restoration', () => {
  const html = readFileSync(INDEX_HTML_PATH, 'utf8');
  expect(html).not.toContain('btn-hybrid-toggle');
  expect(html).not.toMatch(/data-vtab="hybrid"/);
});
