// ── File Attachments ─────────────────────────────────────
//
// Tauri v2 intercepts OS file drops before they reach the webview — HTML5
// dragover/drop events DON'T fire for files from Finder. We use the Tauri
// event system ('tauri://drag-drop') instead, plus Rust invoke commands
// for reading file contents (shell allowlist doesn't include cat/base64).

import { $, esc } from './dom.js';

const { listen }  = window.__TAURI__.event;
const { invoke }  = window.__TAURI__.core;

// ── Error toast ──────────────────────────────────────────
// Floating overlay toast for attachment errors (file too large, read failed, etc.)
// Auto-dismisses after 4s. Only one active at a time.

let _toastTimer = null;

function showAttachmentError(msg) {
  let toast = document.getElementById('att-error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'att-error-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = `△ ${msg}`;
  toast.style.display = 'block';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 4000);
}

// ── Per-session store: Map<sessionId, Attachment[]>
// Attachment: { id, name, path, mimeType, data, isImage, status: 'staged'|'sent' }
const store = new Map();

let _getActiveSessionId = null;

export function initSession(sessionId) {
  if (!store.has(sessionId)) store.set(sessionId, []);
}

export function initAttachments({ getActiveSessionId }) {
  _getActiveSessionId = getActiveSessionId;
  wireDragDrop();   // async, fire-and-forget — listeners register in <5ms
  wireContextMenu();
  wireClearBtn();
  wirePaste();
  document.addEventListener('pixel:session-changed', () => {
    renderAttachmentTokens();
    renderAttachmentPanel();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideImagePreview(); });
  document.addEventListener('mousedown', e => {
    const pop = document.getElementById('att-preview-pop');
    if (pop && !pop.classList.contains('hidden') && !pop.contains(e.target)) hideImagePreview();
  });
}

export function getStagedAttachments(sessionId) {
  return (store.get(sessionId) || []).filter(a => a.status === 'staged');
}

export function markAttachmentsSent(sessionId) {
  const atts = store.get(sessionId);
  if (!atts) return;
  atts.forEach(a => { if (a.status === 'staged') a.status = 'sent'; });
  renderAttachmentTokens();
  renderAttachmentPanel();
}

// ── MIME / extension helpers ──────────────────────────────

const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','bmp','svg','tiff','heic']);
const MIME_MAP   = {
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
  gif:'image/gif', webp:'image/webp', bmp:'image/bmp',
  svg:'image/svg+xml', tiff:'image/tiff', heic:'image/heic',
};

function guessMimeType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return MIME_MAP[ext] || 'text/plain';
}

function isImagePath(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return IMAGE_EXTS.has(ext);
}

// ── Image resize ─────────────────────────────────────────
// Claude recommends images ≤ 1568px on the longest side.
// A raw 4K screenshot is ~11MB base64; after resize it's ~200-400KB.
// We always output JPEG (for compression) unless the image is tiny already.

const CLAUDE_MAX_PX = 1568;

function resizeImageBase64(b64, mimeType) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;
      const longest = Math.max(w, h);

      // Always return originalWidth/originalHeight so the message metadata is accurate.
      // The preview is resized — Claude must NOT use the blob dimensions as ground truth.
      if (longest <= CLAUDE_MAX_PX) {
        resolve({ b64, mimeType, originalWidth: w, originalHeight: h });
        return;
      }

      const scale = CLAUDE_MAX_PX / longest;
      const nw = Math.round(w * scale);
      const nh = Math.round(h * scale);

      const canvas = document.createElement('canvas');
      canvas.width  = nw;
      canvas.height = nh;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, nw, nh);

      const outMime = 'image/jpeg';
      const dataUrl = canvas.toDataURL(outMime, 0.85);
      resolve({ b64: dataUrl.split(',')[1], mimeType: outMime, originalWidth: w, originalHeight: h });
    };
    img.onerror = () => resolve({ b64, mimeType, originalWidth: null, originalHeight: null });
    img.src = `data:${mimeType};base64,${b64}`;
  });
}

// ── Stage a file from its filesystem path (Tauri drop) ────

async function stageFilePath(sessionId, path) {
  const name = path.split('/').pop() || path;
  const isImage = isImagePath(path);
  const mimeType = guessMimeType(name);

  // Guard: reject files > 20MB before reading to prevent OOM.
  // Uses get_file_size_any (no path allowlist) — metadata-only, safe for any drag-drop path.
  const MAX_BYTES = 20 * 1024 * 1024;
  try {
    const fileSize = await invoke('get_file_size_any', { path });
    if (fileSize > MAX_BYTES) {
      const mb = (fileSize / 1024 / 1024).toFixed(1);
      console.warn(`[attachments] ${name} too large (${mb} MB) — max 20 MB`);
      showAttachmentError(`${name} is too large (${mb} MB). Max 20 MB.`);
      return;
    }
  } catch (e) {
    // Cannot verify size — reject rather than risk reading an arbitrarily large file into memory.
    console.warn(`[attachments] size check failed for ${name}:`, e);
    showAttachmentError(`Could not verify size of ${name}. Attachment rejected.`);
    return;
  }

  let data;
  let finalMimeType = mimeType;
  let originalWidth = null, originalHeight = null;
  try {
    if (isImage) {
      const raw = await invoke('read_file_as_base64_any', { path });
      // Resize to Claude's recommended max (1568px) before sending.
      // A raw 4K screenshot is ~11MB base64 and reliably hits rate limits.
      // After resize it's typically 200-400KB — same result, 25-50× smaller request.
      const resized = await resizeImageBase64(raw, mimeType);
      data = resized.b64;
      finalMimeType = resized.mimeType;
      originalWidth = resized.originalWidth;
      originalHeight = resized.originalHeight;
    } else {
      data = await invoke('read_file_as_text_any', { path });
    }
  } catch (err) {
    console.error('[attachments] read failed:', name, err);
    showAttachmentError(`Could not read ${name}. Attachment rejected.`);
    return;
  }

  const att = {
    id: crypto.randomUUID(),
    name,
    path,
    mimeType: finalMimeType,
    data,
    isImage,
    originalWidth,
    originalHeight,
    status: 'staged',
  };
  // Guard: session may have been killed while awaiting the IPC read above.
  // store.delete(sessionId) fires synchronously in killSession — if it ran,
  // store.has() is false and we must NOT re-create the entry (zombie leak).
  if (!store.has(sessionId)) return;
  store.get(sessionId).push(att);
  renderAttachmentTokens();
  renderAttachmentPanel();
}

// ── Stage an image Blob (clipboard paste) ────────────────

async function stageBlob(sessionId, blob, name) {
  const MAX_BYTES = 20 * 1024 * 1024;
  if (blob.size > MAX_BYTES) {
    showAttachmentError(`Pasted image too large (${(blob.size / 1024 / 1024).toFixed(1)} MB). Max 20 MB.`);
    return;
  }
  const mimeType = blob.type || 'image/png';
  let b64;
  try {
    b64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    showAttachmentError('Could not read pasted image.');
    return;
  }
  const resized = await resizeImageBase64(b64, mimeType);
  if (!store.has(sessionId)) return;
  store.get(sessionId).push({
    id: crypto.randomUUID(),
    name,
    path: null,
    mimeType: resized.mimeType,
    data: resized.b64,
    isImage: true,
    originalWidth:  resized.originalWidth,
    originalHeight: resized.originalHeight,
    status: 'staged',
  });
  renderAttachmentTokens();
  renderAttachmentPanel();
}

// ── Clipboard paste ──────────────────────────────────────

function wirePaste() {
  $.inputField?.addEventListener('paste', (e) => {
    const sid = _getActiveSessionId?.();
    if (!sid) return;
    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    const blob = imageItem.getAsFile();
    if (!blob) return;
    const ext = imageItem.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    stageBlob(sid, blob, `clipboard-${Date.now()}.${ext}`);
  });
}

// ── Drag & Drop ──────────────────────────────────────────
// OS drops → Tauri events (tauri://drag-drop)
// Panel re-drag → HTML5 events (internal only, not OS-level)

async function wireDragDrop() {
  const el = $.chatView;
  const indicator = document.getElementById('drop-indicator');

  const showIndicator = () => {
    if (!_getActiveSessionId?.()) return;
    el.classList.add('drag-over');
    indicator?.classList.remove('hidden');
  };
  const hideIndicator = () => {
    el.classList.remove('drag-over');
    indicator?.classList.add('hidden');
  };

  // Tauri OS drag events ─────────────────────────────────
  await listen('tauri://drag-enter', showIndicator);
  await listen('tauri://drag-leave', hideIndicator);

  await listen('tauri://drag-drop', async (event) => {
    hideIndicator();
    const sessionId = _getActiveSessionId?.();
    if (!sessionId) return;
    const paths = event.payload?.paths || [];
    for (const path of paths) {
      await stageFilePath(sessionId, path);
    }
  });

  // HTML5 internal re-drag from attachment panel ─────────
  // (Panel items set 'application/x-pixel-attachment' data — this is not an
  // OS file drag, so HTML5 events do fire here.)
  // Drop targets: chat view (original) + input bar (natural re-stage target)

  function isInternalDrag(e) {
    return e.dataTransfer?.types?.includes('application/x-pixel-attachment');
  }

  function restageFromDrop(e) {
    const internalId = e.dataTransfer?.getData('application/x-pixel-attachment');
    if (!internalId) return;
    e.preventDefault();
    const sessionId = _getActiveSessionId?.();
    if (!sessionId) return;
    const att = (store.get(sessionId) || []).find(a => a.id === internalId);
    if (att) att.status = 'staged';
    renderAttachmentTokens();
    renderAttachmentPanel();
  }

  // Chat view drop (existing)
  el.addEventListener('dragover', (e) => {
    if (!isInternalDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  el.addEventListener('drop', restageFromDrop);

  // Input bar drop — the natural drag target when composing
  const inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.addEventListener('dragover', (e) => {
      if (!isInternalDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      inputBar.classList.add('att-redrop-over');
    });
    inputBar.addEventListener('dragleave', (e) => {
      if (!inputBar.contains(e.relatedTarget)) inputBar.classList.remove('att-redrop-over');
    });
    inputBar.addEventListener('drop', (e) => {
      inputBar.classList.remove('att-redrop-over');
      restageFromDrop(e);
    });
  }
}

// ── Image preview popover ────────────────────────────────

function hideImagePreview() {
  document.getElementById('att-preview-pop')?.classList.add('hidden');
}

function showImagePreview(att, triggerEl) {
  let pop = document.getElementById('att-preview-pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'att-preview-pop';
    pop.className = 'hidden';
    pop.innerHTML =
      '<button class="att-preview-close" aria-label="Close">×</button>' +
      '<img id="att-preview-img" alt="">' +
      '<p id="att-preview-lbl"></p>';
    document.body.appendChild(pop);
    pop.querySelector('.att-preview-close').addEventListener('click', hideImagePreview);
    pop.querySelector('#att-preview-img').addEventListener('error', function() {
      this.alt = 'Preview unavailable';
    });
  }

  const img = pop.querySelector('#att-preview-img');
  img.src = `data:${att.mimeType};base64,${att.data}`;
  img.alt = att.name;
  const dimStr = att.originalWidth ? ` · ${att.originalWidth}×${att.originalHeight}` : '';
  pop.querySelector('#att-preview-lbl').textContent = att.name + dimStr;

  // Render off-screen to measure, then position near trigger
  pop.style.visibility = 'hidden';
  pop.classList.remove('hidden');

  requestAnimationFrame(() => {
    const r = triggerEl.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const margin = 8;

    // Prefer above trigger; fall back to below
    let top = r.top - ph - margin;
    if (top < margin) top = r.bottom + margin;

    // Left-align to trigger; clamp to viewport
    let left = r.left;
    if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
    if (left < margin) left = margin;

    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
    pop.style.visibility = '';
  });
}

// ── Token rendering (above input textarea) ───────────────

export function renderAttachmentTokens() {
  const sessionId = _getActiveSessionId?.();
  const container = document.getElementById('attachment-tokens');
  if (!container) return;
  const staged = sessionId ? getStagedAttachments(sessionId) : [];
  if (staged.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = staged.map(a =>
    `<span class="att-token${a.isImage ? ' att-token-img' : ''}" data-id="${a.id}">` +
    `<span class="att-tok-icon">${a.isImage ? '◈' : '◇'}</span>` +
    `<span class="att-tok-name">${esc(a.name)}</span>` +
    `<span class="att-tok-rm" data-id="${a.id}">×</span>` +
    `</span>`
  ).join('');

  // Image tokens: click anywhere except × opens preview
  container.querySelectorAll('.att-token-img').forEach(tok => {
    tok.addEventListener('click', (e) => {
      if (e.target.classList.contains('att-tok-rm')) return;
      const sid = _getActiveSessionId?.();
      if (!sid) return;
      const att = (store.get(sid) || []).find(a => a.id === tok.dataset.id);
      if (att) showImagePreview(att, tok);
    });
  });

  container.querySelectorAll('.att-tok-rm').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sid = _getActiveSessionId?.();
      if (!sid) return;
      const atts = store.get(sid);
      if (atts) {
        const idx = atts.findIndex(a => a.id === btn.dataset.id);
        if (idx !== -1) atts.splice(idx, 1);
      }
      renderAttachmentTokens();
      renderAttachmentPanel();
    });
  });
}

// ── Attachment panel (sidebar) ───────────────────────────

export function renderAttachmentPanel() {
  const sessionId = _getActiveSessionId?.();
  const container = document.getElementById('attachments-panel');
  if (!container) return;
  const atts = sessionId ? (store.get(sessionId) || []) : [];
  if (atts.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = atts.map(a =>
    `<div class="att-item att-${a.status}" data-id="${a.id}" data-path="${esc(a.path ?? '')}" draggable="true"` +
    `${a.isImage ? ' data-previewable="1"' : ''}>` +
    `<span class="att-item-icon">${a.isImage ? '▣' : '▤'}</span>` +
    `<span class="att-item-name" title="${esc(a.name)}">${esc(a.name)}</span>` +
    `${a.status === 'staged' ? '<span class="att-item-badge">queued</span>' : ''}` +
    `</div>`
  ).join('');

  container.querySelectorAll('.att-item').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-pixel-attachment', el.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, el.dataset.id, el.dataset.path);
    });
    if (el.dataset.previewable) {
      el.setAttribute('tabindex', '0');
      const openPreview = () => {
        const sid = _getActiveSessionId?.();
        if (!sid) return;
        const att = (store.get(sid) || []).find(a => a.id === el.dataset.id);
        if (att) showImagePreview(att, el);
      };
      el.addEventListener('click', openPreview);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPreview(); } });
    }
  });
}

// ── Context menu ─────────────────────────────────────────

let _ctx = null;

function showCtxMenu(x, y, attachmentId, path) {
  const menu = document.getElementById('attachment-ctx-menu');
  if (!menu) return;
  _ctx = { attachmentId, path };
  menu.style.left = Math.min(x, window.innerWidth - 160) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 90) + 'px';
  menu.classList.remove('hidden');
}

function hideCtxMenu() {
  document.getElementById('attachment-ctx-menu')?.classList.add('hidden');
  _ctx = null;
}

function wireContextMenu() {
  document.addEventListener('mousedown', (e) => {
    const menu = document.getElementById('attachment-ctx-menu');
    if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target)) hideCtxMenu();
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctx]');
    if (!btn || !_ctx) return;
    const action = btn.dataset.ctx;
    const sid = _getActiveSessionId?.();

    if (action === 'reveal') {
      const p = _ctx.path;
      if (p) window.__TAURI__.opener.revealItemInDir(p).catch(console.error);
    } else if (action === 'reattach' && sid) {
      const att = (store.get(sid) || []).find(a => a.id === _ctx.attachmentId);
      if (att) att.status = 'staged';
      renderAttachmentTokens();
      renderAttachmentPanel();
    } else if (action === 'remove' && sid) {
      const atts = store.get(sid);
      if (atts) {
        const idx = atts.findIndex(a => a.id === _ctx.attachmentId);
        if (idx !== -1) atts.splice(idx, 1);
      }
      renderAttachmentTokens();
      renderAttachmentPanel();
    }
    hideCtxMenu();
  });
}

// ── Destroy all attachments for a session (call on session kill) ─────────────

export function cleanupSession(sessionId) {
  store.delete(sessionId);
  renderAttachmentTokens();
  renderAttachmentPanel();
}

// ── Clear sent attachments (called by FILES tab CLR button in voice.js) ──────

export function clearSentAttachments() {
  const sid = _getActiveSessionId?.();
  if (!sid) return;
  const atts = store.get(sid);
  if (atts) store.set(sid, atts.filter(a => a.status === 'staged'));
  renderAttachmentPanel();
}

function wireClearBtn() { /* no-op: CLR now routed through voice tab header */ }
