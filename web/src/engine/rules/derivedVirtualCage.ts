/**
 * DerivedVirtualCage — surfaces cell-sets + totals derived by
 * LinearSystem.substituteLiveRows as virtual cages.
 *
 * Mirrors no Python module — this rule is new in the TS engine.
 *
 * pendingVirtualCages entries are linear combinations of existing row/col/box/cage
 * sum equations (produced by LinearSystem's live-row Gaussian-elimination
 * reduction), so any valid solution satisfies them — adding them as cages is sound.
 */

import type { HintResult } from '../hint.js';
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext } from '../rule.js';
import { cellLabel } from './_labels.js';
import { Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';

export class DerivedVirtualCage extends KillerOnlyRule {
  readonly name = 'DerivedVirtualCage';
  readonly displayName = 'Derived Virtual Cage';
  readonly description = `
Derived Virtual Cage — adds a cell-set + total derived from the linear system as a virtual cage.

LinearSystem.substituteLiveRows reduces the row/col/box/cage sum equations as cells become
determined. Each remaining single-coefficient row of the form "these cells sum to T" is a
linear combination of the original equations, so it holds for every valid solution —
adding it as a virtual cage cannot eliminate the correct digit from any cell.

Guards:
  ctx.board.linearSystem.pendingVirtualCages   only system-derived cell-sets are surfaced
`.trim();
  readonly priority = 1;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  applyKiller(ctx: KillerRuleContext): RuleResult {
    const pending = ctx.board.linearSystem.pendingVirtualCages;
    if (pending.length === 0) return emptyResult();
    return { ...emptyResult(), virtualCageAdditions: [pending[0]!] };
  }

  asHintsKiller(ctx: KillerRuleContext, _eliminations: readonly Elimination[]): HintResult[] {
    const pending = ctx.board.linearSystem.pendingVirtualCages;
    return pending.map(({ cells, total }) => {
      const cellLabels = cells.map(cell => cellLabel(cell)).join(' + ');
      return {
        ruleName: this.name,
        displayName: `Virtual cage: ${cells.length} cells = ${total}`,
        explanation: `The cage-sum equations imply ${cellLabels} = ${total}. Adding this as a virtual cage will help narrow candidates.`,
        highlightCells: cells,
        eliminations: [],
        placement: null,
        virtualCageSuggestion: [cells, total],
      };
    });
  }
}
