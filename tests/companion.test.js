/**
 * companion.test.js
 *
 * Tests for exported companion.js functions: getBuddyTrigger, isBuddyAnimal,
 * lint log state management (getLintLogForSession, clearLintLog, addToVexilLog),
 * and the anima gate response mapping (action → approved).
 *
 * DOM-heavy behavior (sprite rendering, polling intervals) is not tested here.
 */
import { beforeEach, afterEach, test, expect, vi } from 'vitest';

// ── Tauri shim ────────────────────────────────────────────────────────────────

const _mockInvoke = vi.fn();

window.__TAURI__ = {
  shell: { Command: { create: vi.fn().mockReturnValue({
    stdout: { on: vi.fn() }, stderr: { on: vi.fn() },
    on: vi.fn(), spawn: vi.fn().mockResolvedValue({ write: vi.fn(), kill: vi.fn(), pid: 1 }),
  }) } },
  core: { invoke: _mockInvoke },
  path: { homeDir: vi.fn().mockResolvedValue('/Users/testuser') },
  dialog: { open: vi.fn() },
  event: { listen: vi.fn().mockResolvedValue(() => {}) },
};

function installInvoke(buddyJson = null) {
  _mockInvoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'read_file_as_text') {
      const path = args?.path ?? '';
      if (path.endsWith('buddy.json') && buddyJson) return JSON.stringify(buddyJson);
      if (path.endsWith('vexil_lint.json')) throw new Error('no file');
      if (path.endsWith('vexil_ops_report.json')) throw new Error('no file');
      if (path.endsWith('vexil_master_out.jsonl')) throw new Error('no file');
      throw new Error('no such file: ' + path);
    }
    if (cmd === 'write_file_as_text') return null;
    if (cmd === 'js_log') return null;
    if (cmd === 'sync_buddy') return null;
    return null;
  });
}

// ── Module loader ─────────────────────────────────────────────────────────────

async function loadCompanion(buddyJson = null) {
  installInvoke(buddyJson);

  // Minimal DOM for initCompanion
  document.body.innerHTML = `
    <div id="companion-wrap" class="hidden"></div>
    <div id="vexil-ascii"></div>
    <div id="vexil-bio">
      <span class="vexil-bio-name"></span>
      <span class="vexil-bio-type"></span>
    </div>
    <div id="approval-overlay" class="hidden">
      <div id="approval-msg"></div>
      <button id="approval-ok"></button>
      <button id="approval-deny"></button>
    </div>
  `;

  const mod = await import('../src/companion.js?t=' + Math.random());
  return mod;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = '';
  import('../src/session.js').then(m => {
    m.sessions.clear();
    m.setActiveSessionId(null);
  });
});

// ── getBuddyTrigger ───────────────────────────────────────────────────────────

test('getBuddyTrigger returns "vexil " when buddy not loaded', async () => {
  const mod = await loadCompanion(null);
  // Before initCompanion, buddy is null → falls back to 'vexil'
  const trigger = mod.getBuddyTrigger();
  expect(trigger).toBe('vexil ');
});

test('getBuddyTrigger includes trailing space', async () => {
  const mod = await loadCompanion({ name: 'Athena', species: 'owl' });
  const trigger = mod.getBuddyTrigger();
  expect(trigger.endsWith(' ')).toBe(true);
});

// ── Lint log state management ─────────────────────────────────────────────────

test('getLintLogForSession returns empty array for unknown session', async () => {
  const mod = await loadCompanion();
  const log = mod.getLintLogForSession('nonexistent-session-id');
  expect(log).toEqual([]);
});

test('clearLintLog empties log for a session', async () => {
  const mod = await loadCompanion();
  const sessionMod = await import('../src/session.js');
  const id = 'clear-test-session';
  sessionMod.sessions.set(id, { status: 'idle', name: 'test' });
  sessionMod.setActiveSessionId(id);

  mod.addToVexilLog('vexil', 'hello from oracle');
  expect(mod.getLintLogForSession(id).length).toBeGreaterThan(0);

  mod.clearLintLog(id);
  expect(mod.getLintLogForSession(id)).toEqual([]);

  sessionMod.sessions.delete(id);
  sessionMod.setActiveSessionId(null);
});

test('addToVexilLog appends entry with state and msg to active session', async () => {
  const mod = await loadCompanion();
  const sessionMod = await import('../src/session.js');
  const id = 'log-append-test';
  sessionMod.sessions.set(id, { status: 'idle', name: 'test' });
  sessionMod.setActiveSessionId(id);

  mod.addToVexilLog('vexil', 'The real problem is upstream.');
  const log = mod.getLintLogForSession(id);
  expect(log.length).toBe(1);
  expect(log[0].state).toBe('vexil');
  expect(log[0].msg).toBe('The real problem is upstream.');
  expect(log[0].ts).toBeTruthy();

  sessionMod.sessions.delete(id);
  sessionMod.setActiveSessionId(null);
});

test('addToVexilLog does nothing when no active session', async () => {
  const mod = await loadCompanion();
  const sessionMod = await import('../src/session.js');
  sessionMod.setActiveSessionId(null);

  mod.addToVexilLog('vexil', 'should not appear');
  // No active session → addToLintLog returns early, no throw
  // Verify by checking that getLintLogForSession('anything') is still empty
  expect(mod.getLintLogForSession('any-id')).toEqual([]);
});

test('lint log caps at 100 entries per session', async () => {
  const mod = await loadCompanion();
  const sessionMod = await import('../src/session.js');
  const id = 'cap-test-session';
  sessionMod.sessions.set(id, { status: 'idle', name: 'test' });
  sessionMod.setActiveSessionId(id);

  for (let i = 0; i < 110; i++) {
    mod.addToVexilLog('vexil', `entry ${i}`);
  }
  const log = mod.getLintLogForSession(id);
  expect(log.length).toBe(100);

  sessionMod.sessions.delete(id);
  sessionMod.setActiveSessionId(null);
});

// ── isBuddyAnimal ─────────────────────────────────────────────────────────────

test('isBuddyAnimal returns false when buddy is not loaded', async () => {
  const mod = await loadCompanion(null);
  expect(mod.isBuddyAnimal('cat')).toBe(false);
});

// ── vexilLogListener ──────────────────────────────────────────────────────────

test('setVexilLogListener is called when addToVexilLog fires', async () => {
  const mod = await loadCompanion();
  const sessionMod = await import('../src/session.js');
  const id = 'listener-test';
  sessionMod.sessions.set(id, { status: 'idle', name: 'test' });
  sessionMod.setActiveSessionId(id);

  const received = [];
  mod.setVexilLogListener((entries) => received.push([...entries]));
  mod.addToVexilLog('vexil', 'test message');

  expect(received.length).toBeGreaterThan(0);
  expect(received[received.length - 1].some(e => e.msg === 'test message')).toBe(true);

  sessionMod.sessions.delete(id);
  sessionMod.setActiveSessionId(null);
});

test('deny + pause writes anima gate response and emits anima:pause-session', async () => {
  const sid = 'gate-session';
  const writes = [];
  _mockInvoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'read_file_as_text') {
      if (args.path.endsWith(`anima_gate_${sid}.json`)) {
        return JSON.stringify({
          id: 'req-123',
          tool: 'Bash',
          input: { command: 'rm -rf build' },
          expires: Math.floor(Date.now() / 1000) + 60,
        });
      }
      throw new Error('no such file');
    }
    if (cmd === 'write_file_as_text') {
      writes.push({ path: args.path, content: args.content });
      return null;
    }
    if (cmd === 'js_log') return null;
    return null;
  });
  document.body.innerHTML = '';
  const sessionMod = await import('../src/session.js');
  sessionMod.sessions.set(sid, { status: 'working', name: 'gate-test' });
  sessionMod.setActiveSessionId(sid);
  const mod = await import('../src/companion.js?t=' + Math.random());
  const pauseSpy = vi.fn();
  document.addEventListener('anima:pause-session', pauseSpy);

  await mod.__testOnlyPollAnimaGate();
  const denyPause = document.querySelector('[data-action="deny_pause"]');
  expect(denyPause).toBeTruthy();
  expect(document.getElementById('perm-tool')?.textContent).toBe('Bash');
  expect(document.getElementById('perm-summary')?.textContent).toContain('rm -rf build');

  denyPause.click();
  for (let i = 0; i < 8; i++) await Promise.resolve();

  const response = writes.find(w => w.path.endsWith(`anima_gate_${sid}_response.json`));
  expect(JSON.parse(response.content)).toEqual({
    id: 'req-123',
    approved: false,
    action: 'deny_pause',
  });
  expect(pauseSpy).toHaveBeenCalledTimes(1);
  expect(pauseSpy.mock.calls[0][0].detail).toEqual({ sessionId: sid });

  sessionMod.sessions.delete(sid);
  sessionMod.setActiveSessionId(null);
});

test('deny + pause event wiring kills the session child and reports idle status', async () => {
  const sid = 'gate-pause-integration';
  const writes = [];
  _mockInvoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'read_file_as_text') {
      if (args.path.endsWith(`anima_gate_${sid}.json`)) {
        return JSON.stringify({
          id: 'req-pause-1',
          tool: 'Bash',
          input: { command: 'deploy --prod' },
          expires: Math.floor(Date.now() / 1000) + 60,
        });
      }
      throw new Error('no such file');
    }
    if (cmd === 'write_file_as_text') {
      writes.push({ path: args.path, content: args.content });
      return null;
    }
    if (cmd === 'js_log') return null;
    return null;
  });

  document.body.innerHTML = '';
  const sessionMod = await import('../src/session.js');
  const lifecycle = await import('../src/session-lifecycle.js?t=' + Math.random());
  const child = { write: vi.fn(), kill: vi.fn(), pid: 777 };
  const deps = {
    renderSessionCard: vi.fn(),
    setActiveSession: vi.fn(),
    pushMessage: vi.fn(),
    setStatus: vi.fn(),
    handleEvent: vi.fn(),
    updateWorkingCursor: vi.fn(),
    showEmptyState: vi.fn(),
    slashCommands: [],
    hideSlashMenu: vi.fn(),
    exitHistoryView: vi.fn(),
    scanHistory: vi.fn(),
  };
  lifecycle.setLifecycleDeps(deps);
  sessionMod.sessions.set(sid, {
    id: sid,
    cwd: '/tmp/gate-project',
    name: 'gate-project',
    status: 'working',
    child,
    toolPending: { pending: true },
    _pendingQueue: [{ text: 'queued', shown: true }],
  });
  sessionMod.setActiveSessionId(sid);

  const pauseHandler = (e) => lifecycle.pauseSession(e.detail?.sessionId);
  document.addEventListener('anima:pause-session', pauseHandler);
  const mod = await import('../src/companion.js?t=' + Math.random());

  await mod.__testOnlyPollAnimaGate();
  document.querySelector('[data-action="deny_pause"]').click();
  for (let i = 0; i < 8; i++) await Promise.resolve();

  const response = writes.find(w => w.path.endsWith(`anima_gate_${sid}_response.json`));
  expect(JSON.parse(response.content)).toMatchObject({
    id: 'req-pause-1',
    approved: false,
    action: 'deny_pause',
  });
  const session = sessionMod.sessions.get(sid);
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(session.child).toBeNull();
  expect(session._paused).toBe(true);
  expect(session._pendingQueue).toEqual([]);
  expect(session.toolPending).toEqual({});
  expect(deps.setStatus).toHaveBeenCalledWith(sid, 'idle');
  expect(deps.pushMessage).toHaveBeenCalledWith(sid, expect.objectContaining({
    type: 'error',
    text: expect.stringContaining('Permission request denied and session paused'),
  }));

  document.removeEventListener('anima:pause-session', pauseHandler);
  sessionMod.sessions.delete(sid);
  sessionMod.setActiveSessionId(null);
});
