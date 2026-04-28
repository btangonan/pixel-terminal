import { beforeEach, afterEach, test, expect, vi } from 'vitest';

const mockInvoke = vi.fn();

function buildDOM() {
  document.body.innerHTML = `
    <div id="session-tabs">
      <button class="session-tab active" data-tab="live"></button>
      <button class="session-tab" data-tab="hist"></button>
    </div>
    <div id="session-list"></div>
    <div id="history-view" class="hidden"></div>
    <div id="history-current" class="hidden"></div>
    <div id="history-list"></div>
    <div id="history-search-wrap" class="hidden"></div>
    <input id="history-search" />
    <div id="history-find" class="hidden"></div>
    <input id="history-find-input" />
    <span id="history-find-status"></span>
    <button id="history-find-prev"></button>
    <button id="history-find-next"></button>
    <button id="history-find-close"></button>
    <div id="message-log"></div>
    <textarea id="msg-input"></textarea>
    <button id="btn-send"></button>
  `;
}

function makeEntry(overrides = {}) {
  return {
    session_id: 'history-alpha',
    file_path: '/Users/testuser/.claude/projects/app/history-alpha.jsonl',
    slug: 'Alpha Session',
    first_user_message: 'build search panel',
    timestamp_start: '2026-04-20T12:00:00Z',
    file_size: 2048,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  buildDOM();
  mockInvoke.mockReset();
  window.__TAURI__ = {
    core: { invoke: mockInvoke },
    shell: { Command: { create: vi.fn() } },
    path: { homeDir: vi.fn().mockResolvedValue('/Users/testuser') },
    event: { listen: vi.fn().mockResolvedValue(() => {}) },
    dialog: { open: vi.fn() },
  };
  window.requestAnimationFrame = vi.fn((cb) => cb());
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  delete window.__TAURI__;
});

async function loadHistoryModule() {
  const domMod = await import('../src/dom.js');
  domMod.initDOM();
  const mod = await import('../src/history.js?t=' + Math.random());
  const sessions = new Map([[
    'live-session',
    {
      id: 'live-session',
      name: 'live-app',
      status: 'idle',
      tokens: 1200,
      _liveTokens: 300,
      familiar: null,
    },
  ]]);
  const createMsgEl = vi.fn((msg) => {
    const el = document.createElement('div');
    el.className = `msg ${msg.type}`;
    el.textContent = msg.text || msg.toolName || '';
    return el;
  });
  const renderMessageLog = vi.fn();
  mod.setHistoryDeps({
    renderMessageLog,
    createMsgEl,
    sessions,
    getActiveSessionId: () => 'live-session',
  });
  mod.initHistory();
  return { mod, createMsgEl, renderMessageLog };
}

test('history search filters actual list and clicking a result restores that session read-only', async () => {
  const entries = [
    makeEntry({ session_id: 'history-alpha', slug: 'Alpha Session', first_user_message: 'build search panel' }),
    makeEntry({ session_id: 'history-beta', slug: 'Beta Session', first_user_message: 'fix renderer' }),
  ];
  const messages = [
    { msg_type: 'user', text: 'build search panel' },
    { msg_type: 'claude', text: 'done' },
  ];
  mockInvoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'scan_session_history') {
      expect(args).toEqual({ projectPath: '/Users/testuser/Projects/app' });
      return entries;
    }
    if (cmd === 'load_session_history') {
      expect(args).toEqual({ filePath: entries[0].file_path });
      return messages;
    }
    return null;
  });
  const { mod, createMsgEl } = await loadHistoryModule();

  await mod.scanHistory('/Users/testuser/Projects/app');
  expect([...document.querySelectorAll('.history-card-name')].map(el => el.textContent))
    .toEqual(['Alpha Session', 'Beta Session']);

  const search = document.getElementById('history-search');
  search.value = 'alpha';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(300);
  expect([...document.querySelectorAll('.history-card-name')].map(el => el.textContent))
    .toEqual(['Alpha Session']);

  document.querySelector('.history-card').click();
  await Promise.resolve();

  expect(mockInvoke).toHaveBeenCalledWith('load_session_history', { filePath: entries[0].file_path });
  expect(createMsgEl).toHaveBeenCalledWith({ type: 'user', text: 'build search panel' });
  expect(createMsgEl).toHaveBeenCalledWith({ type: 'claude', text: 'done' });
  expect(document.getElementById('message-log').textContent).toContain('build search panel');
  expect(document.getElementById('msg-input').disabled).toBe(true);
  expect(document.getElementById('msg-input').placeholder).toBe('read-only history');
  expect(document.getElementById('btn-send').disabled).toBe(true);

  mod.showHistoryTab();
  expect(document.getElementById('message-log').textContent).toContain('build search panel');
});
