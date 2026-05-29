/**
 * 2-String Kite — one row string and one column string sharing a 3×3 box.
 *
 * Row R has digit d in exactly 2 cells: rowEnd (R, rEndCol) and rowKnot (R, rBoxCol).
 * Col C has digit d in exactly 2 cells: colEnd (cEndRow, C) and colKnot (cBoxRow, C).
 * rowKnot and colKnot are in the **same 3×3 box** but are different cells (the "knot").
 * rowEnd and colEnd must not see each other.
 *
 * Proof (valid in both cases):
 *   Case A — d at rowKnot: box weak link → colKnot ≠ d → col strong link → d = colEnd.
 *   Case B — d not at rowKnot: row strong link → d = rowEnd.
 * Either way, at least one of {rowEnd, colEnd} has d.
 * Any cell seeing both rowEnd and colEnd cannot hold d.
 *
 * This is distinct from Skyscraper (row+row or col+col). The previous implementation
 * used a shared-cell variant (rowKnot == colKnot), which is unsound because d at
 * that shared cell leaves neither endpoint holding d.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { dedupElims, sees } from './_helpers.js';
import { cellLabel } from './_labels.js';

export class TwoStringKite {
  readonly name = 'TwoStringKite';
  readonly description =
    'When a row and a column each have exactly two candidates for a digit, and one ' +
    'cell from each string shares a 3×3 box (forming the knot), the digit can be ' +
    'eliminated from any cell that sees both of the non-knot endpoints.';
  readonly priority = 22;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    const board = ctx.board;
    const elims: Elimination[] = [];

    for (let d = 1; d <= 9; d++) {
      for (let r = 0; r < 9; r++) {
        const rowCols: number[] = [];
        for (let c = 0; c < 9; c++) if (board.cands(r, c).has(d)) rowCols.push(c);
        if (rowCols.length !== 2) continue;
        const [rc1, rc2] = rowCols as [number, number];

        for (let col = 0; col < 9; col++) {
          const colRows: number[] = [];
          for (let rr = 0; rr < 9; rr++) if (board.cands(rr, col).has(d)) colRows.push(rr);
          if (colRows.length !== 2) continue;
          const [cr1, cr2] = colRows as [number, number];

          for (const [rBoxCol, rEndCol] of [[rc1, rc2], [rc2, rc1]] as [number, number][]) {
            for (const [cBoxRow, cEndRow] of [[cr1, cr2], [cr2, cr1]] as [number, number][]) {
              // rowKnot = (r, rBoxCol), colKnot = (cBoxRow, col) — must share a box, differ
              if (r === cBoxRow && rBoxCol === col) continue;
              const rKnotBox = Math.floor(r / 3) * 3 + Math.floor(rBoxCol / 3);
              const cKnotBox = Math.floor(cBoxRow / 3) * 3 + Math.floor(col / 3);
              if (rKnotBox !== cKnotBox) continue;

              // Endpoints must not see each other (else a simpler rule already covers this)
              if (sees(r, rEndCol, cEndRow, col)) continue;

              for (let tr = 0; tr < 9; tr++) {
                for (let tc = 0; tc < 9; tc++) {
                  if (tr === r && tc === rEndCol) continue;
                  if (tr === cEndRow && tc === col) continue;
                  if (!board.cands(tr, tc).has(d)) continue;
                  if (sees(tr, tc, r, rEndCol) && sees(tr, tc, cEndRow, col))
                    elims.push({ cell: [tr, tc] as Cell, digit: d });
                }
              }
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
        const [rc1, rc2] = rowCols as [number, number];

        for (let col = 0; col < 9; col++) {
          const colRows: number[] = [];
          for (let rr = 0; rr < 9; rr++) if (board.cands(rr, col).has(d)) colRows.push(rr);
          if (colRows.length !== 2) continue;
          const [cr1, cr2] = colRows as [number, number];

          for (const [rBoxCol, rEndCol] of [[rc1, rc2], [rc2, rc1]] as [number, number][]) {
            for (const [cBoxRow, cEndRow] of [[cr1, cr2], [cr2, cr1]] as [number, number][]) {
              if (r === cBoxRow && rBoxCol === col) continue;
              const rKnotBox = Math.floor(r / 3) * 3 + Math.floor(rBoxCol / 3);
              const cKnotBox = Math.floor(cBoxRow / 3) * 3 + Math.floor(col / 3);
              if (rKnotBox !== cKnotBox) continue;
              if (sees(r, rEndCol, cEndRow, col)) continue;

              const hintElims: Elimination[] = [];
              for (let tr = 0; tr < 9; tr++) {
                for (let tc = 0; tc < 9; tc++) {
                  if (tr === r && tc === rEndCol) continue;
                  if (tr === cEndRow && tc === col) continue;
                  if (!board.cands(tr, tc).has(d)) continue;
                  if (sees(tr, tc, r, rEndCol) && sees(tr, tc, cEndRow, col))
                    hintElims.push({ cell: [tr, tc] as Cell, digit: d });
                }
              }
              if (!hintElims.length) continue;

              const key = `${d}|${r},${rEndCol}|${cEndRow},${col}|${r},${rBoxCol}|${cBoxRow},${col}`;
              if (seen.has(key)) continue;
              seen.add(key);

              const rowEnd: Cell = [r, rEndCol];
              const colEnd: Cell = [cEndRow, col];
              const rowKnot: Cell = [r, rBoxCol];
              const colKnot: Cell = [cBoxRow, col];
              hints.push({
                ruleName: this.name,
                displayName: '2-String Kite',
                explanation: `2-String Kite on ${d}: row ${r + 1} (${cellLabel(rowEnd)}–${cellLabel(rowKnot)}) and col ${col + 1} (${cellLabel(colKnot)}–${cellLabel(colEnd)}) share a box via ${cellLabel(rowKnot)} and ${cellLabel(colKnot)}. Digit ${d} eliminated from cells seeing both ${cellLabel(rowEnd)} and ${cellLabel(colEnd)}.`,
                highlightCells: hintElims.map(e => e.cell),
                eliminations: hintElims,
                placement: null,
                virtualCageSuggestion: null,
                colourGroups: [
                  { cells: [rowKnot, colKnot], colour: 'blue' },
                  { cells: [rowEnd, colEnd], colour: 'green' },
                ],
              });
            }
          }
        }
      }
    }

    return hints;
  }
}
