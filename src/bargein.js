/**
 * bargein.js — client-side TTS barge-in observer.
 *
 * Listens to the same `omi:command` Tauri channel voice.js uses. When a
 * transcript (or voice prompt) arrives, emits a `pixel:bargein` DOM event
 * on `document`. The TTS player in voice.js listens for that event and
 * flushes its AudioContext + sends the voice/v1 cancel frame.
 *
 * This observer is intentionally decoupled from voice.js state so that:
 *   (a) it's easy to unit-test without the full voice wiring
 *   (b) server-side VOICE_BARGEIN_ENABLED=1 (OmiWebhook voice_bargein.py)
 *       can eventually emit its own {type:"bargein"} frame and this
 *       module can normalize both paths into the same DOM event.
 *
 * Public API:
 *     initBargeIn({ tauriListen?, doc? })  → teardown function
 *     onBargeIn(handler)                    → unsubscribe function
 *     _handleOmiCommand(payload, doc)       → testing seam (pure)
 */

const BARGEIN_EVENT = 'pixel:bargein';

const _handlers = new Set();

/**
 * _handleOmiCommand — pure dispatcher: given an omi:command payload and a
 * document, decide whether to emit pixel:bargein. Exported for tests.
 *
 * Triggers on:
 *   - type === 'prompt'                   (voice → oracle routing already fires)
 *   - type === 'transcript' && dispatched (a dispatched transcript = user
 *                                          issued a command during playback)
 *   - type === 'bargein'                  (future: server-side VAD frame)
 */
export function _handleOmiCommand(payload, doc = document) {
  if (!payload || typeof payload !== 'object') return false;
  const { type, dispatched } = payload;
  const shouldFire =
    type === 'prompt' ||
    type === 'bargein' ||
    (type === 'transcript' && dispatched === true);
  if (!shouldFire) return false;

  const evt = new CustomEvent(BARGEIN_EVENT, { detail: { reason: type, payload } });
  doc.dispatchEvent(evt);
  for (const fn of _handlers) {
    try { fn(evt.detail); } catch (err) { console.warn('[bargein] handler threw:', err); }
  }
  return true;
}

/**
 * onBargeIn — subscribe a callback invoked whenever bargein fires.
 * Callback receives { reason, payload } — same shape as CustomEvent.detail.
 * Returns an unsubscribe function.
 */
export function onBargeIn(handler) {
  _handlers.add(handler);
  return () => _handlers.delete(handler);
}

/**
 * initBargeIn — install the Tauri event listener. Returns a teardown.
 *
 * tauriListen defaults to window.__TAURI__.event.listen (production) but
 * can be injected for tests so the suite doesn't touch real Tauri globals.
 */
export function initBargeIn({ tauriListen, doc = document } = {}) {
  const listenFn = tauriListen || (window.__TAURI__?.event?.listen);
  if (!listenFn) {
    console.warn('[bargein] tauriListen unavailable — observer inactive');
    return () => {};
  }
  let unlisten = () => {};
  const p = listenFn('omi:command', (event) => _handleOmiCommand(event?.payload, doc));
  // tauriListen returns a Promise<UnlistenFn>
  if (p && typeof p.then === 'function') {
    p.then((fn) => { unlisten = fn || unlisten; }).catch((err) => {
      console.warn('[bargein] listen failed:', err);
    });
  } else if (typeof p === 'function') {
    unlisten = p;
  }
  return () => {
    try { unlisten(); } catch {}
    _handlers.clear();
  };
}
