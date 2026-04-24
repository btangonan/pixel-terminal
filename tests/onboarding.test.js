/**
 * onboarding.test.js — first-run wizard behavior.
 *
 * Covers the public entry point (`initOnboarding`) and the testable internals
 * (`_validatePath`, `_probePort`). DOM comes from jsdom; WS is mocked.
 */
import { beforeEach, test, expect, vi } from 'vitest';
import {
  initOnboarding,
  _validatePath,
  _probePort,
  _resetOnboarding,
} from '../src/onboarding.js';

beforeEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
});

// ── _validatePath ─────────────────────────────────────────────────────────────

test('_validatePath accepts absolute /Users path', () => {
  const r = _validatePath('/Users/brad/Projects/OmiWebhook');
  expect(r.ok).toBe(true);
  expect(r.path).toBe('/Users/brad/Projects/OmiWebhook');
});

test('_validatePath accepts tilde-home path', () => {
  const r = _validatePath('~/Projects/OmiWebhook');
  expect(r.ok).toBe(true);
});

test('_validatePath rejects empty string', () => {
  expect(_validatePath('')).toMatchObject({ ok: false, reason: 'empty' });
  expect(_validatePath('   ')).toMatchObject({ ok: false, reason: 'empty' });
});

test('_validatePath rejects relative paths', () => {
  expect(_validatePath('OmiWebhook')).toMatchObject({ ok: false, reason: 'not_absolute' });
  // `./` doesn't start with / or ~ so not_absolute catches it first
  expect(_validatePath('./OmiWebhook')).toMatchObject({ ok: false, reason: 'not_absolute' });
});

test('_validatePath rejects shell metacharacters', () => {
  // Each of these would break a shell interpolation.
  for (const bad of [
    '/Users/a;rm -rf /',
    '/Users/a`whoami`',
    '/Users/a$(id)',
    '/Users/a|nc',
    '/Users/a > /tmp/x',
    '/Users/a&',
  ]) {
    expect(_validatePath(bad)).toMatchObject({ ok: false, reason: 'unsafe_chars' });
  }
});

// ── _probePort ────────────────────────────────────────────────────────────────

function mockWsFactory({ behavior }) {
  return (url) => {
    const ws = {
      url,
      close: vi.fn(),
      onopen: null, onerror: null, onclose: null,
    };
    queueMicrotask(() => {
      if (behavior === 'open' && ws.onopen) ws.onopen();
      else if (behavior === 'error' && ws.onerror) ws.onerror();
      else if (behavior === 'close' && ws.onclose) ws.onclose();
      // 'hang' → never fires anything; probe hits timeout
    });
    return ws;
  };
}

test('_probePort resolves ok:true on open', async () => {
  const r = await _probePort({ port: 9877, wsFactory: mockWsFactory({ behavior: 'open' }) });
  expect(r.ok).toBe(true);
  expect(r.reason).toBe('open');
});

test('_probePort resolves ok:false on error', async () => {
  const r = await _probePort({ port: 9877, wsFactory: mockWsFactory({ behavior: 'error' }) });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('error');
});

test('_probePort resolves ok:false on timeout', async () => {
  const r = await _probePort({
    port: 9877, timeoutMs: 20,
    wsFactory: mockWsFactory({ behavior: 'hang' }),
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('timeout');
});

test('_probePort resolves ok:false when WebSocket constructor throws', async () => {
  const r = await _probePort({
    port: 9877,
    wsFactory: () => { throw new Error('refused'); },
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('construct_failed');
});

// ── initOnboarding ────────────────────────────────────────────────────────────

test('initOnboarding returns null when already completed', () => {
  window.localStorage.setItem('voiceOnboardingComplete', '1');
  const overlay = initOnboarding();
  expect(overlay).toBeNull();
  expect(document.querySelector('.voice-onboarding-overlay')).toBeNull();
});

test('initOnboarding appends the modal on first run', () => {
  const overlay = initOnboarding();
  expect(overlay).not.toBeNull();
  expect(document.querySelector('.voice-onboarding-overlay')).toBe(overlay);
  // Step 1 visible, others hidden
  expect(overlay.querySelector('[data-vo-step="1"]').classList.contains('hidden')).toBe(false);
  expect(overlay.querySelector('[data-vo-step="2"]').classList.contains('hidden')).toBe(true);
});

test('Skip sets voiceOnboardingComplete=1 and removes the overlay', () => {
  const overlay = initOnboarding();
  overlay.querySelector('[data-vo-skip]').click();
  expect(window.localStorage.getItem('voiceOnboardingComplete')).toBe('1');
  expect(document.querySelector('.voice-onboarding-overlay')).toBeNull();
});

test('Step 2 Next button is disabled until path validates', () => {
  const overlay = initOnboarding();
  overlay.querySelector('[data-vo-next="2"]').click();
  const input = overlay.querySelector('#vo-bridge-path');
  const next = overlay.querySelector('[data-vo-step="2"] [data-vo-primary]');
  expect(next.disabled).toBe(true);

  input.value = 'not-absolute';
  input.dispatchEvent(new Event('input'));
  expect(next.disabled).toBe(true);

  input.value = '/Users/brad/Projects/OmiWebhook';
  input.dispatchEvent(new Event('input'));
  expect(next.disabled).toBe(false);
});

test('Finish persists bridge path + tts flag when toggled', async () => {
  const overlay = initOnboarding({ wsFactory: mockWsFactory({ behavior: 'open' }) });
  // Advance through wizard
  overlay.querySelector('[data-vo-next="2"]').click();
  const input = overlay.querySelector('#vo-bridge-path');
  input.value = '/Users/brad/Projects/OmiWebhook';
  input.dispatchEvent(new Event('input'));
  overlay.querySelector('[data-vo-step="2"] [data-vo-primary]').click();
  // Allow probe microtask + setState to flush
  await new Promise((r) => setTimeout(r, 10));
  overlay.querySelector('[data-vo-step="3"] [data-vo-primary]').click();
  overlay.querySelector('[data-vo-tts]').checked = true;
  overlay.querySelector('[data-vo-finish]').click();

  expect(window.localStorage.getItem('voiceOnboardingComplete')).toBe('1');
  expect(window.localStorage.getItem('voiceBridgePath')).toBe('/Users/brad/Projects/OmiWebhook');
  expect(window.localStorage.getItem('ttsEnabled')).toBe('1');
  expect(window.localStorage.getItem('ttsBridgeUrl')).toBe('ws://127.0.0.1:9877');
});

test('Finish without toggling TTS leaves ttsEnabled unset', async () => {
  const overlay = initOnboarding({ wsFactory: mockWsFactory({ behavior: 'open' }) });
  overlay.querySelector('[data-vo-next="2"]').click();
  const input = overlay.querySelector('#vo-bridge-path');
  input.value = '~/Projects/OmiWebhook';
  input.dispatchEvent(new Event('input'));
  overlay.querySelector('[data-vo-step="2"] [data-vo-primary]').click();
  await new Promise((r) => setTimeout(r, 10));
  overlay.querySelector('[data-vo-step="3"] [data-vo-primary]').click();
  overlay.querySelector('[data-vo-finish]').click();

  expect(window.localStorage.getItem('ttsEnabled')).toBeNull();
  expect(window.localStorage.getItem('voiceBridgePath')).toBe('~/Projects/OmiWebhook');
});

test('_resetOnboarding clears the complete flag so wizard reopens', () => {
  window.localStorage.setItem('voiceOnboardingComplete', '1');
  _resetOnboarding();
  expect(window.localStorage.getItem('voiceOnboardingComplete')).toBeNull();
});

test('Probe UI shows green+red when STT up and TTS down', async () => {
  // STT opens, TTS hangs → timeout fires at 20ms.
  let call = 0;
  const mixedFactory = (url) => {
    call += 1;
    const behavior = call === 1 ? 'open' : 'error';
    return mockWsFactory({ behavior })(url);
  };

  const overlay = initOnboarding({ wsFactory: mixedFactory });
  overlay.querySelector('[data-vo-next="2"]').click();
  const input = overlay.querySelector('#vo-bridge-path');
  input.value = '/Users/brad/Projects/OmiWebhook';
  input.dispatchEvent(new Event('input'));
  overlay.querySelector('[data-vo-step="2"] [data-vo-primary]').click();

  await new Promise((r) => setTimeout(r, 30));
  const stt = overlay.querySelector('[data-vo-probe="stt"]');
  const tts = overlay.querySelector('[data-vo-probe="tts"]');
  expect(stt.classList.contains('ok')).toBe(true);
  expect(tts.classList.contains('bad')).toBe(true);
});
