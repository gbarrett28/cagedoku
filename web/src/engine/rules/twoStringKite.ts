/**
 * 2-String Kite — one row strong link and one column strong link sharing a corner.
 *
 * Row R has digit d in exactly 2 cells: corner (R, cornerC) and row-end (R, endC).
 * Col cornerC has digit d in exactly 2 cells: corner (R, cornerC) and col-end (colEndR, cornerC).
 * row-end and col-end must not see each other.
 *
 * Logic: if d is NOT in corner, the row strong link forces d = row-end AND the col
 * strong link forces d = col-end simultaneously. Any cell that sees both row-end and
 * col-end therefore cannot hold d in any valid solution.
 *
 * The Skyscraper rule handles row+row and col+col; this rule handles the mixed case.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { dedupElims, sees } from './_helpers.js';
import { cellLabel } from './_labels.js';

export class TwoStringKite {
  readonly name = 'TwoStringKite';
  readonly description =
    'When a digit appears in exactly two cells in a row and exactly two cells in a ' +
    'column that share one of those cells (the corner), the digit can be eliminated ' +
    'from any cell that sees both of the non-corner cells.';
  readonly priority = 22;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    const board = ctx.board;
    const elims: Elimination[] = [];

    for (let d = 1; d <= 9; d++) {
      // Row strong links: rows where d appears in exactly 2 cells
      for (let r = 0; r < 9; r++) {
        const rowCols: number[] = [];
        for (let c = 0; c < 9; c++) if (board.cands(r, c).has(d)) rowCols.push(c);
        if (rowCols.length !== 2) continue;

        for (const [cornerC, endC] of [[rowCols[0]!, rowCols[1]!], [rowCols[1]!, rowCols[0]!]] as [number,number][]) {
          // Col strong link through (r, cornerC)
          const colRows: number[] = [];
          for (let rr = 0; rr < 9; rr++) if (board.cands(rr, cornerC).has(d)) colRows.push(rr);
          if (colRows.length !== 2) continue;

          const colEndR = colRows.find(rr => rr !== r);
          if (colEndR === undefined) continue;

          // row-end and col-end must not see each other
          if (sees(r, endC, colEndR, cornerC)) continue;

          // Eliminate d from cells seeing BOTH (r, endC) and (colEndR, cornerC)
          for (let rr = 0; rr < 9; rr++) {
            for (let cc = 0; cc < 9; cc++) {
              if (rr === r && cc === cornerC) continue;
              if (rr === r && cc === endC) continue;
              if (rr === colEndR && cc === cornerC) continue;
              if (!board.cands(rr, cc).has(d)) continue;
              if (sees(rr, cc, r, endC) && sees(rr, cc, colEndR, cornerC))
                elims.push({ cell: [rr, cc] as Cell, digit: d });
            }
          }
        }
      }
    }

    return { ...emptyResult(), eliminations: dedupElims(elims) };
  }

  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[] {
    if (!eliminations.length) return [];
    const board = ctx.board;
    const hints: HintResult[] = [];
    const seen = new Set<string>();

    for (let d = 1; d <= 9; d++) {
      for (let r = 0; r < 9; r++) {
        const rowCols: number[] = [];
        for (let c = 0; c < 9; c++) if (board.cands(r, c).has(d)) rowCols.push(c);
        if (rowCols.length !== 2) continue;

        for (const [cornerC, endC] of [[rowCols[0]!, rowCols[1]!], [rowCols[1]!, rowCols[0]!]] as [number,number][]) {
          const colRows: number[] = [];
          for (let rr = 0; rr < 9; rr++) if (board.cands(rr, cornerC).has(d)) colRows.push(rr);
          if (colRows.length !== 2) continue;

          const colEndR = colRows.find(rr => rr !== r);
          if (colEndR === undefined) continue;
          if (sees(r, endC, colEndR, cornerC)) continue;

          const hintElims: Elimination[] = [];
          for (let rr = 0; rr < 9; rr++) {
            for (let cc = 0; cc < 9; cc++) {
              if (rr === r && cc === cornerC) continue;
              if (rr === r && cc === endC) continue;
              if (rr === colEndR && cc === cornerC) continue;
              if (!board.cands(rr, cc).has(d)) continue;
              if (sees(rr, cc, r, endC) && sees(rr, cc, colEndR, cornerC))
                hintElims.push({ cell: [rr, cc] as Cell, digit: d });
            }
          }
          if (!hintElims.length) continue;

          const key = `${d}|${r},${endC}|${colEndR},${cornerC}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const corner = [r, cornerC] as Cell;
          const rowEnd = [r, endC] as Cell;
          const colEnd = [colEndR, cornerC] as Cell;
          hints.push({
            ruleName: this.name,
            displayName: '2-String Kite',
            explanation: `2-String Kite on ${d}: row r${r + 1} (${cellLabel(corner)}–${cellLabel(rowEnd)}) and col c${cornerC + 1} (${cellLabel(corner)}–${cellLabel(colEnd)}) share corner ${cellLabel(corner)}. Digit ${d} eliminated from cells seeing both ${cellLabel(rowEnd)} and ${cellLabel(colEnd)}.`,
            highlightCells: [corner, rowEnd, colEnd, ...hintElims.map(e => e.cell)],
            eliminations: hintElims,
            placement: null,
            virtualCageSuggestion: null,
          });
        }
      }
    }

    return hints;
  }
}
