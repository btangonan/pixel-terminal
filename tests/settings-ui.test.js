import { beforeEach, afterEach, test, expect, vi } from 'vitest';

async function getModule() {
  return import('../src/settings-ui.js?t=' + Math.random());
}

function mountDOM() {
  document.body.innerHTML = `
    <div id="settings-panel" class="hidden">
      <button id="perm-mode-bypass" class="source-btn"></button>
      <button id="perm-mode-default" class="source-btn"></button>
      <button id="perm-mode-gated" class="source-btn"></button>
    </div>
    <div id="confirm-overlay" class="hidden">
      <div id="confirm-msg"></div>
      <button id="confirm-ok"></button>
      <button id="confirm-cancel"></button>
    </div>
  `;
}

function installTauriShim(writes, reads = {}) {
  window.__TAURI__ = {
    core: {
      invoke: vi.fn(async (cmd, args) => {
        if (cmd === 'read_file_as_text') {
          const key = args?.path ?? '';
          if (reads[key] == null) throw new Error('no such file');
          return reads[key];
        }
        if (cmd === 'write_file_as_text') {
          writes.push({ path: args.path, content: args.content });
          return null;
        }
        if (cmd === 'js_log') return null;
        throw new Error('unexpected invoke: ' + cmd);
      }),
    },
  };
}

async function initWithDOM(initialMode) {
  mountDOM();
  // share the same dom.js module instance as settings-ui.js (don't cache-bust)
  const domMod = await import('../src/dom.js');
  domMod.initDOM();
  if (initialMode) window.__ANIMA_PERMISSION_MODE__ = initialMode;
  else delete window.__ANIMA_PERMISSION_MODE__;
  const { initSettingsUI } = await getModule();
  initSettingsUI();
}

afterEach(() => {
  document.body.innerHTML = '';
  delete window.__TAURI__;
  delete window.__ANIMA_PERMISSION_MODE__;
});

test('paints the current mode button as active on init', async () => {
  installTauriShim([]);
  await initWithDOM('gated');
  expect(document.getElementById('perm-mode-gated').classList.contains('active')).toBe(true);
  expect(document.getElementById('perm-mode-bypass').classList.contains('active')).toBe(false);
  expect(document.getElementById('perm-mode-default').classList.contains('active')).toBe(false);
});

test('falls back to default when window.__ANIMA_PERMISSION_MODE__ is unset or invalid', async () => {
  installTauriShim([]);
  await initWithDOM(undefined);
  expect(document.getElementById('perm-mode-default').classList.contains('active')).toBe(true);
  expect(document.getElementById('perm-mode-bypass').classList.contains('active')).toBe(false);
});

test('clicking DEFAULT from gated writes settings.json and updates global + active class', async () => {
  const writes = [];
  installTauriShim(writes);
  await initWithDOM('gated');
  document.getElementById('perm-mode-default').click();
  // click handler is async — flush microtasks
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(window.__ANIMA_PERMISSION_MODE__).toBe('default');
  expect(document.getElementById('perm-mode-default').classList.contains('active')).toBe(true);
  expect(document.getElementById('perm-mode-gated').classList.contains('active')).toBe(false);
  const write = writes.find(w => w.path.endsWith('settings.json'));
  expect(write).toBeTruthy();
  expect(JSON.parse(write.content).permissionMode).toBe('default');
});

test('clicking GATED from bypass writes settings.json (no confirmation required)', async () => {
  const writes = [];
  installTauriShim(writes);
  await initWithDOM('bypass');
  document.getElementById('perm-mode-gated').click();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(window.__ANIMA_PERMISSION_MODE__).toBe('gated');
  const write = writes.find(w => w.path.endsWith('settings.json'));
  expect(JSON.parse(write.content).permissionMode).toBe('gated');
});

test('clicking BYPASS from gated requires confirmation; cancel leaves mode unchanged', async () => {
  const writes = [];
  installTauriShim(writes);
  await initWithDOM('gated');
  document.getElementById('perm-mode-bypass').click();
  // confirmation overlay should now be visible
  expect(document.getElementById('confirm-overlay').classList.contains('hidden')).toBe(false);
  document.getElementById('confirm-cancel').click();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(window.__ANIMA_PERMISSION_MODE__).toBe('gated');
  expect(writes.some(w => w.path.endsWith('settings.json'))).toBe(false);
  expect(document.getElementById('perm-mode-gated').classList.contains('active')).toBe(true);
});

test('clicking BYPASS from gated with confirmation persists bypass mode', async () => {
  const writes = [];
  installTauriShim(writes);
  await initWithDOM('gated');
  document.getElementById('perm-mode-bypass').click();
  expect(document.getElementById('confirm-overlay').classList.contains('hidden')).toBe(false);
  document.getElementById('confirm-ok').click();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(window.__ANIMA_PERMISSION_MODE__).toBe('bypass');
  const write = writes.find(w => w.path.endsWith('settings.json'));
  expect(JSON.parse(write.content).permissionMode).toBe('bypass');
});

test('persist preserves other keys in settings.json', async () => {
  const writes = [];
  installTauriShim(writes, {
    '~/.config/pixel-terminal/settings.json': JSON.stringify({ otherKey: 'keep-me', permissionMode: 'gated' }),
  });
  await initWithDOM('gated');
  document.getElementById('perm-mode-default').click();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const write = writes.find(w => w.path.endsWith('settings.json'));
  const parsed = JSON.parse(write.content);
  expect(parsed.permissionMode).toBe('default');
  expect(parsed.otherKey).toBe('keep-me');
});

test('clicking the same mode does not write (no-op)', async () => {
  const writes = [];
  installTauriShim(writes);
  await initWithDOM('gated');
  document.getElementById('perm-mode-gated').click();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(writes.some(w => w.path.endsWith('settings.json'))).toBe(false);
});
