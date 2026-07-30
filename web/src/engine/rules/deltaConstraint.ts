/**
 * DeltaConstraint — R6: narrow candidates using linear difference constraints.
 *
 * When cells p and q satisfy p − q = delta (derived from overlapping cage-sum
 * equations by the linear system), restricts both cells' candidates to valid
 * pairs consistent with the constraint.
 */

import type { HintResult } from '../hint.js';
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext, RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel } from './_labels.js';

export class DeltaConstraint extends KillerOnlyRule {
  readonly name = 'DeltaConstraint';
  readonly displayName = 'Delta Constraint';
  readonly description = `
Delta Constraint — candidate restriction from p − q = δ.

Setup: cells p and q satisfy p − q = δ for a constant δ derived from overlapping row/column/cage-sum equations by the linear system.

Proof: if p = x then q must equal x − δ. Any candidate x for p where (x − δ) is not a current candidate of q, or where x − δ ∉ [1,9], is infeasible for p. Symmetrically, any candidate y for q where (y + δ) is not a current candidate of p, or y + δ ∉ [1,9], is infeasible for q.

Guards:
  ctx.unit !== null   rule requires a unit context for cell iteration
  ctx.board.linearSystem.pairsForCell   only system-reported pairs are processed
  d >= 1 && d <= 9   computed partner value must be in digit range
`.trim();
  readonly priority = 5;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE]);

  private _elimsForPair(
    ctx: RuleContext,
    p: Cell, q: Cell, delta: number,
  ): Elimination[] {
    const board = ctx.board;
    const elims: Elimination[] = [];
    const validP = new Set([...board.cands(q[0], q[1])].map(m => m + delta).filter(d => d >= 1 && d <= 9));
    for (const d of board.cands(p[0], p[1])) {
      if (!validP.has(d)) elims.push({ cell: p, digit: d });
    }
    const validQ = new Set([...board.cands(p[0], p[1])].map(m => m - delta).filter(d => d >= 1 && d <= 9));
    for (const d of board.cands(q[0], q[1])) {
      if (!validQ.has(d)) elims.push({ cell: q, digit: d });
    }
    return elims;
  }

  applyKiller(ctx: KillerRuleContext): RuleResult {
    if (!ctx.unit) return emptyResult();
    const elims: Elimination[] = [];
    const seen = new Set<string>();

    for (const [r, c] of ctx.unit.cells as Cell[]) {
      for (const [p, q, delta] of ctx.board.linearSystem.pairsForCell([r, c] as Cell)) {
        const key = `${p[0]},${p[1]}-${q[0]},${q[1]}-${delta}`;
        if (seen.has(key)) continue;
        seen.add(key);
        elims.push(...this._elimsForPair(ctx, p, q, delta));
      }
    }
    return { ...emptyResult(), eliminations: elims };
  }

  asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[] {
    if (!eliminations.length || !ctx.unit) return [];
    const hints: HintResult[] = [];
    const seen = new Set<string>();

    for (const [r, c] of ctx.unit.cells as Cell[]) {
      for (const [p, q, delta] of ctx.board.linearSystem.pairsForCell([r, c] as Cell)) {
        const key = `${p[0]},${p[1]}-${q[0]},${q[1]}-${delta}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const pairElims = this._elimsForPair(ctx, p, q, delta);
        if (!pairElims.length) continue;

        const nameP = cellLabel(p), nameQ = cellLabel(q);
        const sign = delta >= 0 ? '+' : '-';
        hints.push({
          ruleName: this.name,
          displayName: `Delta: ${nameP} \u2212 ${nameQ} = ${delta}`,
          explanation: `The cage-sum equations show ${nameP} \u2212 ${nameQ} = ${delta}. ${nameP} must equal ${nameQ} ${sign} ${Math.abs(delta)}, which rules out some candidates.`,
          highlightCells: [p, q],
          eliminations: pairElims,
          placement: null,
          virtualCageSuggestion: null,
        });
      }
    }
    return hints;
  }
}
