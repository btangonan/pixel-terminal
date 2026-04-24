# Model bootstrap — state machine + offline behavior

Spec for `src-tauri/src/commands/model_bootstrap.rs`. First-run (and
repair) download flow for Moonshine STT (~30 MB) and Qwen3-TTS MLX
(~1.2 GB). whisper_turbo weights ship bundled, so offline STT always
works even when bootstrap fails.

## State machine

```
   idle ─────── start() ───────▶ downloading
                                      │
                                      │ 200 + bytes ok
                                      ▼
                                  verifying  ─── sha256 ok ──▶ ready
                                      │
                                      │ sha256 mismatch
                                      ▼
                                  corrupted
                                      │
                                      │ delete + retry (max 3)
                                      ▼
                                  downloading  (loop)

   downloading ─── http error ──▶ failed
                                      │
                                      │ retry (2s, 10s, 30s +jitter)
                                      ▼
                                  downloading (×3)
                                      │
                                      │ exhausted retries
                                      ▼
                                  offline_mode
```

Terminal states: **ready**, **offline_mode**. All others are transient.

## Retry policy

| Attempt | Delay | Timeout |
|---|---|---|
| 1 | 0s | 120s |
| 2 | 2s + jitter(0..1s) | 120s |
| 3 | 10s + jitter(0..2s) | 120s |
| retry-exhausted | 30s before entering offline_mode | — |

Timeout covers the 1.2 GB Qwen3 weight on a slow residential connection
(~80 Mbps sustained). Exponential backoff avoids hammering the CDN on
transient outages.

## Cache layout

```
~/Library/Application Support/pixel-terminal/models/
├── manifest.json                    # SHA-256 + version per model
├── moonshine_onnx/
│   ├── encoder.onnx
│   ├── decoder.onnx
│   ├── tokenizer.json
│   └── .complete                    # sentinel; absent during partial downloads
└── qwen3_tts_mlx/
    ├── weights.mlx
    ├── config.json
    └── .complete
```

`.complete` sentinel is only written after SHA-256 verification passes.
Its absence on startup triggers re-entry into the state machine
(`downloading` or `verifying` depending on what's on disk).

## No-network detection

DNS probe to `models.pixel-terminal.local` (CDN host) with a 5 s
deadline. If the probe fails:

- Skip the retry loop entirely — go direct to **offline_mode**
- Set a persistent banner: "No network — voice features limited"
- On network recovery (DNS probe succeeds again), re-enter the state
  machine from **idle**

Implementation: `tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host("models.pixel-terminal.local:443"))`.

## offline_mode behavior

| Component | Behavior |
|---|---|
| STT | falls back to `whisper_turbo` (bundled; no download needed) |
| TTS | `VOICE_TTS_BACKEND` auto-set to `none`; banner "TTS unavailable offline — connect to retry" |
| Barge-in | disabled (implicit — `VOICE_BARGEIN_ENABLED=false`) |
| Non-voice features | unaffected |

User-facing: the app is usable, voice input still works, voice output
is silent with a clear banner.

## Resume / repair

- Partial `.tmp` files support HTTP Range requests. If the range
  endpoint returns 416 (Range Not Satisfiable), the partial is deleted
  and retry starts from offset 0.
- `anima voice repair` CLI (wired in PR-2b onboarding) deletes the
  cache + re-enters the state machine from **idle**.
- SHA-256 mismatch: file deleted, retry counter incremented; after 3
  corruption events the bootstrap gives up and enters offline_mode
  with a prominent banner.

## Telemetry (advisory)

Each state transition emits a Tauri event:

```rust
#[derive(Serialize)]
struct BootstrapEvent {
    model: &'static str,       // "moonshine" | "qwen3_tts"
    from: BootstrapState,
    to: BootstrapState,
    attempt: u32,
    elapsed_ms: u64,
    error: Option<String>,
}
```

The frontend onboarding wizard (PR-2b) listens on these events for the
progress UI. No network telemetry is sent; events are purely in-app.

## Test coverage

`src-tauri/tests/model_bootstrap_offline.test.rs` covers:

- `no_network_enters_offline_mode` — DNS probe fails, state goes
  idle → offline_mode without retry
- `partial_download_resumes_via_range` — .tmp exists, bootstrap issues
  a Range request, completes at correct offset
- `sha256_mismatch_deletes_and_retries` — corrupted payload triggers
  delete + retry
- `three_retries_then_offline` — HTTP 500 loop exhausts retry budget
- `network_recovers_after_offline_mode` — DNS probe succeeds on
  subsequent check, state re-enters idle → downloading

All tests use a trait-based fake `ModelDownloader` so the real CDN is
never contacted from CI.

## Rollback

Code rollback only (no env flag). The bootstrap is load-bearing — users
shipping without it is the v2 failure mode. Reverting PR-2a reverts
all 10 of its files as a unit.
