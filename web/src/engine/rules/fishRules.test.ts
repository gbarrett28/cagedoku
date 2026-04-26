/**
 * Tests for XWing, Swordfish, and Jellyfish (basic fish family).
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { XWing } from './xWing.js';
import { Swordfish } from './swordfish.js';
import { Jellyfish } from './jellyfish.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

function globalCtx(bs: BoardState): RuleContext {
  return { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
}

/** Clear digit d from every cell, then add it back only at the given (r,c) pairs. */
function setDigitCells(bs: BoardState, d: number, cells: [number, number][]): void {
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.cands(r, c).delete(d);
  for (const [r, c] of cells) bs.cands(r, c).add(d);
}

describe('XWing', () => {
  it('row variant: eliminates digit from cover-column cells outside the two base rows', () => {
    const bs = new BoardState(makeTrivialSpec());
    // Digit 3: rows 0 and 4 have it in exactly columns 2 and 7
    setDigitCells(bs, 3, [[0, 2], [0, 7], [4, 2], [4, 7], [2, 2], [6, 7]]);

    const elims = new XWing().apply(globalCtx(bs)).eliminations.filter(e => e.digit === 3);
    expect(elims.some(e => e.cell[0] === 2 && e.cell[1] === 2)).toBe(true);
    expect(elims.some(e => e.cell[0] === 6 && e.cell[1] === 7)).toBe(true);
    // Base rows not targeted
    expect(elims.every(e => e.cell[0] !== 0 && e.cell[0] !== 4)).toBe(true);
  });

  it('column variant: eliminates digit from cover-row cells outside the two base columns', () => {
    const bs = new BoardState(makeTrivialSpec());
    // Digit 5: cols 1 and 6 have it in exactly rows 2 and 7
    setDigitCells(bs, 5, [[2, 1], [7, 1], [2, 6], [7, 6], [3, 1], [5, 6]]);

    const elims = new XWing().apply(globalCtx(bs)).eliminations.filter(e => e.digit === 5);
    expect(elims.some(e => e.cell[0] === 3 && e.cell[1] === 1)).toBe(true);
    expect(elims.some(e => e.cell[0] === 5 && e.cell[1] === 6)).toBe(true);
    expect(elims.every(e => e.cell[1] !== 1 || (e.cell[0] !== 2 && e.cell[0] !== 7))).toBe(true);
  });

  it('returns empty when the two rows do not share the same column pair', () => {
    const bs = new BoardState(makeTrivialSpec());
    // Row 0: d in cols 2,7; Row 4: d in cols 3,8 — different column sets
    setDigitCells(bs, 3, [[0, 2], [0, 7], [4, 3], [4, 8]]);
    expect(new XWing().apply(globalCtx(bs)).eliminations).toHaveLength(0);
  });
});

describe('Swordfish', () => {
  it('row variant: eliminates digit from cover columns outside the three base rows', () => {
    const bs = new BoardState(makeTrivialSpec());
    // Digit 2 in rows 0,3,6 covering exactly cols 1,4,7
    setDigitCells(bs, 2, [
      [0, 1], [0, 4],       // row 0: cols 1,4
      [3, 1], [3, 7],       // row 3: cols 1,7
      [6, 4], [6, 7],       // row 6: cols 4,7
      [2, 1], [5, 7],       // extra cells to be eliminated
    ]);

    const elims = new Swordfish().apply(globalCtx(bs)).eliminations.filter(e => e.digit === 2);
    expect(elims.some(e => e.cell[0] === 2 && e.cell[1] === 1)).toBe(true);
    expect(elims.some(e => e.cell[0] === 5 && e.cell[1] === 7)).toBe(true);
    // Base rows not targeted
    expect(elims.every(e => e.cell[0] !== 0 && e.cell[0] !== 3 && e.cell[0] !== 6)).toBe(true);
  });
});

describe('Jellyfish', () => {
  it('row variant: eliminates digit from cover columns outside the four base rows', () => {
    const bs = new BoardState(makeTrivialSpec());
    // Digit 7 in rows 0,2,5,7 covering exactly cols 1,3,6,8
    setDigitCells(bs, 7, [
      [0, 1], [0, 3],     // row 0: cols 1,3
      [2, 1], [2, 6],     // row 2: cols 1,6
      [5, 3], [5, 8],     // row 5: cols 3,8
      [7, 6], [7, 8],     // row 7: cols 6,8
      [1, 1], [4, 6],     // extra cells to be eliminated
    ]);

    const elims = new Jellyfish().apply(globalCtx(bs)).eliminations.filter(e => e.digit === 7);
    expect(elims.some(e => e.cell[0] === 1 && e.cell[1] === 1)).toBe(true);
    expect(elims.some(e => e.cell[0] === 4 && e.cell[1] === 6)).toBe(true);
    // Base rows not targeted
    const baseRows = new Set([0, 2, 5, 7]);
    expect(elims.every(e => !baseRows.has(e.cell[0]))).toBe(true);
  });
});
