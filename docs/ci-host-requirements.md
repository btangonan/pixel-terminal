# CI host requirements — voice pipeline

Voice CI runs on two lanes because the production target (Apple Silicon
macOS 14+) cannot be fully emulated on GitHub Actions' free ubuntu
runners. The mocked lane catches regressions cheaply on every PR; the
native lane runs real probes on push to `main` and release branches.

## Lane matrix

| Lane | Runner | When | What runs |
|---|---|---|---|
| **mocked** | `ubuntu-latest` (x86_64) | every PR + push | cargo unit + `host_check::tests::mocked_*` (injected fixtures), vitest suite |
| **native** | `macos-14` (Apple Silicon) | push to `main` / release branches | full mocked suite + real `host_check.rs` probes + `latency_harness.py --ci` + `vitest run tests/soak/` |

Runner pricing note: `macos-14` minutes are ~10× `ubuntu-latest`. Native
lane is **opt-in per branch** (only runs on main / release/*) to keep
the monthly burn bounded.

## What each lane asserts

**mocked lane (ubuntu-latest)**:
- All cargo unit tests compile + pass on x86_64
- `host_check::tests::mocked_unsupported_arch` asserts the report carries
  `supported: false` with `failure_reason` set
- `host_check::tests::mocked_old_macos` / `mocked_missing_mlx` / etc.
  cover each failure mode
- vitest JS/TS tests pass
- `npm test` baseline holds (default suite excludes `tests/soak/**`)

**native lane (macos-14)**:
- Everything from mocked lane
- `host_check::tests::real_probe_arm64` runs actual `uname`, `sw_vers`,
  and MLX/onnxruntime version detection
- `python3 tests/harness/latency_harness.py --ci` exits 0 (probes either
  pass or SKIP cleanly)
- `npm run test:soak` runs (short-duration soak scenarios; full 30-min
  soak is gated behind `SOAK_DURATION_MS` env)

## Lane selection in CI workflow

`.github/workflows/voice-ci.yml` defines both lanes via a matrix:

```yaml
strategy:
  matrix:
    include:
      - runner: ubuntu-latest
        lane: mocked
      - runner: macos-14
        lane: native
```

The native entry has `if: github.event_name == 'push' && (contains(github.ref, 'main') || startsWith(github.ref, 'refs/heads/release/'))`.

## When to add a new test

- **Cross-arch host behavior** → mocked lane fixture + assertion
- **MLX / onnxruntime / CoreAudio probe** → native lane only (cfg-gated)
- **Pure logic** (state machines, parsing, percentile math) → mocked lane

Tests that require real audio hardware (CoreAudio callbacks, mic
permission grant) must also be cfg-gated behind `#[cfg(target_arch = "aarch64")]`
and, where applicable, `#[cfg(target_os = "macos")]`.

## Why native lane exists at all

The v3 plan asserted host parity without actually proving it — the CI
lane was Linux-only. That meant `host_check.rs` was only ever compiled
against x86_64 targets; the arm64 code paths were exercised locally on
Brad's laptop but not in CI. Grading (Codex criterion #5) flagged this.
v4 closes the gap: the native lane runs the arm64 paths on every push
to `main`.
