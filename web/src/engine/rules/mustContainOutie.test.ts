/**
 * Tests for MustContainOutie — port of Python's test_must_contain_outie.py.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { MustContainOutie } from './mustContainOutie.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeOutieSpec, makeTrivialSpec } from '../fixtures.js';

/** Build a BoardState with the outie cage set up for must-contain {6,8,9}. */
function boardWithOutie(): { bs: BoardState; cageIdx: number } {
  const bs = new BoardState(makeOutieSpec());
  // Cage is at (row=5,col=0),(row=6,col=0),(row=7,col=0),(row=7,col=1).
  // regions[row][col] — head at (row=5, col=0).
  const cageIdx = bs.regions[5]![0]!;

  // Override cage solutions so must-contain = {6,8,9}
  bs.cageSolns[cageIdx]! = [
    [1, 6, 8, 9],
    [2, 6, 8, 9],
    [6, 7, 8, 9],
  ];

  // External cell in col=0 at (row=2, col=0): candidates = {6,8,9}
  bs.candidates[2]![0]! = new Set([6, 8, 9]);
  // Outie (row=7, col=1): all digits available
  bs.candidates[7]![1]! = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);

  return { bs, cageIdx };
}

function colCtx(bs: BoardState): RuleContext {
  // The 4-cell outie cage occupies 3 cells in visual col 0 (rows 5,6,7) with
  // one outie at (row=7,col=1).  Trigger via colUnitId(0) = visual column 0.
  return {
    unit: bs.units[bs.colUnitId(0)] ?? null,
    cell: null,
    board: bs,
    hint: Trigger.COUNT_DECREASED,
    hintDigit: null,
  };
}

describe('MustContainOutie', () => {
  it('does not crash on a fresh trivial board', () => {
    const bs = new BoardState(makeTrivialSpec());
    const ctx: RuleContext = {
      unit: bs.units[bs.rowUnitId(0)] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    expect(Array.isArray(new MustContainOutie().apply(ctx).eliminations)).toBe(true);
  });

  it('restricts outie (row=7,col=1) to {6,8,9} when triggered by col unit', () => {
    // Cage at (5,0),(6,0),(7,0),(7,1).  Trigger on col 0: 3 cage cells inside,
    // outie at (row=7,col=1).
    const { bs } = boardWithOutie();
    const elims = new MustContainOutie().apply(colCtx(bs)).eliminations;
    const outieElims = new Map<number, boolean>();
    for (const e of elims) {
      if (e.cell[0] === 7 && e.cell[1] === 1) outieElims.set(e.digit, true);
    }
    for (let d = 1; d <= 9; d++) {
      if ([6, 8, 9].includes(d)) {
        expect(outieElims.has(d)).toBe(false); // kept
      } else {
        expect(outieElims.has(d)).toBe(true); // eliminated
      }
    }
  });

  it('gives same result when triggered by the cage unit', () => {
    const { bs, cageIdx } = boardWithOutie();
    const ctx: RuleContext = {
      unit: bs.units[27 + cageIdx] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.SOLUTION_PRUNED,
      hintDigit: null,
    };
    const elims = new MustContainOutie().apply(ctx).eliminations;
    const outieElims = new Map<number, boolean>();
    for (const e of elims) {
      if (e.cell[0] === 7 && e.cell[1] === 1) outieElims.set(e.digit, true);
    }
    for (let d = 1; d <= 9; d++) {
      if ([6, 8, 9].includes(d)) {
        expect(outieElims.has(d)).toBe(false);
      } else {
        expect(outieElims.has(d)).toBe(true);
      }
    }
  });

  it('does not fire when two external cells qualify', () => {
    const { bs } = boardWithOutie();
    // Second qualifying external cell in col=0, at row=3.
    bs.candidates[3]![0]! = new Set([6, 8, 9]);
    const elims = new MustContainOutie().apply(colCtx(bs)).eliminations;
    const outieElims = elims.filter(e => e.cell[0] === 7 && e.cell[1] === 1);
    expect(outieElims).toEqual([]);
  });

  it('does not fire when external candidates include non-must digit', () => {
    const { bs } = boardWithOutie();
    // External cell at (row=2,col=0): now includes 7, which is not in must-contain.
    bs.candidates[2]![0]! = new Set([6, 7, 8, 9]);
    const elims = new MustContainOutie().apply(colCtx(bs)).eliminations;
    const outieElims = elims.filter(e => e.cell[0] === 7 && e.cell[1] === 1);
    expect(outieElims).toEqual([]);
  });

  it('does not fire when unit has multiple outies', () => {
    const { bs } = boardWithOutie();
    bs.candidates[2]![0]! = new Set([6, 8, 9]);
    // Row 5 contains only (row=5,col=0) from the cage; the other 3 cage cells
    // (6,0),(7,0),(7,1) are outies — rule requires exactly 1 outie, so no fire.
    const row5Uid = bs.rowUnitId(5);
    const ctx: RuleContext = {
      unit: bs.units[row5Uid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const elims = new MustContainOutie().apply(ctx).eliminations;
    const cageOutieElims = elims.filter(e => {
      const [r, c] = e.cell as unknown as [number, number];
      return (r === 6 && c === 0) || (r === 7 && c === 0) || (r === 7 && c === 1);
    });
    expect(cageOutieElims).toEqual([]);
  });
});
