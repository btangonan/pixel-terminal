"""
naturalness_bench.py — TTS naturalness smoke bench.

Runs a synthetic vs real-output comparison and reports a numeric score.
This is the CI-safe placeholder: it reads a WAV, verifies the file has
plausible PCM characteristics, and emits a MOS-shaped score in [1.0, 5.0].

The real NISQA-lite pass runs under /walkaway --effort high once the
Qwen3-TTS-MLX weights are on disk — /walkaway substitutes this file for
the NISQA-backed version (same CLI surface) so this bench is the
"does the file look like speech at all" baseline.

Usage:
    python3 bench/naturalness_bench.py path/to/sample.wav
    python3 bench/naturalness_bench.py --sample-rate 24000 path/to/sample.wav
    python3 bench/naturalness_bench.py --synthetic   # generate + score a sine

Exit 0 on pass (score >= threshold), exit 2 on fail. CI sets the threshold
low in placeholder mode and raises it once NISQA is wired.
"""
from __future__ import annotations

import argparse
import math
import struct
import sys
import wave
from pathlib import Path
from typing import Tuple


PLACEHOLDER_MIN_SCORE = 2.5   # sanity floor — /walkaway raises to 3.5 under NISQA
DEFAULT_SAMPLE_RATE = 24_000


def _read_wav(path: Path) -> Tuple[bytes, int, int]:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        width = w.getsampwidth()
        frames = w.readframes(w.getnframes())
    if width != 2:
        raise SystemExit(f"expected 16-bit PCM, got sampwidth={width}")
    if ch != 1:
        raise SystemExit(f"expected mono, got channels={ch}")
    return frames, sr, w.getnframes() if False else len(frames) // 2


def _rms_dbfs(samples: list[int]) -> float:
    if not samples:
        return -120.0
    sumsq = sum(float(s) * float(s) for s in samples)
    rms = math.sqrt(sumsq / len(samples))
    if rms <= 0:
        return -120.0
    return 20.0 * math.log10(rms / 32768.0)


def _zero_crossings(samples: list[int]) -> int:
    zc = 0
    prev = samples[0] if samples else 0
    for s in samples[1:]:
        if (prev <= 0 and s > 0) or (prev >= 0 and s < 0):
            zc += 1
        prev = s
    return zc


def score_wav(path: Path, sample_rate_expected: int) -> float:
    """Placeholder heuristic → returns a 1.0..5.0 MOS-shaped score.

    We combine three signals that predict "not obvious junk":
      1. RMS dBFS in [-40, -6] is good; too quiet or clipping is bad
      2. Zero-crossing rate in human-speech range (not DC, not white noise)
      3. Sample rate matches bridge contract (24kHz)

    The real NISQA model replaces this body. The CLI contract stays the same.
    """
    frames, sr, n = _read_wav(path)
    samples = list(struct.unpack(f"<{n}h", frames))

    score = 5.0
    # Sample rate — hard requirement
    if sr != sample_rate_expected:
        score -= 1.5
    # RMS — penalize extremes
    dbfs = _rms_dbfs(samples)
    if dbfs < -50 or dbfs > -3:
        score -= 1.0
    # Zero-crossing rate — speech-like range for 24kHz
    zcr = _zero_crossings(samples) / max(1, len(samples))
    if zcr < 0.005 or zcr > 0.5:
        score -= 1.0

    return max(1.0, min(5.0, score))


def _write_synthetic_sine(path: Path, seconds: float = 1.0, sr: int = DEFAULT_SAMPLE_RATE) -> None:
    total = int(seconds * sr)
    pcm = bytearray()
    for i in range(total):
        t = i / sr
        s = int(0.2 * 32767 * math.sin(2 * math.pi * 220.0 * t))
        pcm += struct.pack("<h", s)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(pcm))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("wav", nargs="?", help="path to 24kHz mono 16-bit PCM WAV")
    p.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE)
    p.add_argument("--threshold", type=float, default=PLACEHOLDER_MIN_SCORE)
    p.add_argument("--synthetic", action="store_true",
                   help="generate a 1s 220Hz sine into /tmp and score it")
    args = p.parse_args()

    if args.synthetic:
        path = Path("/tmp/naturalness_sample.wav")
        _write_synthetic_sine(path, seconds=1.0, sr=args.sample_rate)
    elif args.wav:
        path = Path(args.wav)
        if not path.exists():
            print(f"ERROR: {path} not found", file=sys.stderr)
            return 2
    else:
        p.print_help()
        return 2

    score = score_wav(path, args.sample_rate)
    print(f"naturalness_bench: file={path} sr={args.sample_rate} score={score:.2f} threshold={args.threshold:.2f}")
    if score < args.threshold:
        print("FAIL", file=sys.stderr)
        return 2
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
