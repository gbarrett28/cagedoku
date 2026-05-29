import { describe, it, expect } from 'vitest';
import { WWing } from './wWing.js';
import { BoardState } from '../boardState.js';
import { SolverEngine } from '../solverEngine.js';
import { makeTrivialSpec } from '../fixtures.js';
import { Trigger, UnitKind } from '../types.js';

/**
 * W-Wing test board.
 *
 * p=5, q=7. Strong link on 5 in col 0: only (0,0) and (4,0) can have 5.
 *   X=(0,0), Y=(4,0).
 *
 * Bivalue cell A={5,7} at (0,5) — sees X=(0,0) via row 0.
 * Bivalue cell B={5,7} at (4,7) — sees Y=(4,0) via row 4.
 * A and B do NOT see each other: different row (0 vs 4), col (5 vs 7), box (1 vs 5). ✓
 *
 * Cells seeing both A=(0,5) and B=(4,7):
 *   - col 5 (sees A) ∩ row 4 (sees B): (4,5)
 *   - row 0 (sees A) ∩ col 7 (sees B): (0,7)
 *   - box 1 (rows 0-2, cols 3-5, sees A) ∩ col 7: no overlap
 *   - box 1 ∩ row 4: no overlap
 *   - box 5 (rows 3-5, cols 6-8, sees B) ∩ row 0: no overlap
 *   - box 5 ∩ col 5: no overlap
 * → digit 7 eliminated from (4,5) and (0,7).
 */
function makeWWingBoard(): { board: BoardState; unit: (typeof board.units)[number] } {
  const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
  const engine = new SolverEngine(board, [], {});

  // Strong link on 5 in col 0: keep 5 only in (0,0) and (4,0)
  for (const r of [1,2,3,5,6,7,8]) engine.applyEliminations([{ cell: [r,0], digit: 5 }]);

  // Bivalue cell A=(0,5) = {5,7}: remove all other digits
  for (const d of [1,2,3,4,6,8,9]) engine.applyEliminations([{ cell: [0,5], digit: d }]);

  // Bivalue cell B=(4,7) = {5,7}: remove all other digits
  for (const d of [1,2,3,4,6,8,9]) engine.applyEliminations([{ cell: [4,7], digit: d }]);

  // Remove 5 from A and B's row peers to prevent other {5,7} bivalue cells from being created
  for (let c = 1; c < 9; c++) if (c !== 5) engine.applyEliminations([{ cell: [0,c], digit: 5 }]);
  for (let c = 1; c < 9; c++) if (c !== 7) engine.applyEliminations([{ cell: [4,c], digit: 5 }]);

  // Find the col 0 unit
  const colUnit = board.units.find(
    u => u.kind === UnitKind.COL && u.cells.some(([, c]) => c === 0)
  )!;
  return { board, unit: colUnit };
}

function unitCtx(board: BoardState, unit: (typeof board.units)[number], hintDigit: number) {
  return { board, unit, cell: null, hint: Trigger.COUNT_HIT_TWO, hintDigit } as const;
}

describe('WWing', () => {
  const rule = new WWing();

  it('eliminates q from cells seeing both bivalue cells', () => {
    const { board, unit } = makeWWingBoard();
    const ctx = unitCtx(board, unit, 5);
    const result = rule.apply(ctx);
    expect(result.eliminations.length).toBeGreaterThan(0);
    expect(result.eliminations.every(e => e.digit === 7)).toBe(true);
  });

  it('targets include cells in the intersection of both wing visibility sets', () => {
    const { board, unit } = makeWWingBoard();
    const ctx = unitCtx(board, unit, 5);
    const result = rule.apply(ctx);
    const targets = new Set(result.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`));
    // (4,5): sees A=(0,5) via col 5, sees B=(4,7) via row 4
    // (0,7): sees A=(0,5) via row 0, sees B=(4,7) via col 7
    expect(targets.has('4,5') || targets.has('0,7')).toBe(true);
  });

  it('asHints returns a hint with correct shape', () => {
    const { board, unit } = makeWWingBoard();
    const ctx = unitCtx(board, unit, 5);
    const elims = rule.apply(ctx).eliminations;
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]!.ruleName).toBe('WWing');
    expect(hints[0]!.displayName).toBe('W-Wing');
    expect(hints[0]!.explanation).toMatch(/W.Wing/i);
    expect(hints[0]!.eliminations.length).toBeGreaterThan(0);
    expect(hints[0]!.placement).toBeNull();
  });

  it('asHints: colourGroups contains the 4 chain cells, highlightCells has only elimination targets', () => {
    // Strong link X=(0,0)–Y=(4,0); wings A=(0,5), B=(4,7)
    // Chain A→X→Y→B: A=blue, X=green, Y=blue, B=green
    // Blue: [A=(0,5), Y=(4,0)]   Green: [X=(0,0), B=(4,7)]
    const { board, unit } = makeWWingBoard();
    const ctx = unitCtx(board, unit, 5);
    const elims = rule.apply(ctx).eliminations;
    const hints = rule.asHints(ctx, elims);
    expect(hints.length).toBeGreaterThan(0);
    const hint = hints[0]!;

    // colourGroups: 2 groups covering A, X, Y, B
    expect(hint.colourGroups?.length).toBe(2);
    const allGroupCells = hint.colourGroups!.flatMap(g => g.cells);
    for (const [r, c] of [[0, 5], [0, 0], [4, 0], [4, 7]] as [number, number][]) {
      expect(allGroupCells.some(([gr, gc]) => gr === r && gc === c)).toBe(true);
    }

    // highlightCells: only elimination targets, NOT the 4 chain cells
    for (const [r, c] of [[0, 5], [0, 0], [4, 0], [4, 7]] as [number, number][]) {
      expect(hint.highlightCells.some(([hr, hc]) => hr === r && hc === c)).toBe(false);
    }
    expect(hint.highlightCells.length).toBeGreaterThan(0);
  });

  it('returns empty when unit context is missing', () => {
    const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const ctx = { board, unit: null, cell: null, hint: Trigger.COUNT_HIT_TWO, hintDigit: 5 } as const;
    const result = rule.apply(ctx);
    expect(result.eliminations).toHaveLength(0);
  });

  it('near-miss: wings see each other — no elimination', () => {
    // W-Wing requires A and B to NOT see each other. If they do, the pattern collapses:
    // A seeing B means A and B share a unit, so when one has q the other cannot — this
    // is covered by a simpler naked-pair or pointing rule, not W-Wing. More importantly,
    // if A sees B and both are {p,q}, a common peer could be covered by that simpler rule
    // already, and the W-Wing proof requires A and B to be independent witnesses. The
    // implementation guards this with `if (sees(ar,ac,br,bc)) continue`.
    //
    // Strong link on 5 in col 0: X=(0,0), Y=(4,0).
    // A=(0,1)={5,7} sees X via row 0.
    // B=(4,1)={5,7} sees Y via row 4.
    // A and B see each other via col 1 — so the guard fires and no W-Wing is generated.
    // Any cell that would see both A and B (e.g. (2,1) via col 1) must NOT have 7 eliminated.
    const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const engine = new SolverEngine(board, [], {});

    // Strong link on 5 in col 0: keep only (0,0) and (4,0)
    for (const r of [1,2,3,5,6,7,8]) engine.applyEliminations([{ cell: [r,0], digit: 5 }]);
    // Bivalue A=(0,1) = {5,7}
    for (const d of [1,2,3,4,6,8,9]) engine.applyEliminations([{ cell: [0,1], digit: d }]);
    // Bivalue B=(4,1) = {5,7}
    for (const d of [1,2,3,4,6,8,9]) engine.applyEliminations([{ cell: [4,1], digit: d }]);
    // Remove 5 from row 0 and row 4 (except the strong-link ends and the wings)
    for (let c = 2; c < 9; c++) engine.applyEliminations([{ cell: [0,c], digit: 5 }]);
    for (let c = 2; c < 9; c++) engine.applyEliminations([{ cell: [4,c], digit: 5 }]);

    // Find col 0 unit for the strong link
    const colUnit = board.units.find(
      u => u.kind === UnitKind.COL && u.cells.some(([, c]) => c === 0)
    )!;
    const ctx = unitCtx(board, colUnit, 5);
    const result = rule.apply(ctx);

    // (2,1) is in col 1 — sees A=(0,1) and B=(4,1). If the guard were missing, 7 might
    // be incorrectly eliminated there. The guard must prevent any such elimination.
    expect(result.eliminations.every(e => !(e.digit === 7))).toBe(true);
  });
});
