/**
 * CellSolutionElimination — R1b: solved cell removes digit from row/col/box peers
 * and from distinct-digit cage peers.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.cell_solution_elimination` module.
 *
 * Fires on CELL_SOLVED. Eliminates hintDigit from every unit peer of ctx.cell,
 * including cells in the same distinct-digit cage (which have the same exclusion
 * property as rows/cols/boxes). Non-distinct cage peers are skipped because those
 * cages allow repeated digits.
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
import { cellLabel } from './_labels.js';

export class CellSolutionElimination {
  readonly name = 'CellSolutionElimination';
  readonly displayName = 'Cell Solution Elimination';
  readonly description = `\
Cell Solution Elimination — a placed digit is removed from all peer cells in shared units.

When cell C is assigned digit d, every other cell in C's row, column, box, and distinct-digit cage cannot hold d (each unit must contain each digit at most once, and for distinct-digit cages no digit may repeat within the cage).

Proof: C = d. For any peer P ≠ C sharing a unit U with C: if d ∈ candidates(P), the unit constraint would require two occurrences of d in U — contradiction. Therefore d can be eliminated from every such P.

Non-distinct cage peers are excluded: those cages permit repeated digits, so the cage constraint does not apply.

Guards:
  ctx.cell !== null                engine sets this on CELL_SOLVED
  ctx.hintDigit !== null           the digit being placed
  unit.kind === UnitKind.CAGE → unit.distinctDigits   skip cages that allow repeated digits`.trim();
  readonly priority = 0;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.CELL_SOLVED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    if (ctx.cell === null || ctx.hintDigit === null) return emptyResult();
    const [r, c] = ctx.cell;
    const d = ctx.hintDigit;
    const elims: Elimination[] = [];
    for (const uid of ctx.board.cellUnitIds(r, c)) {
      const unit = ctx.board.units[uid]!;
      if (unit.kind === UnitKind.CAGE && !unit.distinctDigits) continue;
      for (const [pr, pc] of unit.cells as Cell[]) {
        if (!(pr === r && pc === c) && ctx.board.cands(pr, pc).has(d))
          elims.push({ cell: [pr, pc] as Cell, digit: d });
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
      .map(e => cellLabel(e.cell))
      .join(', ');
    return [{
      ruleName: this.name,
      displayName: 'Naked Single',
      explanation: `Cell ${cellLabel([r, c] as Cell)} is ${d}. Eliminating ${d} from peers: ${peerLabels}.`,
      highlightCells: [[r, c] as Cell, ...eliminations.map(e => e.cell)],
      eliminations: [...eliminations],
      placement: null,
      virtualCageSuggestion: null,
    }];
  }
}
