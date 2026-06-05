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
  readonly killerOnly = false;
  readonly displayName = 'Jellyfish';
  readonly description = `
Jellyfish — generalisation of X-Wing to four base rows and four cover columns.

Setup: select 4 rows R1–R4. In each row, d appears in 2–4 columns. The union of those columns spans exactly 4 columns Ca–Cd.

Proof: identical to Swordfish reasoning with N=4. Each cover column receives at most one d-placement from the four base rows. Any non-base cell in the four cover columns sees a placed d and cannot hold d.

Column variant is identical with rows and columns transposed.

Guards:
  cols.size >= 2 && cols.size <= 4   row qualifies only when d spans 2–4 columns
  coverCols.size === 4   the union of columns must be exactly 4
`.trim();
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
        for (let c = 0; c < 9; c++) if (board.cands(r, c).has(d)) cols.add(c);
        if (cols.size >= 2 && cols.size <= 4) rowCols.push([r, cols]);
      }
      for (const quad of combinations(rowCols, 4)) {
        const baseRows = new Set(quad.map(([r]) => r));
        const coverCols = new Set(quad.flatMap(([, cs]) => [...cs]));
        if (coverCols.size !== 4) continue;
        for (const col of coverCols) {
          for (let r = 0; r < 9; r++) {
            if (!baseRows.has(r) && board.cands(r, col).has(d))
              elims.push({ cell: [r, col] as Cell, digit: d });
          }
        }
      }

      // Column variant: cols where d appears in 2..4 rows
      const colRows: [number, Set<number>][] = [];
      for (let c = 0; c < 9; c++) {
        const rows = new Set<number>();
        for (let r = 0; r < 9; r++) if (board.cands(r, c).has(d)) rows.add(r);
        if (rows.size >= 2 && rows.size <= 4) colRows.push([c, rows]);
      }
      for (const quad of combinations(colRows, 4)) {
        const baseCols = new Set(quad.map(([c]) => c));
        const coverRows = new Set(quad.flatMap(([, rs]) => [...rs]));
        if (coverRows.size !== 4) continue;
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
        if (cols.size >= 2 && cols.size <= 4) rowCols.push([r, cols]);
      }
      for (const quad of combinations(rowCols, 4)) {
        const baseRows = new Set(quad.map(([r]) => r));
        const coverCols = new Set(quad.flatMap(([, cs]) => [...cs]));
        if (coverCols.size !== 4) continue;
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
          ruleName: this.name, displayName: 'Jellyfish',
          explanation: `Jellyfish: ${d} is confined to columns ${colList.map(c => c + 1).join(', ')} across rows ${rowList.map(r => r + 1).join(', ')}. Remove ${d} from all other cells in those columns.`,
          highlightCells: [...pivots, ...elims.map(e => e.cell)],
          eliminations: elims, placement: null, virtualCageSuggestion: null,
        });
      }

      // Column variant
      const colRows: [number, Set<number>][] = [];
      for (let c = 0; c < 9; c++) {
        const rows = new Set<number>();
        for (let r = 0; r < 9; r++) if (board.cands(r, c).has(d)) rows.add(r);
        if (rows.size >= 2 && rows.size <= 4) colRows.push([c, rows]);
      }
      for (const quad of combinations(colRows, 4)) {
        const baseCols = new Set(quad.map(([c]) => c));
        const coverRows = new Set(quad.flatMap(([, rs]) => [...rs]));
        if (coverRows.size !== 4) continue;
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
          ruleName: this.name, displayName: 'Jellyfish',
          explanation: `Jellyfish: ${d} is confined to rows ${rowList.map(r => r + 1).join(', ')} across columns ${colList.map(c => c + 1).join(', ')}. Remove ${d} from all other cells in those rows.`,
          highlightCells: [...pivots, ...elims.map(e => e.cell)],
          eliminations: elims, placement: null, virtualCageSuggestion: null,
        });
      }
    }
    return hints;
  }
}
