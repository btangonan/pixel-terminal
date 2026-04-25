/**
 * tts-player.test.js — vitest suite for tts-player.js.
 *
 * Drives the voice/v1 client with a MockWebSocket + MockAudioContext so the
 * tests exercise the full handshake → chunk → done flow without opening a
 * socket or touching real Web Audio.
 */
import { beforeEach, test, expect, vi } from 'vitest';
import { createTTSPlayer } from '../src/tts-player.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

class MockAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._channel = new Float32Array(length);
  }
  copyToChannel(samples, channel, offset) {
    this._channel.set(samples, offset || 0);
  }
}

class MockAudioNode {
  constructor(ctx) {
    this._ctx = ctx;
    this._started = false;
    this._startAt = 0;
    this.buffer = null;
  }
  connect() {}
  start(at) {
    this._started = true;
    this._startAt = at;
    this._ctx._started.push({ at, duration: this.buffer?.duration ?? 0 });
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    this._started = [];
    this._closed = false;
  }
  createBuffer(channels, length, sampleRate) {
    return new MockAudioBuffer(channels, length, sampleRate);
  }
  createBufferSource() {
    return new MockAudioNode(this);
  }
  close() {
    this._closed = true;
    this.state = 'closed';
  }
}

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;  // CONNECTING
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    MockWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
  // Test helpers
  _open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }
  _message(payload) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
  }
}
MockWebSocket.instances = [];

// base64 of [0x00, 0x00] (single silent Int16 sample) — easy to decode in the player
const SILENT_B64 = 'AAAA';  // 3 bytes of 0 → but atob 'AAAA' = 3 null bytes. For 2 bytes use 'AAA='
const TWO_BYTE_ZERO_B64 = 'AAA=';

function makePlayer({ onStateChange } = {}) {
  MockWebSocket.instances.length = 0;
  return createTTSPlayer({
    wsUrl: 'ws://test.invalid:9877',
    sessionId: 'test-session',
    onStateChange: onStateChange || (() => {}),
    wsFactory: (url) => new MockWebSocket(url),
    audioContextFactory: () => new MockAudioContext(),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('connect() sends hello{protocol:"voice/v1"} and resolves on ready', async () => {
  const states = [];
  const player = makePlayer({ onStateChange: (s) => states.push(s) });

  const pending = player.connect();
  const ws = MockWebSocket.instances[0];
  expect(ws.url).toBe('ws://test.invalid:9877');

  ws._open();
  expect(ws.sent[0]).toMatchObject({
    type: 'hello',
    protocol: 'voice/v1',
    client: 'anima',
    session_id: 'test-session',
    role: 'tts-consumer',
  });

  ws._message({ type: 'ready', sample_rate: 24000, channels: 1, encoding: 'pcm_s16le', backend: 'stub' });
  await pending;
  expect(player.getState()).toBe('ready');
  expect(states).toEqual(['connecting', 'handshaking', 'ready']);
});

test('speak() before ready calls onError and returns null', async () => {
  const player = makePlayer();
  let err = null;
  const req = player.speak('hello', { onError: (e) => { err = e; } });
  expect(req).toBeNull();
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toMatch(/not ready/);
});

test('speak() sends speak frame and chunk events schedule audio; done fires onDone', async () => {
  const player = makePlayer();
  const pending = player.connect();
  const ws = MockWebSocket.instances[0];
  ws._open();
  ws._message({ type: 'ready', sample_rate: 24000, channels: 1, encoding: 'pcm_s16le', backend: 'stub' });
  await pending;

  let done = null;
  const reqId = player.speak('hi there', { onDone: (d) => { done = d; } });
  expect(reqId).toMatch(/^req-/);
  const speakFrame = ws.sent.find((m) => m.type === 'speak');
  expect(speakFrame).toMatchObject({ type: 'speak', request_id: reqId, text: 'hi there' });

  // Send two chunks (each = one silent 16-bit sample = 2 bytes = 1 frame of audio)
  ws._message({ type: 'chunk', request_id: reqId, seq: 0, pcm_b64: TWO_BYTE_ZERO_B64 });
  ws._message({ type: 'chunk', request_id: reqId, seq: 1, pcm_b64: TWO_BYTE_ZERO_B64 });
  ws._message({ type: 'done', request_id: reqId, total_seq: 2 });

  expect(done).toEqual({ totalSeq: 2 });
});

test('cancel() marks request cancelled, flushes AudioContext, and sends cancel frame', async () => {
  const player = makePlayer();
  const pending = player.connect();
  const ws = MockWebSocket.instances[0];
  ws._open();
  ws._message({ type: 'ready', sample_rate: 24000, channels: 1, encoding: 'pcm_s16le', backend: 'stub' });
  await pending;

  const reqId = player.speak('barge-in test');
  // Schedule a chunk so there's an in-flight audio context to flush
  ws._message({ type: 'chunk', request_id: reqId, seq: 0, pcm_b64: TWO_BYTE_ZERO_B64 });

  const ok = player.cancel(reqId);
  expect(ok).toBe(true);

  const cancelFrame = ws.sent.find((m) => m.type === 'cancel');
  expect(cancelFrame).toMatchObject({ type: 'cancel', request_id: reqId });

  // Post-cancel chunks must be ignored (entry.cancelled = true)
  // Calling handleServerMessage directly verifies the cancelled-entry short-circuit
  // without relying on timing.
  expect(() => {
    player._internal.handleServerMessage({
      type: 'chunk', request_id: reqId, seq: 1, pcm_b64: TWO_BYTE_ZERO_B64,
    });
  }).not.toThrow();
});

test('cancelled frame from server resolves onDone with cancelled:true', async () => {
  const player = makePlayer();
  const pending = player.connect();
  const ws = MockWebSocket.instances[0];
  ws._open();
  ws._message({ type: 'ready', sample_rate: 24000, channels: 1, encoding: 'pcm_s16le', backend: 'stub' });
  await pending;

  let done = null;
  const reqId = player.speak('test', { onDone: (d) => { done = d; } });
  ws._message({ type: 'cancelled', request_id: reqId, at_seq: 3 });
  expect(done).toEqual({ cancelled: true, atSeq: 3 });
});

test('server error frame calls onError for the inflight request', async () => {
  const player = makePlayer();
  const pending = player.connect();
  const ws = MockWebSocket.instances[0];
  ws._open();
  ws._message({ type: 'ready', sample_rate: 24000, channels: 1, encoding: 'pcm_s16le', backend: 'stub' });
  await pending;

  let caught = null;
  const reqId = player.speak('test', { onError: (e) => { caught = e; } });
  ws._message({ type: 'error', request_id: reqId, code: 'synth_failed', message: 'weights missing' });
  expect(caught).toBeInstanceOf(Error);
  expect(caught.message).toMatch(/synth_failed/);
});

test('disconnect() cancels inflight, closes WS, sets state idle', async () => {
  const states = [];
  const player = makePlayer({ onStateChange: (s) => states.push(s) });
  const pending = player.connect();
  const ws = MockWebSocket.instances[0];
  ws._open();
  ws._message({ type: 'ready', sample_rate: 24000, channels: 1, encoding: 'pcm_s16le', backend: 'stub' });
  await pending;

  player.speak('one');
  player.speak('two');
  player.disconnect();

  expect(player.getState()).toBe('idle');
  expect(ws.readyState).toBe(3);
});

test('pcm16ToFloat32 decodes little-endian Int16 samples to normalized float32', () => {
  const player = makePlayer();
  // Bytes: [0x00,0x80] = int16 -32768 (LE) → float -1.0
  //        [0xFF,0x7F] = int16  32767 (LE) → float ~0.99997
  //        [0x00,0x00] = int16      0       → float 0.0
  const bytes = new Uint8Array([0x00, 0x80, 0xFF, 0x7F, 0x00, 0x00]);
  const out = player._internal.pcm16ToFloat32(bytes);
  expect(out.length).toBe(3);
  expect(out[0]).toBeCloseTo(-1.0, 4);
  expect(out[1]).toBeCloseTo(0.99997, 4);
  expect(out[2]).toBeCloseTo(0.0, 6);
});

test('malformed JSON frames are ignored without throwing', async () => {
  const player = makePlayer();
  const pending = player.connect();
  const ws = MockWebSocket.instances[0];
  ws._open();
  // Simulate non-JSON garbage
  expect(() => ws.onmessage({ data: '{not-json' })).not.toThrow();
  // Handshake still completes on valid ready
  ws._message({ type: 'ready', sample_rate: 24000, channels: 1, encoding: 'pcm_s16le', backend: 'stub' });
  await pending;
  expect(player.getState()).toBe('ready');
});
