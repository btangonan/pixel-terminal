# Unsupported host — voice feature disabled

Anima's voice feature requires **Apple Silicon macOS 14 or later**. On
any other host the voice pipeline is hard-disabled at startup; the rest
of the app (terminal, sessions, chat, Vexil companion) is unaffected.

## Who this affects

- Intel Macs (x86_64, incl. Rosetta-translated M-series)
- macOS < 14.0
- Apple Silicon hosts with MLX < 0.15 or onnxruntime < 1.17 installed
- Apple Silicon hosts with < 2 GB free disk

## What you see

A one-time banner on first app launch:

> Voice requires Apple Silicon macOS 14+. Your system does not meet the
> requirements. [Learn more](docs/unsupported-hosts.md)

The banner is informational, not interactive. There is no env-var or
hidden toggle to force-enable voice on an unsupported host — that path
was removed intentionally (see **Why hard-block** below).

## Why hard-block (and not "degraded mode")

The v2 plan exposed a `--force-voice` path and per-backend env flips
(`VOICE_STT_BACKEND=whisper_turbo` / `VOICE_TTS_BACKEND=none`). Grading
flagged this as contradictory: the rest of the plan relied on Moonshine
+ Qwen3 latency and MOS properties that whisper_turbo and no-TTS break.

Half-working voice generates worse bug reports than clean disable. The
current scope:

- Target persona: Apple Silicon M-series, macOS 14+, ≥ 16 GB RAM
- Intel / older macOS: not scheduled, not committed
- The future ticket for Intel support (if ever) is tracked in the
  project's issue tracker, not in this doc

## System requirements (voice feature)

| Requirement | Minimum |
|---|---|
| Architecture | arm64 (Apple Silicon) |
| macOS | 14.0+ |
| Python | 3.11 (OmiWebhook runtime) |
| MLX | ≥ 0.15 |
| onnxruntime | ≥ 1.17 |
| Disk free | ≥ 2 GB (weights cache) |
| RAM | ≥ 16 GB |

## How the check runs

`src-tauri/src/commands/host_check.rs` runs cfg-gated probes:

- **arm64**: real system calls (uname, sw_vers, python3 -c "import mlx").
- **non-arm64 / CI**: mocked probe outputs via test fixtures — exists
  purely to keep CI green on GitHub's ubuntu-latest runners.

Probe results populate `HostCheckReport { supported: bool, ... }`. If
`supported == false` the Anima UI disables the voice panel and shows
the banner.

## Rollback

This file documents the hard-stop behavior. To revert to the pre-check
behavior, revert the PR that added it (PR-2a, `voice-audio-permissions-bootstrap`).
