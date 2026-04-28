#!/usr/bin/env python3
"""Minimal voice/v1 TTS server using macOS `say`.

Replaces the bundled anima-tts (which falls back to a 220Hz sine stub when
qwen3_tts_mlx isn't bundled). Same WS protocol so tts-player.js works unmodified.

Protocol (incoming):
  {"type": "hello", "protocol": "voice/v1", "client": "anima",
   "session_id": "...", "role": "tts-consumer"}
  {"type": "speak", "request_id": "...", "text": "...", "voice": "Aiden|Ryan|..."}
  {"type": "cancel", "request_id": "..."}

Protocol (outgoing):
  {"type": "ready", "sample_rate": 24000, "channels": 1,
   "encoding": "pcm_s16le", "backend": "macos_say"}
  {"type": "chunk", "request_id": "...", "seq": N, "pcm_b64": "..."}
  {"type": "done", "request_id": "...", "total_seq": N}
  {"type": "error", "request_id": "...", "code": "...", "message": "..."}
"""
import argparse
import asyncio
import base64
import json
import logging
import os
import subprocess
import sys
from typing import Optional

import websockets

SAMPLE_RATE = 24000
CHANNELS = 1
CHUNK_SAMPLES = 3840  # 0.16s @ 24kHz

# Map app voice names → macOS say voices (`say -v '?'` for the full list).
VOICE_MAP = {
    "Aiden": "Daniel",      # British male
    "Ryan": "Alex",         # American male
    "default": "Samantha",  # American female
}

logger = logging.getLogger("say-tts")


async def synth_to_pcm(text: str, voice: str) -> bytes:
    """Run `say` to a temp WAVE file, return raw PCM body (header stripped).

    `say -o -` does not work for streaming to stdout — it requires a file path.
    Smallest reliable path: WAVE @ 24kHz mono LE16 → strip 44-byte RIFF header.
    """
    import tempfile
    say_voice = VOICE_MAP.get(voice, VOICE_MAP["default"])
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        proc = await asyncio.create_subprocess_exec(
            "/usr/bin/say",
            "-v", say_voice,
            "-o", tmp_path,
            "--file-format=WAVE",
            "--data-format=LEI16@24000",
            text,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"say failed (rc={proc.returncode}): {err}")
        with open(tmp_path, "rb") as f:
            wav = f.read()
        # WAVE header is 44 bytes for canonical PCM. Slice past it for raw PCM.
        # Robust: find the "data" chunk and skip the 8-byte chunk header.
        data_idx = wav.find(b"data")
        if data_idx < 0:
            raise RuntimeError("no 'data' chunk in WAVE output")
        return wav[data_idx + 8:]
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


async def stream_synth(ws, req_id: str, text: str, voice: str):
    """Synthesize text via `say`, stream PCM in CHUNK_SAMPLES chunks."""
    try:
        pcm = await synth_to_pcm(text, voice)
    except Exception as exc:
        logger.error("[say-tts] synth failed req=%s: %s", req_id, exc)
        await ws.send(json.dumps({
            "type": "error", "request_id": req_id,
            "code": "synth_failed", "message": str(exc),
        }))
        return

    bytes_per_chunk = CHUNK_SAMPLES * 2  # 16-bit LE = 2 bytes/sample
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
    logger.info("[say-tts] req=%s done seq=%d (%d bytes)", req_id, seq, len(pcm))


async def handle_session(ws):
    peer = getattr(ws, "remote_address", "?")
    try:
        hello_raw = await asyncio.wait_for(ws.recv(), timeout=5)
    except asyncio.TimeoutError:
        logger.warning("[say-tts] no hello from %s within 5s", peer)
        return
    try:
        hello = json.loads(hello_raw)
    except Exception:
        await ws.send(json.dumps({"type": "error", "code": "bad_hello", "message": "expected JSON"}))
        return

    if hello.get("type") != "hello":
        await ws.send(json.dumps({"type": "error", "code": "bad_hello", "message": "expected type=hello"}))
        return

    session_id = hello.get("session_id", "?")
    logger.info("[say-tts] handshake ok session=%s peer=%s", session_id, peer)
    await ws.send(json.dumps({
        "type": "ready",
        "sample_rate": SAMPLE_RATE,
        "channels": CHANNELS,
        "encoding": "pcm_s16le",
        "backend": "macos_say",
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
            voice = msg.get("voice", "Aiden")
            if not text:
                await ws.send(json.dumps({
                    "type": "error", "request_id": req_id,
                    "code": "empty_text", "message": "text is required",
                }))
                continue
            task = asyncio.create_task(stream_synth(ws, req_id, text, voice))
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
            logger.debug("[say-tts] ignoring type=%s", mtype)


async def serve(host: str, port: int):
    logger.info("[say-tts] listening on ws://%s:%d backend=macos_say", host, port)
    async with websockets.serve(handle_session, host, port):
        await asyncio.Future()


def main():
    parser = argparse.ArgumentParser(description="macOS say-based TTS server")
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
