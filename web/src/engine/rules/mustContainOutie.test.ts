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
  const cageIdx = bs.regions[0]![5]!;

  // Override cage solutions so must-contain = {6,8,9}
  bs.cageSolns[cageIdx]! = [
    [1, 6, 8, 9],
    [2, 6, 8, 9],
    [6, 7, 8, 9],
  ];

  // External cell (0,2): candidates = {6,8,9}
  bs.candidates[0]![2]! = new Set([6, 8, 9]);
  // Outie (1,7): all digits available
  bs.candidates[1]![7]! = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);

  return { bs, cageIdx };
}

function rowCtx(bs: BoardState): RuleContext {
  return {
    unit: bs.units[bs.rowUnitId(0)] ?? null,
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

  it('restricts outie (1,7) to {6,8,9} when triggered by row unit', () => {
    const { bs } = boardWithOutie();
    const elims = new MustContainOutie().apply(rowCtx(bs)).eliminations;
    const outieElims = new Map<number, boolean>();
    for (const e of elims) {
      if (e.cell[0] === 1 && e.cell[1] === 7) outieElims.set(e.digit, true);
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
      if (e.cell[0] === 1 && e.cell[1] === 7) outieElims.set(e.digit, true);
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
    bs.candidates[0]![3]! = new Set([6, 8, 9]); // second qualifying external cell
    const elims = new MustContainOutie().apply(rowCtx(bs)).eliminations;
    const outieElims = elims.filter(e => e.cell[0] === 1 && e.cell[1] === 7);
    expect(outieElims).toEqual([]);
  });

  it('does not fire when external candidates include non-must digit', () => {
    const { bs } = boardWithOutie();
    bs.candidates[0]![2]! = new Set([6, 7, 8, 9]); // 7 is not in must-contain
    const elims = new MustContainOutie().apply(rowCtx(bs)).eliminations;
    const outieElims = elims.filter(e => e.cell[0] === 1 && e.cell[1] === 7);
    expect(outieElims).toEqual([]);
  });

  it('does not fire when column unit has multiple outies', () => {
    const { bs } = boardWithOutie();
    bs.candidates[0]![2]! = new Set([6, 8, 9]);
    // col 5 contains only (0,5) from the cage; outside = (0,6),(0,7),(1,7) — 3 outies
    const col5Uid = bs.colUnitId(5);
    const ctx: RuleContext = {
      unit: bs.units[col5Uid] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const elims = new MustContainOutie().apply(ctx).eliminations;
    const cageOutieElims = elims.filter(e => {
      const [r, c] = e.cell as unknown as [number, number];
      return (r === 0 && c === 6) || (r === 0 && c === 7) || (r === 1 && c === 7);
    });
    expect(cageOutieElims).toEqual([]);
  });
});
