/**
 * HiddenPair — R8: two digits locked to the same two cells, restrict those cells.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.hidden_pair`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { sameCellSet } from './_helpers.js';

export class HiddenPair {
  readonly name = 'HiddenPair';
  readonly description =
    'When two digits each appear in only the same two cells in a unit, ' +
    'those cells must contain those two digits and no others.';
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

  asHints(_ctx: RuleContext, _eliminations: readonly Elimination[]): HintResult[] {
    return [];
  }
}
