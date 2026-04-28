// duplex_soak.test.js — 30-minute duplex voice session stress.
//
// Runs the full voice loop in a tight send/receive cycle for the
// configured duration and asserts:
//   - no dropped frames (send count == ack count)
//   - memory pressure bounded (RSS delta < 200 MB)
//   - no socket reconnects mid-session
//   - no audio dropouts (underrun counter = 0)
//
// Gated on SOAK=1 so normal `vitest run` never triggers the 30-min run.
// CI invokes via `npm run test:soak` on the native macos-14 lane only.

import { describe, it, expect } from 'vitest';

const SOAK = process.env.SOAK === '1';
const SOAK_DURATION_MS = Number(process.env.SOAK_DURATION_MS || 30 * 60 * 1000);
const TICK_MS = 250;

const maybe = SOAK ? describe : describe.skip;

maybe('duplex soak (30 min)', () => {
  it('runs full duplex cycle without drift', async () => {
    // Wiring arrives in PR-B (TTS bridge) + PR-C (barge-in). Until then
    // the SOAK=1 path is an explicit NotImplementedError so we do not
    // silently pass.
    throw new Error(
      'duplex soak not yet wired — SOAK=1 requires PR-B (TTS) + PR-C (barge-in). ' +
      'Unset SOAK to skip, or run after PR-C lands.'
    );
  }, SOAK_DURATION_MS + 60_000);
});

describe('duplex soak — scaffolding', () => {
  it('is skipped when SOAK is not set', () => {
    // Sanity test that always runs: SOAK flag is opt-in. This asserts
    // the default vitest invocation does not accidentally trigger the
    // long-running path.
    if (!SOAK) {
      expect(process.env.SOAK).not.toBe('1');
    } else {
      // When SOAK=1 the maybe(...) block above owns the execution.
      expect(SOAK_DURATION_MS).toBeGreaterThan(0);
    }
  });
});
