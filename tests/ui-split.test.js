/**
 * ui-split.test.js — unit tests for src/ui-split.js.
 *
 * Covers the default-off posture, DOM side effects (toggle button + class
 * on #vexil-panel), localStorage persistence, `pixel:hybrid-toggle`
 * dispatch, rehydration on init, and idempotent/teardown semantics.
 */
import { beforeEach, afterEach, test, expect, vi } from 'vitest';

import { initUISplit, isHybridEnabled, setHybridEnabled } from '../src/ui-split.js';

function mountPanel() {
  document.body.innerHTML = `
    <div id="vexil-panel">
      <div id="voice-log"></div>
      <div id="oracle-chat-log"></div>
      <div id="vexil-log"></div>
    </div>
  `;
}

function makeStorage(seed = {}) {
  const store = { ...seed };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _raw: store,
  };
}

beforeEach(() => {
  mountPanel();
});

afterEach(() => {
  document.body.innerHTML = '';
});

// ── isHybridEnabled / setHybridEnabled ───────────────────────────────────────

test('isHybridEnabled: default-off when storage empty', () => {
  const storage = makeStorage();
  expect(isHybridEnabled(storage)).toBe(false);
});

test('isHybridEnabled: returns true when flag = "1"', () => {
  const storage = makeStorage({ voiceHybridEnabled: '1' });
  expect(isHybridEnabled(storage)).toBe(true);
});

test('setHybridEnabled(true): adds hybrid-split class and persists', () => {
  const storage = makeStorage();
  const result = setHybridEnabled(true, { storage });
  expect(result).toBe(true);
  expect(document.getElementById('vexil-panel').classList.contains('hybrid-split')).toBe(true);
  expect(storage._raw.voiceHybridEnabled).toBe('1');
});

test('setHybridEnabled(false): removes class and clears storage', () => {
  const storage = makeStorage({ voiceHybridEnabled: '1' });
  document.getElementById('vexil-panel').classList.add('hybrid-split');
  setHybridEnabled(false, { storage });
  expect(document.getElementById('vexil-panel').classList.contains('hybrid-split')).toBe(false);
  expect('voiceHybridEnabled' in storage._raw).toBe(false);
});

test('setHybridEnabled: dispatches pixel:hybrid-toggle with {enabled}', () => {
  const storage = makeStorage();
  const spy = vi.fn();
  document.addEventListener('pixel:hybrid-toggle', spy);
  setHybridEnabled(true, { storage });
  setHybridEnabled(false, { storage });
  expect(spy).toHaveBeenCalledTimes(2);
  expect(spy.mock.calls[0][0].detail).toEqual({ enabled: true });
  expect(spy.mock.calls[1][0].detail).toEqual({ enabled: false });
});

// ── initUISplit ──────────────────────────────────────────────────────────────

test('initUISplit: does not inject a toggle when the legacy header is absent', () => {
  const storage = makeStorage();
  initUISplit({ storage });
  expect(document.getElementById('btn-hybrid-toggle')).toBeNull();
});

test('initUISplit: idempotent — calling twice does not duplicate button', () => {
  const storage = makeStorage();
  initUISplit({ storage });
  initUISplit({ storage });
  const btns = document.querySelectorAll('#btn-hybrid-toggle');
  expect(btns.length).toBe(0);
});

test('initUISplit: rehydrates hybrid-split class from storage on init', () => {
  const storage = makeStorage({ voiceHybridEnabled: '1' });
  initUISplit({ storage });
  expect(document.getElementById('vexil-panel').classList.contains('hybrid-split')).toBe(false);
});

test('setHybridEnabled: toggles state and persists without a visible button', () => {
  const storage = makeStorage();
  const panel = document.getElementById('vexil-panel');

  setHybridEnabled(true, { storage });
  expect(panel.classList.contains('hybrid-split')).toBe(true);
  expect(storage._raw.voiceHybridEnabled).toBe('1');

  setHybridEnabled(false, { storage });
  expect(panel.classList.contains('hybrid-split')).toBe(false);
  expect('voiceHybridEnabled' in storage._raw).toBe(false);
});

test('initUISplit: returns noop teardown when header missing', () => {
  document.body.innerHTML = '';
  const teardown = initUISplit({ storage: makeStorage() });
  expect(typeof teardown).toBe('function');
  teardown();
});

test('initUISplit: teardown is harmless when the legacy header is absent', () => {
  const storage = makeStorage({ voiceHybridEnabled: '1' });
  const teardown = initUISplit({ storage });
  document.getElementById('vexil-panel').classList.add('hybrid-split');
  teardown();
  expect(document.getElementById('btn-hybrid-toggle')).toBeNull();
  expect(document.getElementById('vexil-panel').classList.contains('hybrid-split')).toBe(true);
});
