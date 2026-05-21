/**
 * Skyscraper — asymmetric two-row (or two-column) elimination.
 *
 * Row-based: digit d appears in exactly 2 cells in row R1 — (R1, Ca) and
 * (R1, Cb) — and in exactly 2 cells in row R2 — (R2, Ca) and (R2, Cc).
 * The shared column Ca is the **base**; (R1, Cb) and (R2, Cc) are the
 * **roof**. Because d must go in one of the two base cells it must also go
 * in one of the two roof cells, so d can be eliminated from any cell that
 * sees both roof cells.
 *
 * Column-based is identical with rows and columns transposed.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { dedupElims, sees } from './_helpers.js';
import { cellLabel } from './_labels.js';

export class Skyscraper {
  readonly name = 'Skyscraper';
  readonly description =
    'When a digit appears in exactly two cells in each of two rows (or columns) ' +
    'and those rows share exactly one of those columns (or rows), the digit can ' +
    'be eliminated from any cell that sees both of the non-shared cells.';
  readonly priority = 21;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    const board = ctx.board;
    const elims: Elimination[] = [];

    for (let d = 1; d <= 9; d++) {
      // ── Row-based ──────────────────────────────────────────────────────
      const twoRows: [number, number, number][] = []; // [row, colA, colB]
      for (let r = 0; r < 9; r++) {
        const cols: number[] = [];
        for (let c = 0; c < 9; c++) if (board.cands(r, c).has(d)) cols.push(c);
        if (cols.length === 2) twoRows.push([r, cols[0]!, cols[1]!]);
      }
      for (let i = 0; i < twoRows.length; i++) {
        for (let j = i + 1; j < twoRows.length; j++) {
          const [r1, c1a, c1b] = twoRows[i]!;
          const [r2, c2a, c2b] = twoRows[j]!;
          let roofC1: number, roofC2: number;
          if      (c1a === c2a) { roofC1 = c1b; roofC2 = c2b; }
          else if (c1a === c2b) { roofC1 = c1b; roofC2 = c2a; }
          else if (c1b === c2a) { roofC1 = c1a; roofC2 = c2b; }
          else if (c1b === c2b) { roofC1 = c1a; roofC2 = c2a; }
          else continue; // no shared column
          for (let r = 0; r < 9; r++)
            for (let c = 0; c < 9; c++) {
              if ((r === r1 && c === roofC1) || (r === r2 && c === roofC2)) continue;
              if (board.cands(r, c).has(d) && sees(r, c, r1, roofC1) && sees(r, c, r2, roofC2))
                elims.push({ cell: [r, c] as Cell, digit: d });
            }
        }
      }

      // ── Column-based (rows and columns transposed) ────────────────────
      const twoCols: [number, number, number][] = []; // [col, rowA, rowB]
      for (let c = 0; c < 9; c++) {
        const rows: number[] = [];
        for (let r = 0; r < 9; r++) if (board.cands(r, c).has(d)) rows.push(r);
        if (rows.length === 2) twoCols.push([c, rows[0]!, rows[1]!]);
      }
      for (let i = 0; i < twoCols.length; i++) {
        for (let j = i + 1; j < twoCols.length; j++) {
          const [c1, r1a, r1b] = twoCols[i]!;
          const [c2, r2a, r2b] = twoCols[j]!;
          let roofR1: number, roofR2: number;
          if      (r1a === r2a) { roofR1 = r1b; roofR2 = r2b; }
          else if (r1a === r2b) { roofR1 = r1b; roofR2 = r2a; }
          else if (r1b === r2a) { roofR1 = r1a; roofR2 = r2b; }
          else if (r1b === r2b) { roofR1 = r1a; roofR2 = r2a; }
          else continue;
          for (let r = 0; r < 9; r++)
            for (let c = 0; c < 9; c++) {
              if ((r === roofR1 && c === c1) || (r === roofR2 && c === c2)) continue;
              if (board.cands(r, c).has(d) && sees(r, c, roofR1, c1) && sees(r, c, roofR2, c2))
                elims.push({ cell: [r, c] as Cell, digit: d });
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
      // ── Row-based ──
      const twoRows: [number, number, number][] = [];
      for (let r = 0; r < 9; r++) {
        const cols: number[] = [];
        for (let c = 0; c < 9; c++) if (board.cands(r, c).has(d)) cols.push(c);
        if (cols.length === 2) twoRows.push([r, cols[0]!, cols[1]!]);
      }
      for (let i = 0; i < twoRows.length; i++) {
        for (let j = i + 1; j < twoRows.length; j++) {
          const [r1, c1a, c1b] = twoRows[i]!;
          const [r2, c2a, c2b] = twoRows[j]!;
          let baseC: number, roofC1: number, roofC2: number;
          if      (c1a === c2a) { baseC = c1a; roofC1 = c1b; roofC2 = c2b; }
          else if (c1a === c2b) { baseC = c1a; roofC1 = c1b; roofC2 = c2a; }
          else if (c1b === c2a) { baseC = c1b; roofC1 = c1a; roofC2 = c2b; }
          else if (c1b === c2b) { baseC = c1b; roofC1 = c1a; roofC2 = c2a; }
          else continue;
          const elims: Elimination[] = [];
          for (let r = 0; r < 9; r++)
            for (let c = 0; c < 9; c++) {
              if ((r === r1 && c === roofC1) || (r === r2 && c === roofC2)) continue;
              if (board.cands(r, c).has(d) && sees(r, c, r1, roofC1) && sees(r, c, r2, roofC2))
                elims.push({ cell: [r, c] as Cell, digit: d });
            }
          if (!elims.length) continue;
          const key = `R|${d}|${r1},${roofC1}|${r2},${roofC2}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const roof1 = [r1, roofC1] as Cell;
          const roof2 = [r2, roofC2] as Cell;
          const base1 = [r1, baseC] as Cell;
          const base2 = [r2, baseC] as Cell;
          hints.push({
            ruleName: this.name, displayName: 'Skyscraper',
            explanation: `Skyscraper on ${d}: rows r${r1+1} and r${r2+1} share base column c${baseC+1}. Roof cells ${cellLabel(roof1)} and ${cellLabel(roof2)} — ${d} eliminated from cells seeing both.`,
            highlightCells: [base1, base2, roof1, roof2, ...elims.map(e => e.cell)],
            eliminations: elims, placement: null, virtualCageSuggestion: null,
          });
        }
      }

      // ── Column-based ──
      const twoCols: [number, number, number][] = [];
      for (let c = 0; c < 9; c++) {
        const rows: number[] = [];
        for (let r = 0; r < 9; r++) if (board.cands(r, c).has(d)) rows.push(r);
        if (rows.length === 2) twoCols.push([c, rows[0]!, rows[1]!]);
      }
      for (let i = 0; i < twoCols.length; i++) {
        for (let j = i + 1; j < twoCols.length; j++) {
          const [c1, r1a, r1b] = twoCols[i]!;
          const [c2, r2a, r2b] = twoCols[j]!;
          let baseR: number, roofR1: number, roofR2: number;
          if      (r1a === r2a) { baseR = r1a; roofR1 = r1b; roofR2 = r2b; }
          else if (r1a === r2b) { baseR = r1a; roofR1 = r1b; roofR2 = r2a; }
          else if (r1b === r2a) { baseR = r1b; roofR1 = r1a; roofR2 = r2b; }
          else if (r1b === r2b) { baseR = r1b; roofR1 = r1a; roofR2 = r2a; }
          else continue;
          const elims: Elimination[] = [];
          for (let r = 0; r < 9; r++)
            for (let c = 0; c < 9; c++) {
              if ((r === roofR1 && c === c1) || (r === roofR2 && c === c2)) continue;
              if (board.cands(r, c).has(d) && sees(r, c, roofR1, c1) && sees(r, c, roofR2, c2))
                elims.push({ cell: [r, c] as Cell, digit: d });
            }
          if (!elims.length) continue;
          const key = `C|${d}|${roofR1},${c1}|${roofR2},${c2}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const roof1 = [roofR1, c1] as Cell;
          const roof2 = [roofR2, c2] as Cell;
          const base1 = [baseR, c1] as Cell;
          const base2 = [baseR, c2] as Cell;
          hints.push({
            ruleName: this.name, displayName: 'Skyscraper',
            explanation: `Skyscraper on ${d}: cols c${c1+1} and c${c2+1} share base row r${baseR+1}. Roof cells ${cellLabel(roof1)} and ${cellLabel(roof2)} — ${d} eliminated from cells seeing both.`,
            highlightCells: [base1, base2, roof1, roof2, ...elims.map(e => e.cell)],
            eliminations: elims, placement: null, virtualCageSuggestion: null,
          });
        }
      }
    }
    return hints;
  }
}
