/**
 * bargein.test.js — unit tests for src/bargein.js.
 *
 * The module is a thin dispatcher over Tauri's `omi:command` channel that
 * emits a `pixel:bargein` CustomEvent on document (and invokes registered
 * handlers) when a transcript/prompt/bargein frame indicates the user
 * started talking. Tests exercise the pure dispatcher, the subscription
 * API, and the initializer with an injected listen() factory so we don't
 * touch real Tauri globals.
 */
import { beforeEach, afterEach, test, expect, vi } from 'vitest';

import { _handleOmiCommand, onBargeIn, initBargeIn } from '../src/bargein.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── _handleOmiCommand — pure dispatcher ──────────────────────────────────────

test('_handleOmiCommand: prompt type fires', () => {
  const spy = vi.fn();
  document.addEventListener('pixel:bargein', spy);
  const fired = _handleOmiCommand({ type: 'prompt', text: 'hi' });
  expect(fired).toBe(true);
  expect(spy).toHaveBeenCalledTimes(1);
  const evt = spy.mock.calls[0][0];
  expect(evt.detail.reason).toBe('prompt');
  expect(evt.detail.payload.text).toBe('hi');
});

test('_handleOmiCommand: bargein type fires', () => {
  const spy = vi.fn();
  document.addEventListener('pixel:bargein', spy);
  expect(_handleOmiCommand({ type: 'bargein' })).toBe(true);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][0].detail.reason).toBe('bargein');
});

test('_handleOmiCommand: dispatched transcript fires', () => {
  const spy = vi.fn();
  document.addEventListener('pixel:bargein', spy);
  expect(_handleOmiCommand({ type: 'transcript', dispatched: true, text: 'go' })).toBe(true);
  expect(spy).toHaveBeenCalledTimes(1);
});

test('_handleOmiCommand: non-dispatched transcript does NOT fire', () => {
  const spy = vi.fn();
  document.addEventListener('pixel:bargein', spy);
  expect(_handleOmiCommand({ type: 'transcript', dispatched: false })).toBe(false);
  expect(_handleOmiCommand({ type: 'transcript' })).toBe(false);
  expect(spy).not.toHaveBeenCalled();
});

test('_handleOmiCommand: unknown type does NOT fire', () => {
  const spy = vi.fn();
  document.addEventListener('pixel:bargein', spy);
  expect(_handleOmiCommand({ type: 'totally-unknown' })).toBe(false);
  expect(spy).not.toHaveBeenCalled();
});

test('_handleOmiCommand: null/undefined/non-object payloads are safe', () => {
  const spy = vi.fn();
  document.addEventListener('pixel:bargein', spy);
  expect(_handleOmiCommand(null)).toBe(false);
  expect(_handleOmiCommand(undefined)).toBe(false);
  expect(_handleOmiCommand('string')).toBe(false);
  expect(_handleOmiCommand(42)).toBe(false);
  expect(spy).not.toHaveBeenCalled();
});

// ── onBargeIn — subscription API ─────────────────────────────────────────────

test('onBargeIn: registered handler receives {reason, payload}', () => {
  const handler = vi.fn();
  const unsub = onBargeIn(handler);
  _handleOmiCommand({ type: 'prompt', text: 'hi' });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler.mock.calls[0][0]).toMatchObject({
    reason: 'prompt',
    payload: { type: 'prompt', text: 'hi' },
  });
  unsub();
});

test('onBargeIn: unsubscribe stops future deliveries', () => {
  const handler = vi.fn();
  const unsub = onBargeIn(handler);
  _handleOmiCommand({ type: 'prompt' });
  expect(handler).toHaveBeenCalledTimes(1);
  unsub();
  _handleOmiCommand({ type: 'prompt' });
  expect(handler).toHaveBeenCalledTimes(1);
});

test('onBargeIn: throwing handler does NOT break dispatch', () => {
  const bad = vi.fn(() => { throw new Error('boom'); });
  const good = vi.fn();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const u1 = onBargeIn(bad);
  const u2 = onBargeIn(good);
  expect(_handleOmiCommand({ type: 'prompt' })).toBe(true);
  expect(bad).toHaveBeenCalledTimes(1);
  expect(good).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalled();
  u1(); u2();
});

// ── initBargeIn — Tauri wiring via injected factory ──────────────────────────

test('initBargeIn: uses injected tauriListen and dispatches on omi:command', async () => {
  let capturedHandler = null;
  const unlistenFn = vi.fn();
  const tauriListen = vi.fn(async (channel, handler) => {
    expect(channel).toBe('omi:command');
    capturedHandler = handler;
    return unlistenFn;
  });

  const teardown = initBargeIn({ tauriListen });

  // allow the promise returned by listenFn() to resolve
  await Promise.resolve();
  await Promise.resolve();

  expect(tauriListen).toHaveBeenCalledTimes(1);
  expect(typeof capturedHandler).toBe('function');

  const spy = vi.fn();
  document.addEventListener('pixel:bargein', spy);
  capturedHandler({ payload: { type: 'prompt' } });
  expect(spy).toHaveBeenCalledTimes(1);

  teardown();
  expect(unlistenFn).toHaveBeenCalledTimes(1);
});

test('initBargeIn: missing tauriListen returns noop teardown and warns', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const prevTauri = window.__TAURI__;
  window.__TAURI__ = undefined;
  try {
    const teardown = initBargeIn();
    expect(typeof teardown).toBe('function');
    expect(warn).toHaveBeenCalled();
    teardown(); // should not throw
  } finally {
    window.__TAURI__ = prevTauri;
  }
});

test('initBargeIn: teardown clears subscribed handlers', async () => {
  const tauriListen = vi.fn(async () => () => {});
  const handler = vi.fn();
  onBargeIn(handler);
  const teardown = initBargeIn({ tauriListen });
  await Promise.resolve();
  teardown();
  _handleOmiCommand({ type: 'prompt' });
  expect(handler).not.toHaveBeenCalled();
});
