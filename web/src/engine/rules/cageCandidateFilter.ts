/**
 * CageCandidateFilter — R2: eliminate digits absent from all cage solutions.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.cage_candidate_filter` module.
 *
 * Fires on SOLUTION_PRUNED for cage units. Takes the union of all remaining
 * solutions; any candidate digit not in that union cannot be placed and is
 * eliminated.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { cellLabel } from './_labels.js';
import {
  Cell,
  Elimination,
  emptyResult,
  RuleResult,
  Trigger,
  UnitKind,
} from '../types.js';

export class CageCandidateFilter {
  readonly name = 'CageCandidateFilter';
  readonly description =
    'Removes cage solutions that are now impossible because a required digit has been eliminated.';
  readonly priority = 1;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.CAGE]);

  apply(ctx: RuleContext): RuleResult {
    if (!ctx.unit?.distinctDigits) return emptyResult();
    const board = ctx.board;
    const cageIdx = ctx.unit.unitId - 27;
    const solns = board.cageSolns[cageIdx]!;
    if (!solns.length) return emptyResult();
    const cagePossible = new Set(solns.flat());
    const elims: Elimination[] = [];
    for (const [r, c] of ctx.unit.cells as Cell[]) {
      for (const d of board.cands(r, c)) {
        if (!cagePossible.has(d))
          elims.push({ cell: [r, c] as Cell, digit: d });
      }
    }
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[] {
    if (!eliminations.length || !ctx.unit) return [];
    const board = ctx.board;
    const cageIdx = ctx.unit.unitId - 27;
    const solns = board.cageSolns[cageIdx]!;
    const soln4 = solns.slice(0, 4).map(s => '{' + [...s].sort((a, b) => a - b).join(',') + '}');
    const solnDisplay = soln4.join(', ') + (solns.length > 4 ? '...' : '');
    const elimParts = [...eliminations].sort().map(e => `${e.digit} from ${cellLabel(e.cell)}`);
    return [{
      ruleName: this.name,
      displayName: 'Cage candidate filter',
      explanation: `Cage solutions: ${solnDisplay}. Digits absent from all solutions eliminated: ${elimParts.join('; ')}.`,
      highlightCells: [...(ctx.unit.cells as Cell[]), ...eliminations.map(e => e.cell)],
      eliminations: [...eliminations],
      placement: null,
      virtualCageSuggestion: null,
    }];
  }
}
