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
  readonly description =
    'When a digit appears in only two cells in each of two rows, and those cells ' +
    'share the same two columns, the digit can be removed from all other cells in those columns.';
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

  asHints(_ctx: RuleContext, _eliminations: readonly Elimination[]): HintResult[] {
    return [];
  }
}
