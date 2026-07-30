/**
 * SumPairConstraint — R7b: narrow candidates using linear sum constraints.
 *
 * When cells a and b satisfy a + b = total (a sum pair from complementary RREF
 * rows), any candidate d for a is invalid if (total − d) is not in b's
 * candidate set, and vice versa.
 *
 * Sum pairs do not enforce digit distinctness — the cells are typically
 * non-burb so repeated digits are allowed. removeCandidate emits
 * COUNT_DECREASED for a cell's units before CELL_DETERMINED, so by the time
 * CELL_DETERMINED fires the COUNT_DECREASED-triggered pass for the same cell
 * has already narrowed the partner cell; the CELL_DETERMINED-triggered pass
 * is redundant and skipped.
 */

import type { HintResult } from '../hint.js';
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel } from './_labels.js';

export class SumPairConstraint extends KillerOnlyRule {
  readonly name = 'SumPairConstraint';
  readonly displayName = 'Sum Pair Constraint';
  readonly description = `
Sum Pair Constraint — candidate restriction from a + b = T.

Setup: cells a and b satisfy a + b = T for a constant T derived from complementary RREF rows. Digit distinctness is NOT required (cells may be non-peers).

Proof: if a = x then b must equal T − x. Any candidate x for a where (T − x) is not a current candidate of b, or T − x ∉ [1,9], is infeasible. Symmetrically for b.

Guards:
  ctx.hint !== CELL_DETERMINED   redundant with the COUNT_DECREASED pass already triggered for the cell's units when it was determined
  ctx.unit !== null   rule requires a unit context for cell iteration
  ctx.board.linearSystem.sumPairsForCell   only system-reported pairs are processed
  d >= 1 && d <= 9   computed partner value must be in digit range
`.trim();
  readonly priority = 5;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED, Trigger.CELL_DETERMINED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE]);

  applyKiller(ctx: KillerRuleContext): RuleResult {
    // Redundant with the COUNT_DECREASED pass triggered for the cell's units
    // when it was determined — skip here.
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

  asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[] {
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
