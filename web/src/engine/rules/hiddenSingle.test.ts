/**
 * Tests for HiddenSingle — port of Python's test_hidden_single.py.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { HiddenSingle } from './hiddenSingle.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

function makeCtx(bs: BoardState, rowUid: number, hintDigit: number): RuleContext {
  return {
    unit: bs.units[rowUid] ?? null,
    cell: null,
    board: bs,
    hint: Trigger.COUNT_HIT_ONE,
    hintDigit,
  };
}

describe('HiddenSingle', () => {
  it('eliminates all non-target candidates from the sole cell', () => {
    const bs = new BoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    // Confine digit 7 to cell (0,4) in row 0
    for (let c = 0; c < 9; c++) {
      if (c !== 4) bs.cands(0, c).delete(7);
    }
    bs.counts[rowUid]![7] = 1;

    const result = new HiddenSingle().apply(makeCtx(bs, rowUid, 7));
    const elims = result.eliminations;
    // All eliminations target (0,4) and none remove digit 7
    expect(elims.every(e => e.cell[0] === 0 && e.cell[1] === 4)).toBe(true);
    expect(elims.every(e => e.digit !== 7)).toBe(true);
    // Eliminates every candidate except 7
    expect(elims.length).toBe(bs.cands(0, 4).size - 1);
  });

  it('asHints returns a hint with display name and correct eliminations', () => {
    const bs = new BoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    for (let c = 0; c < 9; c++) {
      if (c !== 4) bs.cands(0, c).delete(7);
    }
    bs.counts[rowUid]![7] = 1;
    const ctx = makeCtx(bs, rowUid, 7);
    const elims = new HiddenSingle().apply(ctx).eliminations;
    const hints = new HiddenSingle().asHints(ctx, [...elims]);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.displayName).toBe('Hidden Single');
    expect(hints[0]!.eliminations).toStrictEqual(elims);
  });

  it('returns empty eliminations when digit is absent from all cells', () => {
    const bs = new BoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    for (let c = 0; c < 9; c++) bs.cands(0, c).delete(3);
    bs.counts[rowUid]![3] = 0;

    const result = new HiddenSingle().apply(makeCtx(bs, rowUid, 3));
    expect(result.eliminations).toEqual([]);
  });
});
