/**
 * onboarding.js — first-run voice setup wizard.
 *
 * Runs once when localStorage.voiceOnboardingComplete !== '1'. Walks the user
 * through:
 *
 *   1. Welcome / what this enables (STT + TTS, local-first, $0 cost)
 *   2. Voice-bridge path — location of the OmiWebhook checkout.
 *      Writes to localStorage.voiceBridgePath. Claude validated for shell-
 *      metacharacter safety at call-site in voice.js.
 *   3. Connection test — attempts a brief ws handshake on the STT port and
 *      the TTS port. Shows GREEN/RED per port.
 *   4. Opt-in toggles — mic (voice in) + tts (voice out). Both default OFF.
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
const LS_BRIDGE_PATH = 'voiceBridgePath';
const LS_TTS_ENABLED = 'ttsEnabled';
const LS_TTS_URL = 'ttsBridgeUrl';

const DEFAULT_STT_PORT = 9876;
const DEFAULT_TTS_PORT = 9877;
const DEFAULT_HOST = '127.0.0.1';
const PROBE_TIMEOUT_MS = 1500;

// Reject characters that could break the single-quoted shell interpolation in
// voice.js. `~` is intentionally allowed because it's a valid path anchor;
// tilde expansion only fires at word-start and voice.js quotes the path anyway.
const SHELL_METACHARS_RE = /[;&|`$(){}[\]!#<>*?"'\\]/;

export function _validatePath(p) {
  if (!p || typeof p !== 'string') return { ok: false, reason: 'empty' };
  const trimmed = p.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (SHELL_METACHARS_RE.test(trimmed)) return { ok: false, reason: 'unsafe_chars' };
  if (!trimmed.startsWith('/') && !trimmed.startsWith('~')) return { ok: false, reason: 'not_absolute' };
  return { ok: true, path: trimmed };
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
export function _probePort({ host = DEFAULT_HOST, port, wsFactory, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
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
        <label for="vo-bridge-path">Voice bridge path</label>
        <input id="vo-bridge-path" type="text" spellcheck="false" autocomplete="off"
               placeholder="/Users/you/Projects/OmiWebhook" />
        <p class="voice-onboarding-hint" data-vo-path-hint>Absolute path only. No shell metacharacters.</p>
        <div class="voice-onboarding-nav">
          <button type="button" data-vo-back="1">Back</button>
          <button type="button" data-vo-next="3" data-vo-primary disabled>Test connection</button>
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

async function _runProbes(overlay, wsFactory) {
  const sttItem = overlay.querySelector('[data-vo-probe="stt"]');
  const ttsItem = overlay.querySelector('[data-vo-probe="tts"]');
  const hint = overlay.querySelector('[data-vo-probe-hint]');
  sttItem?.classList.remove('ok', 'bad');
  ttsItem?.classList.remove('ok', 'bad');

  const [stt, tts] = await Promise.all([
    _probePort({ port: DEFAULT_STT_PORT, wsFactory }),
    _probePort({ port: DEFAULT_TTS_PORT, wsFactory }),
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

  const overlay = _buildDom(doc);
  doc.body.appendChild(overlay);
  _show(overlay, 1);

  const finish = (save = {}) => {
    win.localStorage.setItem(LS_COMPLETE, '1');
    if (save.bridgePath) win.localStorage.setItem(LS_BRIDGE_PATH, save.bridgePath);
    if (save.ttsEnabled === true) {
      win.localStorage.setItem(LS_TTS_ENABLED, '1');
      win.localStorage.setItem(LS_TTS_URL, `ws://${DEFAULT_HOST}:${DEFAULT_TTS_PORT}`);
    }
    overlay.remove();
  };

  overlay.querySelector('[data-vo-skip]')?.addEventListener('click', () => finish());

  // Step 2 input → enables Test-connection button only on valid path
  const pathInput = overlay.querySelector('#vo-bridge-path');
  const pathHint = overlay.querySelector('[data-vo-path-hint]');
  const step2Next = overlay.querySelector('[data-vo-step="2"] [data-vo-primary]');
  // Prefill if previously saved
  const priorPath = win.localStorage.getItem(LS_BRIDGE_PATH) || '';
  if (priorPath && pathInput) pathInput.value = priorPath;
  const _validateInput = () => {
    const v = _validatePath(pathInput?.value || '');
    if (!v.ok) {
      step2Next.disabled = true;
      if (pathHint) pathHint.textContent =
        v.reason === 'not_absolute' ? 'Use an absolute path (starts with / or ~).'
        : v.reason === 'unsafe_chars' ? 'Path contains unsafe characters.'
        : 'Enter the absolute path to your OmiWebhook checkout.';
    } else {
      step2Next.disabled = false;
      if (pathHint) pathHint.textContent = 'Looks good.';
    }
  };
  pathInput?.addEventListener('input', _validateInput);
  _validateInput();

  // Navigation: back/next buttons scoped per step
  overlay.querySelectorAll('[data-vo-next]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = Number(btn.dataset.voNext);
      if (target === 3) {
        const v = _validatePath(pathInput?.value || '');
        if (!v.ok) return;
        win.localStorage.setItem(LS_BRIDGE_PATH, v.path);
        _show(overlay, 3);
        await _runProbes(overlay, wsFactory);
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
    const bridgePath = _validatePath(pathInput?.value || '').path || '';
    finish({ bridgePath, ttsEnabled });
  });

  return overlay;
}

// Testing seam — caller can reset the flag to rerun the wizard.
export function _resetOnboarding(win = window) {
  win.localStorage.removeItem(LS_COMPLETE);
}
