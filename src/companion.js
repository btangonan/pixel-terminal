/**
 * companion.js — Vexil Memory Linter companion
 *
 * Polls /tmp/vexil_lint.json every 3s. Surfaces violations via a speech bubble
 * anchored to the bottom-right corner of the app. For ASK-tier violations,
 * shows interactive approve/deny buttons and writes /tmp/vexil_approval.json.
 *
 * Character voice is driven by buddy.json:
 *   ~/.config/pixel-terminal/buddy.json → { species, name, voice, stats, hue }
 *
 * Sprite mapping: buddy.species → SPRITE_DATA key (with fallbacks for
 * species not yet drawn as pixel art).
 */

import { SPRITE_DATA } from './session.js';
import { SPRITES, EYE_CHARS, DEFAULT_EYE, HATS, renderFrame } from './ascii-sprites.js';

const { invoke } = window.__TAURI__.core;

// ── Paths ─────────────────────────────────────────────────────────────────────

const BUDDY_PATH   = `${window.__TAURI_INTERNALS__?.metadata?.homeDir ?? '/Users/' + 'bradleytangonan'}/.config/pixel-terminal/buddy.json`;
const LINT_PATH    = '/tmp/vexil_lint.json';
const APPROVAL_PATH = '/tmp/vexil_approval.json';
const HOOK_GATE_PATH      = '/tmp/pixel_hook_gate.json';
const HOOK_GATE_RESP_PATH = '/tmp/pixel_hook_gate_response.json';

const POLL_INTERVAL = 3000;   // ms
const BUBBLE_AUTODISMISS = 6000;  // ms for non-interactive bubbles

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

// Button labels driven by buddy voice key
const APPROVE_LABELS = {
  sarcastic:  'fine, whatever',
  excitable:  'YES DO IT!!',
  measured:   'approved',
  technical:  'allow',
  impatient:  'ok',
  default:    'approve',
};

const DENY_LABELS = {
  sarcastic:  'absolutely not',
  excitable:  'NO STOP!!',
  measured:   'deny',
  technical:  'reject',
  impatient:  'no',
  default:    'deny',
};

// ── Module state ──────────────────────────────────────────────────────────────

let buddy = null;
let _companionInitialized = false;  // singleton guard — species sync runs exactly once
let _vexilLogListener = null;       // registered by voice.js to re-render the Vexil tab
let _lastLintSeen = '';       // prevent re-showing same lint event
let _lastOpsKey   = '';       // prevent re-showing same ops report
let _approvalPending = false;
let _hookGatePending = false;
let _hookGateReqId   = null;
let _dismissTimer = null;
let _pollActive = false;
let _masterOutOffset = 0;  // line count consumed from vexil_master_out.jsonl

// 3-tier priority queue
// Priority: BLOCK=3 (preempts everything), OPS=2 (preempts warn/ask), WARN/ASK=1
const PRIORITY = { blocked: 3, ask: 3, ops: 2, warn: 1, vexil: 2 };
let _messageQueue = [];       // [{msg, type, interactive, priority}]
let _currentPriority = 0;    // priority of the currently-showing bubble

// ── Tauri home dir ────────────────────────────────────────────────────────────

async function getHomeDir() {
  try {
    // Tauri v2: use path plugin
    return await window.__TAURI__.path.homeDir();
  } catch {
    // Fallback: read from env or hardcode
    return '/Users/' + (window.__TAURI_INTERNALS__?.metadata?.username ?? 'bradleytangonan');
  }
}

// ── Buddy loader ──────────────────────────────────────────────────────────────

async function loadBuddy() {
  try {
    const home = await getHomeDir();
    const raw = await invoke('read_file_as_text', { path: `${home}/.config/pixel-terminal/buddy.json` });
    buddy = JSON.parse(raw);
  } catch {
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
    <div class="companion-bubble hidden" id="companion-bubble">
      <div class="companion-bubble-msg" id="companion-msg"></div>
      <div class="companion-bubble-actions hidden" id="companion-actions">
        <button class="companion-btn companion-approve" id="companion-approve">approve</button>
        <button class="companion-btn companion-deny" id="companion-deny">deny</button>
      </div>
    </div>
  `;

  // Inject into body (fixed position via CSS)
  document.body.appendChild(wrap);

  // Wire approve/deny buttons
  document.getElementById('companion-approve').addEventListener('click', () => {
    writeApproval(true);
  });
  document.getElementById('companion-deny').addEventListener('click', () => {
    writeApproval(false);
  });
}

// ── ASCII sprite rendering + animation ───────────────────────────────────────

let _asciiAnimTimer   = null;  // idle→fidget cycle timer
let _asciiActionTimer = null;  // action frame auto-return timer
let _asciiPre         = null;  // the live <pre> element
let _asciiState       = 'idle'; // 'idle' | 'fidget' | 'action'
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
  const lines = renderFrame(_asciiSpecies, frameIdx, _asciiEye, _asciiHat);
  _asciiPre.textContent = lines.join('\n');
}

function scheduleNextFidget() {
  clearTimeout(_asciiAnimTimer);
  // Idle for 3–8 seconds then briefly fidget
  const delay = 3000 + Math.random() * 5000;
  _asciiAnimTimer = setTimeout(() => {
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

  // Resolve species — use the ASCII species name directly.
  // buddy.species from Claude Code sync is the canonical key (e.g. 'duck').
  // SPRITES may not have all pixel-terminal-only species — fall back to duck.
  _asciiSpecies = SPRITES[buddy.species] ? buddy.species : 'duck';
  _asciiEye     = getEyeChar(buddy);
  _asciiHat     = buddy.hat ?? 'none';

  // Clear previous animation
  clearTimeout(_asciiAnimTimer);
  clearTimeout(_asciiActionTimer);
  _asciiState = 'idle';

  // Build <pre>
  panel.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'vexil-ascii-art';
  panel.appendChild(pre);
  _asciiPre = pre;

  // Render initial idle frame and start animation
  updateAsciiFrame(0);
  scheduleNextFidget();
}

// ── Bubble display ────────────────────────────────────────────────────────────

function showBubble({ msg, type, interactive }) {
  const wrap   = document.getElementById('companion-wrap');
  const bubble = document.getElementById('companion-bubble');
  const msgEl  = document.getElementById('companion-msg');
  const actions = document.getElementById('companion-actions');
  const approveBtn = document.getElementById('companion-approve');
  const denyBtn    = document.getElementById('companion-deny');

  if (!wrap || !bubble) return;

  // Clear any pending autodismiss
  if (_dismissTimer) { clearTimeout(_dismissTimer); _dismissTimer = null; }

  msgEl.textContent = msg;
  bubble.className = `companion-bubble ${type}`;

  if (interactive) {
    const voice = buddy?.voice ?? 'default';
    approveBtn.textContent = APPROVE_LABELS[voice] ?? APPROVE_LABELS.default;
    denyBtn.textContent    = DENY_LABELS[voice]    ?? DENY_LABELS.default;
    actions.classList.remove('hidden');
  } else {
    actions.classList.add('hidden');
  }

  wrap.classList.remove('hidden');
  bubble.classList.remove('hidden');
  _currentPriority = PRIORITY[type] ?? 1;

  // Push log content up so bubble doesn't overlap last lines
  const log = document.getElementById('message-log');
  if (log) { log.classList.add('companion-active'); log.scrollTop = log.scrollHeight; }

  if (!interactive) {
    _dismissTimer = setTimeout(() => hideBubble(), BUBBLE_AUTODISMISS);
  }
}

function hideBubble() {
  const wrap = document.getElementById('companion-wrap');
  const bubble = document.getElementById('companion-bubble');
  if (wrap) wrap.classList.add('hidden');
  if (bubble) bubble.classList.add('hidden');
  _currentPriority = 0;
  // Drain queue: show next message if one is waiting
  if (_messageQueue.length > 0) {
    const next = _messageQueue.shift();
    showBubble(next);
  } else {
    // No more queued messages — release the bottom clearance
    document.getElementById('message-log')?.classList.remove('companion-active');
  }
}

// ── Priority-aware enqueue ────────────────────────────────────────────────────

function enqueueBubble({ msg, type, interactive }) {
  const priority = PRIORITY[type] ?? 1;
  if (priority >= _currentPriority && !_approvalPending) {
    // Higher or equal priority — show immediately (preempt)
    if (_dismissTimer) { clearTimeout(_dismissTimer); _dismissTimer = null; }
    showBubble({ msg, type, interactive });
  } else {
    // Lower priority or approval pending — queue it
    _messageQueue.push({ msg, type, interactive });
  }
}

// ── Approval IPC ──────────────────────────────────────────────────────────────

async function writeApproval(approved) {
  try {
    if (_hookGatePending) {
      // Route to hook gate response file (pixel_gate.py is polling this)
      const payload = JSON.stringify({ id: _hookGateReqId, approved });
      await invoke('write_file_as_text', { path: HOOK_GATE_RESP_PATH, content: payload });
      _hookGatePending = false;
      _hookGateReqId   = null;
    } else {
      // Route to Vexil approval file (memory_lint.py is polling this)
      const payload = JSON.stringify({ approved });
      await invoke('write_file_as_text', { path: APPROVAL_PATH, content: payload });
      _approvalPending = false;
    }
  } catch (e) {
    console.error('[companion] failed to write approval:', e);
    // Leave pending flag set so user can retry
  }
  hideBubble();
}

// ── Hook gate poller ──────────────────────────────────────────────────────────
// Checks /tmp/pixel_hook_gate.json — written by pixel_gate.py when a tool call
// needs user approval. Higher urgency than Vexil lint (a hook is blocking).

async function pollHookGate() {
  if (_hookGatePending) return;  // already showing gate bubble — wait for user
  let raw;
  try {
    raw = await invoke('read_file_as_text', { path: HOOK_GATE_PATH });
  } catch {
    return;  // file missing = no gate pending
  }
  let gate;
  try {
    gate = JSON.parse(raw);
  } catch {
    return;
  }
  if (!gate?.id || !gate?.msg) return;
  if (Date.now() / 1000 > gate.expires) return;  // stale request

  _hookGatePending = true;
  _hookGateReqId   = gate.id;
  invoke('js_log', { msg: `[hook-gate] ${gate.msg?.slice(0, 80)}` }).catch(() => {});
  enqueueBubble({ msg: gate.msg, type: 'ask', interactive: true });
  // Gate messages are interactive (bubble handles approve/deny) — not logged to BUDDY tab
  // since the log entry has no action buttons and would show confusingly in red.
}

// ── Lint file poller ──────────────────────────────────────────────────────────

async function pollLintFile() {
  if (_approvalPending || _hookGatePending) return;  // don't poll while waiting for user response

  let raw;
  try {
    raw = await invoke('read_file_as_text', { path: LINT_PATH });
  } catch {
    return;  // file missing = no lint state
  }

  // Skip if we've already handled this exact payload
  if (raw === _lastLintSeen) return;

  let lint;
  try {
    lint = JSON.parse(raw);
  } catch {
    return;
  }

  if (lint.seen) return;

  _lastLintSeen = raw;

  const state = lint.state;
  const msg   = lint.msg;

  if (state === 'clean' || !msg) {
    // Clean state — ensure bubble is hidden
    hideBubble();
    return;
  }

  invoke('js_log', { msg: `[vexil-lint] state:${state} "${msg?.slice(0, 80)}"` }).catch(() => {});

  if (state === 'needs_approval') {
    // Interactive bubble handles user communication — no log entry needed
    _approvalPending = true;
    enqueueBubble({ msg, type: 'ask', interactive: true });
  } else if (state === 'approved' || state === 'denied' || state === 'timeout_pass') {
    // Terminal states — bubble auto-dismisses, no log entry
    hideBubble();
  } else {
    // blocked / warn — genuinely informational, log to BUDDY tab
    addToLintLog(state, msg);
  }
}

// ── Ops report poll ───────────────────────────────────────────────────────────

async function pollOpsReport() {
  try {
    const raw = await invoke('read_file_as_text', { path: '/tmp/vexil_ops_report.json' });
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
      // Unaccounted deletes = potential data loss — surface in bubble
      enqueueBubble({ msg, type: 'ops', interactive: false });
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
    const cwdB64  = btoa(cwd);
    const pathB64 = btoa(charPath);
    const script = `
import json, base64, os
p   = base64.b64decode('${pathB64}').decode()
cwd = base64.b64decode('${cwdB64}').decode()
data = json.load(open(p)) if os.path.exists(p) else {}
data[cwd] = '${animalName}'
with open(p, 'w') as f:
    json.dump(data, f, indent=2)
`.trim();
    const { Command } = window.__TAURI__.shell;
    const result = await new Command('python3', ['-c', script]).execute();
    if (result.code !== 0) console.warn('saveProjectChar failed:', result.stderr);
  } catch (e) { console.warn('saveProjectChar failed:', e); }
}

// ── Lint event log (for #vexil-monitor panel) ─────────────────────────────────

const LINT_LOG = [];  // max 100 entries, newest first

function addToLintLog(state, msg) {
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  LINT_LOG.push({ ts, state, msg: msg ?? '' });
  if (LINT_LOG.length > 100) LINT_LOG.shift(); // drop oldest when capped
  if (_vexilLogListener) _vexilLogListener(LINT_LOG);
}

export function setVexilLogListener(cb) { _vexilLogListener = cb; }
export function addToVexilLog(state, msg) {
  addToLintLog(state, msg);
  invoke('js_log', { msg: `[vexil-reply] state:${state} "${msg?.slice(0,80)}"` }).catch(() => {});
  // bubble suppressed — log tab is the surface
}

// ── Vexil Master output poll ──────────────────────────────────────────────────

async function pollMasterOut() {
  try {
    const raw = await invoke('read_file_as_text', { path: '/tmp/vexil_master_out.jsonl' });
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

  // Tab is always "BUDDY" — companion name lives in the bio panel, not the tab
  const vexilTabBtn = document.querySelector('.voice-tab[data-vtab="vexil"]');
  if (vexilTabBtn) vexilTabBtn.textContent = 'BUDDY';

  // Populate bio panel with real buddy identity
  // Species: prefer term extracted from personality text (soul > bones for display)
  const bio = document.getElementById('vexil-bio');
  if (bio && buddy) {
    const KNOWN_SPECIES = ['dragon','cat','rabbit','penguin','frog','octopus','duck',
      'goose','blob','turtle','snail','ghost','axolotl','capybara','cactus','robot',
      'mushroom','chonk','owl','parrot','panda','fox','koala','platypus','narwhal',
      'sloth','hedgehog','hamster'];
    const personalityLower = (buddy.personality ?? '').toLowerCase();
    const displaySpecies = KNOWN_SPECIES.find(s => personalityLower.includes(s)) ?? buddy.species;
    const rarityStr = buddy.rarity ? `${buddy.rarity} ` : '';
    bio.querySelector('.vexil-bio-name').textContent =
      `${buddy.name} · ${rarityStr}${displaySpecies}`.trim();
    bio.querySelector('.vexil-bio-personality').textContent = buddy.personality ?? '';
    bio.classList.remove('hidden'); // bio always visible at panel bottom — not tab-toggled
  }

  // Sync buddy species with Claude Code companion — buddy.json is sole owner of this write
  // Skip if sync_real_buddy.ts already ran at launch (wyhash is authoritative over FNV-1a)
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

      // Re-assign any project that held the old species so it doesn't
      // collide with the new buddy on next session open
      if (oldSpecies && oldSpecies !== derivedSpecies) {
        try {
          const charPath = `${home}/${PROJECT_CHARS_FILENAME}`;
          const charRaw  = await invoke('read_file_as_text', { path: charPath });
          const chars    = JSON.parse(charRaw);
          const dirty    = Object.entries(chars).filter(([, v]) => v === oldSpecies);
          if (dirty.length > 0) {
            dirty.forEach(([k]) => delete chars[k]);
            _projectCharsSaveQueue = _projectCharsSaveQueue.then(async () => {
              await invoke('write_file_as_text', { path: charPath, content: JSON.stringify(chars, null, 2) });
            });
            await _projectCharsSaveQueue;
          }
        } catch { /* project-chars.json may not exist yet — fine */ }
      }
      } // end if species mismatch
    } // end else (not syncedFrom claude-code)
  } catch (e) {
    // Species sync failed — non-fatal, polling still starts
    console.warn('[companion] species sync skipped:', e?.message ?? e);
  }

  injectCompanionPanel();
  renderCompanionSprite();

  // Apply buddy hue as CSS variable (used in bubble border)
  if (buddy?.hue) {
    document.documentElement.style.setProperty('--companion-hue', buddy.hue);
  }

  // Heartbeat: write /tmp/pixel_terminal_alive every 5s so memory_lint.py
  // knows the terminal is open and should wait for user approval
  async function writeAlive() {
    try {
      await invoke('write_file_as_text', { path: '/tmp/pixel_terminal_alive', content: String(Date.now()) });
    } catch { /* non-fatal */ }
  }
  writeAlive();  // immediate on init
  setInterval(writeAlive, 5000);

  // Seed dedup keys from existing files — prevents stale data from re-displaying on every launch
  try {
    const raw = await invoke('read_file_as_text', { path: '/tmp/vexil_ops_report.json' });
    const report = JSON.parse(raw);
    _lastOpsKey = `${report.session_start_ts}:${report.ops_count}`;
  } catch { /* file doesn't exist yet — fine */ }
  try {
    const raw = await invoke('read_file_as_text', { path: LINT_PATH });
    _lastLintSeen = raw.trim();
  } catch { /* file doesn't exist yet — fine */ }

  // Seed master output offset — don't re-show old entries from previous launch
  try {
    const raw = await invoke('read_file_as_text', { path: '/tmp/vexil_master_out.jsonl' });
    _masterOutOffset = raw.split('\n').filter(Boolean).length;
  } catch { /* file doesn't exist yet — fine */ }

  // Start polling — hook gate checked first (higher urgency: a hook is blocking)
  setInterval(async () => {
    await pollHookGate();
    await pollLintFile();
  }, POLL_INTERVAL);
  setInterval(pollOpsReport, 5000);   // ops report slower — less frequent events
  setInterval(pollMasterOut, 5000);   // master proactive commentary
}

// Returns the lowercase trigger prefix for addressing the companion (e.g. "vexil ")
export function getBuddyTrigger() {
  return ((buddy?.name ?? 'vexil').toLowerCase()) + ' ';
}

export { LINT_LOG, buddy as companionBuddy };
