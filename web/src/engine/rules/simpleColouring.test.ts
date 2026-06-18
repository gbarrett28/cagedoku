/**
 * Tests for SimpleColouring.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { SimpleColouring } from './simpleColouring.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

function globalCtx(bs: KillerBoardState): RuleContext {
  return { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
}

describe('SimpleColouring', () => {
  it('trap: eliminates digit from uncoloured cell that sees both colours', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const d = 3;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.cands(r, c).delete(d);

    // Chain: (0,0) -[col0]- (5,0) -[row5]- (5,3) -[col3]- (0,3)
    // BFS colours: (0,0)=0, (5,0)=1, (5,3)=0, (0,3)=1
    bs.cands(0, 0).add(d); // colour 0
    bs.cands(5, 0).add(d); // colour 1
    bs.cands(5, 3).add(d); // colour 0
    bs.cands(0, 3).add(d); // colour 1

    // Uncoloured trap target (0,6): sees (0,0)=colour 0 via row 0,
    //   and (0,3)=colour 1 via row 0 → TRAP
    bs.cands(0, 6).add(d);

    const elims = new SimpleColouring().apply(globalCtx(bs)).eliminations.filter(e => e.digit === d);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 6)).toBe(true);
    // Chain cells are not trap targets
    expect(elims.every(e => !([0, 5].includes(e.cell[0]) && [0, 3].includes(e.cell[1])))).toBe(true);
  });

  it('asHints trap: returns a hint with correct shape', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const d = 3;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.cands(r, c).delete(d);
    bs.cands(0, 0).add(d); bs.cands(5, 0).add(d);
    bs.cands(5, 3).add(d); bs.cands(0, 3).add(d);
    bs.cands(0, 6).add(d);
    const ctx = globalCtx(bs);
    const rule = new SimpleColouring();
    const elims = rule.apply(ctx).eliminations.filter(e => e.digit === d);
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.ruleName).toBe('SimpleColouring');
    expect(hints[0]!.explanation.length).toBeGreaterThan(0);
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
  });

  it('asHints wrap: returns a hint with correct shape', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const d = 5;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.cands(r, c).delete(d);
    bs.cands(0, 0).add(d); bs.cands(0, 1).add(d); bs.cands(1, 1).add(d);
    const ctx = globalCtx(bs);
    const rule = new SimpleColouring();
    const elims = rule.apply(ctx).eliminations.filter(e => e.digit === d);
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.ruleName).toBe('SimpleColouring');
    expect(hints[0]!.explanation.length).toBeGreaterThan(0);
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
  });

  it('asHints trap: chainCells tags the two chain colour groups with digit 3, highlightCells has only elimination targets', () => {
    // Chain: (0,0) -[col0]- (5,0) -[row5]- (5,3) -[col3]- (0,3)
    // BFS colours: (0,0)=0, (5,0)=1, (5,3)=0, (0,3)=1
    // Trap target: (0,6) sees (0,0)=colour 0 and (0,3)=colour 1 via row 0
    const bs = new KillerBoardState(makeTrivialSpec());
    const d = 3;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.cands(r, c).delete(d);
    bs.cands(0, 0).add(d); bs.cands(5, 0).add(d);
    bs.cands(5, 3).add(d); bs.cands(0, 3).add(d);
    bs.cands(0, 6).add(d);
    const ctx = globalCtx(bs);
    const rule = new SimpleColouring();
    const elims = rule.apply(ctx).eliminations.filter(e => e.digit === d);
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    const hint = hints[0]!;

    expect(hint.chainCells?.length).toBe(4);
    const ccFor = (r: number, c: number) => hint.chainCells!.find(cc => cc.cell[0] === r && cc.cell[1] === c);
    expect(ccFor(0, 0)).toEqual({ cell: [0, 0], digits: [3], colour: 'green' });
    expect(ccFor(5, 3)).toEqual({ cell: [5, 3], digits: [3], colour: 'green' });
    expect(ccFor(5, 0)).toEqual({ cell: [5, 0], digits: [3], colour: 'blue' });
    expect(ccFor(0, 3)).toEqual({ cell: [0, 3], digits: [3], colour: 'blue' });

    // highlightCells: only the elimination target (0,6), NOT the chain cells
    expect(hint.highlightCells.some(([r, c]) => r === 0 && c === 6)).toBe(true);
    for (const [r, c] of [[0, 0], [5, 0], [5, 3], [0, 3]] as [number, number][]) {
      expect(hint.highlightCells.some(([hr, hc]) => hr === r && hc === c)).toBe(false);
    }
  });

  it('asHints wrap: chainCells tags the two chain colour groups with digit 5, highlightCells has only the bad colour cells', () => {
    // Chain: (0,0) -[row0]- (0,1) -[col1]- (1,1)
    // BFS: (0,0)=0, (0,1)=1, (1,1)=0
    // Wrap: (0,0) and (1,1) both colour 0 and share box 0 → colour 0 is eliminated
    const bs = new KillerBoardState(makeTrivialSpec());
    const d = 5;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.cands(r, c).delete(d);
    bs.cands(0, 0).add(d); bs.cands(0, 1).add(d); bs.cands(1, 1).add(d);
    const ctx = globalCtx(bs);
    const rule = new SimpleColouring();
    const elims = rule.apply(ctx).eliminations.filter(e => e.digit === d);
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    const hint = hints[0]!;

    expect(hint.chainCells?.length).toBe(3);
    const ccFor = (r: number, c: number) => hint.chainCells!.find(cc => cc.cell[0] === r && cc.cell[1] === c);
    expect(ccFor(0, 0)).toEqual({ cell: [0, 0], digits: [5], colour: 'blue' });  // bad (colour 0)
    expect(ccFor(1, 1)).toEqual({ cell: [1, 1], digits: [5], colour: 'blue' });  // bad (colour 0)
    expect(ccFor(0, 1)).toEqual({ cell: [0, 1], digits: [5], colour: 'green' }); // good (colour 1)

    // The good colour cell (0,1) should NOT be in highlightCells
    expect(hint.highlightCells.some(([r, c]) => r === 0 && c === 1)).toBe(false);
    // The bad colour cells (0,0) and (1,1) SHOULD be in highlightCells (they are the elim targets)
    expect(hint.highlightCells.some(([r, c]) => r === 0 && c === 0)).toBe(true);
    expect(hint.highlightCells.some(([r, c]) => r === 1 && c === 1)).toBe(true);
  });

  it('asHints wrap: does not generate additional trap hint for same component', () => {
    // Chain: (0,0) -[row0]- (0,1) -[col1]- (1,1)
    // c0={(0,0),(1,1)}, c1={(0,1)}. Wrap: (0,0) and (1,1) share box 0 → wrap fires.
    // (2,2) is uncoloured, in box 0: sees c0 via box AND c1 via box → phantom trap target.
    // apply() skips the trap via `continue`. asHints() must also skip it.
    // Note: (2,2) is in box 0 but not in row 0 or col 1, so the conjugate pairs are preserved.
    const bs = new KillerBoardState(makeTrivialSpec());
    const d = 5;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.cands(r, c).delete(d);
    bs.cands(0, 0).add(d); // colour 0 (row-0 conjugate pair with (0,1))
    bs.cands(0, 1).add(d); // colour 1 (row-0 edge; col-1 conjugate pair with (1,1))
    bs.cands(1, 1).add(d); // colour 0 (col-1 edge; shares box 0 with (0,0) → wrap)
    bs.cands(2, 2).add(d); // uncoloured: in box 0 → sees c0=(0,0),(1,1) and c1=(0,1) via box 0
    const ctx = globalCtx(bs);
    const rule = new SimpleColouring();
    const elims = rule.apply(ctx).eliminations.filter(e => e.digit === d);
    // apply() returns only wrap eliminations: (0,0) and (1,1)
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 0)).toBe(true);
    expect(elims.some(e => e.cell[0] === 1 && e.cell[1] === 1)).toBe(true);
    // apply() does NOT return the trap elimination for (2,2)
    expect(elims.some(e => e.cell[0] === 2 && e.cell[1] === 2)).toBe(false);
    // asHints() must not generate a hint eliminating (2,2)
    const hints = rule.asHints(ctx, elims);
    expect(hints.every(h => !h.eliminations.some(e => e.cell[0] === 2 && e.cell[1] === 2))).toBe(true);
  });

  it('near-miss: same-colour cells in different units (no conflict) → no wrap', () => {
    // Chain: (0,0) -[row0]- (0,5) -[col5]- (8,5) -[row8]- (8,2)
    // BFS: (0,0)=0, (0,5)=1, (8,5)=0, (8,2)=1
    // Colour-0 cells are (0,0) and (8,5): different row, col, and box → hasConflict is false.
    // Colour-1 cells are (0,5) and (8,2): different row, col, and box → hasConflict is false.
    // No trap target either. Rule should return no eliminations.
    const bs = new KillerBoardState(makeTrivialSpec());
    const d = 6;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.cands(r, c).delete(d);
    bs.cands(0, 0).add(d); // colour 0
    bs.cands(0, 5).add(d); // colour 1
    bs.cands(8, 5).add(d); // colour 0
    bs.cands(8, 2).add(d); // colour 1
    // Verify no two same-colour cells share a unit:
    // (0,0) vs (8,5): different row/col/box ✓; (0,5) vs (8,2): different row/col/box ✓
    const elims = new SimpleColouring().apply(globalCtx(bs)).eliminations.filter(e => e.digit === d);
    expect(elims).toHaveLength(0);
  });

  it('near-miss: uncoloured cell sees only one colour → no trap', () => {
    // Chain: (0,0) -[row0]- (0,3) — only 2 nodes, colours 0 and 1.
    // Colour-0: (0,0). Colour-1: (0,3).
    // Candidate (3,0): sees (0,0) via col 0 (colour 0) but does NOT see (0,3) (different row, col, box).
    // seesC1 is false → trap guard fails → NOT eliminated.
    const bs = new KillerBoardState(makeTrivialSpec());
    const d = 9;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.cands(r, c).delete(d);
    bs.cands(0, 0).add(d); // colour 0
    bs.cands(0, 3).add(d); // colour 1
    bs.cands(3, 0).add(d); // sees colour 0 only (via col 0)
    const elims = new SimpleColouring().apply(globalCtx(bs)).eliminations.filter(e => e.digit === d);
    expect(elims.some(e => e.cell[0] === 3 && e.cell[1] === 0)).toBe(false);
  });

  it('wrap: eliminates digit from a colour group when two same-colour cells see each other', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const d = 5;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.cands(r, c).delete(d);

    // Chain: (0,0) -[row0]- (0,1) -[col1]- (1,1)
    // BFS: (0,0)=0, (0,1)=1, (1,1)=0
    // Wrap: (0,0) and (1,1) both colour 0 and share box 0 → eliminate colour 0
    bs.cands(0, 0).add(d);
    bs.cands(0, 1).add(d);
    bs.cands(1, 1).add(d);

    const elims = new SimpleColouring().apply(globalCtx(bs)).eliminations.filter(e => e.digit === d);
    // Both colour-0 cells eliminated
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 0)).toBe(true);
    expect(elims.some(e => e.cell[0] === 1 && e.cell[1] === 1)).toBe(true);
    // Colour-1 cell (0,1) not eliminated
    expect(elims.every(e => !(e.cell[0] === 0 && e.cell[1] === 1))).toBe(true);
  });
});
