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

  it('near-miss: wings see each other — anti-redundancy guard fires, no elimination', () => {
    // The `sees(A,B)` guard is an anti-redundancy guard, not a soundness guard.
    // When A and B see each other they form a naked pair on {p,q}, and the same
    // eliminations would be produced by that rule. The proof is still valid, but
    // W-Wing skips these cases to avoid duplicate work.
    //
    // Strong link X=(0,0), Y=(4,0) in col 0.
    // A=(0,1)={5,7} sees X via row 0. B=(4,1)={5,7} sees Y via row 4.
    // A and B see each other via col 1 → `sees(A,B)` guard fires → no W-Wing.
    const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const engine = new SolverEngine(board, [], {});

    for (const r of [1,2,3,5,6,7,8]) engine.applyEliminations([{ cell: [r,0], digit: 5 }]);
    for (const d of [1,2,3,4,6,8,9]) engine.applyEliminations([{ cell: [0,1], digit: d }]);
    for (const d of [1,2,3,4,6,8,9]) engine.applyEliminations([{ cell: [4,1], digit: d }]);
    for (let c = 2; c < 9; c++) engine.applyEliminations([{ cell: [0,c], digit: 5 }]);
    for (let c = 2; c < 9; c++) engine.applyEliminations([{ cell: [4,c], digit: 5 }]);

    const colUnit = board.units.find(
      u => u.kind === UnitKind.COL && u.cells.some(([, c]) => c === 0)
    )!;
    expect(rule.apply(unitCtx(board, colUnit, 5)).eliminations).toHaveLength(0);
  });

  it('near-miss: both wings see the same end — complementary-connection soundness guard fires', () => {
    // Soundness guard: `(aSeesX && bSeesY) || (aSeesY && bSeesX)`.
    // If both wings connect to the same strong-link end, the proof breaks:
    //   Case p at Y: neither A nor B sees Y, so neither is forced off p,
    //   neither is forced to q, and the target could legitimately hold q.
    //
    // Strong link X=(0,0), Y=(6,0) in col 0.
    // A=(0,5)={5,7} sees X=(0,0) via row 0. Does NOT see Y=(6,0).
    // B=(2,2)={5,7} sees X=(0,0) via box 0. Does NOT see Y=(6,0).
    // A and B do NOT see each other (different row, col, box).
    // `sees(A,B)` guard passes; complementary-connection guard fails → no W-Wing.
    // T=(0,2) sees A via row 0 and B via box 0 — must NOT have 7 eliminated.
    const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const engine = new SolverEngine(board, [], {});

    // Strong link in col 0: keep 5 only at (0,0) and (6,0)
    for (const r of [1,2,3,4,5,7,8]) engine.applyEliminations([{ cell: [r,0], digit: 5 }]);
    // Wing A=(0,5)={5,7}
    for (const d of [1,2,3,4,6,8,9]) engine.applyEliminations([{ cell: [0,5], digit: d }]);
    // Wing B=(2,2)={5,7}
    for (const d of [1,2,3,4,6,8,9]) engine.applyEliminations([{ cell: [2,2], digit: d }]);
    // Remove 5 from rest of row 0 and box 0 to avoid spurious bivalue cells
    for (const c of [1,2,3,4,6,7,8]) engine.applyEliminations([{ cell: [0,c], digit: 5 }]);
    for (const [r,c] of [[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1]] as [number,number][])
      engine.applyEliminations([{ cell: [r,c], digit: 5 }]);

    const colUnit = board.units.find(
      u => u.kind === UnitKind.COL && u.cells.some(([, c]) => c === 0)
    )!;
    const result = rule.apply(unitCtx(board, colUnit, 5));

    // Without the complementary-connection guard, (0,2) would have 7 incorrectly eliminated.
    expect(result.eliminations.every(e => !(e.digit === 7))).toBe(true);
  });

  it('near-miss: wing A is a link endpoint — soundness guard must prevent self-sees', () => {
    // Bug case: X=(0,0) is bivalue {5,7} and appears in the bivalue list. When
    // used as wing A, aSeesX = sees(X,X) = true (a cell always sees itself via
    // row equality). The complementary-connection guard (aSeesX && bSeesY) passes
    // even though "A sees X" carries no information when A IS X.
    //
    // Proof failure: in "case p at X", A = X = p, so A ≠ q is false.
    // T ≠ q is therefore not guaranteed and the elimination is unsound.
    //
    // p=5, q=7. Col 0 strong link: X=(0,0) bivalue {5,7}, Y=(4,0).
    // B=(4,5) bivalue {5,7}, sees Y via row 4, does NOT see X.
    // Only valid W-Wing pairings involve X as a wing → no valid W-Wing exists.
    const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const engine = new SolverEngine(board, [], {});

    // Remove 5 from every cell except X=(0,0), Y=(4,0), and B=(4,5)
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (!((r === 0 && c === 0) || (r === 4 && c === 0) || (r === 4 && c === 5)))
          engine.applyEliminations([{ cell: [r, c], digit: 5 }]);

    // X=(0,0) bivalue {5,7}
    for (const d of [1,2,3,4,6,8,9]) engine.applyEliminations([{ cell: [0,0], digit: d }]);

    // B=(4,5) bivalue {5,7}
    for (const d of [1,2,3,4,6,8,9]) engine.applyEliminations([{ cell: [4,5], digit: d }]);

    const colUnit = board.units.find(
      u => u.kind === UnitKind.COL && u.cells.some(([, c]) => c === 0)
    )!;
    // Without the guard: W-Wing fires with A=X and eliminates 7 from cells
    // seeing both X and B (e.g. (0,5), (4,0)=Y).
    // With the guard: no eliminations — all pairings involve a link endpoint as wing.
    expect(rule.apply(unitCtx(board, colUnit, 5)).eliminations).toHaveLength(0);
  });

  it('near-miss: wing B is a link endpoint — soundness guard applies symmetrically', () => {
    // Mirror case: Y=(4,0) is bivalue {5,7} and used as wing B.
    // bSeesY = sees(Y,Y) = true; proof fails in "case p at Y" for same reason.
    //
    // p=5, q=7. Col 0 strong link: X=(0,0), Y=(4,0) bivalue {5,7}.
    // A=(0,5) bivalue {5,7}, sees X via row 0, does NOT see Y.
    // Only valid W-Wing pairings involve Y as a wing → no valid W-Wing exists.
    const board = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const engine = new SolverEngine(board, [], {});

    // Remove 5 from every cell except X=(0,0), Y=(4,0), and A=(0,5)
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (!((r === 0 && c === 0) || (r === 4 && c === 0) || (r === 0 && c === 5)))
          engine.applyEliminations([{ cell: [r, c], digit: 5 }]);

    // A=(0,5) bivalue {5,7}
    for (const d of [1,2,3,4,6,8,9]) engine.applyEliminations([{ cell: [0,5], digit: d }]);

    // Y=(4,0) bivalue {5,7}
    for (const d of [1,2,3,4,6,8,9]) engine.applyEliminations([{ cell: [4,0], digit: d }]);

    const colUnit = board.units.find(
      u => u.kind === UnitKind.COL && u.cells.some(([, c]) => c === 0)
    )!;
    expect(rule.apply(unitCtx(board, colUnit, 5)).eliminations).toHaveLength(0);
  });
});
