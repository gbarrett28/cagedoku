/**
 * LinearElimination — apply cells determined by the cage-sum linear system.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.linear_elimination` module.
 *
 * Fires as GLOBAL. Returns initial_eliminations still present in the candidate
 * sets. As hints, returns:
 *  T1 — placement hints for uniquely-determined cells.
 *  T3 — virtual cage suggestion hints for RREF-derived cages not yet added.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';

export class LinearElimination {
  readonly name = 'LinearElimination';
  readonly description = 'Uses linear equations derived from cage sums to eliminate impossible digit values from cells.';
  readonly priority = 1;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();
  /** BoardState must be constructed with includeVirtualCages=true for this rule to function. */
  readonly requiresVirtualCages = true;

  apply(ctx: RuleContext): RuleResult {
    const elims = ctx.board.linearSystem.initialEliminations.filter(
      e => ctx.board.candidates[e.cell[0]][e.cell[1]].has(e.digit)
    );
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
    const hints: HintResult[] = [];
    hints.push(...this._t1PlacementHints(ctx, eliminations));
    hints.push(...this._t3VirtualCageHints(ctx));
    return hints;
  }

  private _t1PlacementHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
    if (!eliminations.length) return [];
    const byCell = new Map<string, Elimination[]>();
    for (const e of eliminations) {
      const k = `${e.cell[0]},${e.cell[1]}`;
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k)!.push(e);
    }
    const hints: HintResult[] = [];
    for (const [key, cellElims] of byCell) {
      const [r, c] = key.split(',').map(Number);
      const elimSet = new Set(cellElims.map(e => e.digit));
      const remaining = [...ctx.board.candidates[r][c]].filter(d => !elimSet.has(d));
      if (remaining.length !== 1) continue;
      const digit = remaining[0];
      hints.push({
        ruleName: this.name,
        displayName: `Algebra: r${r+1}c${c+1} = ${digit}`,
        explanation: `The cage-sum equations (combined with row, column and box totals) uniquely determine r${r+1}c${c+1} = ${digit}.`,
        highlightCells: [[r, c] as unknown as Cell],
        eliminations: cellElims,
        placement: [r, c, digit],
        virtualCageSuggestion: null,
      });
    }
    return hints;
  }

  private _t3VirtualCageHints(ctx: RuleContext): HintResult[] {
    const nSpecCages = Math.max(...ctx.board.regions.flat()) + 1;
    const userVcThreshold = 27 + nSpecCages;
    const userVcCellSets = new Set(
      ctx.board.units
        .filter(u => u.unitId >= userVcThreshold)
        .map(u => (u.cells as Cell[]).map(([r,c]) => `${r},${c}`).sort().join('|'))
    );

    const hints: HintResult[] = [];
    for (const [vcells, vtotal, distinct] of ctx.board.linearSystem.virtualCages) {
      if (!distinct) continue;
      if ((vcells as Cell[]).length < 2 || (vcells as Cell[]).length > 3) continue;
      const key = (vcells as Cell[]).map(([r,c]) => `${r},${c}`).sort().join('|');
      if (userVcCellSets.has(key)) continue;
      const cellLabels = (vcells as Cell[]).map(([r,c]) => `r${r+1}c${c+1}`).join(' + ');
      hints.push({
        ruleName: this.name,
        displayName: `Virtual cage: ${(vcells as Cell[]).length} cells = ${vtotal}`,
        explanation: `The cage-sum equations imply ${cellLabels} = ${vtotal}. Adding this as a virtual cage will help narrow candidates.`,
        highlightCells: vcells as Cell[],
        eliminations: [],
        placement: null,
        virtualCageSuggestion: [vcells as Cell[], vtotal],
      });
    }
    return hints;
  }
}
