/**
 * session-lifecycle.test.js
 *
 * Tests for spawnClaude permission-mode arg selection, close-handler gate-crash
 * reporting, builtin commands, getStaleSessionIds, and expandSlashCommand.
 *
 * Tauri shim is installed once at module level so all dependency modules
 * (session.js, companion.js, etc.) that capture window.__TAURI__ at load time
 * see a consistent spy object throughout the file.
 */
import { beforeEach, afterEach, test, expect, vi } from 'vitest';

// ── Persistent Tauri shim (set up before any module imports) ──────────────────

const _mockInvoke = vi.fn();
const _mockCreate = vi.fn();
const _mockHomeDir = vi.fn().mockResolvedValue('/Users/testuser');

let _mockCmd = null;
let _mockChild = null;
let _spawnedArgs = [];
let _capturedCloseHandler = null;
const _tauriListeners = {};

function resetMockProcess() {
  _spawnedArgs = [];
  _capturedCloseHandler = null;
  _mockChild = {
    write: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    pid: 1234,
  };
  _mockCmd = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((ev, fn) => { if (ev === 'close') _capturedCloseHandler = fn; }),
    spawn: vi.fn().mockResolvedValue(_mockChild),
  };
  _mockCreate.mockReturnValue(_mockCmd);
}

// Install shim before any module in the test file can import window.__TAURI__
window.__TAURI__ = {
  shell: { Command: { create: _mockCreate } },
  core: { invoke: _mockInvoke },
  path: { homeDir: _mockHomeDir },
  dialog: { open: vi.fn() },
  event: {
    listen: vi.fn().mockImplementation(async (event, handler) => {
      _tauriListeners[event] = handler;
      return () => { delete _tauriListeners[event]; };
    }),
  },
  opener: { revealItemInDir: vi.fn() },
};

// ── Default invoke mock ───────────────────────────────────────────────────────

function installDefaultInvoke({ circuitOpen = false, backoffMs = 0, gateSetupFails = false } = {}) {
  _mockInvoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'supervisor_circuit_state') {
      return { open: circuitOpen, backoffMs, crashes: circuitOpen ? 3 : 0 };
    }
    if (cmd === 'resolve_gate_binary') {
      if (gateSetupFails) throw new Error('gate binary not found');
      return { command: '/usr/local/bin/anima-gate', args: [], engine: 'rust' };
    }
    if (cmd === 'write_mcp_config') {
      return { path: '/tmp/anima_mcp_test.json', toolFlag: 'mcp__anima_abc12345__approve' };
    }
    if (cmd === 'supervisor_record_gate_crash') {
      return { open: false, crashes: 1 };
    }
    if (cmd === 'read_slash_commands') return [];
    if (cmd === 'read_file_as_text') throw new Error('file not found');
    if (cmd === 'write_file_as_text') return null;
    if (cmd === 'js_log') return null;
    if (cmd === 'sync_buddy') return null;
    return null;
  });
}

// ── Module loader ─────────────────────────────────────────────────────────────

async function loadLifecycle() {
  const sessionMod = await import('../src/session.js');
  const mod = await import('../src/session-lifecycle.js?t=' + Math.random());

  // Wire up minimal deps so spawnClaude doesn't throw on missing callbacks
  mod.setLifecycleDeps({
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
  });

  return { mod, sessionMod };
}

function makeSession(overrides = {}) {
  return {
    id: 'test-session-id',
    cwd: '/Users/testuser/Projects/myapp',
    name: 'myapp',
    status: 'idle',
    child: null,
    toolPending: {},
    readOnly: false,
    unread: false,
    tokens: 0,
    _nimTokensAccrued: 0,
    _liveTokens: 0,
    _dotsPhase: 0,
    _pendingQueue: [],
    _perfHistory: [],
    _turnStart: null,
    _ttft: null,
    lastActivityAt: Date.now(),
    _taskLedger: { userPrompt: '', tools: [], lastText: '' },
    familiar: { species: 'duck' },
    familiarHue: '#888',
    _familiarFrame: 0,
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  resetMockProcess();
  installDefaultInvoke();
  for (const k of Object.keys(_tauriListeners)) delete _tauriListeners[k];
  window.__ANIMA_PERMISSION_MODE__ = 'bypass';
  vi.clearAllMocks();
  resetMockProcess();
  installDefaultInvoke();
  for (const k of Object.keys(_tauriListeners)) delete _tauriListeners[k];
});

afterEach(() => {
  // Clean up sessions from each test
  import('../src/session.js').then(m => m.sessions.clear());
});

// ── warnIfUnknownCommand ──────────────────────────────────────────────────────

test('warnIfUnknownCommand always returns false (never blocks)', async () => {
  const { mod } = await loadLifecycle();
  expect(mod.warnIfUnknownCommand('test-id', '/unknowncommand')).toBe(false);
  expect(mod.warnIfUnknownCommand('test-id', '/another-unknown')).toBe(false);
  expect(mod.warnIfUnknownCommand('test-id', 'plain text')).toBe(false);
});

// ── expandSlashCommand ────────────────────────────────────────────────────────

test('expandSlashCommand returns text unchanged when no leading slash', async () => {
  const { mod } = await loadLifecycle();
  const result = await mod.expandSlashCommand('hello world');
  expect(result).toBe('hello world');
});

test('expandSlashCommand returns text unchanged for unknown command', async () => {
  const { mod } = await loadLifecycle();
  mod.setLifecycleDeps({ slashCommands: [], pushMessage: vi.fn(), renderSessionCard: vi.fn(), setActiveSession: vi.fn(), setStatus: vi.fn(), handleEvent: vi.fn(), updateWorkingCursor: vi.fn(), showEmptyState: vi.fn(), hideSlashMenu: vi.fn(), exitHistoryView: vi.fn(), scanHistory: vi.fn() });
  const result = await mod.expandSlashCommand('/unknownxyz some args');
  expect(result).toBe('/unknownxyz some args');
});

test('expandSlashCommand expands known command via read_slash_command_content', async () => {
  const expandedBody = 'Please do the thing thoroughly.\n\nBe specific.';
  _mockInvoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'read_slash_command_content' && args.name === 'myskill') return expandedBody;
    return null;
  });

  const { mod } = await loadLifecycle();
  mod.setLifecycleDeps({
    slashCommands: [{ name: 'myskill', description: 'does stuff' }],
    pushMessage: vi.fn(), renderSessionCard: vi.fn(), setActiveSession: vi.fn(),
    setStatus: vi.fn(), handleEvent: vi.fn(), updateWorkingCursor: vi.fn(),
    showEmptyState: vi.fn(), hideSlashMenu: vi.fn(), exitHistoryView: vi.fn(), scanHistory: vi.fn(),
  });

  const result = await mod.expandSlashCommand('/myskill');
  expect(result).toBe(expandedBody);
});

test('expandSlashCommand appends ARGUMENTS when args provided', async () => {
  const expandedBody = 'Do the thing.';
  _mockInvoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'read_slash_command_content') return expandedBody;
    return null;
  });

  const { mod } = await loadLifecycle();
  mod.setLifecycleDeps({
    slashCommands: [{ name: 'myskill', description: 'does stuff' }],
    pushMessage: vi.fn(), renderSessionCard: vi.fn(), setActiveSession: vi.fn(),
    setStatus: vi.fn(), handleEvent: vi.fn(), updateWorkingCursor: vi.fn(),
    showEmptyState: vi.fn(), hideSlashMenu: vi.fn(), exitHistoryView: vi.fn(), scanHistory: vi.fn(),
  });

  const result = await mod.expandSlashCommand('/myskill my arguments here');
  expect(result).toContain('ARGUMENTS: my arguments here');
  expect(result).toContain(expandedBody);
});

// ── getStaleSessionIds ────────────────────────────────────────────────────────

test('getStaleSessionIds excludes active session even if old', async () => {
  const { mod, sessionMod } = await loadLifecycle();
  const id = 'active-old-session';
  sessionMod.sessions.set(id, makeSession({ id, status: 'idle', lastActivityAt: Date.now() - 20 * 60 * 1000 }));
  sessionMod.setActiveSessionId(id);
  const stale = mod.getStaleSessionIds();
  expect(stale).not.toContain(id);
  sessionMod.sessions.delete(id);
  sessionMod.setActiveSessionId(null);
});

test('getStaleSessionIds includes idle old non-active sessions', async () => {
  const { mod, sessionMod } = await loadLifecycle();
  const activeId = 'active-session';
  const staleId = 'stale-session';
  sessionMod.sessions.set(activeId, makeSession({ id: activeId, status: 'idle', lastActivityAt: Date.now() }));
  sessionMod.sessions.set(staleId, makeSession({ id: staleId, status: 'idle', lastActivityAt: Date.now() - 20 * 60 * 1000 }));
  sessionMod.setActiveSessionId(activeId);
  const stale = mod.getStaleSessionIds();
  expect(stale).toContain(staleId);
  expect(stale).not.toContain(activeId);
  sessionMod.sessions.delete(activeId);
  sessionMod.sessions.delete(staleId);
  sessionMod.setActiveSessionId(null);
});

test('getStaleSessionIds excludes working sessions regardless of age', async () => {
  const { mod, sessionMod } = await loadLifecycle();
  const id = 'working-old-session';
  sessionMod.sessions.set(id, makeSession({ id, status: 'working', lastActivityAt: Date.now() - 20 * 60 * 1000 }));
  sessionMod.setActiveSessionId(null);
  const stale = mod.getStaleSessionIds();
  expect(stale).not.toContain(id);
  sessionMod.sessions.delete(id);
});

// ── spawnClaude permission-mode arg selection ─────────────────────────────────

test('bypass mode adds --permission-mode bypassPermissions', async () => {
  window.__ANIMA_PERMISSION_MODE__ = 'bypass';
  const { mod, sessionMod } = await loadLifecycle();
  const id = 'spawn-test-bypass';
  sessionMod.sessions.set(id, makeSession({ id }));

  await mod.spawnClaude(id);
  await Promise.resolve(); // flush async

  const args = _mockCreate.mock.calls[0]?.[1] ?? [];
  expect(args).toContain('--permission-mode');
  expect(args).toContain('bypassPermissions');
  expect(args).not.toContain('--strict-mcp-config');
  sessionMod.sessions.delete(id);
});

test('gated mode with closed circuit adds MCP gate flags', async () => {
  window.__ANIMA_PERMISSION_MODE__ = 'gated';
  installDefaultInvoke({ circuitOpen: false });
  const { mod, sessionMod } = await loadLifecycle();
  const id = 'spawn-test-gated';
  sessionMod.sessions.set(id, makeSession({ id }));

  await mod.spawnClaude(id);
  await Promise.resolve();

  const args = _mockCreate.mock.calls[0]?.[1] ?? [];
  // --strict-mcp-config intentionally removed: it stripped all user MCPs (gemini-memory etc.)
  // Gate server is still registered via --mcp-config; --permission-prompt-tool routes correctly.
  expect(args).not.toContain('--strict-mcp-config');
  expect(args).toContain('--mcp-config');
  expect(args).toContain('--permission-prompt-tool');
  expect(args).toContain('--permission-mode');
  // Should NOT use bypassPermissions in gated mode
  expect(args).not.toContain('bypassPermissions');
  const session = sessionMod.sessions.get(id);
  expect(session?._spawnMode).toBe('gated');
  sessionMod.sessions.delete(id);
});

test('gated mode with open circuit downshifts to --permission-mode default', async () => {
  window.__ANIMA_PERMISSION_MODE__ = 'gated';
  installDefaultInvoke({ circuitOpen: true });
  const { mod, sessionMod } = await loadLifecycle();
  const id = 'spawn-test-degraded';
  sessionMod.sessions.set(id, makeSession({ id }));

  await mod.spawnClaude(id);
  await Promise.resolve();

  const args = _mockCreate.mock.calls[0]?.[1] ?? [];
  expect(args).toContain('--permission-mode');
  expect(args).toContain('default');
  expect(args).not.toContain('--strict-mcp-config');
  expect(args).not.toContain('bypassPermissions');
  const session = sessionMod.sessions.get(id);
  expect(session?._spawnMode).toBe('degraded');
  sessionMod.sessions.delete(id);
});

test('gated mode downshifts to default when gate setup fails', async () => {
  window.__ANIMA_PERMISSION_MODE__ = 'gated';
  installDefaultInvoke({ gateSetupFails: true });
  const { mod, sessionMod } = await loadLifecycle();
  const id = 'spawn-test-gate-fail';
  sessionMod.sessions.set(id, makeSession({ id }));

  await mod.spawnClaude(id);
  await Promise.resolve();

  const args = _mockCreate.mock.calls[0]?.[1] ?? [];
  expect(args).toContain('--permission-mode');
  expect(args).toContain('default');
  expect(args).not.toContain('bypassPermissions');
  expect(args).not.toContain('--strict-mcp-config');
  expect(sessionMod.sessions.get(id)?._spawnMode).toBe('degraded');
  sessionMod.sessions.delete(id);
});

// ── Close handler: gate crash reporting ──────────────────────────────────────

test('close handler calls supervisor_record_gate_crash on non-zero exit in gated mode', async () => {
  window.__ANIMA_PERMISSION_MODE__ = 'gated';
  installDefaultInvoke({ circuitOpen: false });
  const { mod, sessionMod } = await loadLifecycle();
  const id = 'crash-test-gated';
  sessionMod.sessions.set(id, makeSession({ id }));

  await mod.spawnClaude(id);
  await Promise.resolve();

  // The session should now have _spawnMode = 'gated'
  expect(sessionMod.sessions.get(id)?._spawnMode).toBe('gated');

  // Simulate non-zero exit
  if (_capturedCloseHandler) {
    _capturedCloseHandler({ code: 1 });
    await Promise.resolve();

    const calls = _mockInvoke.mock.calls.map(c => c[0]);
    expect(calls).toContain('supervisor_record_gate_crash');
  }
  sessionMod.sessions.delete(id);
});

test('close handler does NOT call supervisor_record_gate_crash in bypass mode', async () => {
  window.__ANIMA_PERMISSION_MODE__ = 'bypass';
  installDefaultInvoke();
  const { mod, sessionMod } = await loadLifecycle();
  const id = 'crash-test-bypass';
  sessionMod.sessions.set(id, makeSession({ id }));

  await mod.spawnClaude(id);
  await Promise.resolve();

  expect(sessionMod.sessions.get(id)?._spawnMode).toBe('bypass');
  _mockInvoke.mockClear();

  if (_capturedCloseHandler) {
    _capturedCloseHandler({ code: 1 });
    await Promise.resolve();
    const calls = _mockInvoke.mock.calls.map(c => c[0]);
    expect(calls).not.toContain('supervisor_record_gate_crash');
  }
  sessionMod.sessions.delete(id);
});

// ── sendMessage: pending queue ────────────────────────────────────────────────

test('sendMessage enqueues when session has no child process', async () => {
  const { mod, sessionMod } = await loadLifecycle();
  const id = 'queue-test';
  const pushed = [];
  mod.setLifecycleDeps({
    renderSessionCard: vi.fn(),
    setActiveSession: vi.fn(),
    pushMessage: vi.fn((sid, msg) => pushed.push(msg)),
    setStatus: vi.fn(),
    handleEvent: vi.fn(),
    updateWorkingCursor: vi.fn(),
    showEmptyState: vi.fn(),
    slashCommands: [],
    hideSlashMenu: vi.fn(),
    exitHistoryView: vi.fn(),
    scanHistory: vi.fn(),
  });
  sessionMod.sessions.set(id, makeSession({ id, child: null }));

  await mod.sendMessage(id, 'hello from test');

  const session = sessionMod.sessions.get(id);
  expect(session._pendingQueue).toEqual(expect.arrayContaining([{ text: 'hello from test', shown: true }]));
  sessionMod.sessions.delete(id);
});

// ── killSession ───────────────────────────────────────────────────────────────

test('killSession removes session from map', async () => {
  const { mod, sessionMod } = await loadLifecycle();
  const id = 'kill-test';
  document.body.innerHTML = `<div id="card-${id}"></div>`;
  sessionMod.sessions.set(id, makeSession({ id }));
  mod.setLifecycleDeps({
    renderSessionCard: vi.fn(), setActiveSession: vi.fn(), pushMessage: vi.fn(),
    setStatus: vi.fn(), handleEvent: vi.fn(), updateWorkingCursor: vi.fn(),
    showEmptyState: vi.fn(), slashCommands: [], hideSlashMenu: vi.fn(),
    exitHistoryView: vi.fn(), scanHistory: vi.fn(),
  });

  mod.killSession(id);

  expect(sessionMod.sessions.has(id)).toBe(false);
  document.body.innerHTML = '';
});

test('pauseSession kills the child, clears pending work, and reports idle status', async () => {
  const { mod, sessionMod } = await loadLifecycle();
  const id = 'pause-test';
  const child = { write: vi.fn(), kill: vi.fn(), pid: 4444 };
  const deps = {
    renderSessionCard: vi.fn(), setActiveSession: vi.fn(), pushMessage: vi.fn(),
    setStatus: vi.fn(), handleEvent: vi.fn(), updateWorkingCursor: vi.fn(),
    showEmptyState: vi.fn(), slashCommands: [], hideSlashMenu: vi.fn(),
    exitHistoryView: vi.fn(), scanHistory: vi.fn(),
  };
  mod.setLifecycleDeps(deps);
  sessionMod.sessions.set(id, makeSession({
    id,
    child,
    status: 'working',
    _pendingQueue: [{ text: 'queued', shown: true }],
    toolPending: { tool1: true },
  }));

  mod.pauseSession(id);

  const session = sessionMod.sessions.get(id);
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(session.child).toBeNull();
  expect(session._manualClose).toBe(true);
  expect(session._paused).toBe(true);
  expect(session._pendingQueue).toEqual([]);
  expect(session.toolPending).toEqual({});
  expect(deps.setStatus).toHaveBeenCalledWith(id, 'idle');
  expect(deps.pushMessage).toHaveBeenCalledWith(id, expect.objectContaining({
    type: 'error',
    text: expect.stringContaining('Permission request denied and session paused'),
  }));
});

test('drag-drop attachment is read and injected into the next Claude message', async () => {
  vi.resetModules();
  resetMockProcess();
  for (const k of Object.keys(_tauriListeners)) delete _tauriListeners[k];

  document.body.innerHTML = `
    <textarea id="msg-input"></textarea>
    <div id="chat-view"></div>
    <div id="drop-indicator" class="hidden"></div>
    <div id="attachment-tokens"></div>
    <div id="attachments-panel"></div>
    <div id="attachment-ctx-menu" class="hidden"></div>
  `;
  const domMod = await import('../src/dom.js');
  domMod.initDOM();
  const sessionMod = await import('../src/session.js');
  const attachments = await import('../src/attachments.js');
  const lifecycle = await import('../src/session-lifecycle.js');
  const id = 'drop-inject-test';
  const write = vi.fn().mockResolvedValue(undefined);
  sessionMod.setActiveSessionId(id);
  sessionMod.sessions.set(id, makeSession({ id, child: { write } }));
  sessionMod.sessionLogs.set(id, { messages: [] });
  lifecycle.setLifecycleDeps({
    renderSessionCard: vi.fn(), setActiveSession: vi.fn(), pushMessage: vi.fn(),
    setStatus: vi.fn(), handleEvent: vi.fn(), updateWorkingCursor: vi.fn(),
    showEmptyState: vi.fn(), slashCommands: [], hideSlashMenu: vi.fn(),
    exitHistoryView: vi.fn(), scanHistory: vi.fn(),
  });
  _mockInvoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'get_file_size_any') {
      expect(args.path).toBe('/tmp/notes.txt');
      return 24;
    }
    if (cmd === 'read_file_as_text_any') {
      expect(args.path).toBe('/tmp/notes.txt');
      return 'dragged file contents';
    }
    if (cmd === 'read_slash_commands') return [];
    if (cmd === 'write_file_as_text') return null;
    if (cmd === 'js_log') return null;
    return null;
  });

  attachments.initSession(id);
  attachments.initAttachments({ getActiveSessionId: () => sessionMod.getActiveSessionId() });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(_tauriListeners['tauri://drag-drop']).toEqual(expect.any(Function));
  await _tauriListeners['tauri://drag-drop']?.({ payload: { paths: ['/tmp/notes.txt'] } });
  expect(attachments.getStagedAttachments(id)).toHaveLength(1);

  await lifecycle.sendMessage(id, 'summarize this attachment');

  expect(write).toHaveBeenCalledTimes(1);
  const frame = JSON.parse(write.mock.calls[0][0]);
  expect(frame.message.content[0]).toEqual({ type: 'text', text: 'summarize this attachment' });
  expect(frame.message.content[1]).toMatchObject({
    type: 'text',
    text: expect.stringContaining('[Attached file: notes.txt | path: /tmp/notes.txt]\ndragged file contents'),
  });
  expect(attachments.getStagedAttachments(id)).toEqual([]);
});

// ── NEW TESTS: lifecycle edge cases (generated by Codex gpt-5.4) ─────────────

describe('lifecycle edge cases', () => {
  function makeDeps(overrides = {}) {
    return {
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
      updateSessionCard: vi.fn(),
      ...overrides,
    };
  }

  async function flushAsync() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  test('isReadyForInput gates direct sends on child, _spawning, and _interrupting', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const write = vi.fn().mockResolvedValue(undefined);
    const id = 'ready-gate-test';
    const deps = makeDeps();
    mod.setLifecycleDeps(deps);

    sessionMod.sessions.set(id, makeSession({ id, child: null }));
    await mod.sendMessage(id, '/compact');
    expect(write).not.toHaveBeenCalled();

    sessionMod.sessions.set(id, makeSession({ id, child: { write }, _spawning: true }));
    await mod.sendMessage(id, '/compact');
    expect(write).not.toHaveBeenCalled();

    sessionMod.sessions.set(id, makeSession({ id, child: { write }, _interrupting: true }));
    await mod.sendMessage(id, '/compact');
    expect(write).not.toHaveBeenCalled();

    sessionMod.sessions.set(id, makeSession({ id, child: { write } }));
    await mod.sendMessage(id, '/compact');
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0][0]).message.content).toContain('Summarize our conversation');
  });

  test('spawnClaude no-ops when _spawning is already true', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const id = 'already-spawning-test';
    const existingChild = { write: vi.fn(), kill: vi.fn() };
    const session = makeSession({ id, child: existingChild, _spawning: true });
    sessionMod.sessions.set(id, session);

    await mod.spawnClaude(id);

    expect(_mockCreate).not.toHaveBeenCalled();
    expect(session.child).toBe(existingChild);
    expect(session._spawning).toBe(true);
  });

  test('spawnClaude kills an orphan child when the session is deleted during async spawn delay', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const id = 'deleted-during-spawn-test';
    const child = { write: vi.fn(), kill: vi.fn(), pid: 4321 };
    let resolveSpawn;
    _mockCmd.spawn.mockImplementation(() => new Promise(resolve => { resolveSpawn = resolve; }));
    sessionMod.sessions.set(id, makeSession({ id }));

    const spawnPromise = mod.spawnClaude(id);
    await flushAsync();
    expect(_mockCmd.spawn).toHaveBeenCalledTimes(1);

    const originalSession = sessionMod.sessions.get(id);
    sessionMod.sessions.delete(id);
    resolveSpawn(child);
    await spawnPromise;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(originalSession._spawning).toBe(false);
    expect(originalSession.child).toBe(null);
  });

  test('spawnClaude resets _spawning after a successful spawn', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const id = 'spawn-success-flag-test';
    const session = makeSession({ id });
    sessionMod.sessions.set(id, session);

    await mod.spawnClaude(id);

    expect(session._spawning).toBe(false);
    expect(session.child).toBe(_mockChild);
    expect(session.toolPending).toEqual({});
  });

  test('spawnClaude resets _spawning after spawn failure', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const id = 'spawn-catch-flag-test';
    const deps = makeDeps();
    const session = makeSession({ id });
    mod.setLifecycleDeps(deps);
    _mockCmd.spawn.mockRejectedValueOnce(new Error('spawn failed'));
    sessionMod.sessions.set(id, session);

    await mod.spawnClaude(id);

    expect(session._spawning).toBe(false);
    expect(session.child).toBe(null);
    expect(deps.pushMessage).toHaveBeenCalledWith(id, expect.objectContaining({
      type: 'error',
      text: expect.stringContaining('Failed to start Claude Code'),
    }));
    expect(deps.setStatus).toHaveBeenCalledWith(id, 'error');
  });

  test('sendMessage with a dead session shows immediately, queues shown item, and respawns with --continue', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const id = 'dead-session-send-test';
    const deps = makeDeps();
    const session = makeSession({ id, child: null });
    mod.setLifecycleDeps(deps);
    sessionMod.sessions.set(id, session);

    await mod.sendMessage(id, 'resume this task');
    await flushAsync();

    expect(deps.pushMessage).toHaveBeenCalledWith(id, { type: 'user', text: 'resume this task' });
    expect(session._pendingQueue).toEqual([{ text: 'resume this task', shown: true }]);
    expect(_mockCreate).toHaveBeenCalledTimes(1);
    expect(_mockCreate.mock.calls[0][1]).toContain('--continue');
    expect(session._interrupted).toBe(false);
  });

  test('sendMessage skipPushMessage suppresses user push for normal, builtin, and Vexil turns', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const deps = makeDeps();
    mod.setLifecycleDeps(deps);

    const normalWrite = vi.fn().mockResolvedValue(undefined);
    sessionMod.sessions.set('skip-normal', makeSession({ id: 'skip-normal', child: { write: normalWrite } }));
    await mod.sendMessage('skip-normal', 'hello there', { skipPushMessage: true });
    expect(deps.pushMessage.mock.calls.some(([, msg]) => msg.type === 'user' && msg.text === 'hello there')).toBe(false);
    expect(normalWrite).toHaveBeenCalledTimes(1);

    deps.pushMessage.mockClear();
    sessionMod.sessions.set('skip-builtin', makeSession({ id: 'skip-builtin', child: { write: vi.fn() }, tokens: 12, _liveTokens: 3 }));
    await mod.sendMessage('skip-builtin', '/cost', { skipPushMessage: true });
    expect(deps.pushMessage.mock.calls.some(([, msg]) => msg.type === 'user')).toBe(false);
    expect(deps.pushMessage).toHaveBeenCalledWith('skip-builtin', expect.objectContaining({ type: 'system-msg' }));

    deps.pushMessage.mockClear();
    _mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'oracle_query') return { msg: 'oracle response' };
      if (cmd === 'read_slash_commands') return [];
      if (cmd === 'js_log') return null;
      if (cmd === 'sync_buddy') return null;
      return null;
    });
    sessionMod.sessionLogs.set('skip-vexil', { messages: [] });
    sessionMod.sessions.set('skip-vexil', makeSession({ id: 'skip-vexil', child: { write: vi.fn() } }));
    await mod.sendMessage('skip-vexil', 'vexil summarize state', { skipPushMessage: true });
    await flushAsync();
    expect(deps.pushMessage.mock.calls.some(([, msg]) => msg.type === 'user')).toBe(false);
  });

  test('sendMessage does not respawn when the session is already spawning', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const id = 'send-no-respawn-spawning';
    const deps = makeDeps();
    const session = makeSession({ id, child: null, _spawning: true });
    mod.setLifecycleDeps(deps);
    sessionMod.sessions.set(id, session);

    await mod.sendMessage(id, 'queued while spawning');

    expect(_mockCreate).not.toHaveBeenCalled();
    expect(session._pendingQueue).toEqual([{ text: 'queued while spawning', shown: true }]);
    expect(session._interrupted).toBeUndefined();
  });

  test('sendMessage does not respawn when the session is interrupting', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const id = 'send-no-respawn-interrupting';
    const deps = makeDeps();
    const session = makeSession({ id, child: null, _interrupting: true });
    mod.setLifecycleDeps(deps);
    sessionMod.sessions.set(id, session);

    await mod.sendMessage(id, 'queued while interrupting');

    expect(_mockCreate).not.toHaveBeenCalled();
    expect(session._pendingQueue).toEqual([{ text: 'queued while interrupting', shown: true }]);
    expect(session._interrupted).toBeUndefined();
  });

  test('system init queue flush skips duplicate push for shown items and pushes hidden items', async () => {
    vi.resetModules();
    resetMockProcess();
    installDefaultInvoke();

    document.body.innerHTML = '<div id="message-log"></div>';
    const sessionMod = await import('../src/session.js');
    const lifecycle = await import('../src/session-lifecycle.js');
    const events = await import('../src/events.js');
    const id = 'queue-flush-test';
    const pushed = [];
    const write = vi.fn().mockResolvedValue(undefined);

    lifecycle.setLifecycleDeps(makeDeps({
      pushMessage: vi.fn((sid, msg) => pushed.push({ sid, msg })),
    }));

    sessionMod.sessionLogs.set(id, { messages: [] });
    sessionMod.setActiveSessionId(id);
    sessionMod.sessions.set(id, makeSession({
      id,
      child: { write },
      _pendingQueue: [
        { text: 'already visible', shown: true },
        { text: 'needs visible push', shown: false },
      ],
    }));

    events.handleEvent(id, { type: 'system', subtype: 'init', model: 'claude-sonnet-4-5' });
    await flushAsync();

    expect(write).toHaveBeenCalledTimes(2);
    expect(pushed.filter(x => x.msg.type === 'user').map(x => x.msg.text)).toEqual(['needs visible push']);
    expect(JSON.parse(write.mock.calls[0][0]).message.content).toBe('already visible');
    expect(JSON.parse(write.mock.calls[1][0]).message.content).toBe('needs visible push');

    document.body.innerHTML = '';
  });

  test('sendMessageDirect returns early through /compact when input is not ready', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const id = 'direct-early-return-test';
    const write = vi.fn().mockResolvedValue(undefined);
    mod.setLifecycleDeps(makeDeps());

    sessionMod.sessions.set(id, makeSession({ id, child: null }));
    await mod.sendMessage(id, '/compact');
    sessionMod.sessions.set(id, makeSession({ id, child: { write }, _spawning: true }));
    await mod.sendMessage(id, '/compact');
    sessionMod.sessions.set(id, makeSession({ id, child: { write }, _interrupting: true }));
    await mod.sendMessage(id, '/compact');

    expect(write).not.toHaveBeenCalled();
  });

  test('createSession preloads only _contextWindow from last_context.json', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const deps = makeDeps();
    mod.setLifecycleDeps(deps);
    _mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'read_file_as_text') return JSON.stringify({ window: 123456, pct: 87 });
      if (cmd === 'read_slash_commands') return [];
      if (cmd === 'write_file_as_text') return null;
      if (cmd === 'js_log') return null;
      if (cmd === 'sync_buddy') return null;
      return null;
    });

    const id = await mod.createSession('/Users/testuser/Projects/context-app');
    const session = sessionMod.sessions.get(id);

    expect(session._contextWindow).toBe(123456);
    expect(session._authoritativePct).toBeUndefined();
    expect(deps.renderSessionCard).toHaveBeenCalledWith(id);
    expect(deps.setActiveSession).toHaveBeenCalledWith(id);
  });

  test('createSession pre-load is a no-op when last_context.json is absent', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const deps = makeDeps();
    mod.setLifecycleDeps(deps);
    _mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'read_file_as_text') throw new Error('file not found');
      if (cmd === 'read_slash_commands') return [];
      if (cmd === 'write_file_as_text') return null;
      if (cmd === 'js_log') return null;
      if (cmd === 'sync_buddy') return null;
      return null;
    });

    const id = await mod.createSession('/Users/testuser/Projects/no-context-app');
    const session = sessionMod.sessions.get(id);

    expect(session).toBeTruthy();
    expect(session._contextWindow).toBeUndefined();
    expect(session._authoritativePct).toBeUndefined();
  });

  test('post-spawn orphan kills child and resets _spawning when sessions map no longer points to original session', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const id = 'post-spawn-orphan-test';
    const child = { write: vi.fn(), kill: vi.fn(), pid: 9876 };
    let resolveSpawn;
    _mockCmd.spawn.mockImplementation(() => new Promise(resolve => { resolveSpawn = resolve; }));

    const original = makeSession({ id });
    const replacement = makeSession({ id, name: 'replacement' });
    sessionMod.sessions.set(id, original);

    const spawnPromise = mod.spawnClaude(id);
    await flushAsync();

    sessionMod.sessions.set(id, replacement);
    resolveSpawn(child);
    await spawnPromise;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(original._spawning).toBe(false);
    expect(original.child).toBe(null);
    expect(sessionMod.sessions.get(id)).toBe(replacement);
  });

  test('interrupted sessions spawn with --continue and clear _interrupted after args are built', async () => {
    const { mod, sessionMod } = await loadLifecycle();
    const id = 'continue-flag-test';
    const session = makeSession({ id, _interrupted: true });
    sessionMod.sessions.set(id, session);

    await mod.spawnClaude(id);

    expect(_mockCreate).toHaveBeenCalledTimes(1);
    expect(_mockCreate.mock.calls[0][1]).toContain('--continue');
    expect(session._interrupted).toBe(false);
  });
});
