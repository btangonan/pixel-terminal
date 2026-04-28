/**
 * settings-ui.js — P2.H Settings UI for ANIMA_PERMISSION_MODE.
 *
 * Three-way selector (bypass / default / gated) persisted to
 *   ~/.config/pixel-terminal/settings.json  →  { "permissionMode": "..." }
 *
 * The file is read once at startup in app.js and hydrated onto
 * window.__ANIMA_PERMISSION_MODE__. This module mutates that global AND
 * writes the file whenever the user changes modes. Changes apply to the
 * next session spawn — existing sessions keep their spawn-time mode.
 *
 * Switching TO bypass requires explicit confirmation via showConfirm()
 * because bypass = --dangerously-skip-permissions (every tool auto-allows).
 * Switching FROM bypass (to default or gated) does NOT require confirmation.
 *
 * No file-writes on initial render: we only write after a user click.
 */

import { $, showConfirm } from './dom.js';

const SETTINGS_PATH = '~/.config/pixel-terminal/settings.json';
const VALID_MODES = new Set(['bypass', 'default', 'gated']);

const BYPASS_WARNING =
  'Switch to BYPASS mode?\n\n' +
  'BYPASS auto-allows every tool call with no prompt — files written, shell\n' +
  'commands run, anything Claude decides. There is no safety net. Only use\n' +
  'this for trusted internal experiments.\n\n' +
  'GATED (recommended) or DEFAULT both keep a human in the loop.';

let initialized = false;

function currentMode() {
  const raw = window.__ANIMA_PERMISSION_MODE__;
  return typeof raw === 'string' && VALID_MODES.has(raw.toLowerCase())
    ? raw.toLowerCase()
    : 'default';
}

function paintActive() {
  const mode = currentMode();
  $.permModeBypass?.classList.toggle('active', mode === 'bypass');
  $.permModeDefault?.classList.toggle('active', mode === 'default');
  $.permModeGated?.classList.toggle('active', mode === 'gated');
}

async function persist(mode) {
  const { invoke } = window.__TAURI__.core;
  let existing = {};
  try {
    const raw = await invoke('read_file_as_text', { path: SETTINGS_PATH });
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object') existing = parsed;
  } catch { /* file doesn't exist yet — fine */ }
  existing.permissionMode = mode;
  const content = JSON.stringify(existing, null, 2);
  await invoke('write_file_as_text', { path: SETTINGS_PATH, content });
}

async function selectMode(next) {
  if (!VALID_MODES.has(next)) return;
  const prev = currentMode();
  if (prev === next) return;

  if (next === 'bypass') {
    const confirmed = await showConfirm(BYPASS_WARNING, 'enable bypass');
    if (!confirmed) { paintActive(); return; }
  }

  window.__ANIMA_PERMISSION_MODE__ = next;
  paintActive();
  try {
    await persist(next);
    try {
      const { invoke } = window.__TAURI__.core;
      invoke('js_log', { msg: `[settings] permission mode ${prev} → ${next}` }).catch(() => {});
    } catch {}
  } catch (e) {
    console.warn('[settings] persist failed:', e);
  }
}

export function initSettingsUI() {
  if (initialized) return;
  initialized = true;
  paintActive();
  $.permModeBypass?.addEventListener('click', () => selectMode('bypass'));
  $.permModeDefault?.addEventListener('click', () => selectMode('default'));
  $.permModeGated?.addEventListener('click', () => selectMode('gated'));
}

export function refreshSettingsUI() {
  paintActive();
}
