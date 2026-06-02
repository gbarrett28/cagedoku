/**
 * Tests for solSums() — port of Python's tests/test_equation.py (sol_sums section).
 *
 * The Python Equation class is not ported to TS (the browser solver uses only
 * solSums at inference time), so only the sol_sums tests are included here.
 */

import { describe, expect, it } from 'vitest';
import { solDiffs, solSums } from './equation.js';

describe('solSums', () => {
  it('returns correct combinations for well-known cage totals', () => {
    expect(solSums(1, 0, 5)).toEqual([[5]]);
    expect(solSums(2, 0, 3)).toEqual([[1, 2]]);
    expect(solSums(3, 0, 6)).toEqual([[1, 2, 3]]);
    expect(solSums(2, 0, 17)).toEqual([[8, 9]]);
  });

  it('returns empty for impossible single-digit cage', () => {
    // Digit cannot exceed 9
    expect(solSums(1, 0, 10)).toEqual([]);
  });

  it('returns empty when sum is below minimum', () => {
    // Minimum 2-cell sum is 1+2 = 3
    expect(solSums(2, 0, 2)).toEqual([]);
  });

  it('returns sorted number arrays (not frozensets)', () => {
    const results = solSums(3, 0, 15);
    expect(results.length).toBeGreaterThan(0);
    for (const s of results) {
      expect(Array.isArray(s)).toBe(true);
      // Each array is sorted ascending
      for (let i = 0; i < s.length - 1; i++) {
        expect(s[i]!).toBeLessThan(s[i + 1]!);
      }
      // All digits are distinct and in 1-9
      expect(new Set(s).size).toBe(s.length);
      expect(s.every(d => d >= 1 && d <= 9)).toBe(true);
    }
  });

  it('respects custom maxDigit', () => {
    // With digits 1-6, a 2-cell cage summing to 11 has only [5, 6]
    expect(solSums(2, 0, 11, 6)).toEqual([[5, 6]]);
    // 2-cell cage summing to 13 is impossible with max digit 6
    expect(solSums(2, 0, 13, 6)).toEqual([]);
  });

  it('excludes digits <= m', () => {
    // n=1, m=4, v=5: only [5] (digits must be > 4)
    expect(solSums(1, 4, 5)).toEqual([[5]]);
    // n=1, m=5, v=5: impossible (digit must be > 5, but only digit 5 sums to 5)
    expect(solSums(1, 5, 5)).toEqual([]);
  });
});

describe('solDiffs', () => {
  it('returns empty for negative target', () => {
    expect(solDiffs(1, 1, -1)).toEqual([]);
  });

  it('returns empty when zero pos or neg cells', () => {
    expect(solDiffs(0, 1, 3)).toEqual([]);
    expect(solDiffs(1, 0, 3)).toEqual([]);
  });

  it('1 pos + 1 neg, target=0: all pairs a,b where a=b — impossible (distinct digits)', () => {
    // a - b = 0 requires a = b, but digits must be distinct
    expect(solDiffs(1, 1, 0)).toEqual([]);
  });

  it('1 pos + 1 neg, target=1: a - b = 1', () => {
    const r = solDiffs(1, 1, 1);
    // Pairs: (2,1),(3,2),(4,3),(5,4),(6,5),(7,6),(8,7),(9,8)
    expect(r.length).toBe(8);
    for (const { pos, neg } of r) {
      expect(pos[0]! - neg[0]!).toBe(1);
    }
  });

  it('2 pos + 1 neg, target=3: all distinct digit solutions with sum(pos)-neg=3', () => {
    const r = solDiffs(2, 1, 3);
    expect(r.length).toBeGreaterThan(0);
    for (const { pos, neg } of r) {
      expect(pos.length).toBe(2);
      expect(neg.length).toBe(1);
      expect(pos[0]! + pos[1]! - neg[0]!).toBe(3);
      // All 3 digits are distinct
      const all = [...pos, ...neg];
      expect(new Set(all).size).toBe(3);
    }
  });

  it('all digits in solutions are in 1-9 and distinct across pos and neg', () => {
    const r = solDiffs(2, 2, 2);
    for (const { pos, neg } of r) {
      const all = [...pos, ...neg];
      expect(new Set(all).size).toBe(4);
      expect(all.every(d => d >= 1 && d <= 9)).toBe(true);
      expect([...pos].sort((a, b) => a - b)).toEqual([...pos]);
      expect([...neg].sort((a, b) => a - b)).toEqual([...neg]);
    }
  });

  it('returns empty when no valid split exists (target too large)', () => {
    // 1 pos + 8 neg, target = 100 is impossible
    expect(solDiffs(1, 8, 100)).toEqual([]);
  });
});
