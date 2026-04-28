#!/usr/bin/env python3
"""voice/v1 TTS server with multi-backend routing.

Backends (selected per-voice by name prefix):
  • Piper (rhasspy/piper)    — voice IDs containing `_GB-` or `_US-`
                                e.g. en_GB-alba-medium
  • Kokoro (kokoro-onnx)     — voice IDs starting with af_/am_/bf_/bm_/...
                                e.g. af_bella, am_michael (the natural-
                                sounding US voices Piper doesn't have)

Both backends advertise output at 24kHz mono PCM s16le; Piper voices (which
natively output 22050) get resampled server-side so tts-player.js sees a
consistent stream regardless of which voice the user picked.

Voice file locations:
  ~/.cache/piper-voices/<voice>.onnx (+ .onnx.json)
  ~/.cache/kokoro-onnx/kokoro-v1.0.onnx + voices-v1.0.bin

Protocol (incoming):
  {"type":"hello","protocol":"voice/v1","client":"anima",
   "session_id":"...","role":"tts-consumer"}
  {"type":"speak","request_id":"...","text":"...","voice":"en_US-lessac-high"}
  {"type":"cancel","request_id":"..."}

Protocol (outgoing):
  {"type":"ready","sample_rate":<sr>,"channels":1,
   "encoding":"pcm_s16le","backend":"piper"}
  {"type":"chunk","request_id":"...","seq":N,"pcm_b64":"..."}
  {"type":"done","request_id":"...","total_seq":N}
  {"type":"error","request_id":"...","code":"...","message":"..."}
"""
import argparse
import asyncio
import base64
import io
import json
import logging
import os
import wave
from pathlib import Path
from typing import Optional

import numpy as np
import websockets
from piper import PiperVoice

VOICES_DIR = Path(os.environ.get("PIPER_VOICES_DIR", str(Path.home() / ".cache" / "piper-voices")))
KOKORO_DIR = Path(os.environ.get("KOKORO_DIR", str(Path.home() / ".cache" / "kokoro-onnx")))
DEFAULT_VOICE = os.environ.get("PIPER_DEFAULT_VOICE", "en_GB-alba-medium")
CHUNK_SAMPLES = 3840  # 0.16s @ 24kHz; sized for low latency
TARGET_SR = 24000     # all output resampled to this so tts-player sees one rate

logger = logging.getLogger("piper-tts")

# Lazy voice cache — loaded on first use, kept in memory after.
_voice_cache: dict[str, PiperVoice] = {}
_kokoro = None         # lazy-loaded Kokoro instance (shared across all kokoro voices)
_chatterbox = None     # lazy-loaded ChatterboxTurboTTS (one default voice, no presets)


def _is_kokoro_voice(name: str) -> bool:
    """Kokoro voice IDs use a 2-letter language+gender prefix (af_, am_, bf_, etc.)."""
    if not name or "-" in name.split("_", 1)[0]:
        return False
    parts = name.split("_", 1)
    return len(parts[0]) == 2 and parts[0] in {
        "af", "am", "bf", "bm", "ef", "em", "ff", "fm",
        "hf", "hm", "if", "im", "jf", "jm", "pf", "pm", "zf", "zm",
    }


def _is_chatterbox_voice(name: str) -> bool:
    """Voice IDs starting with `cb_` route to Chatterbox Turbo.
    Currently only `cb_default` (Chatterbox's natural default voice)."""
    return name.startswith("cb_")


def _load_kokoro():
    global _kokoro
    if _kokoro is not None:
        return _kokoro
    from kokoro_onnx import Kokoro
    onnx = KOKORO_DIR / "kokoro-v1.0.onnx"
    voices_bin = KOKORO_DIR / "voices-v1.0.bin"
    if not onnx.is_file() or not voices_bin.is_file():
        raise FileNotFoundError(f"Kokoro model files missing in {KOKORO_DIR}")
    logger.info("[kokoro] loading model from %s", KOKORO_DIR)
    _kokoro = Kokoro(str(onnx), str(voices_bin))
    return _kokoro


def _load_chatterbox():
    global _chatterbox
    if _chatterbox is not None:
        return _chatterbox
    from mlx_audio.tts.utils import load_model
    logger.info("[chatterbox] loading mlx-community/Chatterbox-Turbo-TTS-fp16")
    _chatterbox = load_model("mlx-community/Chatterbox-Turbo-TTS-fp16")
    return _chatterbox


def _resample_to_target(samples: np.ndarray, sr: int) -> bytes:
    """Resample float32/-1..1 samples to TARGET_SR and return int16 LE bytes."""
    if sr != TARGET_SR:
        import librosa
        samples = librosa.resample(samples.astype(np.float32), orig_sr=sr, target_sr=TARGET_SR)
    pcm16 = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    return pcm16.tobytes()


def list_available_voices() -> list[str]:
    if not VOICES_DIR.is_dir():
        return []
    return sorted(p.stem for p in VOICES_DIR.glob("*.onnx"))


def load_piper_voice(name: str) -> PiperVoice:
    if name in _voice_cache:
        return _voice_cache[name]
    onnx = VOICES_DIR / f"{name}.onnx"
    cfg = VOICES_DIR / f"{name}.onnx.json"
    if not onnx.is_file():
        raise FileNotFoundError(f"voice file not found: {onnx}")
    if not cfg.is_file():
        raise FileNotFoundError(f"voice config not found: {cfg}")
    logger.info("[piper-tts] loading voice %s", name)
    v = PiperVoice.load(str(onnx), config_path=str(cfg))
    _voice_cache[name] = v
    return v


async def synth_to_pcm(text: str, voice_name: str, *, speed: float = 1.0) -> bytes:
    """Synthesize text → pcm_s16le bytes at TARGET_SR. Routes by voice name.

    `speed` < 1.0 produces a slower / more dramatic read (used for *stage*
    segments). Each backend exposes a different parameter name; we map it.
    """
    def _run_piper():
        # Piper uses length_scale: >1 = slower. Map speed → length_scale = 1/speed.
        length_scale = 1.0 / max(0.1, speed)
        from piper import SynthesisConfig
        v = load_piper_voice(voice_name)
        buf = io.BytesIO()
        cfg = SynthesisConfig(length_scale=length_scale)
        with wave.open(buf, "wb") as wf:
            v.synthesize_wav(text, wf, syn_config=cfg)
        buf.seek(0)
        with wave.open(buf, "rb") as wf:
            sr = wf.getframerate()
            pcm_int16 = wf.readframes(wf.getnframes())
        samples = np.frombuffer(pcm_int16, dtype="<i2").astype(np.float32) / 32767.0
        return _resample_to_target(samples, sr)

    def _run_kokoro():
        k = _load_kokoro()
        audio, sr = k.create(text, voice=voice_name, lang="en-us", speed=speed)
        return _resample_to_target(audio, sr)

    def _run_chatterbox():
        m = _load_chatterbox()
        chunks = []
        # Chatterbox-Turbo accepts `speed` in its generate signature.
        for r in m.generate(text=text, verbose=False, speed=speed):
            if hasattr(r, "audio"):
                chunks.append(np.array(r.audio))
        if not chunks:
            return b""
        audio = np.concatenate(chunks).astype(np.float32)
        return _resample_to_target(audio, 24000)

    if _is_chatterbox_voice(voice_name):
        runner = _run_chatterbox
    elif _is_kokoro_voice(voice_name):
        runner = _run_kokoro
    else:
        runner = _run_piper
    return await asyncio.get_event_loop().run_in_executor(None, runner)


# Speed multiplier for *stage direction* segments — gives a slower, more
# dramatic / settled feel without needing a second voice loaded.
STAGE_SPEED = 0.82
NORMAL_SPEED = 1.0


async def stream_synth(ws, req_id: str, text: str, voice_name: str,
                       segments: Optional[list] = None):
    """Synthesize one speak request and stream PCM chunks.

    If `segments` is provided (list of {text, stage:bool}), each segment is
    synthesized separately — stage segments at STAGE_SPEED — and the PCM
    streams are concatenated. Otherwise the full `text` is synthesized at
    NORMAL_SPEED (legacy path).
    """
    if _is_chatterbox_voice(voice_name):
        backend = "chatterbox"
    elif _is_kokoro_voice(voice_name):
        backend = "kokoro"
    else:
        backend = "piper"

    try:
        if segments and isinstance(segments, list):
            pcm_parts = []
            for seg in segments:
                seg_text = (seg.get("text") or "").strip()
                if not seg_text:
                    continue
                speed = STAGE_SPEED if seg.get("stage") else NORMAL_SPEED
                pcm_parts.append(await synth_to_pcm(seg_text, voice_name, speed=speed))
            pcm = b"".join(pcm_parts)
        else:
            pcm = await synth_to_pcm(text, voice_name)
    except Exception as exc:
        logger.error("[%s-tts] synth failed req=%s voice=%s: %s",
                     backend, req_id, voice_name, exc)
        await ws.send(json.dumps({
            "type": "error", "request_id": req_id,
            "code": "synth_failed", "message": str(exc),
        }))
        return

    bytes_per_chunk = CHUNK_SAMPLES * 2
    seq = 0
    for off in range(0, len(pcm), bytes_per_chunk):
        chunk = pcm[off:off + bytes_per_chunk]
        await ws.send(json.dumps({
            "type": "chunk", "request_id": req_id, "seq": seq,
            "pcm_b64": base64.b64encode(chunk).decode("ascii"),
        }))
        seq += 1
    await ws.send(json.dumps({
        "type": "done", "request_id": req_id, "total_seq": seq,
    }))
    seg_info = f" segments={len(segments)}" if segments else ""
    logger.info("[%s-tts] req=%s voice=%s%s done seq=%d (%d bytes @ %dHz)",
                backend, req_id, voice_name, seg_info, seq, len(pcm), TARGET_SR)


async def handle_session(ws):
    peer = getattr(ws, "remote_address", "?")
    try:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
    except (asyncio.TimeoutError, Exception):
        logger.warning("[piper-tts] bad hello from %s", peer)
        return

    if hello.get("type") != "hello":
        await ws.send(json.dumps({"type": "error", "code": "bad_hello", "message": "expected type=hello"}))
        return

    session_id = hello.get("session_id", "?")
    logger.info("[piper-tts] handshake ok session=%s peer=%s", session_id, peer)
    await ws.send(json.dumps({
        "type": "ready",
        "sample_rate": TARGET_SR,
        "channels": 1,
        "encoding": "pcm_s16le",
        "backend": "piper+kokoro",
    }))

    inflight: dict[str, asyncio.Task] = {}

    async for raw in ws:
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        mtype = msg.get("type")
        if mtype == "speak":
            req_id = msg.get("request_id", "")
            text = msg.get("text", "")
            voice = msg.get("voice") or DEFAULT_VOICE
            segments = msg.get("segments")  # optional v2: per-segment prosody
            if not text and not segments:
                await ws.send(json.dumps({
                    "type": "error", "request_id": req_id,
                    "code": "empty_text", "message": "text or segments required",
                }))
                continue
            task = asyncio.create_task(stream_synth(ws, req_id, text, voice, segments))
            inflight[req_id] = task
        elif mtype == "cancel":
            req_id = msg.get("request_id", "")
            task = inflight.pop(req_id, None)
            if task and not task.done():
                task.cancel()
                await ws.send(json.dumps({
                    "type": "cancelled", "request_id": req_id, "at_seq": 0,
                }))
        else:
            logger.debug("[piper-tts] ignoring type=%s", mtype)


async def serve(host: str, port: int):
    voices = list_available_voices()
    if not voices:
        logger.error("[piper-tts] no voices in %s — download .onnx + .onnx.json from rhasspy/piper-voices", VOICES_DIR)
    else:
        logger.info("[piper-tts] %d voices available: %s", len(voices), ", ".join(voices))
    # Pre-load default so first speak isn't slow.
    if DEFAULT_VOICE in voices:
        try:
            load_piper_voice(DEFAULT_VOICE)
            logger.info("[piper-tts] preloaded default voice %s", DEFAULT_VOICE)
        except Exception as e:
            logger.warning("[piper-tts] preload of %s failed: %s", DEFAULT_VOICE, e)
    # Pre-load Kokoro (one model, all American voices share it).
    try:
        _load_kokoro()
        logger.info("[kokoro] model preloaded")
    except Exception as e:
        logger.warning("[kokoro] preload failed: %s — kokoro voices unavailable", e)
    # Chatterbox-Turbo loads lazily on first request (3-5s cold start).
    # Skip preload — many users won't pick it.
    logger.info("[piper-tts] listening on ws://%s:%d backend=piper", host, port)
    async with websockets.serve(handle_session, host, port):
        await asyncio.Future()


def main():
    parser = argparse.ArgumentParser(description="Piper TTS server (voice/v1)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9877)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    asyncio.run(serve(args.host, args.port))


if __name__ == "__main__":
    main()
