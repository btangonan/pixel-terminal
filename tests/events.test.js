import { beforeEach, afterEach, test, expect, vi } from 'vitest';

const _mockInvoke = vi.fn();

window.__TAURI__ = {
  shell: { Command: { create: vi.fn() } },
  core: { invoke: _mockInvoke },
  path: { homeDir: vi.fn().mockResolvedValue('/Users/testuser') },
  dialog: { open: vi.fn() },
  event: { listen: vi.fn().mockResolvedValue(() => {}) },
  opener: { revealItemInDir: vi.fn() },
};

_mockInvoke.mockImplementation(async (cmd) => {
  if (cmd === 'read_slash_commands') return [];
  if (cmd === 'read_file_as_text') throw new Error('not found');
  if (cmd === 'write_file_as_text') return null;
  if (cmd === 'append_line_to_file') return null;
  if (cmd === 'js_log') return null;
  if (cmd === 'sync_buddy') return null;
  if (cmd === 'supervisor_circuit_state') return { open: false, backoffMs: 0 };
  return null;
});

window.__ANIMA_PERMISSION_MODE__ = 'bypass';

function installDefaultInvoke() {
  _mockInvoke.mockImplementation(async (cmd) => {
    if (cmd === 'read_slash_commands') return [];
    if (cmd === 'read_file_as_text') throw new Error('not found');
    if (cmd === 'write_file_as_text') return null;
    if (cmd === 'append_line_to_file') return null;
    if (cmd === 'js_log') return null;
    if (cmd === 'sync_buddy') return null;
    if (cmd === 'supervisor_circuit_state') return { open: false, backoffMs: 0 };
    return null;
  });
}

function makeSession(overrides = {}) {
  return {
    id: 'test-id',
    cwd: '/test/project',
    name: 'project',
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
    _spawning: false,
    _perfHistory: [],
    _turnStart: null,
    _ttft: null,
    lastActivityAt: Date.now(),
    _taskLedger: { userPrompt: '', tools: [], lastText: '' },
    familiar: { species: 'owl' },
    familiarHue: '#888',
    _familiarFrame: 0,
    ...overrides,
  };
}

async function loadModules() {
  const sessionMod = await import('../src/session.js');
  const eventsMod  = await import('../src/events.js?t=' + Math.random());
  const lifecycleMod = await import('../src/session-lifecycle.js?t=' + Math.random());
  lifecycleMod.setLifecycleDeps({
    renderSessionCard: vi.fn(), setActiveSession: vi.fn(),
    pushMessage: vi.fn(), setStatus: vi.fn(), handleEvent: vi.fn(),
    updateWorkingCursor: vi.fn(), showEmptyState: vi.fn(),
    slashCommands: [], hideSlashMenu: vi.fn(),
    exitHistoryView: vi.fn(), scanHistory: vi.fn(),
  });
  return { sessionMod, eventsMod };
}

function addSession(sessionMod, session = makeSession()) {
  sessionMod.sessions.set(session.id, session);
  sessionMod.sessionLogs.set(session.id, { messages: [] });
  return session;
}

beforeEach(() => {
  vi.clearAllMocks();
  installDefaultInvoke();
  document.body.innerHTML = '';
  window.__ANIMA_PERMISSION_MODE__ = 'bypass';
});

afterEach(async () => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  localStorage.clear();
  const m = await import('../src/session.js');
  m.sessions.clear();
  m.sessionLogs.clear();
  m.setActiveSessionId(null);
});

test('system.init event', async () => {
  const { sessionMod, eventsMod } = await loadModules();
  const id = 'system-init-idle';
  const s = addSession(sessionMod, makeSession({ id, status: 'waiting', _restarting: true }));

  eventsMod.handleEvent(id, { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' });

  expect(s.model).toBe('claude-sonnet-4-6');
  expect(s._contextWindow).toBe(200000);
  expect(sessionMod.sessionLogs.get(id).messages).toContainEqual({
    type: 'system-msg',
    text: 'Ready \u00b7 claude-sonnet-4-6',
  });
  expect(s.status).toBe('idle');
  expect(s._restarting).toBe(false);

  const workingId = 'system-init-working';
  const working = addSession(sessionMod, makeSession({ id: workingId, status: 'working', _restarting: false }));

  eventsMod.handleEvent(workingId, { type: 'system', subtype: 'init', model: 'claude-haiku-4-5' });

  expect(working.status).toBe('working');
  expect(working._restarting).toBe(false);
});

test('assistant event - usage tracking', async () => {
  const { sessionMod, eventsMod } = await loadModules();
  const id = 'assistant-usage';
  const s = addSession(sessionMod, makeSession({ id }));

  eventsMod.handleEvent(id, {
    type: 'assistant',
    message: {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 0,
      },
      content: [],
    },
  });

  expect(s._liveTokens).toBe(150);
  expect(s._contextTokens).toBe(300);
  expect(s._contextBaseline).toBe(300);
});

test('assistant event - pushes claude message when not streamed', async () => {
  const { sessionMod, eventsMod } = await loadModules();
  const id = 'assistant-text';
  addSession(sessionMod, makeSession({ id }));

  eventsMod.handleEvent(id, {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello world' }] },
  });

  expect(sessionMod.sessionLogs.get(id).messages).toContainEqual({
    type: 'claude',
    text: 'Hello world',
  });
});

test('assistant event - skips claude message when already streamed', async () => {
  const { sessionMod, eventsMod } = await loadModules();
  const id = 'assistant-streamed';
  addSession(sessionMod, makeSession({ id, _didStreamText: true }));

  eventsMod.handleEvent(id, {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello world' }] },
  });

  expect(sessionMod.sessionLogs.get(id).messages.some(m => m.type === 'claude')).toBe(false);
});

test('assistant event - tool_use block pushes tool message for non-internal tools', async () => {
  const { sessionMod, eventsMod } = await loadModules();
  const id = 'assistant-tool';
  addSession(sessionMod, makeSession({ id }));

  eventsMod.handleEvent(id, {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Read', id: 'tool-abc', input: { file_path: '/test.txt' } }],
    },
  });

  expect(sessionMod.sessionLogs.get(id).messages).toContainEqual(expect.objectContaining({
    type: 'tool',
    toolName: 'Read',
  }));
});

test('assistant event - tool_use block does NOT push message for internal tools', async () => {
  const { sessionMod, eventsMod } = await loadModules();
  const id = 'assistant-internal-tool';
  addSession(sessionMod, makeSession({ id }));

  eventsMod.handleEvent(id, {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'TodoWrite', id: 'tool-xyz', input: {} }],
    },
  });

  expect(sessionMod.sessionLogs.get(id).messages.some(m => m.type === 'tool')).toBe(false);
});

test('user event - tool_result updates existing tool message result', async () => {
  const { sessionMod, eventsMod } = await loadModules();
  const id = 'user-tool-result';
  addSession(sessionMod, makeSession({ id }));
  sessionMod.sessionLogs.get(id).messages.push({ type: 'tool', toolId: 'tool-abc', result: null });

  eventsMod.handleEvent(id, {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tool-abc', content: 'file contents here' }],
    },
  });

  const toolMsg = sessionMod.sessionLogs.get(id).messages.find(m => m.type === 'tool' && m.toolId === 'tool-abc');
  expect(toolMsg.result).toBe('file contents here');
});

test('result event - accumulates tokens and resets _liveTokens', async () => {
  vi.useFakeTimers();
  const { sessionMod, eventsMod } = await loadModules();
  const id = 'result-tokens';
  const s = addSession(sessionMod, makeSession({
    id,
    _liveTokens: 150,
    tokens: 0,
    _turnStart: Date.now(),
    _hitRateLimit: true,
  }));

  eventsMod.handleEvent(id, {
    type: 'result',
    usage: { input_tokens: 80, output_tokens: 40 },
  });
  vi.runAllTimers();

  expect(s.tokens).toBe(120);
  expect(s._liveTokens).toBe(0);
  expect(s._hitRateLimit).toBe(false);
});

test('result event with rate_limit subtype - sets _hitRateLimit', async () => {
  const { sessionMod, eventsMod } = await loadModules();
  const id = 'result-rate-limit';
  const s = addSession(sessionMod, makeSession({ id }));

  eventsMod.handleEvent(id, { type: 'result', subtype: 'rate_limit', usage: null });

  expect(s._hitRateLimit).toBe(true);
});

test('rate_limit_event - increments rateLimitCount and sets flag', async () => {
  const { sessionMod, eventsMod } = await loadModules();
  const id = 'rate-limit-event';
  const s = addSession(sessionMod, makeSession({ id }));

  eventsMod.handleEvent(id, { type: 'rate_limit_event' });

  expect(s._hitRateLimit).toBe(true);
  expect(s._rateLimitCount).toBe(1);

  eventsMod.handleEvent(id, { type: 'rate_limit_event' });

  expect(s._rateLimitCount).toBe(2);
});

test('content_block_start with text block - initializes stream state', async () => {
  const { sessionMod, eventsMod } = await loadModules();
  const id = 'content-text-start';
  const s = addSession(sessionMod, makeSession({ id }));

  eventsMod.handleEvent(id, {
    type: 'content_block_start',
    content_block: { type: 'text' },
  });

  expect(s._streamText).toBe('');
  expect(s._streamMsg).toBe(null);
  expect(s._streamEl).toBe(null);
});

test('content_block_start with tool_use - pushes tool message for non-internal tool', async () => {
  const { sessionMod, eventsMod } = await loadModules();
  const id = 'content-tool-start';
  const s = addSession(sessionMod, makeSession({ id }));

  eventsMod.handleEvent(id, {
    type: 'content_block_start',
    content_block: { type: 'tool_use', name: 'Bash', id: 'cbs-tool-1' },
  });

  expect(sessionMod.sessionLogs.get(id).messages).toContainEqual(expect.objectContaining({
    type: 'tool',
    toolName: 'Bash',
  }));
  expect(s.toolPending['cbs-tool-1']).toBe(true);
});

test('handleEvent no-ops when session does not exist', async () => {
  const { sessionMod, eventsMod } = await loadModules();

  expect(() => eventsMod.handleEvent('nonexistent-id', {
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-4-6',
  })).not.toThrow();
  expect(sessionMod.sessionLogs.size).toBe(0);
});
