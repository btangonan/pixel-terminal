import { afterEach, test, expect, vi } from 'vitest';

function installTauriShim() {
  window.__TAURI__ = {
    shell: { Command: { create: vi.fn().mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      spawn: vi.fn().mockResolvedValue({ write: vi.fn(), kill: vi.fn(), pid: 1 }),
      execute: vi.fn().mockResolvedValue({ code: 1 }),
    }) } },
    core: { invoke: vi.fn().mockResolvedValue(null) },
    path: { homeDir: vi.fn().mockResolvedValue('/Users/testuser') },
    dialog: { open: vi.fn() },
    event: { listen: vi.fn().mockResolvedValue(() => {}) },
    opener: { revealItemInDir: vi.fn() },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

test('showEmptyState removes transient messages without wiping persistent empty-state node', async () => {
  installTauriShim();
  document.body.innerHTML = `
    <div id="message-log">
      <div id="empty-state">Start a session</div>
      <div class="msg user">temporary user text</div>
      <div class="working-cursor"></div>
      <div class="msg-new"></div>
    </div>
    <div id="session-prompt" class="hidden"></div>
  `;
  const domMod = await import('../src/dom.js');
  domMod.initDOM();
  const { showEmptyState } = await import('../src/cards.js?t=' + Math.random());

  showEmptyState();

  expect(document.getElementById('empty-state')?.textContent).toBe('Start a session');
  expect(document.querySelector('#message-log .msg')).toBeNull();
  expect(document.querySelector('#message-log .working-cursor')).toBeNull();
  expect(document.querySelector('#message-log .msg-new')).toBeNull();
  expect(document.body.classList.contains('no-session-active')).toBe(true);
  expect(document.getElementById('session-prompt').classList.contains('hidden')).toBe(false);
});
