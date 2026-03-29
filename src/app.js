/**
 * Pixel Terminal — app.js
 * Uses Tauri global APIs (withGlobalTauri: true), no bundler needed.
 *
 * Globals available:
 *   window.__TAURI__.shell.Command
 *   window.__TAURI__.dialog.open
 *   window.marked  (from marked.umd.js)
 */

'use strict';

// ── Tauri + marked globals ─────────────────────────────────

const { Command } = window.__TAURI__.shell;
const { open: openDialog } = window.__TAURI__.dialog;
const { invoke } = window.__TAURI__.core;
const { parse: mdParse } = window.marked;
window.marked.setOptions({ breaks: true, gfm: true });

// ── Sprite data (inlined — eliminates all load/protocol issues) ──────────
const SPRITE_DATA = {
  'cat': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBTgApxcIv/x8Qe7fooAJ5fI//stS/+DaBiG8YeCfpgZ+PggwMiAA4AUGzjYgNnPnzwH05IykgwXDhxh+P7tDU596PqR9YIAqfopsf9a1UQGrbZ8uBiMj6yfBZ8hIItBlsIcTw5A1gvzCLGAUvujjq1mQI4EEB8dMGHTCEsqIIvXlyvAHQNjE0qGMHmQepjlIDbMI8TqJ9d+GEBOObgCkQndYhBGTiIWucfBBu0PywOzQQBXEkTXD1IP0gfSD9NLin5y7SclAJmw5TmYJaD8Bgs5x1WTGF7euYvXcnT9IPUgfcTkX2raT0oAMmEzDGaguIoy3PEgDLKAlFIcpB85+ZGjn1z7iQ1AJnyGwDSDQpDUAmyg9RMbgEzoGmGKYJpJBYNJPzEByISeZJABSNMyq1Bw0gFhEBsXGOr6RwHDCAUAGpNqzZQe1mUAAAAASUVORK5CYII=',
  'rabbit': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA9klEQVR4nGNgGAWjYBQgA04ukf8gjItPKiBVP7XtJwSYsAmeW90AthgXn1RAqn5K7Cc1AJmIdRQpltMyxqgdgCz4DCI16YIsggGj0AaKA4EeAcmCLvD92xtGkOOX5DrDxa4dOkyUYUahiAAgRz+l9pMTgEz4JGMm70WhCTkchsnRT6n9yO4ARQQoAGEYXwAy4TMMlKSNeP3ANDlgoPUTE4CM+JIPLBmCDECOWWLAQOqH6dWys2XgOC/I8MPwPTh7YjODCV3g+tYp4FIcOQ+C2MQWSAOtHwRAKQYUaKCkf+7zJpyexwlAlsEcgsweKfpHwShgGDkAAJoz5Ga0OakEAAAAAElFTkSuQmCC',
  'penguin': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAAsTAAALEwEAmpwYAAABF0lEQVRYhWP8//8/w0gGTAwjHDAxjHDAxDDCARPDCAcsuCS4uEVRSsdvX18z0sVFVLSfKDP+//+PgTm5RP6rWsX9f/32JRyDxLCpxYVB6pExqXqpYT8xZjDg0gzTAKNJcQClHqDUflLMYMKXhB49vsrwfmYow8UaLVJTH8Oxzd0McrLaYDaMJhVQYj/RZvynYQyC8K02OzCmZwoixQwmbAWHjIEXRkCBxNALFXzAyrcUTAumrwZjYgGl9oPUqFnHg80ApUJ096ADJmyCTy5swynGyMiIFxPyACH9lNpPSD/BAPj+7Q3O6gafHCHLcDmA2vaTqp8Fl+KtPg/ghRcphRDIElBew6af2ACkxH5S9TOO9gYZRjYAADtGhP+ePrhdAAAAAElFTkSuQmCC',
  'crab': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA60lEQVR4nGNgGAWjYBSMgmEEOLlE/oMwseJMlBpAbUCJ/SD5OWoyOOVBcuhmsOAyIOUWw//v394w4hPH5QgQja4Glzi17ScVMGETTLn1hCgxdABzKHpI4xLHBci1H90t2NhEBcAcLMkIX9KitgcotZ8U/UzYBEGOffT4Kjzfgdj09ACl9lOkn5NL5P9SA4P/MBqZTUwhBFP3+u1LMI3MJtUMUu0nRz8TuuZjvhrg0ALRMIAsRsgRIHWg2JaT1QbTyGxCsUCp/eToZyHkGbAB6gjDCAGQJVabb8BpXGLEAHLsp6b+UTAKGIY/AADH7fC4BIq4LgAAAABJRU5ErkJggg==',
  'rat': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBSMZMCIS4KTS+Q/jP392xtGXGK0AJTaTYp+FnwGFdrpgun+Q5f/o/Fp7glK7CZFPyMhT2gLCaOIXX33lqjYB+lFtxSZT0wskms3KfqZiDFstrUoCk0MAFkE8uiuK88YQA4BYRCbGM9TajcpepmIMWj1R1YGNx0pMA2KReSkjAxKVSz+gzA5DqHUbmypD1kvLsCI7gEQ3X3nBCO2ZLR4Zi6DUWgDzhh0lDX8v//xeUaQOSAzYPpBjkAG2FIBpXZj039udQNDbPpk4rOQo6wh2BDkWAQZZCKj/r/Kw/E/odBHj32YXhi+vnUKTjMotRuXfpBekBm49DMhc0zY2RmwxQIsBkFsfA4B6QM5AOQYEA0KbVCog/SDML4YpNRuXPpBAGQGIf1wgOwBWAiCaGQ2A5GAVP2U2k1Nt4+CUcAwMgAAymMvotX5iBgAAAAASUVORK5CYII=',
  'seal': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAAxklEQVR4nGNgGAWjYBSMghEMGAkp4OQS+Y/M//7tDUE91DSDUvsJ6WckpLmitwlFrKO4jmQPkGsGpfYTo5+JGINAmpBpcgAlZtBSLxNyaMGSCzIbBPYd3cGwY/MuMI0L4NNPjBm0sp8YvWAA0tA4fdp/ZBpZHFmMXP34zKCH/dj0M2LLM7B8AuL7ZSQzaKnKE5UHh6J+JnRDrt1+yAAyBJtmYsBQ08+ILgDTCAMFsaEMTtYeYDYoH4HY+Erhoa5/FIwChpEFAKM3JDuNyYkcAAAAAElFTkSuQmCC',
  'snake': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABHUlEQVR4nGNgGOGAkWEYAk4ukf/I/O/f3jCOmADg5BL5X6iTznDs4zUGK34tMH3y8WGcgcCEyxBkTK5DyDWDUvv7r8wEex5G4wOMlIYgLg+Qawal9sP0wwDJ7ueEhnqVWTUKTZRmKphBTfuJ0c+ETRAWgrCYIAdQYgal9sNi+/72GPLcz0lCCNLCDGrZ/+JgAXkp4DulIUihGdSwHwYI6WciZAChUhQXAIU6yAOTSrlJLkSpYT+x+lmQOdiSCiwEkeVweWag9WMzB1k/Nn1MyJpAhQ4o1kAYPQTNZW3BhRKIxubQgdaPbg42/dj0MWILNRhAdggMgJI0qIGBHpoDrR+bOcj6celjxGYIPkeBACmNksGkn9xyaBQwDGMAAKNsPyaqyIfWAAAAAElFTkSuQmCC',
  'k-whale': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAACSElEQVR4nOVXzW7bMAymFCfNNuTYwvEpj6BnyMGAmlOeNKfAgA95BesNdhoK9DbksKaxrYGu6HKe/NOliQ8jQFAWRH4kJZmUsNbCv5IxRiilbN8alH3rro0PAN51wUBlJBxbBGTzEgCKLhtdDvYF8Jn4xhj4UAKMcw6l3mxLmk/2u4nebGvQpx/fRV8AbUEOSc418QFASE+muQEEK5P9borfxfkF4lgXKMmZvgBobIyRhOO+kSe3wnenhXBQvs3hP4BzlmXCsQyjlb2/D62bD+gbZZZlX7hOi50JruVMdonHxhf8J0g78ai1yIv3u/X8/FTtGABM41if0jT5CgAvvqPFdhOPbrVbaZpM9WZ7pp1Dmkzn1Q4qpcox8QOaiJZLYeX8zRk5h/z0s1788LC0qMCoE7wZgFIqT/a7md5sX9EJB/6NBz8GPgCUAQc//XoH5ZTnp4qRguAOBd7JV37PPhJAst9JHsAY+FQWA1TMCyi5wuFwqOR6vfY6BABnl1l7aQCPWsNY+AAgqn8AZogWtJFTxPv01+5VATD9rgDQTtPGGPh0AgQmwN0dTN+CFsaxrpXSNKHhTClVZZ/TJQEg3Rqfd4WiUQUkNRm84cBmw9dU8GalGcDxeKztLhaLzgBuiU/XpybbqKNUJ9145qvVbYy6KMNoRXVchNFK8vrerNWfjR9GqzuGj31AjeEYGIs/ToDLKnVX5dBHTKPrwiNeDn2seGxdit829uoK7LAcGC4c4mzzgVLXckfeANoccO+Rq+EPtAn/Lf0GFXRi02iJaN8AAAAASUVORK5CYII=',
  'cat2': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAAsTAAALEwEAmpwYAAABuElEQVRYhe1XsUoDQRDdW4JoAoKgQiy1EcFS/AAbGy0EfyB10N5axDZiq50/EBH8hWAnIjZiIyoqCNGcYrPy1rxlOfY2u4mFcj4YspOZt7NvmNtLEqWUKDKkKDikKDqUUrk2Uh5XPt9lNpDv83thUL4P5rzKI/5m+0jhk0Y/pAE+fqj4QfjcI8/neUu+DV4fdkWrVhVX6bDxY4D8/eVRvV6YqvTFR/2zu050fYi93GqIuZ1NI5r+e/qc8LuSb5Prl08xMzYkZssfol9AOEEhoUA++PYeP91A6SKWKxO6axA/ub5kDsM14y50H5821shncawppNcYM458V/3Qx4C1fU2UWeGwtPNkRuSk0dQbrew19Rqw4xnuWzeu5x754IFPLmCPYFY4zI676vfixzRQ2gIwLgRELh7em84db6yK+mnbKZ5o1aoVTgfykA8eD4P9fIe36yPPVT+EH9NAmScGQuwLDIYCvvF38e3xAz/mLeCqH8oPbaB0kZPkO4dkdNC+wBDPWgw/FIPwQxsos0QmkRyL38QPaqCyfsCAeF6f15fIwdq0tsfbC3OxcJ1X/C/xqTv5/zcoio0v6Sr8VDTnp8YAAAAASUVORK5CYII=',
  'frog2': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAAsTAAALEwEAmpwYAAABy0lEQVRYheWXvUvDUBTFbx5BTIpQIUFQcCidBNGtXVydqrg5O7hYcJMKzp06V3DyL9BBnBydKi6Cq5PgIK0iSNMuEjmvvfE1JmnSDx1yoLyP5Lzfvfe9Jq3mui6lWYJSLkEpl6CUS1DKJSjl0qMumhkbBfpS55x2U0OrabLxlPRtovrDvFH8qRfAzNjzRPS+Vyv45924QYyTADhop83XI/wy+frBNZVPS5TN974tTrvJwWnTSqB/j+SyEMfJzbZcL+4acfgizLxVyUmombFlC1U3r+R4mNjPBYRQQHyUAg5bQ3rh4TjAj6MkfBFkhtGybFlxGNBCPI4Dh0YpIPODuDyeJF9TH0AMb7V6SaIIqNr+2s6AaSVXoY7TGjiCWIfh8EHwAqoGzkGofo5B5eeLC7+4UO3iks6P7gKfJUn47Nf9i3Dy3N8tFuj55YGWl9a95GH2vwVYgP+sYdOtdTiQSH8HFgPNCv+p8UqVxhmVSwWPjTjCkh+Vr6nVXy07sj+b1em+OkMbxwZ9fL7RY92U83wdY/8JMEwrib/bcVqG//Qk4fuLkNDfddpNyfcKELajf6H//EcquGOYVuSPomEyTMvb0Rj3zo3DmqS+Aaa7NqYBW1vuAAAAAElFTkSuQmCC'
};

// ── SpriteRenderer ─────────────────────────────────────────
// CSS background-image + RAF. No canvas. No image load events.
// Sheet 64x16 displayed at 128x32 (2x). backgroundPosition shifts per frame.

const ANIMALS = ['cat', 'rabbit', 'penguin', 'rat', 'seal', 'snake', 'k-whale', 'cat2', 'frog2'];
const HUES = [0, 120, 195, 270];
const IDENTITY_SEQ_KEY = 'pixel-terminal-identity-seq-v7';

function getNextIdentity() {
  // Animal order: global counter cycles all 9 animals before any repeats.
  // Hue order: per-animal counter — first appearance always gets hue 0 (original color),
  //            subsequent appearances advance through HUES independently per animal.
  const store = JSON.parse(localStorage.getItem(IDENTITY_SEQ_KEY) || '{"idx":0,"counts":{}}');
  const animalIndex = store.idx % ANIMALS.length;
  const animal = ANIMALS[animalIndex];
  const count = store.counts[animal] || 0;
  store.counts[animal] = count + 1;
  store.idx = store.idx + 1;
  localStorage.setItem(IDENTITY_SEQ_KEY, JSON.stringify(store));
  return {
    animalIndex,
    hueIndex: count % HUES.length,
  };
}

class SpriteRenderer {
  constructor(el, charIndex, hueIndex = 0) {
    this.el = el;
    this._frameIdx = 0;
    this._status = 'idle';
    this._raf = null;
    this._lastTs = 0;
    this._FPS = 6;

    const animal = ANIMALS[charIndex % ANIMALS.length];
    const data = SPRITE_DATA[animal];

    el.style.width = '40px';
    el.style.height = '40px';
    el.style.flexShrink = '0';
    el.style.backgroundImage = "url('" + data + "')";
    el.style.backgroundSize = '160px 40px';
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundPosition = '0 0';
    el.style.imageRendering = 'pixelated';
    if (hueIndex > 0) el.style.filter = `hue-rotate(${HUES[hueIndex]}deg) saturate(1.4)`;
    // Loop starts only when setStatus transitions to an active state
  }

  setStatus(status) {
    if (this._status === status) return;
    const wasInactive = this._status === 'idle' || this._status === 'error' || this._status === 'waiting';
    this._status = status;
    this._frameIdx = 0;
    this._lastTs = 0; // reset so first frame of new state doesn't skip delay
    this.el.style.backgroundPosition = '0 0'; // snap to frame 0 immediately
    this._FPS = 3;
    // Animate only during active work — waiting/idle/error hold frame 0
    const isInactive = status === 'idle' || status === 'error' || status === 'waiting';
    if (wasInactive && !isInactive && !this._raf) this._startLoop();
  }

  _startLoop() {
    const loop = (ts) => {
      // Self-cancel when inactive — don't keep spinning at 60fps doing nothing
      if (this._status === 'idle' || this._status === 'error' || this._status === 'waiting') {
        this._raf = null;
        return;
      }
      this._raf = requestAnimationFrame(loop);
      if (ts - this._lastTs >= 1000 / this._FPS) {
        this._frameIdx = (this._frameIdx + 1) % 4;
        this.el.style.backgroundPosition = (-this._frameIdx * 40) + 'px 0';
        this._lastTs = ts;
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  destroy() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }
}

// ── Self-directory detection ────────────────────────────────
// Walks upward from cwd checking for .pixel-terminal sentinel file.
// Prevents Claude sessions from editing Pixel Terminal's own source files.

async function isSelfDirectory(cwd) {
  const paths = [];
  let dir = cwd.replace(/\/$/, '');
  for (let i = 0; i < 10; i++) {
    paths.push(dir + '/.pixel-terminal');
    const parent = dir.replace(/\/[^/]+$/, '') || '/';
    if (parent === dir) break;
    dir = parent;
  }
  const results = await Promise.all(
    paths.map(p => Command.create('test', ['-f', p]).execute().catch(e => { console.warn('isSelfDirectory check failed:', e); return { code: 1 }; }))
  );
  return results.some(r => r.code === 0);
}

// ── Session state ──────────────────────────────────────────

/** @type {Map<string, Session>} */
const sessions = new Map();

/** @type {Map<string, {messages: Object[]}>} */
const sessionLogs = new Map();

/** @type {Map<string, SpriteRenderer>} — one renderer per session card */
const spriteRenderers = new Map();

let activeSessionId = null;

// Notify the Rust WebSocket bridge of current session state.
// Called on create/kill/switch so OmiWebhook can route "session N" commands.
async function syncOmiSessions() {
  const data = [...sessions.entries()].map(([id, s], i) => ({
    id, name: s.name, index: i + 1, status: s.status,
  }));
  try {
    await invoke('sync_omi_sessions', { sessions: data, active: activeSessionId });
  } catch (_) { /* bridge not available — ignore */ }
}

// ── Session lifecycle ──────────────────────────────────────

async function createSession(cwd, opts = {}) {
  const id    = crypto.randomUUID();
  const name  = cwd.split('/').pop() || cwd;
  const { animalIndex: charIndex, hueIndex } = getNextIdentity();

  sessionLogs.set(id, { messages: [] });

  /** @type {Session} */
  const session = {
    id, cwd, name, charIndex, hueIndex,
    status: 'idle',
    child: null,
    toolPending: {},
    readOnly: !!opts.readOnly,
    unread: false,
    tokens: 0,
    _liveTokens: 0,
    _dotsPhase: 0,
    _pendingMsg: null,
  };
  sessions.set(id, session);

  renderSessionCard(id);
  setActiveSession(id);
  const modeLabel = opts.readOnly ? ' (read-only)' : '';
  pushMessage(id, { type: 'system-msg', text: `Starting in ${cwd}${modeLabel}…` });

  spawnClaude(id); // fire-and-forget — all handling is callback-based
  setStatus(id, 'waiting'); // static "waiting…" during init — no rotating words until user sends
  syncOmiSessions();
  return id;
}

// Spawn (or re-spawn) the Claude CLI process for an existing session.
// Called by createSession on init, and by the Escape handler to restart after interrupt.
async function spawnClaude(id) {
  const s = sessions.get(id);
  if (!s) return;
  try {
    const claudeArgs = [
      '-p',
      '--input-format',  'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
    ];
    if (s.readOnly) claudeArgs.push('--disallowed-tools', 'Edit,Write,MultiEdit,NotebookEdit,Bash');
    const cmd = Command.create('claude', claudeArgs, { cwd: s.cwd });

    let _buf = '';
    cmd.stdout.on('data', (chunk) => {
      _buf += chunk;
      const lines = _buf.split('\n');
      _buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleEvent(id, JSON.parse(line)); } catch (_) {}
      }
    });

    cmd.stderr.on('data', (line) => {
      if (line && line.trim()) pushMessage(id, { type: 'error', text: `[stderr] ${line.trim()}` });
    });

    cmd.on('close', (data) => {
      const code = (typeof data === 'object' && data !== null) ? data.code : data;
      s.child = null;
      setStatus(id, code === 0 ? 'idle' : 'error');
      pushMessage(id, { type: 'system-msg', text: `Session ended (exit ${code})` });
    });

    const child = await cmd.spawn();
    s.child = child;
    s.toolPending = {};
    // _pendingMsg is flushed in system/init handler — Claude only reads stdin after that event

  } catch (err) {
    pushMessage(id, { type: 'error', text: `Failed to start Claude Code: ${err}` });
    setStatus(id, 'error');
  }
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.child?.kill(); } catch (_) {}

  spriteRenderers.get(id)?.destroy();
  spriteRenderers.delete(id);

  sessions.delete(id);
  sessionLogs.delete(id);
  document.getElementById(`card-${id}`)?.remove();

  if (activeSessionId === id) {
    const remaining = [...sessions.keys()];
    if (remaining.length > 0) setActiveSession(remaining[remaining.length - 1]);
    else {
      activeSessionId = null;
      showEmptyState();
    }
  }
  syncOmiSessions();
}

// Returns true and shows a warning if text looks like an unrecognized slash command.
// Guard: skips check when _slashCommands is empty (load may have failed).
function warnIfUnknownCommand(id, text) {
  if (!_slashCommands.length) return false; // can't validate — pass through
  const m = text.match(/^\/([^\s\/]+)/);
  if (!m) return false;
  const name = m[1];
  if (_slashCommands.find(c => c.name === name)) return false;
  pushMessage(id, { type: 'warn', text: `Unknown command: /${name}` });
  return true;
}

// Expand /commandname messages by reading the skill file content.
// Only expands if text starts with /name matching a known slash command.
// Shows original text in log — sends expanded content to Claude.
async function expandSlashCommand(text) {
  const m = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!m) return text;
  const [, cmdName, args = ''] = m;
  if (!_slashCommands.find(c => c.name === cmdName)) return text;
  try {
    const body = await invoke('read_slash_command_content', { name: cmdName });
    if (!body) return text;
    return args.trim() ? body + '\n\nARGUMENTS: ' + args.trim() : body;
  } catch (_) {
    return text;
  }
}

async function sendMessage(id, text) {
  const s = sessions.get(id);
  if (!s || !text.trim()) return;

  const raw = text.trim();

  if (warnIfUnknownCommand(id, raw)) return;

  if (!s.child) {
    // Process still spawning — queue until system/init fires.
    // Don't pushMessage yet — show it after "Ready" so log order is correct.
    s._pendingMsg = raw;
    setStatus(id, 'working'); // badge reacts immediately
    return;
  }

  const expanded = await expandSlashCommand(raw);
  pushMessage(id, { type: 'user', text: raw }); // show original in log
  setStatus(id, 'working');

  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: expanded }
  }) + '\n';
  try {
    await s.child.write(line);
  } catch (err) {
    pushMessage(id, { type: 'error', text: 'Send failed — please retry' });
    setStatus(id, 'idle');
  }
}

// ── Event handler ──────────────────────────────────────────

function handleEvent(id, event) {
  const s = sessions.get(id);
  if (!s) return;

  switch (event.type) {

    case 'assistant': {
      // Cancel any pending idle debounce — Claude is still going
      clearTimeout(s._idleTimer);
      if (event.message?.usage) {
        s._lastMsgUsage = event.message.usage;
        const u = event.message.usage;
        // Only count input+output — cache_read recurs every turn (already-counted context),
        // causing exponential inflation. cache_creation has the same problem.
        s._liveTokens = (u.input_tokens || 0) + (u.output_tokens || 0);
      }
      const blocks = event.message?.content || [];

      const texts = blocks.filter(b => b.type === 'text').map(b => b.text);
      if (texts.length) pushMessage(id, { type: 'claude', text: texts.join('\n') });

      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const input = typeof b.input === 'object'
            ? JSON.stringify(b.input, null, 2)
            : String(b.input || '');
          if (!isInternalTool(b.name)) {
            pushMessage(id, { type: 'tool', toolName: b.name, toolId: b.id, input, result: null });
          }
          s.toolPending[b.id] = true;
        }
      }
      setStatus(id, 'working'); // no-op if already working — so always refresh card for live tokens
      updateSessionCard(id);
      break;
    }

    case 'user': {
      const blocks = event.message?.content || [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const resultText = typeof b.content === 'string'
            ? b.content
            : JSON.stringify(b.content);
          const data = sessionLogs.get(id);
          // tool_use always precedes tool_result — scan from end, no reverse copy needed
          const toolMsg = data
            ? data.messages.findLast(m => m.type === 'tool' && m.toolId === b.tool_use_id)
            : null;
          if (toolMsg) {
            toolMsg.result = resultText;
            if (activeSessionId === id) {
              // Targeted update: swap just the status glyph instead of rebuilding all messages
              const log = document.getElementById('message-log');
              const toolEl = log?.querySelector(`[data-tool-id="${b.tool_use_id}"]`);
              if (toolEl) {
                toolEl.querySelector('.tool-status').textContent = '✓';
              }
            }
          }
          delete s.toolPending[b.tool_use_id];
        }
      }
      break;
    }

    case 'result': {
      // Prefer result.usage (per-turn total); fall back to live tokens already shown
      const u = event.usage || s._lastMsgUsage;
      if (u) s.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
      else s.tokens += s._liveTokens; // result.usage absent and no assistant usage either
      s._liveTokens = 0;
      s._lastMsgUsage = null;
      // Debounce: Claude may immediately start another turn after result.
      // Wait 400ms before going idle so the cursor doesn't flicker between turns.
      clearTimeout(s._idleTimer);
      s._idleTimer = setTimeout(() => {
        setStatus(id, 'idle');
        if (activeSessionId !== id) {
          s.unread = true;
          updateSessionCard(id);
        }
      }, 400);
      break;
    }

    case 'system':
      if (event.subtype === 'init') {
        pushMessage(id, { type: 'system-msg', text: `Ready · ${event.model || 'claude'}` });
        // Don't clobber 'working' — user may have queued a message before init
        if (s.status !== 'working') setStatus(id, 'idle');
        // Flush message queued before Claude was ready.
        // pushMessage here so it appears AFTER "Ready" in the log.
        if (s._pendingMsg && s.child) {
          const msg = s._pendingMsg;
          s._pendingMsg = null;
          if (warnIfUnknownCommand(id, msg)) break;
          pushMessage(id, { type: 'user', text: msg }); // show original
          expandSlashCommand(msg).then(expanded => {
            if (!s.child) return;
            return s.child.write(JSON.stringify({ type: 'user', message: { role: 'user', content: expanded } }) + '\n');
          }).catch(() => {
            pushMessage(id, { type: 'error', text: 'Failed to send — please resend your message' });
            setStatus(id, 'idle');
          });
        }
      }
      break;

    case 'rate_limit_event':
      pushMessage(id, { type: 'system-msg', text: `Rate limited — retrying…` });
      break;
  }
}

// ── Status ─────────────────────────────────────────────────

function setStatus(id, status) {
  const s = sessions.get(id);
  if (!s || s.status === status) return;
  if (status === 'working') s._dotsPhase = 0; // always start from "" on new working transition
  s.status = status;
  updateSessionCard(id);
  if (activeSessionId === id) updateWorkingCursor(status);
}

// Tools that are Claude Code internal scaffolding — never show in UI
const INTERNAL_TOOLS = new Set([
  'ToolSearch','TodoWrite','TodoRead','AskUserQuestion',
  'TaskCreate','TaskUpdate','TaskList','TaskGet','TaskStop','TaskOutput',
  'ExitPlanMode','EnterPlanMode','NotebookEdit',
  'RemoteTrigger','CronCreate','CronDelete','CronList',
  'ListMcpResourcesTool','ReadMcpResourceTool',
  'EnterWorktree','ExitWorktree',
]);
function isInternalTool(name) {
  return name.startsWith('mcp__') || INTERNAL_TOOLS.has(name);
}

const WORKING_MSGS = [
  'thinking', 'scheming', 'deliberating', 'gallivanting', 'pondering',
  'contemplating', 'ruminating', 'cogitating', 'hypothesizing', 'spelunking',
  'wrangling', 'untangling', 'cross-referencing', 'noodling', 'vibing',
  'consulting the void', 'reading the entrails', 'asking nicely',
  'summoning context', 'doing its thing',
];
let _workingTimer = null;
let _workingMsgIdx = 0;

function updateWorkingCursor(status) {
  const log = document.getElementById('message-log');
  if (!log) return;
  let cur = document.getElementById('working-cursor');
  if (status === 'working') {
    if (!cur) {
      cur = document.createElement('div');
      cur.id = 'working-cursor';
      log.appendChild(cur);
      scheduleScroll();
    }
    // Build cursor structure once, update text node only — avoid innerHTML re-parsing every 3s
    if (!cur.firstChild) {
      const glyph = document.createElement('span');
      glyph.className = 'cursor-blink';
      glyph.textContent = '▋';
      cur.appendChild(glyph);
      cur.appendChild(document.createTextNode(''));
    }
    const textNode = cur.lastChild;
    const setMsg = () => {
      textNode.textContent = ' ' + WORKING_MSGS[_workingMsgIdx++ % WORKING_MSGS.length] + '…';
    };
    setMsg();
    clearInterval(_workingTimer);
    _workingTimer = setInterval(setMsg, 3000);
  } else {
    clearInterval(_workingTimer);
    _workingTimer = null;
    cur?.remove();
  }
}

// ── Message log ────────────────────────────────────────────

// rAF-coalesced scroll — only scrolls if user hasn't manually scrolled up
let _scrollPending = false;
let _pinToBottom = true; // false when user scrolls up; restored when user scrolls back down or sends a message

function scheduleScroll(force = false) {
  if (!force && !_pinToBottom) return;
  if (_scrollPending) return;
  _scrollPending = true;
  requestAnimationFrame(() => {
    _scrollPending = false;
    const log = document.getElementById('message-log');
    if (log) log.lastElementChild?.scrollIntoView({ block: 'end' });
  });
}

function pushMessage(id, msg) {
  const data = sessionLogs.get(id);
  if (!data) return;
  data.messages.push(msg);
  if (activeSessionId === id) {
    const log = document.getElementById('message-log');
    if (log) {
      // Insert BEFORE the working cursor so cursor stays at bottom
      const cursor = document.getElementById('working-cursor');
      const el = createMsgEl(msg);
      el.classList.add('msg-new');
      if (cursor) log.insertBefore(el, cursor);
      else log.appendChild(el);
      scheduleScroll();
    }
  }
}

function renderMessageLog(id) {
  const log = document.getElementById('message-log');
  if (!log) return;
  log.innerHTML = ''; // cursor gets wiped here — restore below
  const data = sessionLogs.get(id);
  if (data) {
    // DocumentFragment: build all elements off-DOM, single reflow on append
    const frag = document.createDocumentFragment();
    for (const msg of data.messages) frag.appendChild(createMsgEl(msg));
    log.appendChild(frag);
  }
  // Always restore cursor to match current session status
  const s = sessions.get(id);
  if (s && s.status === 'working') {
    updateWorkingCursor(s.status);
  }
  scheduleScroll();
}

function createMsgEl(msg) {
  const el = document.createElement('div');
  el.className = `msg ${msg.type}`;

  if (msg.type === 'user') {
    el.innerHTML = `<div class="msg-bubble">${esc(msg.text)}</div>`;

  } else if (msg.type === 'claude') {
    // Cache parsed HTML — msg.text is immutable after creation
    if (!msg._html) {
      const normalized = msg.text.replace(/\n\n(?=[ \t]*(?:\d+[.)]\s|[-*+]\s))/g, '\n');
      msg._html = mdParse(normalized);
    }
    el.innerHTML = `<div class="msg-bubble">${msg._html}</div>`;
    // Orange for the last paragraph regardless of trailing hr/empty nodes
    const paras = el.querySelectorAll('.msg-bubble p');
    if (paras.length) paras[paras.length - 1].style.color = '#e8820c';

  } else if (msg.type === 'tool') {
    const icon = toolIcon(msg.toolName);
    // Cache hint — msg.input is immutable after creation
    if (msg._hint === undefined) msg._hint = toolHint(msg.toolName, msg.input);
    const hint = msg._hint;
    const hasResult = msg.result !== null && msg.result !== undefined;
    const status = hasResult ? '✓' : '…';
    el.dataset.toolId = msg.toolId;
    el.innerHTML = `<div class="tool-line">${icon} <span class="tool-name">${esc(msg.toolName)}</span>${hint ? ` <span class="tool-hint">${esc(hint)}</span>` : ''} <span class="tool-status">${status}</span></div>`;

  } else if (msg.type === 'system-msg') {
    el.innerHTML = `<div class="system-label">${esc(msg.text)}</div>`;

  } else if (msg.type === 'error') {
    el.innerHTML = `<div class="error-msg">${esc(msg.text)}</div>`;
  } else if (msg.type === 'warn') {
    el.innerHTML = `<div class="warn-msg">${esc(msg.text)}</div>`;
  }

  return el;
}

// ── Token formatting ────────────────────────────────────────

function formatTokens(n) {
  const t = n || 0;
  if (t < 1_000_000) return '~' + Math.round(t / 1000) + 'K';
  return '~' + (t / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

// ── Session cards ──────────────────────────────────────────

function renderSessionCard(id) {
  const s = sessions.get(id);
  if (!s) return;

  const card = document.createElement('div');
  card.className = 'session-card';
  card.id = `card-${id}`;
  card.innerHTML = `
    <div class="session-card-top">
      <div class="sprite-wrap" id="card-sprite-wrap-${id}"></div>
      <div class="session-card-info">
        <div class="session-card-name">${esc(s.name)}</div>
        <div class="session-card-tokens" id="card-tokens-${id}"></div>
      </div>
      <span class="card-badge" id="card-status-${id}"></span>
    </div>
    <button class="session-card-kill" title="Kill session" data-id="${id}">✕</button>
  `;

  card.addEventListener('click', (e) => {
    if (e.target.closest('.session-card-kill')) return;
    setActiveSession(id);
  });
  card.querySelector('.session-card-kill').addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await showConfirm(`Terminate "${s.name}"? This will end the session.`);
    if (ok) killSession(id);
  });
  document.getElementById('session-list').appendChild(card);

  // Attach sprite renderer to the wrap div
  const wrap = document.getElementById(`card-sprite-wrap-${id}`);
  spriteRenderers.set(id, new SpriteRenderer(wrap, s.charIndex, s.hueIndex));
}

function updateSessionCard(id) {
  const s = sessions.get(id);
  if (!s) return;

  spriteRenderers.get(id)?.setStatus(s.status);

  const statusEl = document.getElementById(`card-status-${id}`);
  if (statusEl) {
    if (s.unread) {
      statusEl.textContent = 'NEW';
      statusEl.className = 'card-badge unread';
    } else {
      const label = { idle: 'IDLE', error: 'ERR', working: '.'.repeat(s._dotsPhase || 0), waiting: '···' }[s.status] ?? '···';
      statusEl.textContent = label;
      statusEl.className = `card-badge ${s.status}`;
    }
    statusEl.style.display = '';
  }

  const tokensEl = document.getElementById(`card-tokens-${id}`);
  if (tokensEl) {
    tokensEl.textContent = formatTokens(s.tokens + (s._liveTokens || 0));
  }

  const card = document.getElementById(`card-${id}`);
  if (card) card.classList.toggle('active', activeSessionId === id);
}

// ── Session switching ──────────────────────────────────────

function setActiveSession(id) {
  const prev = activeSessionId;
  activeSessionId = id;
  _pinToBottom = true;
  const viewedSession = sessions.get(id);
  if (viewedSession) viewedSession.unread = false;
  if (prev && prev !== id) updateSessionCard(prev);
  updateSessionCard(id);
  showChatView();
  renderMessageLog(id);
  const s = sessions.get(id);
  if (s) updateWorkingCursor(s.status);
  document.getElementById('msg-input')?.focus();
  syncOmiSessions();
}

// ── View helpers ───────────────────────────────────────────

function showEmptyState() {
  document.getElementById('message-log').innerHTML = '';
}

function showChatView() {
  // intentionally no-op — never disable controls in a terminal app
}


// ── Util ───────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toolIcon(name = '') {
  return '·';
}

function toolHint(name, inputStr) {
  try {
    const obj = JSON.parse(inputStr);
    const n = name.toLowerCase();
    // File/path tools
    if (obj.file_path) return obj.file_path.replace(/.*\//, '');
    if (obj.path) return obj.path.replace(/.*\//, '');
    if (obj.pattern) return obj.pattern;
    if (obj.command) return String(obj.command).slice(0, 60);
    // Memory tools
    if (obj.query_texts) return obj.query_texts[0]?.slice(0, 50);
    if (obj.collection && obj.documents) return obj.collection;
    // Web
    if (obj.url) return obj.url.replace(/^https?:\/\//, '').slice(0, 50);
    if (obj.query) return String(obj.query).slice(0, 50);
    // Figma
    if (obj.node_id) return `node:${obj.node_id}`;
    if (obj.name) return String(obj.name).slice(0, 50);
    // Generic: first string value
    const first = Object.values(obj).find(v => typeof v === 'string');
    return first ? first.slice(0, 50) : '';
  } catch (_) {
    return String(inputStr || '').slice(0, 50);
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ── Confirm modal ──────────────────────────────────────────

function showConfirm(message, okLabel = 'terminate') {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay');
    document.getElementById('confirm-msg').textContent = message;
    document.getElementById('confirm-ok').textContent = okLabel;
    overlay.classList.remove('hidden');

    function onOk()    { cleanup(); resolve(true);  }
    function onCancel(){ cleanup(); resolve(false); }
    function onKey(e)  {
      if (e.key === 'Enter')  { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }

    function cleanup() {
      overlay.classList.add('hidden');
      document.getElementById('confirm-ok').removeEventListener('click', onOk);
      document.getElementById('confirm-cancel').removeEventListener('click', onCancel);
      window.removeEventListener('keydown', onKey);
    }

    document.getElementById('confirm-ok').addEventListener('click', onOk);
    document.getElementById('confirm-cancel').addEventListener('click', onCancel);
    window.addEventListener('keydown', onKey);
  });
}

// ── Folder picker ──────────────────────────────────────────

async function pickFolder() {
  try {
    const dir = await openDialog({ directory: true, multiple: false, title: 'Choose Project Folder' });
    if (!dir) return;
    if (await isSelfDirectory(dir)) {
      const proceed = await showConfirm(
        "This is Pixel Terminal's own source directory.\nEditing files here will crash all running sessions.\nProceed in read-only mode?",
        'proceed read-only'
      );
      if (!proceed) return;
      await createSession(dir, { readOnly: true });
    } else {
      await createSession(dir);
    }
  } catch (err) {
    console.error('Folder picker error:', err);
  }
}

// ── Slash command / flag autocomplete menu ──────────────────

let _slashCommands = [];    // loaded once on startup
let _slashActiveIdx = -1;   // keyboard-highlighted row
let _activeToken   = null;  // token that opened the menu

const FLAG_ITEMS = [
  { name: 'seq',        description: 'sequential-thinking MCP — structured multi-step reasoning' },
  { name: 'think',      description: 'pause and reason carefully before responding' },
  { name: 'think-hard', description: '--think + --seq combined' },
  { name: 'ultrathink', description: '--think-hard + explicit plan before acting' },
  { name: 'uc',         description: 'ultra-compressed output' },
  { name: 'no-mcp',     description: 'disable all MCP servers' },
  { name: 'grade',      description: 'grade current plan (use with /sm:introspect)' },
  { name: 'quick',      description: 'fast bootstrap — skip memory queries' },
  { name: 'cold',       description: 'fresh start, skip project memory' },
  { name: 'retro',      description: 'end-of-session retro (use with /checkpoint)' },
  { name: 'dry-run',    description: 'show what would happen without writing' },
  { name: 'state-only', description: 'write STATE.md only (use with /checkpoint)' },
  { name: 'brief',      description: 'meeting/pitch brief mode (use with /research)' },
];

async function loadSlashCommands() {
  try {
    _slashCommands = await invoke('read_slash_commands');
  } catch (_) {
    _slashCommands = [];
  }
}

function showSlashMenu(token) {
  _activeToken = token;
  const menu = document.getElementById('slash-menu');
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
  const inputBar = document.getElementById('input-bar');
  const sidebar  = document.getElementById('sidebar');
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

function hideSlashMenu() {
  document.getElementById('slash-menu').classList.add('hidden');
  _slashActiveIdx = -1;
}

function moveSlashSelection(delta) {
  const menu = document.getElementById('slash-menu');
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
function getSlashToken(input) {
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
function getFlagToken(input) {
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

function acceptSlashItem(name) {
  const input = document.getElementById('msg-input');
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

function acceptActiveSlashItem() {
  const menu = document.getElementById('slash-menu');
  const items = menu.querySelectorAll('.slash-item');
  const idx = _slashActiveIdx >= 0 ? _slashActiveIdx : 0;
  if (items[idx]) acceptSlashItem(items[idx].dataset.name);
}

// ── Bootstrap ──────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {

  loadSlashCommands();

  // Animate working badge: per-session phase cycles "" "." ".." "..." every 400ms
  setInterval(() => {
    sessions.forEach((s, id) => {
      if (s.status === 'working' && !s.unread) {
        s._dotsPhase = (s._dotsPhase + 1) % 4;
        const el = document.getElementById(`card-status-${id}`);
        if (el) el.textContent = '.'.repeat(s._dotsPhase);
      }
    });
  }, 400);

  // Open links in system browser — prevent Tauri webview from navigating away
  document.getElementById('message-log').addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    e.preventDefault();
    window.__TAURI__.opener.openUrl(href);
  });

  // Track whether user has scrolled up — suppress auto-scroll if so
  document.getElementById('message-log').addEventListener('scroll', () => {
    const log = document.getElementById('message-log');
    _pinToBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
  });

  // Sidebar resize
  const sidebar = document.getElementById('sidebar');
  const resizeHandle = document.getElementById('sidebar-resize');
  let _resizing = false, _resizeStartX = 0, _resizeStartW = 0;
  let _resizeRafId = null, _resizeW = 0;
  resizeHandle.addEventListener('mousedown', (e) => {
    _resizing = true;
    _resizeStartX = e.clientX;
    _resizeStartW = sidebar.offsetWidth;
    resizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!_resizing) return;
    _resizeW = Math.max(80, Math.min(340, _resizeStartW + (e.clientX - _resizeStartX)));
    if (!_resizeRafId) {
      _resizeRafId = requestAnimationFrame(() => {
        sidebar.style.width = _resizeW + 'px';
        _resizeRafId = null;
      });
    }
  });
  window.addEventListener('mouseup', () => {
    if (!_resizing) return;
    _resizing = false;
    // Flush any pending RAF and apply the final width immediately
    if (_resizeRafId) { cancelAnimationFrame(_resizeRafId); _resizeRafId = null; sidebar.style.width = _resizeW + 'px'; }
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  document.getElementById('btn-new-session').addEventListener('click', pickFolder);
  showEmptyState(); // input disabled until first session opens

  document.getElementById('btn-send').addEventListener('click', () => {
    const input = document.getElementById('msg-input');
    const text = input.value;
    if (!text.trim() || !activeSessionId) return;
    input.value = '';
    input.style.height = ''; // reset to rows="1" — avoids WebKit scrollHeight=0 collapse
    _pinToBottom = true;
    hideSlashMenu();
    sendMessage(activeSessionId, text);
  });

  document.getElementById('msg-input').addEventListener('keydown', (e) => {
    const menuVisible = !document.getElementById('slash-menu').classList.contains('hidden');
    if (menuVisible) {
      if (e.key === 'ArrowDown')  { e.preventDefault(); moveSlashSelection(1); return; }
      if (e.key === 'ArrowUp')    { e.preventDefault(); moveSlashSelection(-1); return; }
      if (e.key === 'Tab') {
        e.preventDefault(); acceptActiveSlashItem(); return;
      }
      if (e.key === 'Enter' && !e.shiftKey && _slashActiveIdx >= 0) {
        // Only accept if user explicitly navigated to an item with arrow keys
        e.preventDefault(); acceptActiveSlashItem(); return;
      }
      if (e.key === 'Escape')     { e.preventDefault(); hideSlashMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const input = document.getElementById('msg-input');
      const text = input.value;
      if (!text.trim() || !activeSessionId) return;
      input.value = '';
      input.style.height = '';
      _pinToBottom = true;
      hideSlashMenu();
      sendMessage(activeSessionId, text);
    }
  });

  document.getElementById('msg-input').addEventListener('input', (e) => {
    autoResize(e.target);
    const token = getSlashToken(e.target) || getFlagToken(e.target);
    if (token) {
      showSlashMenu(token);
    } else {
      hideSlashMenu();
    }
  });

  // Click outside slash menu → close it
  document.addEventListener('mousedown', (e) => {
    const menu = document.getElementById('slash-menu');
    const input = document.getElementById('msg-input');
    if (!menu.classList.contains('hidden') &&
        !menu.contains(e.target) && e.target !== input) {
      hideSlashMenu();
    }
  });

  // Esc — cancel active Claude operation (skip if slash menu is open)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('slash-menu').classList.contains('hidden')) return;
    if (e.key === 'Escape' && activeSessionId) {
      const s = sessions.get(activeSessionId);
      if (s && s.child && (s.status === 'working' || s.status === 'waiting')) {
        e.preventDefault();
        try { s.child.kill(); } catch (_) {}
        s.child = null;
        clearTimeout(s._idleTimer);
        pushMessage(activeSessionId, { type: 'system-msg', text: 'Interrupted — restarting…' });
        setStatus(activeSessionId, 'working');
        spawnClaude(activeSessionId);
      }
    }
  });

  // Cmd+1-5 to switch sessions
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '5') {
      e.preventDefault();
      const ids = [...sessions.keys()];
      const target = ids[parseInt(e.key) - 1];
      if (target) setActiveSession(target);
    }
  });

  // ── Omi voice bridge ───────────────────────────────────────
  // Listens for voice commands from OmiWebhook via the Rust WebSocket bridge.
  // "hey pixel, <text> full stop" → sendMessage to targeted session.
  // Dot = clickable toggle. Green=listening, amber=muted, gray=disconnected.

  const { listen: tauriListen } = window.__TAURI__.event;

  // Listening toggle state — persists across restarts
  let omiConnected = false;
  let omiListening = localStorage.getItem('omiListening') !== 'false';

  function _omiIndicatorUpdate() {
    const el = document.getElementById('omi-indicator');
    if (!el) return;
    if (!omiConnected) {
      el.classList.remove('connected', 'muted');
      el.title = 'Omi voice bridge (disconnected)';
    } else if (!omiListening) {
      el.classList.add('connected', 'muted');
      el.title = 'Omi muted — click to resume (Ctrl+Shift+O)';
    } else {
      el.classList.add('connected');
      el.classList.remove('muted');
      el.title = 'Omi listening — click to mute (Ctrl+Shift+O)';
    }
  }

  function toggleOmiListening() {
    omiListening = !omiListening;
    localStorage.setItem('omiListening', omiListening);
    _omiIndicatorUpdate();
    try { invoke('set_omi_listening', { enabled: omiListening }); } catch (_) {}
  }

  document.getElementById('omi-indicator')?.addEventListener('click', toggleOmiListening);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'O') {
      e.preventDefault();
      toggleOmiListening();
    }
  });

  function resolveSession(ref) {
    if (ref == null) return activeSessionId;
    if (typeof ref === 'number') {
      const keys = [...sessions.keys()];
      return keys[ref - 1] || activeSessionId;
    }
    const needle = String(ref).toLowerCase();
    for (const [id, s] of sessions) {
      if (s.name.toLowerCase().includes(needle)) return id;
    }
    return activeSessionId;
  }

  tauriListen('omi:command', (event) => {
    const { type, text, session, ts, dispatched } = event.payload;

    // Transcript events always show in the voice log, even when muted
    if (type === 'transcript') {
      appendVoiceLog(text, ts, dispatched);
      return;
    }

    if (!omiListening) return;  // JS-side mute guard — commands only

    const targetId = resolveSession(session ?? null);
    if (!targetId) return;
    if (type === 'prompt') {
      sendMessage(targetId, text);
    } else if (type === 'switch') {
      setActiveSession(targetId);
    } else if (type === 'list_sessions') {
      const lines = [...sessions.entries()]
        .map(([_, s], i) => `${i + 1}. ${s.name} [${s.status}]`)
        .join('\n');
      pushMessage(activeSessionId, { type: 'system-msg', text: `Omi sessions:\n${lines}` });
    }
  });

  // ── Voice log (transcript sidebar) ────────────────────────
  const MAX_VOICE_LOG = 200;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function appendVoiceLog(text, ts, dispatched) {
    const log = document.getElementById('voice-log');
    if (!log || !text) return;
    const entry = document.createElement('div');
    entry.className = 'voice-entry' + (dispatched ? ' dispatched' : '');
    entry.innerHTML = `<span class="ts">${escapeHtml(ts || '')}</span>${dispatched ? '▶ ' : ''}${escapeHtml(text)}`;
    log.appendChild(entry);
    while (log.children.length > MAX_VOICE_LOG) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  document.getElementById('btn-clear-voice-log')?.addEventListener('click', () => {
    const log = document.getElementById('voice-log');
    if (log) log.innerHTML = '';
  });

  tauriListen('omi:connected', () => {
    omiConnected = true;
    _omiIndicatorUpdate();
    // Re-send current mute state so a reconnecting OmiWebhook stays in sync
    try { invoke('set_omi_listening', { enabled: omiListening }); } catch (_) {}
    // Re-send always-on state if active
    if (alwaysOn) {
      try { invoke('set_voice_mode', { mode: 'always_on' }); } catch (_) {}
    }
  });

  tauriListen('omi:disconnected', () => {
    omiConnected = false;
    _omiIndicatorUpdate();
  });

  // ── Always-on mic toggle ───────────────────────────────────
  // When active, pixel_voice_bridge skips "hey pixel" trigger —
  // every transcribed utterance (3s silence timeout) is sent as a command.

  let alwaysOn = localStorage.getItem('alwaysOn') === 'true';

  function _alwaysOnUpdate() {
    const el = document.getElementById('always-on-btn');
    if (!el) return;
    if (alwaysOn) {
      el.classList.add('active');
      el.title = 'Always-on mic active — click to return to trigger mode (Ctrl+Shift+A)';
    } else {
      el.classList.remove('active');
      el.title = 'Always-on mic off — no "hey pixel" needed when on (Ctrl+Shift+A)';
    }
  }

  function toggleAlwaysOn() {
    alwaysOn = !alwaysOn;
    localStorage.setItem('alwaysOn', alwaysOn);
    _alwaysOnUpdate();
    try { invoke('set_voice_mode', { mode: alwaysOn ? 'always_on' : 'trigger_mode' }); } catch (_) {}
  }

  document.getElementById('always-on-btn')?.addEventListener('click', toggleAlwaysOn);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      toggleAlwaysOn();
    }
  });

  _alwaysOnUpdate(); // restore persisted state on load

  // Window close (red X) — HTML confirm modal
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  let _forceClose = false;
  appWindow.onCloseRequested(async (event) => {
    if (_forceClose) return;
    event.preventDefault();
    const count = sessions.size;
    const msg = count > 0
      ? `Close Pixel Terminal? ${count} session${count > 1 ? 's' : ''} will be terminated.`
      : 'Close Pixel Terminal?';
    const ok = await showConfirm(msg);
    if (ok) {
      _forceClose = true;
      for (const [id] of sessions) {
        try { sessions.get(id)?.child?.kill(); } catch (_) {}
      }
      appWindow.close();
    }
  });
});
