/**
 * Jellyfish — R14: 4-row or 4-column basic fish.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.jellyfish`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { combinations, dedupElims } from './_helpers.js';

export class Jellyfish {
  readonly name = 'Jellyfish';
  readonly description = 'Generalisation of X-Wing across four rows and four columns.';
  readonly priority = 15;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    const board = ctx.board;
    const elims: Elimination[] = [];

    for (let d = 1; d <= 9; d++) {
      // Row variant: rows where d appears in 2..4 columns
      const rowCols: [number, Set<number>][] = [];
      for (let r = 0; r < 9; r++) {
        const cols = new Set<number>();
        for (let c = 0; c < 9; c++) if (board.candidates[r][c].has(d)) cols.add(c);
        if (cols.size >= 2 && cols.size <= 4) rowCols.push([r, cols]);
      }
      for (const quad of combinations(rowCols, 4)) {
        const baseRows = new Set(quad.map(([r]) => r));
        const coverCols = new Set(quad.flatMap(([, cs]) => [...cs]));
        if (coverCols.size !== 4) continue;
        for (const col of coverCols) {
          for (let r = 0; r < 9; r++) {
            if (!baseRows.has(r) && board.candidates[r][col].has(d))
              elims.push({ cell: [r, col] as unknown as Cell, digit: d });
          }
        }
      }

      // Column variant: cols where d appears in 2..4 rows
      const colRows: [number, Set<number>][] = [];
      for (let c = 0; c < 9; c++) {
        const rows = new Set<number>();
        for (let r = 0; r < 9; r++) if (board.candidates[r][c].has(d)) rows.add(r);
        if (rows.size >= 2 && rows.size <= 4) colRows.push([c, rows]);
      }
      for (const quad of combinations(colRows, 4)) {
        const baseCols = new Set(quad.map(([c]) => c));
        const coverRows = new Set(quad.flatMap(([, rs]) => [...rs]));
        if (coverRows.size !== 4) continue;
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
