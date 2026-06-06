/**
 * XWing — R12: X-Wing pattern.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.x_wing`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { combinations, dedupElims } from './_helpers.js';

export class XWing {
  readonly name = 'XWing';
  readonly killerOnly = false;
  readonly displayName = 'X-Wing';
  readonly description = `
X-Wing — when digit d appears in exactly two cells in each of two rows and those cells share the same two columns, d can be removed from all other cells in those columns.

Setup: base rows R1, R2; cover columns Ca, Cb. In R1, d is a candidate only at (R1,Ca) and (R1,Cb); similarly for R2.

Proof (2 cases, exhaustive because exactly one cell per base row holds d):
  Case d in (R1,Ca): d cannot also be in (R2,Ca) (same column); so d goes in (R2,Cb). Any non-base cell in Ca or Cb sees a placed d and cannot hold d.
  Case d in (R1,Cb): symmetric; d goes in (R2,Ca). Same conclusion.
Either way, every non-base cell in columns Ca and Cb cannot hold d.

Column variant is identical with rows and columns transposed.

Guards:
  cols.size === 2   row qualifies only when d appears in exactly 2 columns
  [...cols1].every(c => cols2.has(c))   both rows must cover the same 2 columns
`.trim();
  readonly priority = 13;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    const board = ctx.board;
    const elims: Elimination[] = [];

    for (let d = 1; d <= 9; d++) {
      // Row variant: rows where d appears in exactly 2 columns
      const rowCols: [number, Set<number>][] = [];
      for (let r = 0; r < 9; r++) {
        const cols = new Set<number>();
        for (let c = 0; c < 9; c++) if (board.cands(r, c).has(d)) cols.add(c);
        if (cols.size === 2) rowCols.push([r, cols]);
      }
      for (const [p1, p2] of combinations(rowCols, 2)) {
        const [r1, cols1] = p1!; const [r2, cols2] = p2!;
        if (cols1.size !== cols2.size || ![...cols1].every(c => cols2.has(c))) continue;
        for (const col of cols1) {
          for (let r = 0; r < 9; r++) {
            if (r !== r1 && r !== r2 && board.cands(r, col).has(d))
              elims.push({ cell: [r, col] as Cell, digit: d });
          }
        }
      }

      // Column variant: cols where d appears in exactly 2 rows
      const colRows: [number, Set<number>][] = [];
      for (let c = 0; c < 9; c++) {
        const rows = new Set<number>();
        for (let r = 0; r < 9; r++) if (board.cands(r, c).has(d)) rows.add(r);
        if (rows.size === 2) colRows.push([c, rows]);
      }
      for (const [p1c, p2c] of combinations(colRows, 2)) {
        const [c1, rows1] = p1c!; const [c2, rows2] = p2c!;
        if (rows1.size !== rows2.size || ![...rows1].every(r => rows2.has(r))) continue;
        for (const row of rows1) {
          for (let c = 0; c < 9; c++) {
            if (c !== c1 && c !== c2 && board.cands(row, c).has(d))
              elims.push({ cell: [row, c] as Cell, digit: d });
          }
        }
      }
    }
    return { ...emptyResult(), eliminations: dedupElims(elims) };
  }

  asHints(ctx: RuleContext, _eliminations: readonly Elimination[]): HintResult[] {
    if (!_eliminations.length) return [];
    const board = ctx.board;
    const hints: HintResult[] = [];

    for (let d = 1; d <= 9; d++) {
      // Row variant: find pairs of rows where d is confined to the same 2 columns
      const rowCols: [number, Set<number>][] = [];
      for (let r = 0; r < 9; r++) {
        const cols = new Set<number>();
        for (let c = 0; c < 9; c++) if (board.cands(r, c).has(d)) cols.add(c);
        if (cols.size === 2) rowCols.push([r, cols]);
      }
      for (const [p1, p2] of combinations(rowCols, 2)) {
        const [r1, cols1] = p1!; const [r2, cols2] = p2!;
        if (![...cols1].every(c => cols2.has(c))) continue;
        const [ca, cb] = [...cols1].sort((a, b) => a - b) as [number, number];
        const elims: Elimination[] = [];
        for (const col of [ca, cb])
          for (let r = 0; r < 9; r++)
            if (r !== r1 && r !== r2 && board.cands(r, col).has(d))
              elims.push({ cell: [r, col] as Cell, digit: d });
        if (!elims.length) continue;
        const pivots: Cell[] = [[r1, ca], [r1, cb], [r2, ca], [r2, cb]];
        hints.push({
          ruleName: this.name, displayName: 'X-Wing',
          explanation: `X-Wing: ${d} is confined to columns ${ca + 1} and ${cb + 1} in rows ${r1 + 1} and ${r2 + 1}. Remove ${d} from all other cells in those columns.`,
          highlightCells: [...pivots],
          eliminations: elims, placement: null, virtualCageSuggestion: null,
        });
      }

      // Column variant: find pairs of cols where d is confined to the same 2 rows
      const colRows: [number, Set<number>][] = [];
      for (let c = 0; c < 9; c++) {
        const rows = new Set<number>();
        for (let r = 0; r < 9; r++) if (board.cands(r, c).has(d)) rows.add(r);
        if (rows.size === 2) colRows.push([c, rows]);
      }
      for (const [p1c, p2c] of combinations(colRows, 2)) {
        const [c1, rows1] = p1c!; const [c2, rows2] = p2c!;
        if (![...rows1].every(r => rows2.has(r))) continue;
        const [ra, rb] = [...rows1].sort((a, b) => a - b) as [number, number];
        const elims: Elimination[] = [];
        for (const row of [ra, rb])
          for (let c = 0; c < 9; c++)
            if (c !== c1 && c !== c2 && board.cands(row, c).has(d))
              elims.push({ cell: [row, c] as Cell, digit: d });
        if (!elims.length) continue;
        const pivots: Cell[] = [[ra, c1], [ra, c2], [rb, c1], [rb, c2]];
        hints.push({
          ruleName: this.name, displayName: 'X-Wing',
          explanation: `X-Wing: ${d} is confined to rows ${ra + 1} and ${rb + 1} in columns ${c1 + 1} and ${c2 + 1}. Remove ${d} from all other cells in those rows.`,
          highlightCells: [...pivots],
          eliminations: elims, placement: null, virtualCageSuggestion: null,
        });
      }
    }
    return hints;
  }
}
