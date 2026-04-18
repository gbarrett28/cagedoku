/**
 * Tests for SimpleColouring.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { SimpleColouring } from './simpleColouring.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

function globalCtx(bs: BoardState): RuleContext {
  return { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
}

describe('SimpleColouring', () => {
  it('trap: eliminates digit from uncoloured cell that sees both colours', () => {
    const bs = new BoardState(makeTrivialSpec());
    const d = 3;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r][c].delete(d);

    // Chain: (0,0) -[col0]- (5,0) -[row5]- (5,3) -[col3]- (0,3)
    // BFS colours: (0,0)=0, (5,0)=1, (5,3)=0, (0,3)=1
    bs.candidates[0][0].add(d); // colour 0
    bs.candidates[5][0].add(d); // colour 1
    bs.candidates[5][3].add(d); // colour 0
    bs.candidates[0][3].add(d); // colour 1

    // Uncoloured trap target (0,6): sees (0,0)=colour 0 via row 0,
    //   and (0,3)=colour 1 via row 0 → TRAP
    bs.candidates[0][6].add(d);

    const elims = new SimpleColouring().apply(globalCtx(bs)).eliminations.filter(e => e.digit === d);
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 6)).toBe(true);
    // Chain cells are not trap targets
    expect(elims.every(e => !([0, 5].includes(e.cell[0]) && [0, 3].includes(e.cell[1])))).toBe(true);
  });

  it('wrap: eliminates digit from a colour group when two same-colour cells see each other', () => {
    const bs = new BoardState(makeTrivialSpec());
    const d = 5;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) bs.candidates[r][c].delete(d);

    // Chain: (0,0) -[row0]- (0,1) -[col1]- (1,1)
    // BFS: (0,0)=0, (0,1)=1, (1,1)=0
    // Wrap: (0,0) and (1,1) both colour 0 and share box 0 → eliminate colour 0
    bs.candidates[0][0].add(d);
    bs.candidates[0][1].add(d);
    bs.candidates[1][1].add(d);

    const elims = new SimpleColouring().apply(globalCtx(bs)).eliminations.filter(e => e.digit === d);
    // Both colour-0 cells eliminated
    expect(elims.some(e => e.cell[0] === 0 && e.cell[1] === 0)).toBe(true);
    expect(elims.some(e => e.cell[0] === 1 && e.cell[1] === 1)).toBe(true);
    // Colour-1 cell (0,1) not eliminated
    expect(elims.every(e => !(e.cell[0] === 0 && e.cell[1] === 1))).toBe(true);
  });
});
