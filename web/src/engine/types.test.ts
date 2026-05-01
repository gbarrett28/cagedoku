/**
 * Tests for engine/types.ts — shared value types and enumerations.
 * Port of Python's tests/solver/engine/test_types.py.
 */

import { describe, expect, it } from 'vitest';
import {
  Trigger, UnitKind,
  cellKey, hasProgress, emptyResult,
} from './types.js';
import type { Elimination, Unit, Cell } from './types.js';

// ---------------------------------------------------------------------------
// Trigger ordering
// ---------------------------------------------------------------------------

describe('Trigger ordering', () => {
  it('CELL_DETERMINED has the lowest numeric value (highest priority)', () => {
    expect(Trigger.CELL_DETERMINED).toBe(0);
  });

  it('triggers increase numerically in priority order', () => {
    expect(Trigger.CELL_DETERMINED).toBeLessThan(Trigger.COUNT_HIT_ONE);
    expect(Trigger.COUNT_HIT_ONE).toBeLessThan(Trigger.COUNT_HIT_TWO);
    expect(Trigger.COUNT_HIT_TWO).toBeLessThan(Trigger.COUNT_DECREASED);
    expect(Trigger.COUNT_DECREASED).toBeLessThan(Trigger.SOLUTION_PRUNED);
    expect(Trigger.SOLUTION_PRUNED).toBeLessThan(Trigger.GLOBAL);
    expect(Trigger.GLOBAL).toBeLessThan(Trigger.CELL_SOLVED);
  });
});

// ---------------------------------------------------------------------------
// Elimination value-object semantics
// ---------------------------------------------------------------------------

describe('Elimination', () => {
  it('can be stored in a Set using cellKey for identity', () => {
    // TypeScript objects use reference equality; the canonical way to compare
    // Elimination values by content is via (cellKey, digit) tuples.
    const a: Elimination = { cell: [1, 2] as Cell, digit: 5 };
    const b: Elimination = { cell: [1, 2] as Cell, digit: 5 };
    // Same content, different objects — not ===, but serialise identically.
    expect(a).not.toBe(b);
    expect(`${cellKey(a.cell)},${a.digit}`).toBe(`${cellKey(b.cell)},${b.digit}`);
  });

  it('cell and digit fields are accessible', () => {
    const e: Elimination = { cell: [3, 7] as Cell, digit: 9 };
    expect(e.cell[0]).toBe(3);  // row
    expect(e.cell[1]).toBe(7);  // col
    expect(e.digit).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// BoardEvent: CELL_DETERMINED payload
// ---------------------------------------------------------------------------

describe('Board event — CELL_DETERMINED', () => {
  it('payload is the cell (tuple) for CELL_DETERMINED trigger', () => {
    // BoardEvent.payload is Cell | number.  For CELL_DETERMINED it should be
    // a Cell tuple so callers can extract row/col.
    const cell: Cell = [4, 6];
    const event = { trigger: Trigger.CELL_DETERMINED, payload: cell, hintDigit: 7 };
    const [row, col] = event.payload as Cell;
    expect(row).toBe(4);
    expect(col).toBe(6);
    expect(event.hintDigit).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Unit cells
// ---------------------------------------------------------------------------

describe('Unit cells', () => {
  it('a row unit holds exactly 9 cells', () => {
    const unit: Unit = {
      unitId: 0,
      kind: UnitKind.ROW,
      cells: Array.from({ length: 9 }, (_, c) => [0, c] as Cell),
      distinctDigits: true,
    };
    expect(unit.cells.length).toBe(9);
  });

  it('cellKey encodes row-major (row,col) order', () => {
    const cell: Cell = [2, 5];
    expect(cellKey(cell)).toBe('2,5');
  });
});

// ---------------------------------------------------------------------------
// hasProgress / emptyResult
// ---------------------------------------------------------------------------

describe('hasProgress', () => {
  it('returns false for an empty result', () => {
    expect(hasProgress(emptyResult())).toBe(false);
  });

  it('returns true when eliminations are present', () => {
    const r = emptyResult();
    (r.eliminations as Elimination[]).push({ cell: [0, 0] as Cell, digit: 1 });
    expect(hasProgress(r)).toBe(true);
  });
});
