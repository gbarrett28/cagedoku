/**
 * Tests for cage rules: SolutionMapFilter, CageIntersection, CageCandidateFilter.
 * Port of Python's test_cage_rules.py.
 *
 * Note: _per_cell_possible is module-private in TS (not exported), so that
 * helper test is covered indirectly via test_solution_map_filter_eliminates_per_cell_infeasible_digits.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { CageCandidateFilter } from './cageCandidateFilter.js';
import { CageIntersection } from './cageIntersection.js';
import { SolutionMapFilter } from './solutionMapFilter.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeThreeCellCageSpec, makeTrivialSpec, makeTwoCellCageSpec } from '../fixtures.js';

function cageCtx(
  bs: BoardState,
  cageUnitId: number,
  trigger: Trigger = Trigger.COUNT_DECREASED,
): RuleContext {
  return {
    unit: bs.units[cageUnitId] ?? null,
    cell: null,
    board: bs,
    hint: trigger,
    hintDigit: null,
  };
}

describe('SolutionMapFilter', () => {
  it('does not crash on a fresh trivial board', () => {
    const bs = new BoardState(makeTrivialSpec());
    const cageIdx = bs.regions[0]![0]!;
    const result = new SolutionMapFilter().apply(cageCtx(bs, 27 + cageIdx));
    expect(Array.isArray(result.eliminations)).toBe(true);
  });

  it('returns a list (possibly empty) when cage solutions are restricted', () => {
    const bs = new BoardState(makeTrivialSpec());
    const cageIdx = bs.regions[0]![0]!;
    const cageUnit = bs.units[27 + cageIdx]!;
    const [r, c] = cageUnit.cells[0] as unknown as [number, number];
    bs.candidates[r]![c]! = new Set([3]); // solution {5} is now unreachable
    const result = new SolutionMapFilter().apply(cageCtx(bs, 27 + cageIdx));
    expect(Array.isArray(result.eliminations)).toBe(true);
  });

  it('eliminates per-cell infeasible digits (3-cell cage test)', () => {
    // Regression test for coarse-vs-per-cell gap (mirrors Python's
    // test_solution_map_filter_eliminates_per_cell_infeasible_digits):
    // 3-cell cage (row=0,col=0),(row=1,col=0),(row=2,col=0); total=12.
    // Restrict (row=0,col=0) and (row=1,col=0) to {1,2} → (row=2,col=0) forced to 9.
    const spec = makeThreeCellCageSpec();
    const bs = new BoardState(spec);
    const cageIdx = bs.regions[0]![0]!;  // head at (row=0, col=0)
    expect(bs.units[27 + cageIdx]!.cells.length).toBe(3);

    bs.candidates[0]![0]! = new Set([1, 2]);  // (row=0, col=0)
    bs.candidates[1]![0]! = new Set([1, 2]);  // (row=1, col=0)
    // (row=2, col=0) retains full candidates

    const result = new SolutionMapFilter().apply(cageCtx(bs, 27 + cageIdx));
    const elimsByCell = new Map<string, Set<number>>();
    for (const e of result.eliminations) {
      const key = `${e.cell[0]},${e.cell[1]}`;
      if (!elimsByCell.has(key)) elimsByCell.set(key, new Set());
      elimsByCell.get(key)!.add(e.digit);
    }
    // (row=2,col=0) must be 9: all digits 1-8 should be eliminated
    const elimsC = elimsByCell.get('2,0') ?? new Set();
    for (let d = 1; d <= 8; d++) {
      expect(elimsC.has(d)).toBe(true);
    }
  });
});

describe('CageIntersection', () => {
  it('does not crash on a fresh trivial board', () => {
    const bs = new BoardState(makeTrivialSpec());
    const cageIdx = bs.regions[0]![0]!;
    const result = new CageIntersection().apply(cageCtx(bs, 27 + cageIdx));
    expect(Array.isArray(result.eliminations)).toBe(true);
  });
});

describe('CageCandidateFilter', () => {
  it('asHints returns at least one hint for a two-cell cage', () => {
    const spec = makeTwoCellCageSpec();
    const bs = new BoardState(spec);
    const cageUid = bs.cageUnitId(0, 0);
    const ctx = cageCtx(bs, cageUid);
    const rule = new CageCandidateFilter();
    const elims = rule.apply(ctx).eliminations;
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints.every(h => h.placement === null)).toBe(true);
  });
});
