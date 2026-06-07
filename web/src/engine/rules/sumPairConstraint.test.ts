/**
 * Tests for SumPairConstraint.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { SumPairConstraint } from './sumPairConstraint.js';
import type { RuleContext } from '../rule.js';
import { cellKey, Trigger } from '../types.js';
import type { Cell } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

/** Inject a sum pair (a + b = total) into the linear system for testing. */
function injectSumPair(bs: KillerBoardState, a: Cell, b: Cell, total: number): void {
  const pair = [a, b, total] as unknown as readonly [Cell, Cell, number];
  bs.linearSystem.sumPairs.push(pair);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = (bs.linearSystem as any)._sumPairsByCell as Map<string, typeof pair[]>;
  const kA = cellKey(a); const kB = cellKey(b);
  if (!map.has(kA)) map.set(kA, []);
  if (!map.has(kB)) map.set(kB, []);
  map.get(kA)!.push(pair); map.get(kB)!.push(pair);
}

describe('SumPairConstraint', () => {
  it('apply: eliminates candidates inconsistent with a + b = total', () => {
    // a=(0,0) + b=(0,1) = 10  →  a ∈ {1..9} must pair with b ∈ {1..9}
    // valid pairs: (1,9),(2,8),(3,7),(4,6),(5,5),(6,4),(7,3),(8,2),(9,1)
    // With b = {1,2,3}: valid a values = {7,8,9} → eliminate 1-6 from a
    const bs = new KillerBoardState(makeTrivialSpec());
    const a: Cell = [0, 0]; const b: Cell = [0, 1];
    bs.candidates[0]![0]! = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    bs.candidates[0]![1]! = new Set([1, 2, 3]);
    injectSumPair(bs, a, b, 10);

    const ctx: RuleContext = {
      unit: bs.units[bs.rowUnitId(0)] ?? null, cell: null,
      board: bs, hint: Trigger.COUNT_DECREASED, hintDigit: null,
    };
    const elims = new SumPairConstraint().apply(ctx).eliminations;

    // a: only {7,8,9} valid (pair with {1,2,3} to reach 10) → eliminate 1-6 from a
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 0 && e.digit === 1)).toBe(true);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 0 && e.digit === 6)).toBe(true);
    // 7, 8, 9 must NOT be eliminated from a
    expect(elims.every(e => !(e.cell[0] === 0 && e.cell[1] === 0 && e.digit >= 7))).toBe(true);
  });

  it('asHints: returns a hint with correct shape for a sum pair', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const a: Cell = [0, 0]; const b: Cell = [0, 1];
    bs.candidates[0]![0]! = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    bs.candidates[0]![1]! = new Set([1, 2, 3]);
    injectSumPair(bs, a, b, 10);

    const ctx: RuleContext = {
      unit: bs.units[bs.rowUnitId(0)] ?? null, cell: null,
      board: bs, hint: Trigger.COUNT_DECREASED, hintDigit: null,
    };
    const rule = new SumPairConstraint();
    const elims = rule.apply(ctx).eliminations;
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, [...elims]);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.ruleName).toBe('SumPairConstraint');
    expect(hints[0]!.displayName).toContain('r1c1');
    expect(hints[0]!.displayName).toContain('r1c2');
    expect(hints[0]!.displayName).toContain('10');
    expect(hints[0]!.explanation).toContain('10');
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.highlightCells).toHaveLength(2);
    expect(hints[0]!.placement).toBeNull();
  });

  it('returns empty when CELL_DETERMINED trigger is used', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const a: Cell = [0, 0]; const b: Cell = [0, 1];
    bs.candidates[0]![0]! = new Set([1, 2, 3]);
    bs.candidates[0]![1]! = new Set([7, 8, 9]);
    injectSumPair(bs, a, b, 10);

    const ctx: RuleContext = {
      unit: bs.units[bs.rowUnitId(0)] ?? null, cell: null,
      board: bs, hint: Trigger.CELL_DETERMINED, hintDigit: null,
    };
    expect(new SumPairConstraint().apply(ctx).eliminations).toHaveLength(0);
  });
});
