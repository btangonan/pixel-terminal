"""latency_harness.py — voice pipeline latency measurement harness.

Measures p50/p95 for 5 timing metrics across the 13 fixture clips and
validates them against `acceptance.yaml`.

PR-1 ships the harness scaffolding, fixture loader, percentile math, and
acceptance gate. The actual measurement probes are stubbed until the
downstream PRs land:

  stt_ttfb_ms       → wired in PR-A  (Moonshine STT on OmiWebhook)
  tts_ttfb_ms       → wired in PR-B  (Qwen3-TTS bridge on :9877)
  vad_endpoint_ms   → wired in PR-A  (Silero VAD / endpoint detector)
  e2e_ms            → wired in PR-B  (STT→Claude→TTS full loop)
  bargein_flush_ms  → wired in PR-C  (barge-in audio flush timing)

Each measurement function in this file is a PLACEHOLDER that returns
None. `--ci` mode without env var `HARNESS_ENABLE_PROBES=1` will emit a
neutral SKIP verdict per unwired metric (not a failure). Once the probes
land the respective PR flips the `ENABLED_METRICS` gate and the CI starts
enforcing p50/p95 bounds.

Usage:
    # Dry-run (default) — lists fixtures + acceptance bounds
    python tests/harness/latency_harness.py

    # CI mode — runs probes (or SKIPs where unwired), prints verdict
    python tests/harness/latency_harness.py --ci

    # Force real measurement (Apple-Silicon macOS only; fails on unwired)
    HARNESS_ENABLE_PROBES=1 python tests/harness/latency_harness.py --ci
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path
from typing import Callable

try:
    import yaml  # type: ignore
except ImportError:
    yaml = None  # handled in load_config


HARNESS_DIR = Path(__file__).resolve().parent
FIXTURES_DIR = HARNESS_DIR / "fixtures"
ACCEPTANCE_PATH = HARNESS_DIR / "acceptance.yaml"


# ── Config ──────────────────────────────────────────────────────────────

def load_config() -> dict:
    if yaml is None:
        # Minimal fallback parser: hand-extract the v1 schema from the file.
        # The harness file is small + stable; this avoids requiring PyYAML
        # just to run --ci in a stripped CI image.
        return _fallback_parse(ACCEPTANCE_PATH.read_text())
    with ACCEPTANCE_PATH.open() as f:
        return yaml.safe_load(f)


def _fallback_parse(text: str) -> dict:
    """Crude line-scanner — adequate for the v1 acceptance.yaml only."""
    cfg: dict = {"metrics": {}}
    current_metric = None
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if line.startswith("iterations_per_clip:"):
            cfg["iterations_per_clip"] = int(line.split(":", 1)[1])
        elif line.startswith("warmup_runs:"):
            cfg["warmup_runs"] = int(line.split(":", 1)[1])
        elif line.endswith("_ms:") and not line.startswith(" "):
            current_metric = line.strip().rstrip(":")
            cfg["metrics"][current_metric] = {}
        elif current_metric and line.lstrip().startswith(("p50_max:", "p95_max:")):
            k, v = [p.strip() for p in line.strip().split(":", 1)]
            cfg["metrics"][current_metric][k] = int(v)
    return cfg


# ── Fixture discovery ───────────────────────────────────────────────────

def list_fixtures() -> list[Path]:
    return sorted(FIXTURES_DIR.glob("clip_*.wav"))


# ── Metric probes (PLACEHOLDERS — wired in downstream PRs) ──────────────
#
# Each probe takes a fixture path and returns the measured metric in ms,
# or None if the underlying backend is not wired / available.

def probe_stt_ttfb_ms(wav: Path) -> float | None:
    """PR-A: measure time from audio_start → first transcript token.

    Until Moonshine lands, this returns None. Set HARNESS_ENABLE_PROBES=1
    after PR-A to force execution (will raise NotImplementedError here).
    """
    if os.environ.get("HARNESS_ENABLE_PROBES") == "1":
        raise NotImplementedError("stt_ttfb probe is wired in PR-A")
    return None


def probe_tts_ttfb_ms(wav: Path) -> float | None:
    """PR-B: measure time from text_send → first audio packet on WS :9877."""
    if os.environ.get("HARNESS_ENABLE_PROBES") == "1":
        raise NotImplementedError("tts_ttfb probe is wired in PR-B")
    return None


def probe_vad_endpoint_ms(wav: Path) -> float | None:
    """PR-A: measure time from last-speech-sample → endpoint_detected event."""
    if os.environ.get("HARNESS_ENABLE_PROBES") == "1":
        raise NotImplementedError("vad_endpoint probe is wired in PR-A")
    return None


def probe_e2e_ms(wav: Path) -> float | None:
    """PR-B: measure user_speech_end → assistant audio onset (full loop)."""
    if os.environ.get("HARNESS_ENABLE_PROBES") == "1":
        raise NotImplementedError("e2e probe is wired in PR-B")
    return None


def probe_bargein_flush_ms(wav: Path) -> float | None:
    """PR-C: measure user_speech_during_tts → audio-silent timing."""
    if os.environ.get("HARNESS_ENABLE_PROBES") == "1":
        raise NotImplementedError("bargein_flush probe is wired in PR-C")
    return None


PROBES: dict[str, Callable[[Path], float | None]] = {
    "stt_ttfb_ms": probe_stt_ttfb_ms,
    "tts_ttfb_ms": probe_tts_ttfb_ms,
    "vad_endpoint_ms": probe_vad_endpoint_ms,
    "e2e_ms": probe_e2e_ms,
    "bargein_flush_ms": probe_bargein_flush_ms,
}


# ── Measurement loop ────────────────────────────────────────────────────

def measure_metric(name: str, fixtures: list[Path], cfg: dict) -> dict:
    probe = PROBES[name]
    iterations = cfg.get("iterations_per_clip", 5)
    warmup = cfg.get("warmup_runs", 1)

    samples: list[float] = []
    for wav in fixtures:
        for i in range(warmup + iterations):
            v = probe(wav)
            if v is None:
                return {"status": "skipped", "reason": f"{name} probe not wired"}
            if i >= warmup:
                samples.append(v)

    if not samples:
        return {"status": "skipped", "reason": "no samples"}

    p50 = statistics.median(samples)
    p95 = _percentile(samples, 95)
    bounds = cfg["metrics"][name]
    passed = p50 <= bounds["p50_max"] and p95 <= bounds["p95_max"]
    return {
        "status": "pass" if passed else "fail",
        "n": len(samples),
        "p50_ms": round(p50, 1),
        "p95_ms": round(p95, 1),
        "p50_max": bounds["p50_max"],
        "p95_max": bounds["p95_max"],
    }


def _percentile(values: list[float], pct: int) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * (pct / 100.0)
    f = int(k)
    c = min(f + 1, len(s) - 1)
    if f == c:
        return s[f]
    return s[f] + (s[c] - s[f]) * (k - f)


# ── CLI ─────────────────────────────────────────────────────────────────

def run_ci() -> int:
    cfg = load_config()
    fixtures = list_fixtures()
    if len(fixtures) == 0:
        print("ERROR: no fixtures in", FIXTURES_DIR, file=sys.stderr)
        print("Run: python tests/harness/gen_fixtures.py", file=sys.stderr)
        return 2

    print(f"harness: {len(fixtures)} fixtures, "
          f"{cfg.get('iterations_per_clip', 5)} iterations/clip")
    results: dict[str, dict] = {}
    any_failed = False
    any_skipped = False

    for name in PROBES:
        r = measure_metric(name, fixtures, cfg)
        results[name] = r
        if r["status"] == "fail":
            any_failed = True
            print(f"  FAIL    {name:20s} p50={r['p50_ms']}ms (max {r['p50_max']}), "
                  f"p95={r['p95_ms']}ms (max {r['p95_max']})")
        elif r["status"] == "pass":
            print(f"  PASS    {name:20s} p50={r['p50_ms']}ms, p95={r['p95_ms']}ms")
        else:
            any_skipped = True
            print(f"  SKIP    {name:20s} {r.get('reason', '')}")

    print()
    print(json.dumps(results, indent=2))

    if any_failed:
        return 1
    if any_skipped and os.environ.get("HARNESS_STRICT") == "1":
        print("HARNESS_STRICT=1 — skipped metrics treated as failure", file=sys.stderr)
        return 1
    return 0


def run_dry() -> int:
    cfg = load_config()
    fixtures = list_fixtures()
    print(f"Fixtures: {len(fixtures)} in {FIXTURES_DIR}")
    for f in fixtures:
        print(f"  {f.name}  ({f.stat().st_size} bytes)")
    print()
    print("Thresholds (from acceptance.yaml):")
    for name, bounds in cfg["metrics"].items():
        print(f"  {name:20s} p50<{bounds['p50_max']}ms  p95<{bounds['p95_max']}ms")
    print()
    print("Run `--ci` to execute. Probes SKIP until wired by PR-A/B/C.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ci", action="store_true",
                        help="Run probes and enforce acceptance.yaml bounds")
    args = parser.parse_args()
    return run_ci() if args.ci else run_dry()


if __name__ == "__main__":
    sys.exit(main())
