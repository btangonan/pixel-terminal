"""gen_fixtures.py — deterministic synthetic WAV clips for latency harness.

Produces 13 fixtures under fixtures/ at 16 kHz mono 16-bit PCM. Uses stdlib
only (no numpy) so the harness has zero install-time friction. Content is a
simple sine/silence mix because PR-1 measures timing, not WER.

Run: python tests/harness/gen_fixtures.py
"""
import math
import os
import struct
import wave
from pathlib import Path

SR = 16000
AMP = 0.3 * 32767  # 30% of int16 full-scale


def _tone(freq_hz: float, duration_s: float):
    n = int(SR * duration_s)
    for i in range(n):
        yield int(AMP * math.sin(2.0 * math.pi * freq_hz * i / SR))


def _silence(duration_s: float):
    n = int(SR * duration_s)
    for _ in range(n):
        yield 0


def _write(path: Path, samples):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        data = struct.pack(f"<{sum(1 for _ in [None])}h", 0)  # placeholder; replaced below
        frames = b"".join(struct.pack("<h", s) for s in samples)
        w.writeframes(frames)


def _concat(*chunks):
    for chunk in chunks:
        for s in chunk:
            yield s


def main():
    out = Path(__file__).parent / "fixtures"
    out.mkdir(parents=True, exist_ok=True)

    specs = [
        ("clip_01_short_cmd.wav", _tone(440, 0.5)),
        ("clip_02_short_cmd.wav", _tone(480, 0.7)),
        ("clip_03_medium_query.wav", _tone(440, 1.5)),
        ("clip_04_medium_query.wav", _tone(500, 2.0)),
        ("clip_05_long_question.wav", _tone(440, 3.0)),
        ("clip_06_long_question.wav", _tone(520, 4.0)),
        ("clip_07_very_long.wav", _tone(440, 5.0)),
        ("clip_08_silence_short.wav", _silence(0.3)),
        ("clip_09_silence_long.wav", _silence(1.0)),
        ("clip_10_trailing_silence.wav", _concat(_tone(440, 1.0), _silence(0.5))),
        ("clip_11_bargein.wav", _tone(600, 0.8)),
        ("clip_12_multi_utterance.wav",
         _concat(_tone(440, 1.0), _silence(0.5), _tone(500, 1.0))),
        ("clip_13_edge_max.wav", _tone(440, 6.0)),
    ]

    for name, gen in specs:
        _write(out / name, gen)
        print(f"wrote {name}")

    print(f"\n{len(specs)} fixtures in {out}")


if __name__ == "__main__":
    main()
