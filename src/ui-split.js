/**
 * ui-split.js — hybrid voice/text split-pane toggle.
 *
 * Keeps programmatic split-pane state for legacy callers:
 *   - Left:  live voice transcript (`#voice-log`)
 *   - Right: oracle chat / vexil log
 *
 * Pure CSS does the layout (`.hybrid-split` class on `#vexil-panel`); this
 * module owns the localStorage flag and the `pixel:hybrid-toggle` DOM event
 * so voice.js / oracle code can react
 * without a hard dependency.
 *
 * Default-off. Persists to `localStorage.voiceHybridEnabled` ('1' = on).
 *
 * Public API:
 *     initUISplit({ doc?, storage? })  → teardown function
 *     isHybridEnabled(storage?)        → boolean
 *     setHybridEnabled(on, opts?)      → boolean (new state)
 */

const LS_KEY = 'voiceHybridEnabled';
const SPLIT_CLASS = 'hybrid-split';
const EVENT_NAME = 'pixel:hybrid-toggle';
const TOGGLE_ID = 'btn-hybrid-toggle';

function _storage(storage) {
  return storage || (typeof localStorage !== 'undefined' ? localStorage : null);
}

export function isHybridEnabled(storage) {
  const s = _storage(storage);
  if (!s) return false;
  try { return s.getItem(LS_KEY) === '1'; } catch { return false; }
}

export function setHybridEnabled(on, { doc = document, storage } = {}) {
  const enabled = !!on;
  const s = _storage(storage);
  if (s) {
    try {
      if (enabled) s.setItem(LS_KEY, '1');
      else s.removeItem(LS_KEY);
    } catch { /* storage disabled — proceed */ }
  }
  const panel = doc.getElementById('vexil-panel');
  if (panel) panel.classList.toggle(SPLIT_CLASS, enabled);
  const btn = doc.getElementById(TOGGLE_ID);
  if (btn) {
    btn.classList.toggle('active', enabled);
    btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  }
  doc.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { enabled } }));
  return enabled;
}

/**
 * initUISplit — legacy entry point. The visible split toggle was removed from
 * the oracle card, so app startup should not inject any controls.
 *
 * Returns a teardown that removes any stale toggle button.
 */
export function initUISplit({ doc = document, storage } = {}) {
  return () => {
    doc.getElementById(TOGGLE_ID)?.remove();
  };
}
