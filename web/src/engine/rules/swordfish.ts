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
  readonly killerOnly = false;
  readonly displayName = 'Swordfish';
  readonly description = `
Swordfish — generalisation of X-Wing to three base rows and three cover columns.

Setup: select 3 rows R1, R2, R3. In each row, d appears in 2 or 3 columns. The union of those columns spans exactly 3 columns Ca, Cb, Cc.

Proof: d must occupy exactly one cell per base row, and each such cell is in one of {Ca, Cb, Cc}. By pigeonhole across the three cover columns, each column holds at most one of these d-placements. Any non-base cell in Ca, Cb, or Cc therefore sees a placed d and cannot hold d.

Column variant is identical with rows and columns transposed.

Guards:
  cols.size >= 2 && cols.size <= 3   row qualifies only when d spans 2 or 3 columns
  coverCols.size === 3   the union of columns must be exactly 3 (not fewer, not more)
`.trim();
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
        for (let c = 0; c < 9; c++) if (board.cands(r, c).has(d)) cols.add(c);
        if (cols.size >= 2 && cols.size <= 3) rowCols.push([r, cols]);
      }
      for (const triple of combinations(rowCols, 3)) {
        const baseRows = new Set(triple.map(([r]) => r));
        const coverCols = new Set(triple.flatMap(([, cs]) => [...cs]));
        if (coverCols.size !== 3) continue;
        for (const col of coverCols) {
          for (let r = 0; r < 9; r++) {
            if (!baseRows.has(r) && board.cands(r, col).has(d))
              elims.push({ cell: [r, col] as Cell, digit: d });
          }
        }
      }

      // Column variant: cols where d appears in 2 or 3 rows
      const colRows: [number, Set<number>][] = [];
      for (let c = 0; c < 9; c++) {
        const rows = new Set<number>();
        for (let r = 0; r < 9; r++) if (board.cands(r, c).has(d)) rows.add(r);
        if (rows.size >= 2 && rows.size <= 3) colRows.push([c, rows]);
      }
      for (const triple of combinations(colRows, 3)) {
        const baseCols = new Set(triple.map(([c]) => c));
        const coverRows = new Set(triple.flatMap(([, rs]) => [...rs]));
        if (coverRows.size !== 3) continue;
        for (const row of coverRows) {
          for (let c = 0; c < 9; c++) {
            if (!baseCols.has(c) && board.cands(row, c).has(d))
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
      // Row variant
      const rowCols: [number, Set<number>][] = [];
      for (let r = 0; r < 9; r++) {
        const cols = new Set<number>();
        for (let c = 0; c < 9; c++) if (board.cands(r, c).has(d)) cols.add(c);
        if (cols.size >= 2 && cols.size <= 3) rowCols.push([r, cols]);
      }
      for (const triple of combinations(rowCols, 3)) {
        const baseRows = new Set(triple.map(([r]) => r));
        const coverCols = new Set(triple.flatMap(([, cs]) => [...cs]));
        if (coverCols.size !== 3) continue;
        const elims: Elimination[] = [];
        for (const col of coverCols)
          for (let r = 0; r < 9; r++)
            if (!baseRows.has(r) && board.cands(r, col).has(d))
              elims.push({ cell: [r, col] as Cell, digit: d });
        if (!elims.length) continue;
        const rowList = [...baseRows].sort((a, b) => a - b);
        const colList = [...coverCols].sort((a, b) => a - b);
        const pivots: Cell[] = rowList.flatMap(r => colList.map(c => [r, c] as Cell));
        hints.push({
          ruleName: this.name, displayName: 'Swordfish',
          explanation: `Swordfish: ${d} is confined to columns ${colList.map(c => c + 1).join(', ')} across rows ${rowList.map(r => r + 1).join(', ')}. Remove ${d} from all other cells in those columns.`,
          highlightCells: [...pivots, ...elims.map(e => e.cell)],
          eliminations: elims, placement: null, virtualCageSuggestion: null,
        });
      }

      // Column variant
      const colRows: [number, Set<number>][] = [];
      for (let c = 0; c < 9; c++) {
        const rows = new Set<number>();
        for (let r = 0; r < 9; r++) if (board.cands(r, c).has(d)) rows.add(r);
        if (rows.size >= 2 && rows.size <= 3) colRows.push([c, rows]);
      }
      for (const triple of combinations(colRows, 3)) {
        const baseCols = new Set(triple.map(([c]) => c));
        const coverRows = new Set(triple.flatMap(([, rs]) => [...rs]));
        if (coverRows.size !== 3) continue;
        const elims: Elimination[] = [];
        for (const row of coverRows)
          for (let c = 0; c < 9; c++)
            if (!baseCols.has(c) && board.cands(row, c).has(d))
              elims.push({ cell: [row, c] as Cell, digit: d });
        if (!elims.length) continue;
        const rowList = [...coverRows].sort((a, b) => a - b);
        const colList = [...baseCols].sort((a, b) => a - b);
        const pivots: Cell[] = rowList.flatMap(r => colList.map(c => [r, c] as Cell));
        hints.push({
          ruleName: this.name, displayName: 'Swordfish',
          explanation: `Swordfish: ${d} is confined to rows ${rowList.map(r => r + 1).join(', ')} across columns ${colList.map(c => c + 1).join(', ')}. Remove ${d} from all other cells in those rows.`,
          highlightCells: [...pivots, ...elims.map(e => e.cell)],
          eliminations: elims, placement: null, virtualCageSuggestion: null,
        });
      }
    }
    return hints;
  }
}
