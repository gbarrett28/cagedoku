/**
 * Tests for XWing, Swordfish, and Jellyfish (basic fish family).
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { XWing } from './xWing.js';
import { Swordfish } from './swordfish.js';
import { Jellyfish } from './jellyfish.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

function globalCtx(bs: KillerBoardState): RuleContext {
  return { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
}

/** Clear digit d from every cell, then add it back only at the given (r,c) pairs. */
function setDigitCells(bs: KillerBoardState, d: number, cells: [number, number][]): void {
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.cands(r, c).delete(d);
  for (const [r, c] of cells) bs.cands(r, c).add(d);
}

describe('XWing', () => {
  it('row variant: eliminates digit from cover-column cells outside the two base rows', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    // Digit 3: rows 0 and 4 have it in exactly columns 2 and 7
    setDigitCells(bs, 3, [[0, 2], [0, 7], [4, 2], [4, 7], [2, 2], [6, 7]]);

    const elims = new XWing().apply(globalCtx(bs)).eliminations.filter(e => e.digit === 3);
    expect(elims.some(e => e.cell[0] === 2 && e.cell[1] === 2)).toBe(true);
    expect(elims.some(e => e.cell[0] === 6 && e.cell[1] === 7)).toBe(true);
    // Base rows not targeted
    expect(elims.every(e => e.cell[0] !== 0 && e.cell[0] !== 4)).toBe(true);
  });

  it('column variant: eliminates digit from cover-row cells outside the two base columns', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    // Digit 5: cols 1 and 6 have it in exactly rows 2 and 7
    setDigitCells(bs, 5, [[2, 1], [7, 1], [2, 6], [7, 6], [3, 1], [5, 6]]);

    const elims = new XWing().apply(globalCtx(bs)).eliminations.filter(e => e.digit === 5);
    expect(elims.some(e => e.cell[0] === 3 && e.cell[1] === 1)).toBe(true);
    expect(elims.some(e => e.cell[0] === 5 && e.cell[1] === 6)).toBe(true);
    expect(elims.every(e => e.cell[1] !== 1 || (e.cell[0] !== 2 && e.cell[0] !== 7))).toBe(true);
  });

  it('asHints: highlightCells contains only the 4 pivot cells, not elimination targets (issue #144)', () => {
    // Regression for bug #144: elimination cells must not appear in highlightCells.
    const bs = new KillerBoardState(makeTrivialSpec());
    setDigitCells(bs, 3, [[0, 2], [0, 7], [4, 2], [4, 7], [2, 2], [6, 7]]);
    const ctx = globalCtx(bs);
    const rule = new XWing();
    const elims = rule.apply(ctx).eliminations.filter(e => e.digit === 3);
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    const h = hints[0]!;
    expect(h.highlightCells).toHaveLength(4);
    const elimKeys = new Set(h.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`));
    for (const [r, c] of h.highlightCells) {
      expect(elimKeys.has(`${r},${c}`)).toBe(false);
    }
  });

  it('returns empty when the two rows do not share the same column pair', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    // Row 0: d in cols 2,7; Row 4: d in cols 3,8 — different column sets
    setDigitCells(bs, 3, [[0, 2], [0, 7], [4, 3], [4, 8]]);
    expect(new XWing().apply(globalCtx(bs)).eliminations).toHaveLength(0);
  });

  it('near-miss: only row has d in 3 cols → size=3 fails cols.size===2 guard → no X-Wing', () => {
    // Only row 0 has d (in cols 1, 4, 7 — size=3 > 2). Row-variant guard cols.size===2 fails.
    // Each col has d in exactly 1 row → column-variant also finds nothing.
    const bs = new KillerBoardState(makeTrivialSpec());
    setDigitCells(bs, 4, [[0, 1], [0, 4], [0, 7]]);
    expect(new XWing().apply(globalCtx(bs)).eliminations.filter(e => e.digit === 4)).toHaveLength(0);
  });
});

describe('Swordfish', () => {
  it('row variant: eliminates digit from cover columns outside the three base rows', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
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

  it('near-miss: 3 qualifying rows but union spans 5 cols → coverCols.size !== 3 → no Swordfish', () => {
    // Rows 0,3,6 each qualify (sizes 2,2,3) but their union is {1,2,3,4,5} — size=5 > 3.
    // Row-variant guard coverCols.size===3 fails for the only possible triple.
    // Only 2 cols (1 and 3) appear in 2 rows each; the rest appear in 1 row → no qualifying col-triple.
    const bs = new KillerBoardState(makeTrivialSpec());
    setDigitCells(bs, 6, [
      [0, 1], [0, 2],
      [3, 3], [3, 4],
      [6, 1], [6, 3], [6, 5],
    ]);
    expect(new Swordfish().apply(globalCtx(bs)).eliminations.filter(e => e.digit === 6)).toHaveLength(0);
  });
});

describe('Swordfish.asHints', () => {
  it('returns a hint with correct shape when swordfish pattern exists', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    setDigitCells(bs, 2, [
      [0, 1], [0, 4],
      [3, 1], [3, 7],
      [6, 4], [6, 7],
      [2, 1], [5, 7],
    ]);
    const ctx = globalCtx(bs);
    const rule = new Swordfish();
    const elims = rule.apply(ctx).eliminations.filter(e => e.digit === 2);
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.ruleName).toBe('Swordfish');
    expect(hints[0]!.explanation).toContain('2');
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
  });
});

describe('Jellyfish', () => {
  it('row variant: eliminates digit from cover columns outside the four base rows', () => {

    const bs = new KillerBoardState(makeTrivialSpec());
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

  it('near-miss: 4 qualifying rows but union spans 6 cols → coverCols.size !== 4 → no Jellyfish', () => {
    // Rows 0,2,5,7 each qualify (size=2) but their union is {1,2,3,4,5,6} — size=6 > 4.
    // Row-variant guard coverCols.size===4 fails for the only possible quad.
    // Only 2 cols (1 and 5) appear in 2 rows each → column-variant cannot form a qualifying quad.
    const bs = new KillerBoardState(makeTrivialSpec());
    setDigitCells(bs, 8, [
      [0, 1], [0, 2],
      [2, 3], [2, 4],
      [5, 5], [5, 1],
      [7, 5], [7, 6],
    ]);
    expect(new Jellyfish().apply(globalCtx(bs)).eliminations.filter(e => e.digit === 8)).toHaveLength(0);
  });

  it('asHints: returns a hint with correct shape when jellyfish pattern exists', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    setDigitCells(bs, 7, [
      [0, 1], [0, 3],
      [2, 1], [2, 6],
      [5, 3], [5, 8],
      [7, 6], [7, 8],
      [1, 1], [4, 6],
    ]);
    const ctx = globalCtx(bs);
    const rule = new Jellyfish();
    const elims = rule.apply(ctx).eliminations.filter(e => e.digit === 7);
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.ruleName).toBe('Jellyfish');
    expect(hints[0]!.explanation).toContain('7');
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
  });
});
