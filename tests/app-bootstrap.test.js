import { afterEach, test, expect, vi } from 'vitest';

function installTauriShim(readResult) {
  window.__TAURI__ = {
    shell: { Command: { create: vi.fn().mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      spawn: vi.fn().mockResolvedValue({ write: vi.fn(), kill: vi.fn(), pid: 1 }),
      execute: vi.fn().mockResolvedValue({ code: 1 }),
    }) } },
    core: {
      invoke: vi.fn(async (cmd) => {
        if (cmd === 'read_file_as_text') {
          if (readResult instanceof Error) throw readResult;
          return readResult;
        }
        if (cmd === 'write_file_as_text') return null;
        if (cmd === 'js_log') return null;
        if (cmd === 'sync_buddy') return null;
        return null;
      }),
    },
    path: { homeDir: vi.fn().mockResolvedValue('/Users/testuser') },
    dialog: { open: vi.fn() },
    event: { listen: vi.fn().mockResolvedValue(() => {}) },
    opener: { openUrl: vi.fn(), revealItemInDir: vi.fn() },
    window: { getCurrentWindow: vi.fn(() => ({ onCloseRequested: vi.fn(), close: vi.fn() })) },
  };
}

afterEach(() => {
  delete window.__ANIMA_PERMISSION_MODE__;
  document.body.innerHTML = '';
});

test('hydratePermissionMode fails closed to default when settings JSON is unparsable', async () => {
  installTauriShim('{ this is not json');
  window.__ANIMA_PERMISSION_MODE__ = 'bypass';
  const { hydratePermissionMode } = await import('../src/app.js?t=' + Math.random());

  await expect(hydratePermissionMode()).resolves.toBe('default');
  expect(window.__ANIMA_PERMISSION_MODE__).toBe('default');
  expect(window.__TAURI__.core.invoke).toHaveBeenCalledWith('read_file_as_text', {
    path: '~/.config/pixel-terminal/settings.json',
  });
});

test('hydratePermissionMode accepts valid persisted gated mode', async () => {
  installTauriShim(JSON.stringify({ permissionMode: 'GATED' }));
  const { hydratePermissionMode } = await import('../src/app.js?t=' + Math.random());

  await expect(hydratePermissionMode()).resolves.toBe('gated');
  expect(window.__ANIMA_PERMISSION_MODE__).toBe('gated');
});
