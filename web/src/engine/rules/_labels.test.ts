/**
 * Tests for engine/rules/_labels.ts — cellLabel, unitLabel, unitTypeLabel.
 */

import { describe, expect, it } from 'vitest';
import { UnitKind } from '../types.js';
import type { Unit, Cell } from '../types.js';
import { cellLabel, unitLabel, unitTypeLabel } from './_labels.js';

function makeUnit(kind: UnitKind, cells: Cell[]): Unit {
  return { unitId: 0, kind, cells, distinctDigits: true };
}

describe('cellLabel', () => {
  it('formats (row,col) as r<row+1>c<col+1>', () => {
    expect(cellLabel([0, 0] as Cell)).toBe('r1c1');
    expect(cellLabel([2, 5] as Cell)).toBe('r3c6');
    expect(cellLabel([8, 8] as Cell)).toBe('r9c9');
  });
});

describe('unitLabel', () => {
  it('ROW: labels by 1-based row number', () => {
    const unit = makeUnit(UnitKind.ROW, Array.from({ length: 9 }, (_, c) => [2, c] as Cell));
    expect(unitLabel(unit)).toBe('row 3');
  });

  it('COL: labels by 1-based col number', () => {
    const unit = makeUnit(UnitKind.COL, Array.from({ length: 9 }, (_, r) => [r, 4] as Cell));
    expect(unitLabel(unit)).toBe('col 5');
  });

  it('BOX: labels by 1-based box row and col', () => {
    // Box starting at row=3, col=3 → box row 2, box col 2
    const unit = makeUnit(UnitKind.BOX, [[3, 3], [3, 4], [3, 5], [4, 3], [4, 4], [4, 5], [5, 3], [5, 4], [5, 5]] as Cell[]);
    expect(unitLabel(unit)).toBe('box (2,2)');
  });

  it('CAGE: lists sorted cell labels', () => {
    const unit = makeUnit(UnitKind.CAGE, [[1, 2], [0, 5]] as Cell[]);
    expect(unitLabel(unit)).toBe('cage [r1c6, r2c3]');
  });
});

describe('unitTypeLabel', () => {
  it('returns plural labels for each unit kind', () => {
    expect(unitTypeLabel(UnitKind.ROW)).toBe('rows');
    expect(unitTypeLabel(UnitKind.COL)).toBe('columns');
    expect(unitTypeLabel(UnitKind.BOX)).toBe('boxes');
    expect(unitTypeLabel(UnitKind.CAGE)).toBe('cages');
  });
});
