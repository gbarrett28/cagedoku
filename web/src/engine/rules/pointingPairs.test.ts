/**
 * Tests for PointingPairs — port of Python's test_pointing_pairs.py.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { PointingPairs } from './pointingPairs.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

describe('PointingPairs', () => {
  it('eliminates a digit confined to one row within a box from the rest of that row', () => {
    const bs = new BoardState(makeTrivialSpec());
    // Box 0: rows 0-2, cols 0-2. Confine digit 5 to row 0 within box 0.
    for (let r = 1; r < 3; r++)
      for (let c = 0; c < 3; c++)
        bs.cands(r, c).delete(5);

    const boxUid = bs.boxUnitId(0, 0);
    const ctx: RuleContext = {
      unit: bs.units[boxUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const elims = new PointingPairs().apply(ctx).eliminations;
    const elimMap = new Map<string, number>();
    for (const e of elims) {
      if (e.digit === 5) elimMap.set(`${e.cell[0]},${e.cell[1]}`, e.digit);
    }

    // 5 must be eliminated from (0,3)..(0,8)
    for (let c = 3; c < 9; c++) {
      expect(elimMap.has(`0,${c}`)).toBe(true);
    }

    const hints = new PointingPairs().asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.displayName).toBe('Pointing Pairs');
  });

  it('eliminates a digit confined to one column within a box from the rest of that col', () => {
    const bs = new BoardState(makeTrivialSpec());
    // Confine digit 8 to col 0 within box 0
    for (let r = 0; r < 3; r++)
      for (let c = 1; c < 3; c++)
        bs.cands(r, c).delete(8);

    const boxUid = bs.boxUnitId(0, 0);
    const ctx: RuleContext = {
      unit: bs.units[boxUid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const elims = new PointingPairs().apply(ctx).eliminations;
    const elimMap = new Map<string, number>();
    for (const e of elims) {
      if (e.digit === 8) elimMap.set(`${e.cell[0]},${e.cell[1]}`, e.digit);
    }

    // 8 must be eliminated from col 0, rows 3-8
    for (let r = 3; r < 9; r++) {
      expect(elimMap.has(`${r},0`)).toBe(true);
    }
  });
});
