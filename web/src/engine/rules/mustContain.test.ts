/**
 * Tests for MustContain — port of Python's test_must_contain.py.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { MustContain } from './mustContain.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeThreeCellCageSpec, makeTrivialSpec } from '../fixtures.js';

describe('MustContain', () => {
  it('does not crash on a fresh trivial board (row unit)', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const ctx: RuleContext = {
      unit: bs.units[bs.rowUnitId(0)] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const result = new MustContain().apply(ctx);
    expect(Array.isArray(result.eliminations)).toBe(true);
  });

  it('returns a list of eliminations for every unit type', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const rule = new MustContain();
    for (const unit of bs.units) {
      const ctx: RuleContext = {
        unit,
        cell: null,
        board: bs,
        hint: Trigger.COUNT_DECREASED,
        hintDigit: null,
      };
      expect(Array.isArray(rule.apply(ctx).eliminations)).toBe(true);
    }
  });

  it('golden path: must-contain digit confined to row overlap → eliminated from non-cage row cells', () => {
    // Three-cell cage at (0,0),(1,0),(2,0). Solutions all include 5 → must-contain={5}.
    // Remove 5 from cage cells outside row 0 so 5 is confined to (0,0) in row 0.
    // Use includeVirtualCages:false to prevent linear-system virtual cages from interfering.
    const spec = makeThreeCellCageSpec();
    const bs = new KillerBoardState(spec, { includeVirtualCages: false });
    const cageUid = bs.cageUnitId(0, 0);
    const cageIdx = cageUid - 27;
    bs.cageSolns[cageIdx] = [[5, 3, 4], [5, 1, 6]];
    // Clear digit 5 from every cell to prevent other cages from interfering
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]!.delete(5);
    // Only cage cells (0,0),(1,0),(2,0) and row-0 targets have 5
    bs.candidates[0]![0]!.add(5);
    // Leave (1,0) and (2,0) without 5 → confined to row-0 overlap
    for (let c = 1; c < 9; c++) bs.candidates[0]![c]!.add(5); // targets

    const ctx: RuleContext = {
      unit: bs.units[bs.rowUnitId(0)] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };

    const elims = new MustContain().apply(ctx).eliminations;
    for (let c = 1; c < 9; c++) {
      expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === c && e.digit === 5)).toBe(true);
    }
    // Cage cell (0,0) is not targeted by digit-5 confinement
    expect(elims.every(e => !(e.cell[0] === 0 && e.cell[1] === 0 && e.digit === 5))).toBe(true);
  });

  it('near-miss: must-contain digit has candidate outside overlap → no elimination', () => {
    // Same cage, but digit 5 remains a candidate in (1,0) — outside row 0 but inside cage.
    // otherElsewhere.has(5) is true → confined is empty → no elimination of 5 from row 0.
    const spec = makeThreeCellCageSpec();
    const bs = new KillerBoardState(spec, { includeVirtualCages: false });
    const cageUid = bs.cageUnitId(0, 0);
    const cageIdx = cageUid - 27;
    bs.cageSolns[cageIdx] = [[5, 3, 4], [5, 1, 6]];
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]!.delete(5);
    bs.candidates[0]![0]!.add(5);
    bs.candidates[1]![0]!.add(5); // outside row 0 → otherElsewhere.has(5) → not confined
    for (let c = 1; c < 9; c++) bs.candidates[0]![c]!.add(5); // potential targets

    const ctx: RuleContext = {
      unit: bs.units[bs.rowUnitId(0)] ?? null,
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };

    const elims = new MustContain().apply(ctx).eliminations;
    expect(elims.filter(e => e.digit === 5)).toHaveLength(0);
  });
});
