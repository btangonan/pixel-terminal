# Latency harness fixtures

13 calibration WAV clips used by `tests/harness/latency_harness.py`.

All clips: 16 kHz mono, 16-bit PCM, deterministic synthetic sine + silence.
The harness measures **timing** (TTFB, end-to-end, barge-in flush), not
transcription accuracy — so synthetic content is sufficient for PR-1.

Transcription-accuracy (WER) fixtures live next to the parity tests in
`OmiWebhook/tests/fixtures/` and are added in PR-A.

## Clip map

| File | Duration | Purpose |
|---|---|---|
| `clip_01_short_cmd.wav` | 0.5s | Short command ("stop") |
| `clip_02_short_cmd.wav` | 0.7s | Short command variant |
| `clip_03_medium_query.wav` | 1.5s | Medium query |
| `clip_04_medium_query.wav` | 2.0s | Medium query variant |
| `clip_05_long_question.wav` | 3.0s | Long question |
| `clip_06_long_question.wav` | 4.0s | Long question variant |
| `clip_07_very_long.wav` | 5.0s | Very long utterance |
| `clip_08_silence_short.wav` | 0.3s | Pure silence (VAD floor) |
| `clip_09_silence_long.wav` | 1.0s | Silence between speech |
| `clip_10_trailing_silence.wav` | 1.5s | Speech + 500ms trailing silence |
| `clip_11_bargein.wav` | 0.8s | Barge-in trigger clip |
| `clip_12_multi_utterance.wav` | 2.5s | Two utterances with silence gap |
| `clip_13_edge_max.wav` | 6.0s | Maximum expected duration |

Regenerate with `python tests/harness/gen_fixtures.py` (deterministic; seed fixed).
