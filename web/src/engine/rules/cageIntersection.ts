/**
 * CageIntersection — R3: cage must-contain digit confined to one unit → eliminate outside.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.cage_intersection` module.
 *
 * When every remaining cage solution contains digit d, and every cell in the
 * cage that can hold d lies within a single row, column, or box, d can be
 * eliminated from the rest of that unit (outside the cage).
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel, unitLabel } from './_labels.js';

interface _Match {
  digit: number;
  carriers: Cell[];
  sharedUnitId: number;
  eliminations: Elimination[];
}

export class CageIntersection {
  readonly name = 'CageIntersection';
  readonly description =
    "When a cage's required digit is confined to cells that all lie in one row, column, or box, that digit can be removed from other cells in that unit.";
  readonly priority = 2;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.CAGE]);

  private _iterMatches(ctx: RuleContext): _Match[] {
    if (!ctx.unit?.distinctDigits) return [];
    const board = ctx.board;
    const cageCells = ctx.unit.cells as Cell[];
    const cageIdx = ctx.unit.unitId - 27;
    const solns = board.cageSolns[cageIdx];
    if (!solns.length) return [];

    const must = new Set<number>(solns[0]);
    for (const s of solns.slice(1)) { for (const d of must) { if (!s.includes(d)) must.delete(d); } }

    const cageCellSet = new Set(cageCells.map(([r, c]) => `${r},${c}`));
    const matches: _Match[] = [];

    for (const d of must) {
      const carriers = cageCells.filter(([r, c]) => board.candidates[r][c].has(d));
      if (!carriers.length) continue;

      let shared: Set<number> | null = null;
      for (const [r, c] of carriers) {
        const uids = board.cellUnitIds(r, c).filter((uid: number) => board.units[uid].kind !== UnitKind.CAGE);
        const nonCage = new Set<number>(uids);
        shared = shared === null ? nonCage : new Set<number>([...shared].filter((uid: number) => nonCage.has(uid)));
        if (!shared.size) break;
      }
      if (!shared?.size) continue;

      for (const uid of shared) {
        const elims = (board.units[uid].cells as Cell[])
          .filter(([r, c]) => !cageCellSet.has(`${r},${c}`) && board.candidates[r][c].has(d))
          .map(cell => ({ cell, digit: d }));
        if (elims.length) matches.push({ digit: d, carriers, sharedUnitId: uid, eliminations: elims });
      }
    }
    return matches;
  }

  apply(ctx: RuleContext): RuleResult {
    const seen = new Set<string>();
    const elims: Elimination[] = [];
    for (const m of this._iterMatches(ctx)) {
      for (const e of m.eliminations) {
        const key = `${e.cell[0]},${e.cell[1]}:${e.digit}`;
        if (!seen.has(key)) { seen.add(key); elims.push(e); }
      }
    }
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
    if (!eliminations.length) return [];
    const seen = new Set<string>();
    const hints: HintResult[] = [];
    for (const m of this._iterMatches(ctx)) {
      const newElims = m.eliminations.filter(e => {
        const k = `${e.cell[0]},${e.cell[1]}:${e.digit}`; if (seen.has(k)) return false; seen.add(k); return true;
      });
      if (!newElims.length) continue;
      const board = ctx.board;
      const cageLabels = [...(ctx.unit!.cells as Cell[])].sort((a,b)=>a[0]-b[0]||a[1]-b[1]).map(cellLabel).join(', ');
      const carriersStr = [...m.carriers].sort((a,b)=>a[0]-b[0]||a[1]-b[1]).map(cellLabel).join(', ');
      const uLbl = unitLabel(board.units[m.sharedUnitId]);
      const elimStr = [...newElims].sort((a,b)=>a.cell[0]-b.cell[0]||a.cell[1]-b.cell[1]).map(e=>cellLabel(e.cell)).join(', ');
      hints.push({
        ruleName: this.name,
        displayName: 'Cage Intersection',
        explanation: `Cage [${cageLabels}] must contain ${m.digit} in every remaining solution. The only cells in this cage that can currently hold ${m.digit} are ${carriersStr} — all within ${uLbl}. Since ${m.digit} must appear in the cage and all its candidates are locked to ${uLbl}, ${m.digit} can be eliminated from ${elimStr}.`,
        highlightCells: [...m.carriers, ...newElims.map(e => e.cell)],
        eliminations: newElims,
        placement: null,
        virtualCageSuggestion: null,
      });
    }
    return hints;
  }
}
