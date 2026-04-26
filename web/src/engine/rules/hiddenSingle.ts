/**
 * HiddenSingle — R2: digit with exactly one possible cell in a unit → place it there.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.hidden_single` module.
 *
 * For ROW/COL/BOX: count=1 forces the sole remaining cell to hold d.
 * For CAGE: count=1 is necessary but not sufficient — d must appear in EVERY
 * feasible cage solution. If any solution omits d, d is not required.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { unitLabel } from './_labels.js';

export class HiddenSingle {
  readonly name = 'HiddenSingle';
  readonly description = 'When a digit can go in only one cell in a row, column, box, or cage, it must go there.';
  readonly priority = 1;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_HIT_ONE]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE]);

  apply(ctx: RuleContext): RuleResult {
    if (!ctx.unit || ctx.hintDigit === null) return emptyResult();
    const d = ctx.hintDigit;

    if (ctx.unit.kind === UnitKind.CAGE) {
      if (!ctx.unit.distinctDigits) return emptyResult();
      const cageIdx = ctx.unit.unitId - 27;
      const solns = ctx.board.cageSolns[cageIdx]!;
      if (!solns.length || !solns.every(s => s.includes(d))) return emptyResult();
    }

    const sole = (ctx.unit.cells as Cell[]).find(([r, c]) => ctx.board.cands(r, c).has(d));
    if (!sole) return emptyResult();
    const [r, c] = sole;
    const elims: Elimination[] = [...ctx.board.cands(r, c)]
      .filter(other => other !== d)
      .map(other => ({ cell: [r, c] as Cell, digit: other }));
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
    if (!eliminations.length || !ctx.unit || ctx.hintDigit === null) return [];
    const d = ctx.hintDigit;
    const sole = eliminations[0]!.cell;
    const [r, c] = sole;
    const explanation = ctx.unit.kind === UnitKind.CAGE
      ? `${d} is the only candidate for r${r+1}c${c+1} in this cage, and ${d} is essential to every remaining cage solution. Place ${d} there by eliminating all other candidates.`
      : `${d} can only go in r${r+1}c${c+1} within ${unitLabel(ctx.unit)}. Eliminate all other candidates from that cell to place ${d}.`;
    return [{
      ruleName: this.name,
      displayName: 'Hidden Single',
      explanation,
      highlightCells: [sole],
      eliminations,
      placement: null,
      virtualCageSuggestion: null,
    }];
  }
}
