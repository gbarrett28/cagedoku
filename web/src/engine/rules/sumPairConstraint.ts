/**
 * SumPairConstraint — R7b: narrow candidates using linear sum constraints.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.sum_pair_constraint` module.
 *
 * When cells a and b satisfy a + b = total (a sum pair from complementary RREF
 * rows), any candidate d for a is invalid if (total − d) is not in b's
 * candidate set, and vice versa.
 *
 * Sum pairs do not enforce digit distinctness — the cells are typically
 * non-burb so repeated digits are allowed. CELL_DETERMINED is handled by
 * LinearSystem.substituteCell; this rule handles COUNT_DECREASED filtering.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel } from './_labels.js';

export class SumPairConstraint {
  readonly name = 'SumPairConstraint';
  readonly description =
    'When two cells sum to a known constant, restricts both to valid complementary pairs.';
  readonly priority = 5;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED, Trigger.CELL_DETERMINED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE]);

  apply(ctx: RuleContext): RuleResult {
    // CELL_DETERMINED is handled by LinearSystem.substituteCell — skip here
    if (ctx.hint === Trigger.CELL_DETERMINED || !ctx.unit) return emptyResult();
    const board = ctx.board;
    const elims: Elimination[] = [];
    const seen = new Set<string>();

    for (const [r, c] of ctx.unit.cells as Cell[]) {
      for (const [a, b, total] of board.linearSystem.sumPairsForCell([r, c] as Cell)) {
        const key = `${a[0]},${a[1]}-${b[0]},${b[1]}-${total}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const validA = new Set([...board.cands(b[0], b[1])].map(m => total - m).filter(d => d >= 1 && d <= 9));
        for (const d of board.cands(a[0], a[1])) { if (!validA.has(d)) elims.push({ cell: a, digit: d }); }
        const validB = new Set([...board.cands(a[0], a[1])].map(m => total - m).filter(d => d >= 1 && d <= 9));
        for (const d of board.cands(b[0], b[1])) { if (!validB.has(d)) elims.push({ cell: b, digit: d }); }
      }
    }
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
    if (!eliminations.length || ctx.hint === Trigger.CELL_DETERMINED || !ctx.unit) return [];
    const board = ctx.board;
    const hints: HintResult[] = [];
    const seen = new Set<string>();

    for (const [r, c] of ctx.unit.cells as Cell[]) {
      for (const [a, b, total] of board.linearSystem.sumPairsForCell([r, c] as Cell)) {
        const key = `${a[0]},${a[1]}-${b[0]},${b[1]}-${total}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const pairElims: Elimination[] = [];
        const validA = new Set([...board.cands(b[0], b[1])].map(m => total - m).filter(d => d >= 1 && d <= 9));
        for (const d of board.cands(a[0], a[1])) { if (!validA.has(d)) pairElims.push({ cell: a, digit: d }); }
        const validB = new Set([...board.cands(a[0], a[1])].map(m => total - m).filter(d => d >= 1 && d <= 9));
        for (const d of board.cands(b[0], b[1])) { if (!validB.has(d)) pairElims.push({ cell: b, digit: d }); }
        if (!pairElims.length) continue;

        hints.push({
          ruleName: this.name,
          displayName: `Sum: ${cellLabel(a)} + ${cellLabel(b)} = ${total}`,
          explanation: `The cage-sum equations show ${cellLabel(a)} + ${cellLabel(b)} = ${total}. Each cell's candidates must be consistent with the other's — any digit d is ruled out if (${total} \u2212 d) is not a candidate in the partner cell.`,
          highlightCells: [a, b],
          eliminations: pairElims,
          placement: null,
          virtualCageSuggestion: null,
        });
      }
    }
    return hints;
  }
}
