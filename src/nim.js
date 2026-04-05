// ── @NIM@ — pixel terminal currency ───────────────────────────────────────────
// Nim accrues globally from token usage across all sessions.
// Spent on re-rolls (and future unlocks).

const _NIM_KEY = 'pixel-nim-balance';

export const NIM_PER_TOKENS  = 1000; // 1 nim per 1000 tokens spent
export const REROLL_NIM_COST = 0;    // 0 = gate open for testing

export function getNimBalance() {
  return parseInt(localStorage.getItem(_NIM_KEY) || '0', 10);
}

export function addNim(amount) {
  if (amount <= 0) return;
  localStorage.setItem(_NIM_KEY, String(getNimBalance() + amount));
}

/** Returns true and deducts if affordable. Cost 0 always passes without touching balance. */
export function spendNim(cost) {
  if (cost === 0) return true;
  const bal = getNimBalance();
  if (bal < cost) return false;
  localStorage.setItem(_NIM_KEY, String(bal - cost));
  return true;
}

/**
 * Called after s.tokens is updated. Awards nim for newly-spent tokens.
 * Tracks s._nimTokensAccrued to avoid double-counting across result events.
 */
export function accrueNimForSession(s) {
  const unaccrued = s.tokens - (s._nimTokensAccrued ?? 0);
  if (unaccrued <= 0) return;
  const earned = Math.floor(unaccrued / NIM_PER_TOKENS);
  if (earned > 0) {
    addNim(earned);
    s._nimTokensAccrued = (s._nimTokensAccrued ?? 0) + earned * NIM_PER_TOKENS;
  }
}
