/**
 * HiddenPair — R8: two digits locked to the same two cells, restrict those cells.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.hidden_pair`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { sameCellSet } from './_helpers.js';
import { cellLabel, unitLabel } from './_labels.js';

export class HiddenPair {
  readonly name = 'HiddenPair';
  readonly killerOnly = false;
  readonly displayName = 'Hidden Pair';
  readonly description = `\
Hidden Pair — two digits each confined to the same two cells restrict those cells to only those digits.

If digits d1 and d2 each appear in exactly the same two cells A and B within a unit, then A and B together must account for both d1 and d2 (the unit constraint requires each digit exactly once). No other digit can fit in A or B because adding a third digit there would leave d1 or d2 with nowhere to go.

Proof: d1 can only go in {A, B}; d2 can only go in {A, B}. The two cells must each hold one of {d1, d2}. Therefore:
  - A holds d1 or d2 — all other candidates of A are impossible.
  - B holds the remaining one — all other candidates of B are impossible.

Guards:
  count(d1, unit) === 2          d1 has exactly 2 candidate cells in the unit
  count(d2, unit) === 2          d2 also has exactly 2 candidate cells
  sameCellSet(d2Cells, pairCells)  both digits land in the same two cells`.trim();
  readonly priority = 7;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_HIT_TWO]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([
    UnitKind.ROW, UnitKind.COL, UnitKind.BOX,
  ]);

  apply(ctx: RuleContext): RuleResult {
    if (!ctx.unit || ctx.hintDigit === null) return emptyResult();
    const board = ctx.board;
    const uid = ctx.unit.unitId;
    const cells = ctx.unit.cells as Cell[];
    const d1 = ctx.hintDigit;

    const pairCells = cells.filter(([r, c]) => board.cands(r, c).has(d1));
    if (pairCells.length !== 2) return emptyResult();

    const elims: Elimination[] = [];
    for (let d2 = 1; d2 <= 9; d2++) {
      if (d2 === d1) continue;
      if (board.count(uid, d2) !== 2) continue;
      const d2Cells = cells.filter(([r, c]) => board.cands(r, c).has(d2));
      if (!sameCellSet(d2Cells, pairCells)) continue;
      // Hidden pair {d1, d2} found — restrict pair cells to only {d1, d2}
      for (const [r, c] of pairCells) {
        for (const d of board.cands(r, c)) {
          if (d !== d1 && d !== d2)
            elims.push({ cell: [r, c] as Cell, digit: d });
        }
      }
      break; // one hidden pair per invocation is sufficient
    }
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[] {
    if (!eliminations.length || !ctx.unit || ctx.hintDigit === null) return [];
    const board = ctx.board;
    const uid = ctx.unit.unitId;
    const cells = ctx.unit.cells as Cell[];
    const d1 = ctx.hintDigit;
    const pairCells = cells.filter(([r, c]) => board.cands(r, c).has(d1));
    if (pairCells.length !== 2) return [];
    let d2: number | null = null;
    for (let d = 1; d <= 9; d++) {
      if (d === d1 || board.count(uid, d) !== 2) continue;
      if (sameCellSet(cells.filter(([r, c]) => board.cands(r, c).has(d)), pairCells)) { d2 = d; break; }
    }
    if (d2 === null) return [];
    const [c1, c2] = pairCells as [Cell, Cell];
    const digits = [d1, d2].sort((a, b) => a - b);
    return [{
      ruleName: this.name, displayName: 'Hidden Pair',
      explanation: `Hidden Pair: only {${digits.join(',')}} can go in ${cellLabel(c1)} and ${cellLabel(c2)} within ${unitLabel(ctx.unit)}. Remove all other candidates from these two cells.`,
      highlightCells: [...pairCells, ...eliminations.map(e => e.cell)],
      secondaryHighlightCells: cells.filter(([pr, pc]) => !pairCells.some(([qr, qc]) => qr === pr && qc === pc)),
      eliminations: [...eliminations], placement: null, virtualCageSuggestion: null,
      patternDigits: digits,
    }];
  }
}
