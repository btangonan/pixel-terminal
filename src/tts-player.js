/**
 * tts-player.js — Web Audio consumer for pixel_tts_bridge.
 *
 * Connects to ws://127.0.0.1:9877 (the OmiWebhook-side bridge), sends voice/v1
 * hello, then streams synthesis requests via speak{} and schedules incoming
 * PCM16 chunks on an AudioContext for gapless playback.
 *
 * Public API:
 *   const player = createTTSPlayer({ wsUrl, sessionId, onStateChange });
 *   await player.connect();
 *   const requestId = player.speak(text);
 *   player.cancel(requestId);   // barge-in
 *   player.disconnect();
 *
 * The player is deliberately WebSocket + AudioContext concrete in `connect()`
 * but takes both as injectable factories for testability — the vitest suite
 * swaps in a mock WS + mock AudioContext without touching window globals.
 */

const DEFAULT_WS_URL = 'ws://127.0.0.1:9877';
const PROTOCOL = 'voice/v1';
const DEFAULT_SAMPLE_RATE = 24000;

/**
 * States:
 *   "idle"        — never connected, or disconnected
 *   "connecting"  — WS opening
 *   "handshaking" — sent hello, waiting for ready
 *   "ready"       — ready to accept speak()
 *   "error"       — fatal; call connect() again to retry
 */

export function createTTSPlayer({
  wsUrl = DEFAULT_WS_URL,
  sessionId = `anima-tts-${Date.now()}`,
  onStateChange = () => {},
  wsFactory = (url) => new WebSocket(url),
  audioContextFactory = () => new (window.AudioContext || window.webkitAudioContext)({ sampleRate: DEFAULT_SAMPLE_RATE }),
  base64Decoder = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
} = {}) {
  let ws = null;
  let ctx = null;
  let state = 'idle';
  let sampleRate = DEFAULT_SAMPLE_RATE;
  let connectResolve = null;
  let connectReject = null;

  // Queue of scheduled AudioBufferSourceNode end-times so chunks play gaplessly.
  let nextStartTime = 0;

  // Map of request_id → { cancelled, onDone, onError }
  const inflight = new Map();

  function setState(next) {
    if (state !== next) {
      state = next;
      try { onStateChange(state); } catch {}
    }
  }

  function resetScheduler() {
    nextStartTime = ctx ? ctx.currentTime : 0;
  }

  function pcm16ToFloat32(bytes) {
    // bytes is Uint8Array containing little-endian Int16 samples
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(bytes.byteLength / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = view.getInt16(i * 2, true) / 32768;
    }
    return out;
  }

  function scheduleChunk(float32Samples) {
    if (!ctx) return;
    const buffer = ctx.createBuffer(1, float32Samples.length, sampleRate);
    buffer.copyToChannel(float32Samples, 0, 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const startAt = Math.max(nextStartTime, ctx.currentTime);
    node.start(startAt);
    nextStartTime = startAt + buffer.duration;
    return node;
  }

  function flushScheduled() {
    // Chrome/Safari AudioContext can't revoke an already-scheduled start,
    // so flushing = closing + replacing the context. This is the barge-in
    // cancel path when the user starts talking during TTS playback.
    if (ctx && ctx.state !== 'closed') {
      try { ctx.close(); } catch {}
    }
    ctx = audioContextFactory();
    resetScheduler();
  }

  function handleServerMessage(msg) {
    if (msg.type === 'ready') {
      sampleRate = msg.sample_rate || DEFAULT_SAMPLE_RATE;
      setState('ready');
      if (connectResolve) {
        connectResolve();
        connectResolve = connectReject = null;
      }
      return;
    }

    if (msg.type === 'chunk') {
      const entry = inflight.get(msg.request_id);
      if (!entry || entry.cancelled) return;
      const bytes = base64Decoder(msg.pcm_b64);
      const samples = pcm16ToFloat32(bytes);
      scheduleChunk(samples);
      return;
    }

    if (msg.type === 'done') {
      const entry = inflight.get(msg.request_id);
      inflight.delete(msg.request_id);
      if (entry?.onDone) entry.onDone({ totalSeq: msg.total_seq });
      return;
    }

    if (msg.type === 'cancelled') {
      const entry = inflight.get(msg.request_id);
      inflight.delete(msg.request_id);
      if (entry?.onDone) entry.onDone({ cancelled: true, atSeq: msg.at_seq });
      return;
    }

    if (msg.type === 'error') {
      const entry = inflight.get(msg.request_id);
      if (msg.request_id) inflight.delete(msg.request_id);
      if (entry?.onError) entry.onError(new Error(`[tts] ${msg.code}: ${msg.message}`));
      return;
    }
  }

  function connect() {
    if (state === 'ready' || state === 'handshaking' || state === 'connecting') {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      connectResolve = resolve;
      connectReject = reject;
      setState('connecting');
      ctx = audioContextFactory();
      resetScheduler();

      ws = wsFactory(wsUrl);
      ws.onopen = () => {
        setState('handshaking');
        ws.send(JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL,
          client: 'anima',
          session_id: sessionId,
          role: 'tts-consumer',
        }));
      };
      ws.onmessage = (evt) => {
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return; // malformed frame — ignore
        }
        handleServerMessage(msg);
      };
      ws.onerror = (err) => {
        setState('error');
        if (connectReject) {
          connectReject(err instanceof Error ? err : new Error('ws error'));
          connectResolve = connectReject = null;
        }
      };
      ws.onclose = () => {
        setState('idle');
        // Resolve pending connect promises as error; speak() callers see
        // the state transition via onStateChange.
        if (connectReject) {
          connectReject(new Error('ws closed before handshake'));
          connectResolve = connectReject = null;
        }
      };
    });
  }

  function speak(text, { voice = null, onDone = () => {}, onError = () => {} } = {}) {
    if (state !== 'ready') {
      onError(new Error(`tts-player not ready (state=${state})`));
      return null;
    }
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    inflight.set(requestId, { cancelled: false, onDone, onError });
    ws.send(JSON.stringify({
      type: 'speak',
      request_id: requestId,
      text,
      voice,
    }));
    return requestId;
  }

  function cancel(requestId) {
    const entry = inflight.get(requestId);
    if (!entry) return false;
    entry.cancelled = true;
    flushScheduled();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'cancel', request_id: requestId }));
    }
    return true;
  }

  function cancelAll() {
    for (const id of inflight.keys()) cancel(id);
  }

  function disconnect() {
    cancelAll();
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    if (ctx) {
      try { ctx.close(); } catch {}
      ctx = null;
    }
    setState('idle');
  }

  return {
    connect,
    speak,
    cancel,
    cancelAll,
    disconnect,
    getState: () => state,
    // Exposed for tests + barge-in integration (voice.js).
    _internal: { handleServerMessage, flushScheduled, pcm16ToFloat32 },
  };
}
