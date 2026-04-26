/**
 * SolutionMapFilter — R4: per-cell feasibility filter for cage solutions.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.solution_map_filter` module.
 *
 * For each cage, backtracks to find which (cell, digit) pairs are reachable in
 * at least one valid assignment of a surviving solution. Infeasible solutions
 * are pruned directly from board.cageSolns. Unreachable (cell, digit) pairs
 * are returned as eliminations.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel } from './_labels.js';

/** Backtrack over sorted_cells, assigning digits from solution. Returns per-cell possible sets. */
function perCellPossible(
  sortedCells: Cell[],
  solution: number[],
  getCands: (r: number, c: number) => Set<number>,
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>(sortedCells.map(([r, c]) => [`${r},${c}`, new Set()]));
  function bt(idx: number, remaining: Set<number>): boolean {
    if (idx === sortedCells.length) return true;
    const [r, c] = sortedCells[idx]!;
    let found = false;
    for (const d of [...getCands(r, c)].filter(d => remaining.has(d))) {
      remaining.delete(d);
      if (bt(idx + 1, remaining)) { result.get(`${r},${c}`)!.add(d); found = true; }
      remaining.add(d);
    }
    return found;
  }
  bt(0, new Set(solution));
  return result;
}

export class SolutionMapFilter {
  readonly name = 'SolutionMapFilter';
  readonly description =
    'Removes cage solutions that are now impossible because one of their digits has been eliminated from the relevant cell.';
  readonly priority = 3;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.CAGE]);

  apply(ctx: RuleContext): RuleResult {
    if (!ctx.unit?.distinctDigits) return emptyResult();
    const board = ctx.board;
    const cageIdx = ctx.unit.unitId - 27;
    const solns = [...board.cageSolns[cageIdx]!];
    if (!solns.length) return emptyResult();

    const cageCells = ctx.unit.cells as Cell[];
    // Sort most-constrained first
    const allCandUnion = new Set(solns.flat());
    const sortedCells = [...cageCells].sort(([r1,c1],[r2,c2]) =>
      [...board.cands(r1, c1)].filter(d => allCandUnion.has(d)).length -
      [...board.cands(r2, c2)].filter(d => allCandUnion.has(d)).length
    );

    const perCellPoss = new Map<string, Set<number>>(cageCells.map(([r,c]) => [`${r},${c}`, new Set()]));
    const surviving: number[][] = [];

    for (const soln of solns) {
      const cellPoss = perCellPossible(sortedCells, soln, (r, c) => board.cands(r, c));
      if (cageCells.every(([r,c]) => cellPoss.get(`${r},${c}`)!.size > 0)) {
        for (const [key, digits] of cellPoss) { for (const d of digits) perCellPoss.get(key)!.add(d); }
        surviving.push(soln);
      }
    }

    // Prune infeasible solutions directly (side-effect, see Python docstring)
    if (surviving.length < solns.length) board.cageSolns[cageIdx]!.splice(0, Infinity, ...surviving);

    const elims: Elimination[] = [];
    for (const [r, c] of cageCells) {
      for (const d of board.cands(r, c)) {
        if (!perCellPoss.get(`${r},${c}`)!.has(d))
          elims.push({ cell: [r, c] as Cell, digit: d });
      }
    }
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
    if (!eliminations.length || !ctx.unit) return [];
    const board = ctx.board;
    const cageIdx = ctx.unit.unitId - 27;
    const solns = board.cageSolns[cageIdx]!;
    const soln4 = solns.slice(0, 4).map(s => '{' + [...s].sort((a,b)=>a-b).join(',') + '}');
    const solnDisplay = soln4.join(', ') + (solns.length > 4 ? '...' : '');
    const elimParts = [...eliminations].sort((a,b)=>a.digit-b.digit).map(e => `${e.digit} from ${cellLabel(e.cell)}`);
    return [{
      ruleName: this.name,
      displayName: 'Solution map filter',
      explanation: `Cage solutions: ${solnDisplay}. Mapping feasible per-cell assignments eliminates: ${elimParts.join('; ')}.`,
      highlightCells: [...(ctx.unit.cells as Cell[]), ...eliminations.map(e => e.cell)],
      eliminations,
      placement: null,
      virtualCageSuggestion: null,
    }];
  }
}
