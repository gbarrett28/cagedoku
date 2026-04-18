/**
 * Tests for CellSolutionElimination — port of Python's test_cell_solution_elimination.py.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { CellSolutionElimination } from './cellSolutionElimination.js';
import type { RuleContext } from '../rule.js';
import { Trigger, UnitKind } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

function makeCtx(bs: BoardState): RuleContext {
  return {
    unit: null,
    cell: [0, 0] as unknown as import('../types.js').Cell,
    board: bs,
    hint: Trigger.CELL_SOLVED,
    hintDigit: 5,
  };
}

describe('CellSolutionElimination', () => {
  it('eliminates solved digit from all row, col, and box peers', () => {
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[0][0] = new Set([5]);
    const elims = new CellSolutionElimination().apply(makeCtx(bs)).eliminations;
    const elimCells = new Set(elims.map(e => `${e.cell[0]},${e.cell[1]}`));

    expect(elims.every(e => e.digit === 5)).toBe(true);
    // Row peers
    for (let c = 1; c < 9; c++) expect(elimCells.has(`0,${c}`)).toBe(true);
    // Col peers
    for (let r = 1; r < 9; r++) expect(elimCells.has(`${r},0`)).toBe(true);
    // Box 0 peers (rows 0-2, cols 0-2, excluding (0,0))
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        if (r !== 0 || c !== 0) expect(elimCells.has(`${r},${c}`)).toBe(true);
  });

  it('only targets row/col/box peers — not cage-only peers', () => {
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[0][0] = new Set([5]);
    const elims = new CellSolutionElimination().apply(makeCtx(bs)).eliminations;
    const nonCageUids = new Set(
      bs.cellUnitIds(0, 0).filter(uid => bs.units[uid].kind !== UnitKind.CAGE)
    );
    for (const e of elims) {
      const [r, c] = e.cell as unknown as [number, number];
      const shared = [...nonCageUids].some(uid =>
        bs.units[uid].cells.some(([cr, cc]) => cr === r && cc === c)
      );
      expect(shared).toBe(true);
    }
  });

  it('declares CELL_SOLVED as trigger, not CELL_DETERMINED', () => {
    const rule = new CellSolutionElimination();
    expect(rule.triggers.has(Trigger.CELL_SOLVED)).toBe(true);
    expect(rule.triggers.has(Trigger.CELL_DETERMINED)).toBe(false);
  });

  it('asHints returns a single hint with non-empty eliminations referencing r1c1', () => {
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[0][0] = new Set([5]);
    const ctx = makeCtx(bs);
    const rule = new CellSolutionElimination();
    const elims = rule.apply(ctx).eliminations;
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBe(1);
    expect(hints[0].placement).toBeNull();
    expect(hints[0].eliminations.length).toBeGreaterThan(0);
    expect(hints[0].explanation).toContain('r1c1');
  });
});
