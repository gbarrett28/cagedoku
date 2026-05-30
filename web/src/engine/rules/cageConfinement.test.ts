/**
 * Tests for CageConfinement — pigeonhole elimination when n cages fill n same-type units.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { CageConfinement } from './cageConfinement.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec, makeTwoCellCageSpec } from '../fixtures.js';

function globalCtx(bs: BoardState): RuleContext {
  return { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
}

describe('CageConfinement', () => {
  it('does not crash on a fresh trivial board', () => {
    const bs = new BoardState(makeTrivialSpec());
    expect(Array.isArray(new CageConfinement().apply(globalCtx(bs)).eliminations)).toBe(true);
  });

  it('golden path (n=1): essential digit confined to col → eliminated from col outside cage', () => {
    // Two-cell cage at (0,0),(1,0) — both in col 0.
    // Override solutions to [[5,6]] → must-contain = {5,6}.
    // Use includeVirtualCages:false and clear digit 5 from all other cells
    // to prevent interference from other cages or linear-system virtual cages.
    const bs = new BoardState(makeTwoCellCageSpec(), { includeVirtualCages: false });
    const cageUid = bs.cageUnitId(0, 0);
    const cageIdx = cageUid - 27;
    bs.cageSolns[cageIdx] = [[5, 6]];
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]!.delete(5);
    bs.candidates[0]![0]!.add(5);
    bs.candidates[1]![0]!.add(5);
    for (let r = 2; r < 9; r++) bs.candidates[r]![0]!.add(5); // targets

    const elims = new CageConfinement().apply(globalCtx(bs)).eliminations;

    for (let r = 2; r < 9; r++) {
      expect(elims.some(e => e.cell[0] === r && e.cell[1] === 0 && e.digit === 5)).toBe(true);
    }
    // Cage cells (0,0) and (1,0) are not targeted by digit-5 confinement
    expect(elims.every(e => !(e.cell[0] <= 1 && e.cell[1] === 0 && e.digit === 5))).toBe(true);
  });

  it('near-miss: digit not in every cage solution → not must-contain → no elimination', () => {
    // Solutions [[5,6],[3,8]] — digit 5 only in first solution, not must-contain.
    // CageConfinement requires d in every solution; this cage fails that guard.
    const bs = new BoardState(makeTwoCellCageSpec(), { includeVirtualCages: false });
    const cageUid = bs.cageUnitId(0, 0);
    const cageIdx = cageUid - 27;
    bs.cageSolns[cageIdx] = [[5, 6], [3, 8]];
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]!.delete(5);
    bs.candidates[0]![0]!.add(5);
    bs.candidates[1]![0]!.add(5);
    for (let r = 2; r < 9; r++) bs.candidates[r]![0]!.add(5); // potential targets

    const elims = new CageConfinement().apply(globalCtx(bs)).eliminations;
    expect(elims.filter(e => e.digit === 5)).toHaveLength(0);
  });

  it('asHints: returns hint with correct shape for n=1 confinement', () => {
    const bs = new BoardState(makeTwoCellCageSpec(), { includeVirtualCages: false });
    const cageUid = bs.cageUnitId(0, 0);
    const cageIdx = cageUid - 27;
    bs.cageSolns[cageIdx] = [[5, 6]];
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r]![c]!.delete(5);
    bs.candidates[0]![0]!.add(5);
    bs.candidates[1]![0]!.add(5);
    for (let r = 2; r < 9; r++) bs.candidates[r]![0]!.add(5);

    const ctx = globalCtx(bs);
    const rule = new CageConfinement();
    const elims = rule.apply(ctx).eliminations.filter(e => e.digit === 5);
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, elims);
    const h = hints.find(h => h.eliminations.some(e => e.digit === 5));
    expect(h).toBeDefined();
    expect(h!.ruleName).toBe('CageConfinement');
    expect(h!.explanation).toContain('5');
    expect(h!.placement).toBeNull();
  });
});
