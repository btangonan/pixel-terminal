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

// ── _validatePath (bundled sidecar era) ──────────────────────────────────────

test('_validatePath returns bundled_sidecar mode for null', () => {
  const r = _validatePath(null);
  expect(r.ok).toBe(true);
  expect(r.mode).toBe('bundled_sidecar');
});

test('_validatePath returns bundled_sidecar mode for empty string', () => {
  expect(_validatePath('')).toMatchObject({ ok: true, mode: 'bundled_sidecar' });
  expect(_validatePath('   ')).toMatchObject({ ok: true, mode: 'bundled_sidecar' });
});

test('_validatePath rejects manual paths (absolute)', () => {
  const r = _validatePath('/Users/brad/Projects/OmiWebhook');
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('manual_path_removed');
});

test('_validatePath rejects manual paths (tilde)', () => {
  const r = _validatePath('~/Projects/OmiWebhook');
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('manual_path_removed');
});

test('_validatePath rejects manual paths (relative)', () => {
  expect(_validatePath('OmiWebhook')).toMatchObject({ ok: false, reason: 'manual_path_removed' });
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

test('_probePort uses invokeFn for STT port when provided', async () => {
  const invokeFn = vi.fn().mockResolvedValue({ stt_port_open: true, tts_port_open: false });
  const r = await _probePort({ port: 9876, invokeFn });
  expect(invokeFn).toHaveBeenCalledWith('voice_sidecar_health');
  expect(r.ok).toBe(true);
  expect(r.reason).toBe('health_check');
});

test('_probePort uses invokeFn for TTS port when provided', async () => {
  const invokeFn = vi.fn().mockResolvedValue({ stt_port_open: false, tts_port_open: true });
  const r = await _probePort({ port: 9877, invokeFn });
  expect(r.ok).toBe(true);
  expect(r.reason).toBe('health_check');
});

test('_probePort returns health_check_failed when invokeFn throws', async () => {
  const invokeFn = vi.fn().mockRejectedValue(new Error('tauri error'));
  const r = await _probePort({ port: 9876, invokeFn });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('health_check_failed');
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

test('Step 2 has Start voice services button (no path input)', () => {
  const overlay = initOnboarding();
  overlay.querySelector('[data-vo-next="2"]').click();
  expect(overlay.querySelector('[data-vo-start-sidecar]')).not.toBeNull();
  expect(overlay.querySelector('#vo-bridge-path')).toBeNull();
});

test('Finish with TTS toggled sets ttsEnabled=1 (no voiceBridgePath)', async () => {
  const invokeFn = vi.fn().mockResolvedValue({ stt_port_open: true, tts_port_open: true });
  const win = { ...window, __TAURI__: { core: { invoke: invokeFn } }, localStorage: window.localStorage };
  const overlay = initOnboarding({ win });
  // Advance to step 2 → click Start → advances to step 3 (probes run)
  overlay.querySelector('[data-vo-next="2"]').click();
  overlay.querySelector('[data-vo-start-sidecar]').click();
  await new Promise((r) => setTimeout(r, 10));
  // Advance to step 4
  overlay.querySelector('[data-vo-step="3"] [data-vo-primary]').click();
  overlay.querySelector('[data-vo-tts]').checked = true;
  overlay.querySelector('[data-vo-finish]').click();

  expect(window.localStorage.getItem('voiceOnboardingComplete')).toBe('1');
  expect(window.localStorage.getItem('ttsEnabled')).toBe('1');
  expect(window.localStorage.getItem('voiceBridgePath')).toBeNull();
  expect(window.localStorage.getItem('ttsBridgeUrl')).toBeNull();
});

test('Finish without toggling TTS leaves ttsEnabled unset', async () => {
  const invokeFn = vi.fn().mockResolvedValue({ stt_port_open: true, tts_port_open: true });
  const win = { ...window, __TAURI__: { core: { invoke: invokeFn } }, localStorage: window.localStorage };
  const overlay = initOnboarding({ win });
  overlay.querySelector('[data-vo-next="2"]').click();
  overlay.querySelector('[data-vo-skip-start]').click();
  await new Promise((r) => setTimeout(r, 10));
  overlay.querySelector('[data-vo-step="3"] [data-vo-primary]').click();
  overlay.querySelector('[data-vo-finish]').click();

  expect(window.localStorage.getItem('ttsEnabled')).toBeNull();
  expect(window.localStorage.getItem('voiceBridgePath')).toBeNull();
});

test('_resetOnboarding clears the complete flag so wizard reopens', () => {
  window.localStorage.setItem('voiceOnboardingComplete', '1');
  _resetOnboarding();
  expect(window.localStorage.getItem('voiceOnboardingComplete')).toBeNull();
});

test('Probe UI shows green+red when STT up and TTS down via invokeFn', async () => {
  const invokeFn = vi.fn().mockResolvedValue({ stt_port_open: true, tts_port_open: false });
  const win = { ...window, __TAURI__: { core: { invoke: invokeFn } }, localStorage: window.localStorage };
  const overlay = initOnboarding({ win });
  overlay.querySelector('[data-vo-next="2"]').click();
  overlay.querySelector('[data-vo-start-sidecar]').click();

  await new Promise((r) => setTimeout(r, 30));
  const stt = overlay.querySelector('[data-vo-probe="stt"]');
  const tts = overlay.querySelector('[data-vo-probe="tts"]');
  expect(stt.classList.contains('ok')).toBe(true);
  expect(tts.classList.contains('bad')).toBe(true);
});
