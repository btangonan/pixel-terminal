import { beforeEach, test, expect } from 'vitest';
import {
  getNimBalance,
  addNim,
  spendNim,
  accrueNimForSession,
  NIM_PER_TOKENS,
} from '../src/nim.js';

beforeEach(() => {
  localStorage.clear();
});

test('getNimBalance returns 0 when empty', () => {
  expect(getNimBalance()).toBe(0);
});

test('addNim(0) is a no-op', () => {
  addNim(0);
  expect(getNimBalance()).toBe(0);
});

test('addNim increases balance', () => {
  addNim(5);
  expect(getNimBalance()).toBe(5);
});

test('spendNim(0) always returns true without touching balance', () => {
  expect(spendNim(0)).toBe(true);
  expect(getNimBalance()).toBe(0);
});

test('spendNim deducts when affordable', () => {
  addNim(10);
  expect(spendNim(4)).toBe(true);
  expect(getNimBalance()).toBe(6);
});

test('spendNim returns false when insufficient', () => {
  expect(spendNim(5)).toBe(false);
  expect(getNimBalance()).toBe(0);
});

test('accrueNimForSession earns 1 nim per NIM_PER_TOKENS tokens', () => {
  const s = { tokens: NIM_PER_TOKENS * 2 + 300, _nimTokensAccrued: 0 };
  accrueNimForSession(s);
  expect(getNimBalance()).toBe(2);
  expect(s._nimTokensAccrued).toBe(NIM_PER_TOKENS * 2);
});

test('accrueNimForSession does not double-count on repeated calls', () => {
  const s = { tokens: NIM_PER_TOKENS, _nimTokensAccrued: 0 };
  accrueNimForSession(s);
  accrueNimForSession(s); // second call should be a no-op
  expect(getNimBalance()).toBe(1);
});

test('accrueNimForSession with no new tokens is a no-op', () => {
  const s = { tokens: 500, _nimTokensAccrued: 0 };
  accrueNimForSession(s);
  expect(getNimBalance()).toBe(0);
});
