/**
 * Swordfish — R13: 3-row or 3-column basic fish.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.swordfish`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { combinations, dedupElims } from './_helpers.js';

export class Swordfish {
  readonly name = 'Swordfish';
  readonly description = 'Generalisation of X-Wing across three rows and three columns.';
  readonly priority = 14;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    const board = ctx.board;
    const elims: Elimination[] = [];

    for (let d = 1; d <= 9; d++) {
      // Row variant: rows where d appears in 2 or 3 columns
      const rowCols: [number, Set<number>][] = [];
      for (let r = 0; r < 9; r++) {
        const cols = new Set<number>();
        for (let c = 0; c < 9; c++) if (board.candidates[r][c].has(d)) cols.add(c);
        if (cols.size >= 2 && cols.size <= 3) rowCols.push([r, cols]);
      }
      for (const triple of combinations(rowCols, 3)) {
        const baseRows = new Set(triple.map(([r]) => r));
        const coverCols = new Set(triple.flatMap(([, cs]) => [...cs]));
        if (coverCols.size !== 3) continue;
        for (const col of coverCols) {
          for (let r = 0; r < 9; r++) {
            if (!baseRows.has(r) && board.candidates[r][col].has(d))
              elims.push({ cell: [r, col] as unknown as Cell, digit: d });
          }
        }
      }

      // Column variant: cols where d appears in 2 or 3 rows
      const colRows: [number, Set<number>][] = [];
      for (let c = 0; c < 9; c++) {
        const rows = new Set<number>();
        for (let r = 0; r < 9; r++) if (board.candidates[r][c].has(d)) rows.add(r);
        if (rows.size >= 2 && rows.size <= 3) colRows.push([c, rows]);
      }
      for (const triple of combinations(colRows, 3)) {
        const baseCols = new Set(triple.map(([c]) => c));
        const coverRows = new Set(triple.flatMap(([, rs]) => [...rs]));
        if (coverRows.size !== 3) continue;
        for (const row of coverRows) {
          for (let c = 0; c < 9; c++) {
            if (!baseCols.has(c) && board.candidates[row][c].has(d))
              elims.push({ cell: [row, c] as unknown as Cell, digit: d });
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
