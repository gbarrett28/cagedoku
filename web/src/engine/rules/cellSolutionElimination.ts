/**
 * CellSolutionElimination — R1b: solved cell removes digit from row/col/box peers.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.cell_solution_elimination` module.
 *
 * Fires on CELL_SOLVED. Eliminates hintDigit from every non-cage unit peer of
 * ctx.cell. Cage peers are handled by R3/R4/R5 (CageIntersection, etc.).
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import {
  Cell,
  Elimination,
  emptyResult,
  RuleResult,
  Trigger,
  UnitKind,
} from '../types.js';

export class CellSolutionElimination {
  readonly name = 'CellSolutionElimination';
  readonly description =
    'When a cell is solved, removes that digit from all other cells in the same row, column, and box.';
  readonly priority = 0;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.CELL_SOLVED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    if (ctx.cell === null || ctx.hintDigit === null) return emptyResult();
    const [r, c] = ctx.cell;
    const d = ctx.hintDigit;
    const elims: Elimination[] = [];
    for (const uid of ctx.board.cellUnitIds(r, c)) {
      const unit = ctx.board.units[uid];
      if (unit.kind === UnitKind.CAGE) continue;
      for (const [pr, pc] of unit.cells as Cell[]) {
        if (!(pr === r && pc === c) && ctx.board.candidates[pr][pc].has(d))
          elims.push({ cell: [pr, pc] as unknown as Cell, digit: d });
      }
    }
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[] {
    if (!eliminations.length || ctx.cell === null || ctx.hintDigit === null) return [];
    const [r, c] = ctx.cell;
    const d = ctx.hintDigit;
    const peerLabels = [...eliminations]
      .sort((a, b) => a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1])
      .map(e => `r${e.cell[0] + 1}c${e.cell[1] + 1}`)
      .join(', ');
    return [{
      ruleName: this.name,
      displayName: 'Naked Single',
      explanation: `Cell r${r + 1}c${c + 1} is ${d}. Eliminating ${d} from peers: ${peerLabels}.`,
      highlightCells: [[r, c] as unknown as Cell, ...eliminations.map(e => e.cell)],
      eliminations: [...eliminations],
      placement: null,
      virtualCageSuggestion: null,
    }];
  }
}
