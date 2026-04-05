// ── DOM utilities + cache ─────────────────────────────────

// Sanitize marked output before DOM injection — prevents XSS from LLM-injected HTML.
// Options and parse call are deferred to function body so this module is importable
// in non-browser environments (Vitest/jsdom) without window.marked at load time.
function mdParse(text) {
  window.marked.setOptions({ breaks: true, gfm: true });
  return window.DOMPurify.sanitize(window.marked.parse(text));
}

// DOM cache — populated by initDOM()
export const $ = {};

export function initDOM() {
  $.messageLog = document.getElementById('message-log');
  $.inputField = document.getElementById('msg-input');
  $.btnSend = document.getElementById('btn-send');
  $.btnNewSession = document.getElementById('btn-new-session');
  $.sessionList = document.getElementById('session-list');
  $.chatView = document.getElementById('chat-view');
  $.slashMenu = document.getElementById('slash-menu');
  $.omiIndicator = document.getElementById('omi-indicator');
  $.alwaysOnBtn = document.getElementById('always-on-btn');
  $.settingsPanel = document.getElementById('settings-panel');
  $.settingsBtn = document.getElementById('settings-btn');
  $.voiceLog = document.getElementById('voice-log');
  $.vexilLog   = document.getElementById('vexil-log');
  $.vexilAscii = document.getElementById('vexil-ascii');
  $.voiceLogHeader = document.getElementById('voice-log-header');
  $.aboutOverlay = document.getElementById('about-overlay');
  $.aboutClose = document.getElementById('about-close');
  $.confirmOverlay = document.getElementById('confirm-overlay');
  $.confirmMsg = document.getElementById('confirm-msg');
  $.confirmOk = document.getElementById('confirm-ok');
  $.confirmCancel = document.getElementById('confirm-cancel');
  $.sidebar = document.getElementById('sidebar');
  $.sidebarResize = document.getElementById('sidebar-resize');
  $.sidebarHResize = document.getElementById('sidebar-h-resize');
  $.attachmentsPanel = document.getElementById('attachments-panel');
  $.btnClearVoiceLog = document.getElementById('btn-clear-voice-log');
  $.voiceSourceBle = document.getElementById('voice-source-ble');
  $.voiceSourceMic = document.getElementById('voice-source-mic');
  $.sessionPrompt = document.getElementById('session-prompt');
  $.sessionPromptGotIt = document.getElementById('session-prompt-got-it');
  $.sessionPromptWalker = document.getElementById('session-prompt-walker');
  $.sidebarHeader = document.getElementById('sidebar-header');
  $.inputBar = document.getElementById('input-bar');
  // Session search
  $.btnSearch = document.getElementById('btn-search');
  $.sessionSearch = document.getElementById('session-search');
  $.sessionSearchWrap = document.getElementById('session-search-wrap');
  $.sessionPanel = document.getElementById('session-panel');
  // History panel
  $.historySearchWrap = document.getElementById('history-search-wrap');
  $.historyView = document.getElementById('history-view');
  $.historyList = document.getElementById('history-list');
  $.historyCurrent = document.getElementById('history-current');
  $.historySearch = document.getElementById('history-search');
  // Oracle pre-session chat
  $.oraclePreChat = document.getElementById('oracle-pre-chat');
  $.oracleInput   = document.getElementById('oracle-input');
  $.oracleSend    = document.getElementById('oracle-send');
  // History find bar
  $.historyFind = document.getElementById('history-find');
  $.historyFindInput = document.getElementById('history-find-input');
  $.historyFindStatus = document.getElementById('history-find-status');
  $.historyFindPrev = document.getElementById('history-find-prev');
  $.historyFindNext = document.getElementById('history-find-next');
  $.historyFindClose = document.getElementById('history-find-close');
}

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

export { mdParse };

export function toolIcon(name = '') {
  return '\u00b7';
}

export function toolHint(name, inputStr) {
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

export function showConfirm(message, okLabel = 'terminate') {
  return new Promise((resolve) => {
    $.confirmMsg.textContent = message;
    $.confirmOk.textContent = okLabel;
    $.confirmOverlay.classList.remove('hidden');

    function onOk()    { cleanup(); resolve(true);  }
    function onCancel(){ cleanup(); resolve(false); }
    function onKey(e)  {
      if (e.key === 'Enter')  { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }

    function cleanup() {
      $.confirmOverlay.classList.add('hidden');
      $.confirmOk.removeEventListener('click', onOk);
      $.confirmCancel.removeEventListener('click', onCancel);
      window.removeEventListener('keydown', onKey);
    }

    $.confirmOk.addEventListener('click', onOk);
    $.confirmCancel.addEventListener('click', onCancel);
    window.addEventListener('keydown', onKey);
  });
}
