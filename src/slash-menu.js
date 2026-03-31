// ── Slash command / flag autocomplete menu ──────────────────

import { $, esc, autoResize } from './dom.js';

const { invoke } = window.__TAURI__.core;

let _slashCommands = [];    // loaded once on startup

const BUILTIN_SLASH_COMMANDS = [
  { name: 'clear', description: 'Clear conversation and restart session' },
  { name: 'cost', description: 'Show token usage for this session' },
  { name: 'compact', description: 'Summarize conversation to save context' },
  { name: 'help', description: 'List all available commands' },
  { name: 'model', description: 'Switch Claude model (restarts session)' },
  { name: 'effort', description: 'Set reasoning effort level' },
];
let _slashActiveIdx = -1;   // keyboard-highlighted row
let _activeToken   = null;  // token that opened the menu

const FLAG_ITEMS = [
  { name: 'seq',        description: 'sequential-thinking MCP \u2014 structured multi-step reasoning' },
  { name: 'think',      description: 'pause and reason carefully before responding' },
  { name: 'think-hard', description: '--think + --seq combined' },
  { name: 'ultrathink', description: '--think-hard + explicit plan before acting' },
  { name: 'uc',         description: 'ultra-compressed output' },
  { name: 'no-mcp',     description: 'disable all MCP servers' },
  { name: 'grade',      description: 'grade current plan (use with /sm:introspect)' },
  { name: 'quick',      description: 'fast bootstrap \u2014 skip memory queries' },
  { name: 'cold',       description: 'fresh start, skip project memory' },
  { name: 'retro',      description: 'end-of-session retro (use with /checkpoint)' },
  { name: 'dry-run',    description: 'show what would happen without writing' },
  { name: 'state-only', description: 'write STATE.md only (use with /checkpoint)' },
  { name: 'brief',      description: 'meeting/pitch brief mode (use with /research)' },
];

export async function loadSlashCommands() {
  try {
    _slashCommands = await invoke('read_slash_commands');
  } catch (_) {
    _slashCommands = [];
  }
}

export function getSlashCommands() { return [...BUILTIN_SLASH_COMMANDS, ..._slashCommands]; }
export function isBuiltinCommand(name) { return BUILTIN_SLASH_COMMANDS.some(c => c.name === name); }

export function showSlashMenu(token) {
  _activeToken = token;
  const menu = $.slashMenu;
  const q = token.query.toLowerCase();

  let matches, prefix;
  if (token.type === 'flag') {
    matches = FLAG_ITEMS.filter(f =>
      f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)
    );
    prefix = '--';
  } else {
    matches = _slashCommands.filter(c =>
      c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    );
    prefix = '/';
  }

  if (!matches.length) { hideSlashMenu(); return; }

  // Position flush against the top of the input bar, right of the sidebar
  const inputBar = $.inputBar;
  const sidebar  = $.sidebar;
  const rect = inputBar.getBoundingClientRect();
  menu.style.bottom = (window.innerHeight - rect.top) + 'px';
  menu.style.left   = (sidebar.offsetWidth + 1) + 'px'; // +1 for resize handle

  _slashActiveIdx = -1;
  menu.innerHTML = matches.map((c, i) =>
    `<div class="slash-item" data-idx="${i}" data-name="${esc(c.name)}">` +
    `<span class="slash-item-name">${prefix}${esc(c.name)}</span>` +
    `<span class="slash-item-desc">${esc(c.description)}</span>` +
    `</div>`
  ).join('');

  menu.querySelectorAll('.slash-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // don't blur input
      acceptSlashItem(el.dataset.name);
    });
  });

  menu.classList.remove('hidden');
}

export function hideSlashMenu() {
  $.slashMenu.classList.add('hidden');
  _slashActiveIdx = -1;
}

export function moveSlashSelection(delta) {
  const menu = $.slashMenu;
  const items = menu.querySelectorAll('.slash-item');
  if (!items.length) return;
  items[_slashActiveIdx]?.classList.remove('active');
  _slashActiveIdx = Math.max(0, Math.min(items.length - 1, _slashActiveIdx + delta));
  const active = items[_slashActiveIdx];
  active.classList.add('active');
  active.scrollIntoView({ block: 'nearest' });
}

// Returns { start, end, query, type:'slash' } for a /word at cursor, or null.
// Only matches if / is at start of input or preceded by a space (not mid-URL).
export function getSlashToken(input) {
  const val = input.value;
  const pos = input.selectionStart;
  let slashPos = -1;
  for (let i = pos - 1; i >= 0; i--) {
    if (val[i] === '/') {
      if (i === 0 || val[i - 1] === ' ') { slashPos = i; break; }
    } else if (val[i] === ' ') {
      break;
    }
  }
  if (slashPos === -1) return null;
  const query = val.slice(slashPos + 1, pos);
  if (query.includes(' ')) return null;
  return { start: slashPos, end: pos, query, type: 'slash' };
}

// Returns { start, end, query, type:'flag' } for a --word at cursor, or null.
// Only matches if -- is at start of input or preceded by a space.
export function getFlagToken(input) {
  const val = input.value;
  const pos = input.selectionStart;
  if (pos < 2) return null;
  let dashPos = -1;
  for (let i = pos - 1; i >= 1; i--) {
    if (val[i] === '-' && val[i - 1] === '-') {
      if (i - 1 === 0 || val[i - 2] === ' ') { dashPos = i - 1; break; }
    } else if (val[i] === ' ') {
      break;
    }
  }
  if (dashPos === -1) return null;
  const query = val.slice(dashPos + 2, pos);
  if (query.includes(' ') || query.startsWith('-')) return null;
  return { start: dashPos, end: pos, query, type: 'flag' };
}

export function acceptSlashItem(name) {
  const input = $.inputField;
  const token = _activeToken;
  const prefix = token?.type === 'flag' ? '--' : '/';
  if (token) {
    const val = input.value;
    const newVal = val.slice(0, token.start) + prefix + name + ' ' + val.slice(token.end);
    input.value = newVal;
    const newPos = token.start + prefix.length + name.length + 1;
    input.setSelectionRange(newPos, newPos);
  } else {
    input.value = prefix + name + ' ';
  }
  input.focus();
  hideSlashMenu();
  autoResize(input);
}

export function acceptActiveSlashItem() {
  const menu = $.slashMenu;
  const items = menu.querySelectorAll('.slash-item');
  const idx = _slashActiveIdx >= 0 ? _slashActiveIdx : 0;
  if (items[idx]) acceptSlashItem(items[idx].dataset.name);
}

export function getSlashActiveIdx() { return _slashActiveIdx; }
