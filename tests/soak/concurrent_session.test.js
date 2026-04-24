// concurrent_session.test.js — 2-session isolation stress.
//
// Opens two concurrent voice sessions (distinct session_ids) and
// asserts:
//   - commands sent to session A do not land in session B
//   - audio output for session A does not bleed into session B
//   - barge-in on session A does not flush session B
//   - each session's event stream stays isolated
//
// Gated on SOAK=1 — this test also runs an abbreviated 5-minute
// duration by default (SOAK_DURATION_MS=300000) on the native lane.

import { describe, it, expect } from 'vitest';

const SOAK = process.env.SOAK === '1';
const ISOLATION_DURATION_MS = Number(process.env.SOAK_ISOLATION_MS || 5 * 60 * 1000);

const maybe = SOAK ? describe : describe.skip;

maybe('concurrent session isolation (5 min)', () => {
  it('keeps two sessions fully isolated', async () => {
    // Wiring arrives in the session-routing PR (future work — session_id
    // is captured by PR-0 but not yet propagated into event routing).
    // The Grade-A plan scopes PR-0 to handshake-only; full isolation
    // tests light up once the router lands.
    throw new Error(
      'concurrent session isolation not yet wired — requires session_id ' +
      'routing (future PR after PR-0). Unset SOAK to skip.'
    );
  }, ISOLATION_DURATION_MS + 30_000);
});

describe('concurrent session — scaffolding', () => {
  it('skips by default', () => {
    if (!SOAK) {
      expect(process.env.SOAK).not.toBe('1');
    } else {
      expect(ISOLATION_DURATION_MS).toBeGreaterThan(0);
    }
  });
});
