/**
 * ui-split.js — hybrid voice/text split-pane toggle.
 *
 * Adds a toggle in the voice-log header that splits `#vexil-panel` into
 * two side-by-side columns:
 *   - Left:  live voice transcript (`#voice-log`)
 *   - Right: oracle chat / vexil log
 *
 * Pure CSS does the layout (`.hybrid-split` class on `#vexil-panel`); this
 * module just owns the toggle button, the localStorage flag, and the
 * `pixel:hybrid-toggle` DOM event so voice.js / oracle code can react
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
 * initUISplit — install the toggle button into the voice-log header and
 * rehydrate state from localStorage. Safe to call multiple times; the
 * toggle button is deduped by id.
 *
 * Returns a teardown that removes the button + clears the split class.
 */
export function initUISplit({ doc = document, storage } = {}) {
  const header = doc.getElementById('voice-log-header');
  if (!header) {
    return () => {};
  }
  let btn = doc.getElementById(TOGGLE_ID);
  if (!btn) {
    btn = doc.createElement('button');
    btn.id = TOGGLE_ID;
    btn.className = 'hybrid-toggle-btn';
    btn.title = 'Toggle hybrid voice/text split view';
    btn.setAttribute('aria-label', 'Toggle hybrid voice/text split view');
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = '⇋';
    header.appendChild(btn);
  }

  const onClick = () => {
    setHybridEnabled(!isHybridEnabled(storage), { doc, storage });
  };
  btn.addEventListener('click', onClick);

  // Rehydrate from storage on init
  setHybridEnabled(isHybridEnabled(storage), { doc, storage });

  return () => {
    btn.removeEventListener('click', onClick);
    if (btn.parentNode) btn.parentNode.removeChild(btn);
    const panel = doc.getElementById('vexil-panel');
    if (panel) panel.classList.remove(SPLIT_CLASS);
  };
}
