/**
 * companion.js — Vexil Memory Linter companion
 *
 * Polls ~/.local/share/pixel-terminal/vexil_lint.json every 3s. Surfaces violations
 * via a speech bubble anchored to the bottom-right corner of the app. For ASK-tier
 * violations, shows interactive approve/deny buttons and writes vexil_approval.json.
 *
 * Character voice is driven by buddy.json:
 *   ~/.config/pixel-terminal/buddy.json → { species, name, voice, stats, hue }
 *
 * Sprite mapping: buddy.species → SPRITE_DATA key (with fallbacks for
 * species not yet drawn as pixel art).
 */

import { SPRITE_DATA, getActiveSessionId } from './session.js';
import { SPRITES, EYE_CHARS, DEFAULT_EYE, HATS, renderFrame } from './ascii-sprites.js';
import { showOracleCard } from './cards.js';

const { invoke } = window.__TAURI__.core;

// ── IPC directory ─────────────────────────────────────────────────────────────
// Use ~/.local/share/pixel-terminal/ instead of /tmp/ to avoid world-writable
// symlink attacks and multi-user collisions (see PRE_AUDIT_SUMMARY_v2.md #2).

let _ipcDir = null;
async function getIpcDir() {
  if (_ipcDir) return _ipcDir;
  let home = await window.__TAURI__.path.homeDir();
  if (!home.endsWith('/')) home += '/';
  _ipcDir = `${home}.local/share/pixel-terminal/`;
  return _ipcDir;
}

// Lazy path getters (awaitable)
const ipcPath = async (name) => (await getIpcDir()) + name;

// Legacy constants replaced by ipcPath():
//   LINT_PATH    → ipcPath('vexil_lint.json')
//   APPROVAL_PATH → ipcPath('vexil_approval.json')
//   HOOK_GATE_PATH      → ipcPath('pixel_hook_gate.json')
//   HOOK_GATE_RESP_PATH → ipcPath('pixel_hook_gate_response.json')

const POLL_INTERVAL = 3000;   // ms

// ── Species → sprite key fallback map ────────────────────────────────────────
// Fallbacks used until proper pixel art is drawn for each species.

const BUDDY_SPRITE_MAP = {
  dragon:   'dragon',    // ← drawn
  cat:      'cat',
  rabbit:   'rabbit',
  penguin:  'penguin',
  frog:     'frog3',
  octopus:  'octopus',
  axolotl:  'seal',      // semi-aquatic, soft shape
  capybara: 'rat',       // rodent family
  hamster:  'rat',       // rodent family
  owl:      'penguin',   // upright bird shape
  parrot:   'penguin',   // bird
  panda:    'cat2',      // similar head shape
  fox:      'cat',       // feline-adjacent
  koala:    'cat2',      // similar shape
  platypus: 'seal',      // semi-aquatic oddball
  narwhal:  'seal',      // aquatic
  sloth:    'seal',      // slow mammal
  hedgehog: 'cat',       // small mammal
  // S44 species (Claude Code built-in set) — pixel art not yet drawn, use closest analogue
  duck:     'penguin',
  goose:    'penguin',
  blob:     'octopus',
  turtle:   'crab',
  snail:    'snake',
  ghost:    'cat2',
  cactus:   'crab',
  robot:    'cat',
  mushroom: 'frog3',
  chonk:    'seal',
};


// ── Module state ──────────────────────────────────────────────────────────────

let buddy = null;
let _companionInitialized = false;  // singleton guard — species sync runs exactly once
let _vexilLogListener = null;       // registered by voice.js to re-render the Vexil tab
let _oracleResponseListener = null; // registered by voice.js for pre-session ORACLE chat
let _lastLintSeen = '';       // prevent re-showing same lint event
let _lastOpsKey   = '';       // prevent re-showing same ops report
let _approvalPending = false;
let _hookGatePending = false;
let _hookGateReqId   = null;
let _pollActive = false;
let _masterOutOffset = 0;  // line count consumed from vexil_master_out.jsonl

// ── Tauri home dir ────────────────────────────────────────────────────────────

async function getHomeDir() {
  // Tauri v2: use path plugin. No fallback — a wrong path silently breaks buddy loading
  // for every user who isn't the developer. Fail loud instead.
  return await window.__TAURI__.path.homeDir();
}

// ── Buddy loader ──────────────────────────────────────────────────────────────

async function loadBuddy() {
  try {
    const home = await getHomeDir();
    const raw = await invoke('read_file_as_text', { path: `${home}/.config/pixel-terminal/buddy.json` });
    buddy = JSON.parse(raw);
  } catch (e) {
    console.warn('[companion] buddy load failed:', e?.message ?? e);
    buddy = {
      species: 'dragon',
      name: 'Buddy',
      voice: 'default',
      hue: '#FFFFFF',
      stats: { snark: 5, chaos: 5, wisdom: 5, debugging: 5, patience: 5 },
    };
  }
}

// ── DOM injection ─────────────────────────────────────────────────────────────

function injectCompanionPanel() {
  if (document.getElementById('companion-wrap')) return;

  const wrap = document.createElement('div');
  wrap.id = 'companion-wrap';
  wrap.className = 'companion-wrap hidden';

  wrap.innerHTML = `
    <div class="companion-sprite-wrap" id="companion-sprite"></div>
  `;

  // Inject into body (fixed position via CSS)
  document.body.appendChild(wrap);

  // Wire approval dialog buttons (approval uses the neutral system dialog, not the bubble)
  document.getElementById('approval-ok').addEventListener('click', () => writeApproval(true));
  document.getElementById('approval-deny').addEventListener('click', () => writeApproval(false));
}

// ── ASCII sprite rendering + animation ───────────────────────────────────────

let _asciiAnimTimer   = null;  // idle→fidget cycle timer
let _asciiActionTimer = null;  // action frame auto-return timer
let _asciiBlinkTimer  = null;  // eye blink cycle timer
let _asciiPre         = null;  // the live <pre> element
let _asciiState       = 'idle'; // 'idle' | 'fidget' | 'action'
let _asciiBlinking    = false; // true during blink (eyes closed)
let _asciiSpecies     = 'duck';
let _asciiEye         = DEFAULT_EYE;
let _asciiHat         = 'none';

function getEyeChar(buddy) {
  // buddy.eyes may be set by Claude Code sync (e.g. 'sleepy', 'star')
  // or absent — fall back to dot
  const raw = buddy?.eyes ?? 'dot';
  return EYE_CHARS[raw] ?? DEFAULT_EYE;
}

function updateAsciiFrame(frameIdx) {
  if (!_asciiPre) return;
  // During blink, swap eye char to '-' (closed eyes)
  const eye = _asciiBlinking ? '-' : _asciiEye;
  const lines = renderFrame(_asciiSpecies, frameIdx, eye, _asciiHat);
  _asciiPre.textContent = lines.join('\n');
}

function scheduleNextFidget() {
  clearTimeout(_asciiAnimTimer);
  if (!_asciiPre) return;  // panel gone — stop recursing
  // Idle for 3–8 seconds then briefly fidget
  const delay = 3000 + Math.random() * 5000;
  _asciiAnimTimer = setTimeout(() => {
    if (!_asciiPre) return;  // panel removed between schedule and fire
    if (_asciiState !== 'idle') { scheduleNextFidget(); return; }
    _asciiState = 'fidget';
    updateAsciiFrame(1);
    // Return to idle after 350ms
    setTimeout(() => {
      _asciiState = 'idle';
      updateAsciiFrame(0);
      scheduleNextFidget();
    }, 350);
  }, delay);
}

/** Independent eye blink cycle — fires every 3–6s, 150ms blink duration */
function scheduleNextBlink() {
  clearTimeout(_asciiBlinkTimer);
  if (!_asciiPre) return;
  const delay = 3000 + Math.random() * 3000;
  _asciiBlinkTimer = setTimeout(() => {
    if (!_asciiPre) return;
    // Don't blink during action frames — looks odd mid-action
    if (_asciiState === 'action') { scheduleNextBlink(); return; }
    _asciiBlinking = true;
    // Re-render current frame with closed eyes
    const frameIdx = _asciiState === 'fidget' ? 1 : 0;
    updateAsciiFrame(frameIdx);
    // Open eyes after 150ms
    setTimeout(() => {
      _asciiBlinking = false;
      if (_asciiPre) updateAsciiFrame(_asciiState === 'fidget' ? 1 : 0);
      scheduleNextBlink();
    }, 150);
  }, delay);
}

/** Called from events.js on tool_use — briefly plays action frame */
export function triggerAsciiAction() {
  if (!_asciiPre || _asciiState === 'action') return;
  // Only show action frame ~40% of tool calls (avoids spam on rapid tools)
  if (Math.random() > 0.4) return;
  clearTimeout(_asciiActionTimer);
  clearTimeout(_asciiAnimTimer);
  _asciiState = 'action';
  updateAsciiFrame(2);
  _asciiActionTimer = setTimeout(() => {
    _asciiState = 'idle';
    updateAsciiFrame(0);
    scheduleNextFidget();
  }, 600);
}

function renderCompanionSprite() {
  // ── Floating pixel sprite (bottom-right bubble) ──────────────────────────
  const spriteWrap = document.getElementById('companion-sprite');
  if (spriteWrap && buddy) {
    const spriteKey = BUDDY_SPRITE_MAP[buddy.species] ?? 'cat';
    const data = SPRITE_DATA[spriteKey];
    if (data) {
      spriteWrap.innerHTML = '';
      const canvas = document.createElement('canvas');
      canvas.width = 48; canvas.height = 48;
      canvas.className = 'companion-sprite-canvas';
      spriteWrap.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      const img = new Image();
      img.onload = () => {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, 16, 16, 0, 0, 48, 48);
      };
      img.src = data;
    }
  }

  // ── ASCII buddy in sidebar panel ──────────────────────────────────────────
  const panel = document.getElementById('vexil-ascii');
  if (!panel || !buddy) return;

  // Bones species is authoritative — personality text may mention a stale species name
  _asciiSpecies = SPRITES[buddy.species] ? buddy.species : 'duck';
  _asciiEye     = getEyeChar(buddy);
  _asciiHat     = buddy.hat ?? 'none';

  // Clear previous animation
  clearTimeout(_asciiAnimTimer);
  clearTimeout(_asciiActionTimer);
  clearTimeout(_asciiBlinkTimer);
  _asciiState = 'idle';
  _asciiBlinking = false;

  // Build <pre>
  panel.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'vexil-ascii-art';
  panel.appendChild(pre);
  _asciiPre = pre;

  // "about me" hover button — opens oracle stat card
  const viewBtn = document.createElement('button');
  viewBtn.className = 'oracle-view-btn';
  viewBtn.innerHTML = 'about<br>me';
  viewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showOracleCard(buddy);
  });
  panel.appendChild(viewBtn);

  // Render initial idle frame and start animation
  updateAsciiFrame(0);
  scheduleNextFidget();
  scheduleNextBlink();
}

// ── Bubble display ────────────────────────────────────────────────────────────

// ── Approval dialog (standalone — no bubble) ─────────────────────────────────

function showApprovalDialog(msg) {
  document.getElementById('approval-msg').textContent = msg;
  document.getElementById('approval-overlay').classList.remove('hidden');
}

function hideApprovalDialog() {
  document.getElementById('approval-overlay').classList.add('hidden');
}

// ── Approval IPC ──────────────────────────────────────────────────────────────

async function writeApproval(approved) {
  try {
    if (_hookGatePending) {
      // Hook gate response (pixel_gate.py is polling this)
      const payload = JSON.stringify({ id: _hookGateReqId, approved });
      await invoke('write_file_as_text', { path: await ipcPath('pixel_hook_gate_response.json'), content: payload });
      await invoke('write_file_as_text', { path: await ipcPath('pixel_hook_gate.json'), content: '{}' }).catch(e => console.warn('[companion] hook gate reset failed:', e));
      _hookGatePending = false;
      _hookGateReqId   = null;
    } else {
      // Route to Vexil approval file (memory_lint.py is polling this)
      const payload = JSON.stringify({ approved });
      await invoke('write_file_as_text', { path: await ipcPath('vexil_approval.json'), content: payload });
      _approvalPending = false;
      _lastLintSeen = '';  // reset so pollLintFile re-reads fresh state from memory_lint.py
    }
  } catch (e) {
    console.error('[companion] failed to write approval:', e);
    // Leave pending flag set so user can retry
    return;
  }
  hideApprovalDialog();
}

// ── Hook gate poller ──────────────────────────────────────────────────────────
// Polls pixel_hook_gate.json for permission gate requests (pixel_gate.py hooks)

async function pollHookGate() {
  if (_hookGatePending) return;

  let raw;
  try {
    raw = await invoke('read_file_as_text', { path: await ipcPath('pixel_hook_gate.json') });
  } catch {
    return;  // file missing = no gate pending
  }
  let gate;
  try {
    gate = JSON.parse(raw);
  } catch (e) {
    console.warn('[companion] hook gate parse failed:', e?.message ?? e);
    return;
  }
  if (!gate?.id || !gate?.msg) return;
  if (Date.now() / 1000 > gate.expires) return;

  _hookGatePending = true;
  _hookGateReqId   = gate.id;
  invoke('js_log', { msg: `[hook-gate] ${gate.msg?.slice(0, 80)}` }).catch(() => {});
  showApprovalDialog(gate.msg);
}

// ── Lint file poller ──────────────────────────────────────────────────────────

async function pollLintFile() {
  if (_approvalPending || _hookGatePending) return;  // don't poll while waiting for user response

  let raw;
  try {
    raw = await invoke('read_file_as_text', { path: await ipcPath('vexil_lint.json') });
  } catch {
    return;  // file missing = no lint state
  }

  // Skip if we've already handled this exact payload
  if (raw === _lastLintSeen) return;

  let lint;
  try {
    lint = JSON.parse(raw);
  } catch (e) {
    console.warn('[companion] lint parse failed — partial write?', e?.message ?? e);
    setTimeout(pollLintFile, 50);  // partial write in flight — retry once after 50ms
    return;
  }

  if (lint.seen) return;

  _lastLintSeen = raw;

  const state = lint.state;
  const msg   = lint.msg;

  if (state === 'clean' || !msg) {
    return;
  }

  invoke('js_log', { msg: `[vexil-lint] state:${state} "${msg?.slice(0, 80)}"` }).catch(() => {});

  if (state === 'needs_approval') {
    _approvalPending = true;
    showApprovalDialog(msg);
  } else if (state === 'approved' || state === 'denied' || state === 'timeout_pass') {
    hideApprovalDialog();
  } else {
    // blocked / warn — genuinely informational, log to BUDDY tab
    addToLintLog(state, msg);
  }
}

// ── Ops report poll ───────────────────────────────────────────────────────────

async function pollOpsReport() {
  try {
    const raw = await invoke('read_file_as_text', { path: await ipcPath('vexil_ops_report.json') });
    const report = JSON.parse(raw);
    // Dedup by ops_count + session_start_ts — shows again if new ops were logged
    const key = `${report.session_start_ts}:${report.ops_count}`;
    if (key === _lastOpsKey) return;
    _lastOpsKey = key;

    const { session_deletes, session_adds, session_true_deletes, unaccounted, dst_summary } = report;

    let msg;
    if (unaccounted === 0) {
      msg = `${session_deletes} deleted. ${session_adds} moved${dst_summary && dst_summary !== 'none' ? ` (${dst_summary})` : ''}. ${session_true_deletes} gone. ✓`;
      addToLintLog('ops', msg);  // VEXIL tab only — ops accounting, not character voice
      invoke('js_log', { msg: `[vexil-ops] ${msg}` }).catch(() => {});
    } else {
      msg = `${session_deletes} deleted. ${session_adds} added. ${unaccounted} unaccounted.`;
      addToLintLog('ops', msg);
      // Unaccounted deletes = potential data loss — logged above
    }
  } catch (_) { /* file not yet written */ }
}

// ── Companion species derivation ──────────────────────────────────────────────
// Derives the user's Claude Code companion animal from their account UUID,
// using the same algorithm as cli.js (FNV-1a hash → seeded PRNG → S44 pick).

const COMPANION_SEED = 'friend-2026-401';
const S44 = ['duck','goose','blob','cat','dragon','octopus','owl','penguin',
             'turtle','snail','ghost','axolotl','capybara','cactus','robot',
             'rabbit','mushroom','chonk'];

async function deriveBuddySpecies() {
  try {
    const home = await getHomeDir();
    const raw = await invoke('read_file_as_text', { path: `${home}/.claude.json` });
    const auth = JSON.parse(raw);
    const uuid = auth.oauthAccount?.accountUuid ?? auth.userID ?? 'anon';
    const key = uuid + COMPANION_SEED;
    // FNV-1a 32-bit hash — exact port of vV_() from cli.js
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    // Seeded PRNG — exact port of GV_() from cli.js
    let K = h >>> 0;
    const rng = () => {
      K = (K + 1831565813) | 0;
      let _ = Math.imul(K ^ (K >>> 15), 1 | K);
      _ = (_ + Math.imul(_ ^ (_ >>> 7), 61 | _)) ^ _;
      return ((_ ^ (_ >>> 14)) >>> 0) / 4294967296;
    };
    return S44[Math.floor(rng() * S44.length)];
  } catch { return buddy?.species ?? 'dragon'; }
}

// ── Project character persistence ─────────────────────────────────────────────
// project-chars.json is the sole owner of the cwd → animal mapping.
// buddy.json is sole-owned by initCompanion. Two files, no collision.

const PROJECT_CHARS_FILENAME = '.config/pixel-terminal/project-chars.json';

// Write queue — serializes reads so concurrent session creates don't clobber each other
let _projectCharsSaveQueue = Promise.resolve();

export function isBuddyAnimal(animalName) {
  if (!buddy) return false;
  const spriteKey = BUDDY_SPRITE_MAP[buddy.species] ?? buddy.species ?? '';
  return spriteKey.length > 0 && animalName.startsWith(spriteKey);
}

export async function getProjectChar(cwd) {
  try {
    const home = await getHomeDir();
    const raw = await invoke('read_file_as_text', { path: `${home}/${PROJECT_CHARS_FILENAME}` });
    return JSON.parse(raw)[cwd] ?? null;
  } catch { return null; }
}

export async function saveProjectChar(cwd, animalName) {
  _projectCharsSaveQueue = _projectCharsSaveQueue.then(() => _writeProjectChar(cwd, animalName));
  return _projectCharsSaveQueue;
}

async function _writeProjectChar(cwd, animalName) {
  try {
    const home = await getHomeDir();
    const charPath = `${home}/${PROJECT_CHARS_FILENAME}`;
    let chars = {};
    try {
      const raw = await invoke('read_file_as_text', { path: charPath });
      chars = JSON.parse(raw);
    } catch { /* file doesn't exist yet — start empty */ }
    chars[cwd] = animalName;
    await invoke('write_file_as_text', { path: charPath, content: JSON.stringify(chars, null, 2) });
  } catch (e) { console.warn('saveProjectChar failed:', e); }
}

// ── Lint event log (for #vexil-monitor panel) ─────────────────────────────────

// Per-session log: Map<sessionId, [{ts, state, msg}]>, max 100 entries per session
const LINT_LOG = new Map();

function addToLintLog(state, msg) {
  const sessionId = getActiveSessionId();
  if (!sessionId) return;
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!LINT_LOG.has(sessionId)) LINT_LOG.set(sessionId, []);
  const log = LINT_LOG.get(sessionId);
  log.push({ ts, state, msg: msg ?? '' });
  if (log.length > 100) log.shift(); // drop oldest when capped
  if (_vexilLogListener) _vexilLogListener(log);
}

export function getLintLogForSession(id) { return LINT_LOG.get(id) ?? []; }
export function clearLintLog(id) { LINT_LOG.set(id, []); }

export function setVexilLogListener(cb) { _vexilLogListener = cb; }
export function setOracleResponseListener(cb) { _oracleResponseListener = cb; }
export function addToVexilLog(state, msg) {
  addToLintLog(state, msg);
  invoke('js_log', { msg: `[vexil-reply] state:${state} "${msg?.slice(0,80)}"` }).catch(() => {});
  // bubble suppressed — log tab is the surface
}

// ── Vexil Master output poll ──────────────────────────────────────────────────

async function pollMasterOut() {
  try {
    const raw = await invoke('read_file_as_text', { path: '~/.local/share/pixel-terminal/vexil_master_out.jsonl' });
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= _masterOutOffset) return;
    const newLines = lines.slice(_masterOutOffset);
    _masterOutOffset = lines.length;
    for (const line of newLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.msg) {
          addToLintLog('vexil', entry.msg);
          invoke('js_log', { msg: `[vexil-master] "${entry.msg?.slice(0,80)}"` }).catch(() => {});
          // bubble suppressed — log tab is the surface
        }
      } catch { /* malformed line */ }
    }
  } catch { /* file not yet created */ }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initCompanion() {
  if (_companionInitialized) return;
  _companionInitialized = true;
  await loadBuddy();

  // Populate bio panel with real buddy identity
  // Species: prefer term extracted from personality text (soul > bones for display)
  const bio = document.getElementById('vexil-bio');
  if (bio && buddy) {
    // Bones species is authoritative — personality text may mention a stale species name
    const displaySpecies = buddy.species ?? 'duck';
    const rarityStr = buddy.rarity ? `${buddy.rarity} ` : '';
    bio.querySelector('.vexil-bio-name').textContent =
      `${buddy.name} · ${rarityStr}${displaySpecies}`.trim();
    // bio starts visible (no hidden class) — placeholder text already shown
  }

  // Sync buddy species with Claude Code companion — buddy.json is sole owner of this write
  // Skip if sync_buddy (Rust) already ran at startup (wyhash is authoritative over FNV-1a)
  try {
    if (buddy.syncedFrom === 'claude-code') {
      // Real sync already wrote correct species — FNV-1a would produce wrong result
    } else {
      const derivedSpecies = await deriveBuddySpecies();
      if (buddy.species !== derivedSpecies || buddy.companionSeed !== COMPANION_SEED) {
      const oldSpecies = buddy.species;
      buddy.species      = derivedSpecies;
      buddy.companionSeed = COMPANION_SEED;

      const home = await getHomeDir();
      const buddyPath = `${home}/.config/pixel-terminal/buddy.json`;

      // Read → patch → write via Rust (no python3/sh needed)
      const rawBuddy = await invoke('read_file_as_text', { path: buddyPath });
      const buddyData = JSON.parse(rawBuddy);
      buddyData.species      = derivedSpecies;
      buddyData.companionSeed = COMPANION_SEED;
      await invoke('write_file_as_text', { path: buddyPath, content: JSON.stringify(buddyData, null, 2) });

      } // end if species mismatch
    } // end else (not syncedFrom claude-code)
  } catch (e) {
    // Species sync failed — non-fatal, polling still starts
    console.warn('[companion] species sync skipped:', e?.message ?? e);
  }

  injectCompanionPanel();
  renderCompanionSprite();

  // Companion hue: always use app accent — species hue is for familiars, not the oracle
  document.documentElement.style.setProperty('--companion-hue', '#d87756');

  // Heartbeat: write alive marker every 5s so memory_lint.py
  // knows the terminal is open and should wait for user approval
  async function writeAlive() {
    try {
      await invoke('write_file_as_text', { path: await ipcPath('pixel_terminal_alive'), content: String(Date.now()) });
    } catch { /* non-fatal */ }
  }
  writeAlive();  // immediate on init
  setInterval(writeAlive, 5000);

  // Seed dedup keys from existing files — prevents stale data from re-displaying on every launch
  try {
    const raw = await invoke('read_file_as_text', { path: await ipcPath('vexil_ops_report.json') });
    const report = JSON.parse(raw);
    _lastOpsKey = `${report.session_start_ts}:${report.ops_count}`;
  } catch { /* file doesn't exist yet — fine */ }
  try {
    const raw = await invoke('read_file_as_text', { path: await ipcPath('vexil_lint.json') });
    _lastLintSeen = raw.trim();
  } catch { /* file doesn't exist yet — fine */ }

  // Seed master output offset — don't re-show old entries from previous launch
  try {
    const raw = await invoke('read_file_as_text', { path: '~/.local/share/pixel-terminal/vexil_master_out.jsonl' });
    _masterOutOffset = raw.split('\n').filter(Boolean).length;
  } catch { /* file doesn't exist yet — fine */ }

  // Start polling — hook gate checked first (higher urgency: a hook is blocking)
  setInterval(async () => {
    await pollHookGate();
    await pollLintFile();
  }, POLL_INTERVAL);
  setInterval(pollOpsReport, 5000);   // ops report slower — less frequent events
  setInterval(pollMasterOut, 800);    // master proactive commentary — fast pickup for alacrity

  document.dispatchEvent(new CustomEvent('pixel:companion-ready', { detail: { name: buddy?.name } }));
}

// Returns the lowercase trigger prefix for addressing the companion (e.g. "vexil ")
export function getBuddyTrigger() {
  return ((buddy?.name ?? 'vexil').toLowerCase()) + ' ';
}

export async function saveCommentaryFrequency(level) {
  try {
    buddy.commentaryFrequency = level;
    const home = await getHomeDir();
    const path = `${home}/.config/pixel-terminal/buddy.json`;
    const raw = await invoke('read_file_as_text', { path });
    const data = JSON.parse(raw);
    data.commentaryFrequency = level;
    await invoke('write_file_as_text', { path, content: JSON.stringify(data, null, 2) });
  } catch (e) {
    console.warn('[companion] failed to save commentary frequency:', e?.message ?? e);
  }
}

// Reloads buddy from disk and updates the live module-level reference.
// Call after any operation that rewrites buddy.json (e.g. reroll_oracle).
// Returns the fresh buddy object. Because `buddy` is a live ES module binding,
// all importers of `companionBuddy` and closures over `buddy` see the new value.
export async function reloadBuddy() {
  await loadBuddy();
  return buddy;
}

export { LINT_LOG, buddy as companionBuddy };
