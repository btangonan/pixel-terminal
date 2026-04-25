/**
 * onboarding.js — first-run voice setup wizard.
 *
 * Runs once when localStorage.voiceOnboardingComplete !== '1'. Walks the user
 * through:
 *
 *   1. Welcome / what this enables (STT + TTS, local-first, $0 cost)
 *   2. Sidecar readiness — starts bundled anima-stt + anima-tts via Tauri invoke.
 *   3. Connection test — probes STT + TTS ports via voice_sidecar_health.
 *   4. Opt-in toggles — tts (voice out). Default OFF.
 *      Flipping tts=on flips localStorage.ttsEnabled=1.
 *
 * Cancellable at any step — skipping sets voiceOnboardingComplete=1 anyway
 * so the wizard never re-opens without user request. "Rerun" is exposed in
 * Settings UI (PR-D hooks in).
 *
 * Testable surface: pure functions (_buildDom, _validatePath, _probePort)
 * exported for vitest. The public `initOnboarding()` is fire-and-forget.
 */

const LS_COMPLETE = 'voiceOnboardingComplete';
const LS_TTS_ENABLED = 'ttsEnabled';

const DEFAULT_STT_PORT = 9876;
const DEFAULT_TTS_PORT = 9877;
const DEFAULT_HOST = '127.0.0.1';
const PROBE_TIMEOUT_MS = 1500;

// _validatePath: bundled sidecar era — no manual path needed.
// Empty/null → ok (bundled sidecar mode). Non-empty → rejected (manual paths removed).
export function _validatePath(p) {
  if (p == null || String(p).trim() === '') return { ok: true, mode: 'bundled_sidecar' };
  return { ok: false, reason: 'manual_path_removed' };
}

/**
 * _probePort — open a WebSocket with a short timeout and report success/fail.
 *
 * We don't send the voice/v1 hello here; we only verify the port is accepting
 * connections. A failed probe means the bridge isn't running, not that it's
 * misconfigured — the UI should direct the user to start it.
 *
 * wsFactory is injectable for tests.
 */
export async function _probePort({ host = DEFAULT_HOST, port, wsFactory, timeoutMs = PROBE_TIMEOUT_MS, invokeFn } = {}) {
  if (invokeFn) {
    try {
      const status = await invokeFn('voice_sidecar_health');
      if (port === DEFAULT_STT_PORT) {
        return { ok: Boolean(status.stt_port_open ?? status.sttPortOpen ?? status.stt_running ?? status.sttRunning), reason: 'health_check' };
      }
      if (port === DEFAULT_TTS_PORT) {
        return { ok: Boolean(status.tts_port_open ?? status.ttsPortOpen ?? status.tts_running ?? status.ttsRunning), reason: 'health_check' };
      }
    } catch {
      return { ok: false, reason: 'health_check_failed' };
    }
  }
  // WebSocket fallback for tests / environments without Tauri invoke
  const factory = wsFactory || ((url) => new WebSocket(url));
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      try { ws && ws.close && ws.close(); } catch {}
      resolve({ ok, reason });
    };
    try {
      ws = factory(`ws://${host}:${port}`);
    } catch (err) {
      finish(false, 'construct_failed');
      return;
    }
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    ws.onopen = () => { clearTimeout(timer); finish(true, 'open'); };
    ws.onerror = () => { clearTimeout(timer); finish(false, 'error'); };
    ws.onclose = () => { clearTimeout(timer); if (!settled) finish(false, 'closed'); };
  });
}

export function _buildDom(doc = document) {
  const overlay = doc.createElement('div');
  overlay.id = 'voice-onboarding-overlay';
  overlay.className = 'voice-onboarding-overlay';
  overlay.innerHTML = `
    <div class="voice-onboarding-modal" role="dialog" aria-labelledby="vo-title" aria-modal="true">
      <header class="voice-onboarding-header">
        <h2 id="vo-title">Voice setup</h2>
        <button type="button" class="voice-onboarding-skip" data-vo-skip>Skip</button>
      </header>
      <section class="voice-onboarding-step" data-vo-step="1">
        <p>Anima can talk and listen locally — $0, on-device, Apple Silicon.</p>
        <p class="voice-onboarding-hint">You'll need the <code>OmiWebhook</code> repo cloned and its venv ready.</p>
        <div class="voice-onboarding-nav">
          <button type="button" data-vo-next="2">Get started</button>
        </div>
      </section>
      <section class="voice-onboarding-step hidden" data-vo-step="2">
        <p>Anima bundles the voice services. Click below to start them.</p>
        <p class="voice-onboarding-hint" data-vo-sidecar-hint></p>
        <div class="voice-onboarding-nav">
          <button type="button" data-vo-back="1">Back</button>
          <button type="button" data-vo-start-sidecar data-vo-primary>Start voice services</button>
          <button type="button" data-vo-next="3" data-vo-skip-start>Skip</button>
        </div>
      </section>
      <section class="voice-onboarding-step hidden" data-vo-step="3">
        <p>Checking bridges…</p>
        <ul class="voice-onboarding-probe">
          <li data-vo-probe="stt"><span class="voice-onboarding-dot"></span> STT (port ${DEFAULT_STT_PORT})</li>
          <li data-vo-probe="tts"><span class="voice-onboarding-dot"></span> TTS (port ${DEFAULT_TTS_PORT})</li>
        </ul>
        <p class="voice-onboarding-hint" data-vo-probe-hint></p>
        <div class="voice-onboarding-nav">
          <button type="button" data-vo-back="2">Back</button>
          <button type="button" data-vo-next="4" data-vo-primary>Continue</button>
        </div>
      </section>
      <section class="voice-onboarding-step hidden" data-vo-step="4">
        <label class="voice-onboarding-toggle">
          <input type="checkbox" data-vo-tts /> Enable voice output (Claude speaks replies)
        </label>
        <p class="voice-onboarding-hint">You can change this later in Settings.</p>
        <div class="voice-onboarding-nav">
          <button type="button" data-vo-back="3">Back</button>
          <button type="button" data-vo-finish data-vo-primary>Finish</button>
        </div>
      </section>
    </div>
  `;
  return overlay;
}

function _show(overlay, step) {
  overlay.querySelectorAll('[data-vo-step]').forEach((s) => {
    s.classList.toggle('hidden', s.dataset.voStep !== String(step));
  });
}

async function _runProbes(overlay, wsFactory, invokeFn) {
  const sttItem = overlay.querySelector('[data-vo-probe="stt"]');
  const ttsItem = overlay.querySelector('[data-vo-probe="tts"]');
  const hint = overlay.querySelector('[data-vo-probe-hint]');
  sttItem?.classList.remove('ok', 'bad');
  ttsItem?.classList.remove('ok', 'bad');

  const [stt, tts] = await Promise.all([
    _probePort({ port: DEFAULT_STT_PORT, wsFactory, invokeFn }),
    _probePort({ port: DEFAULT_TTS_PORT, wsFactory, invokeFn }),
  ]);
  sttItem?.classList.add(stt.ok ? 'ok' : 'bad');
  ttsItem?.classList.add(tts.ok ? 'ok' : 'bad');
  if (hint) {
    if (stt.ok && tts.ok) {
      hint.textContent = 'Both bridges reachable. You can continue.';
    } else if (!stt.ok && !tts.ok) {
      hint.textContent = 'Neither bridge is running. Start OmiWebhook/start.sh and start_tts_bridge.command, then Back → Test again.';
    } else if (!stt.ok) {
      hint.textContent = 'STT bridge not reachable. Start OmiWebhook/start.sh.';
    } else {
      hint.textContent = 'TTS bridge not reachable. Start OmiWebhook/start_tts_bridge.command.';
    }
  }
  return { stt, tts };
}

export function initOnboarding({ doc = document, win = window, wsFactory } = {}) {
  // Skip if the user has already completed or dismissed the wizard.
  if (win.localStorage.getItem(LS_COMPLETE) === '1') return null;

  const invokeFn = win.__TAURI__?.core?.invoke;

  const overlay = _buildDom(doc);
  doc.body.appendChild(overlay);
  _show(overlay, 1);

  const finish = (save = {}) => {
    win.localStorage.setItem(LS_COMPLETE, '1');
    if (save.ttsEnabled === true) {
      win.localStorage.setItem(LS_TTS_ENABLED, '1');
    }
    overlay.remove();
  };

  overlay.querySelector('[data-vo-skip]')?.addEventListener('click', () => finish());

  // Step 2: start bundled sidecars
  const sidecarHint = overlay.querySelector('[data-vo-sidecar-hint]');
  overlay.querySelector('[data-vo-start-sidecar]')?.addEventListener('click', async () => {
    if (sidecarHint) sidecarHint.textContent = 'Starting voice services…';
    if (invokeFn) {
      try {
        await invokeFn('start_voice_sidecar', { source: win.localStorage.getItem('voiceSource') || 'mic' });
        if (sidecarHint) sidecarHint.textContent = 'Voice services started.';
      } catch (err) {
        if (sidecarHint) sidecarHint.textContent = `Could not start: ${err}`;
        return;
      }
    }
    _show(overlay, 3);
    await _runProbes(overlay, wsFactory, invokeFn);
  });

  // Step 2 skip → go straight to probe (may fail if sidecars not running)
  overlay.querySelector('[data-vo-skip-start]')?.addEventListener('click', async () => {
    _show(overlay, 3);
    await _runProbes(overlay, wsFactory, invokeFn);
  });

  // Navigation: back/next buttons scoped per step
  overlay.querySelectorAll('[data-vo-next]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = Number(btn.dataset.voNext);
      if (target === 3) {
        _show(overlay, 3);
        await _runProbes(overlay, wsFactory, invokeFn);
      } else {
        _show(overlay, target);
      }
    });
  });
  overlay.querySelectorAll('[data-vo-back]').forEach((btn) => {
    btn.addEventListener('click', () => _show(overlay, Number(btn.dataset.voBack)));
  });

  overlay.querySelector('[data-vo-finish]')?.addEventListener('click', () => {
    const ttsEnabled = overlay.querySelector('[data-vo-tts]')?.checked === true;
    finish({ ttsEnabled });
  });

  return overlay;
}

// Testing seam — caller can reset the flag to rerun the wizard.
export function _resetOnboarding(win = window) {
  win.localStorage.removeItem(LS_COMPLETE);
}
