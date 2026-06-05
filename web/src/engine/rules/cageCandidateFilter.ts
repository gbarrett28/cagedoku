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
  readonly killerOnly = true;
  readonly displayName = 'Cage Candidate Filter';
  readonly description = `\
Cage Candidate Filter — a digit absent from every remaining cage solution cannot appear in any cage cell.

Each cell in a cage must hold a digit that appears in at least one feasible cage solution. If digit d does not appear in any remaining solution for the cage, then no assignment can place d in the cage, so d is impossible in every cage cell.

Proof: Let S be the set of remaining cage solutions. For any cell C in the cage, C's digit must be consistent with some solution s ∈ S, so C's digit must appear in at least one s. Therefore candidates(C) ⊆ ⋃S. Any d ∉ ⋃S can be eliminated from all cage cells.

Guards:
  ctx.unit?.distinctDigits   non-distinct cages allow repeated digits; their solutions are handled differently
  solns.length > 0           empty solution set is a degenerate (already-failed) state`.trim();
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
