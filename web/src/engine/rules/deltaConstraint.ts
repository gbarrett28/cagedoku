/**
 * DeltaConstraint — R6: narrow candidates using linear difference constraints.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.delta_constraint` module.
 *
 * When cells p and q satisfy p − q = delta (derived from overlapping cage-sum
 * equations by the linear system), restricts both cells' candidates to valid
 * pairs consistent with the constraint.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel } from './_labels.js';

export class DeltaConstraint {
  readonly name = 'DeltaConstraint';
  readonly description =
    'When two cells differ by a known constant (derived from overlapping row/column sums), restricts both cells\' candidates to valid pairs.';
  readonly priority = 5;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE]);

  apply(ctx: RuleContext): RuleResult {
    if (!ctx.unit) return emptyResult();
    const board = ctx.board;
    const elims: Elimination[] = [];
    const seen = new Set<string>();

    for (const [r, c] of ctx.unit.cells as Cell[]) {
      for (const [p, q, delta] of board.linearSystem.pairsForCell([r, c] as Cell)) {
        const key = `${p[0]},${p[1]}-${q[0]},${q[1]}-${delta}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const validP = new Set([...board.cands(q[0], q[1])].map(m => m + delta).filter(d => d >= 1 && d <= 9));
        for (const d of board.cands(p[0], p[1])) {
          if (!validP.has(d)) elims.push({ cell: p, digit: d });
        }
        const validQ = new Set([...board.cands(p[0], p[1])].map(m => m - delta).filter(d => d >= 1 && d <= 9));
        for (const d of board.cands(q[0], q[1])) {
          if (!validQ.has(d)) elims.push({ cell: q, digit: d });
        }
      }
    }
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
    if (!eliminations.length || !ctx.unit) return [];
    const board = ctx.board;
    const hints: HintResult[] = [];
    const seen = new Set<string>();

    for (const [r, c] of ctx.unit.cells as Cell[]) {
      for (const [p, q, delta] of board.linearSystem.pairsForCell([r, c] as Cell)) {
        const key = `${p[0]},${p[1]}-${q[0]},${q[1]}-${delta}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const pairElims: Elimination[] = [];
        const validP = new Set([...board.cands(q[0], q[1])].map(m => m + delta).filter(d => d >= 1 && d <= 9));
        for (const d of board.cands(p[0], p[1])) { if (!validP.has(d)) pairElims.push({ cell: p, digit: d }); }
        const validQ = new Set([...board.cands(p[0], p[1])].map(m => m - delta).filter(d => d >= 1 && d <= 9));
        for (const d of board.cands(q[0], q[1])) { if (!validQ.has(d)) pairElims.push({ cell: q, digit: d }); }
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
