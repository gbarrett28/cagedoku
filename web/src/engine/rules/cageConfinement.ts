/**
 * CageConfinement — pigeonhole elimination when n cages fill n same-type units.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.cage_confinement` module.
 *
 * For n cages C₁…Cₙ and n distinct same-type units U₁…Uₙ: if digit d is
 * essential to every cage and every d-candidate cell lies within ⋃Uⱼ, then by
 * pigeonhole d is eliminated from (⋃Uⱼ) \ (⋃Cᵢ).
 *
 * Fires as GLOBAL. Parameterised by maxN (default 2).
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel, typeUnitId, unitLabel, unitTypeLabel } from './_labels.js';

interface _ConfinementMatch {
  digit: number;
  cageCellsList: Cell[][];
  unitIds: number[];
  eliminations: Elimination[];
}

/** All combinations of k items from array. */
function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [head, ...tail] = arr;
  return [...combinations(tail, k - 1).map(c => [head, ...c]), ...combinations(tail, k)];
}

export class CageConfinement {
  readonly name = 'CageConfinement';
  readonly description =
    'Checks all groups of cages that together cover complete rows, columns, or boxes, and eliminates digits inconsistent with the resulting sum constraints.';
  readonly priority = 12;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  constructor(private readonly maxN = 2) {}

  private _findAllMatches(board: RuleContext['board']): _ConfinementMatch[] {
    const matches: _ConfinementMatch[] = [];
    for (const kind of [UnitKind.ROW, UnitKind.COL, UnitKind.BOX] as UnitKind[]) {
      for (let d = 1; d <= 9; d++) {
        matches.push(...this._search(board, kind, d));
      }
    }
    return matches;
  }

  private _search(board: RuleContext['board'], kind: UnitKind, d: number): _ConfinementMatch[] {
    // For each cage where d is essential, record which same-type unit IDs have d-candidates
    const cageInfo: Array<{cells: Cell[]; dUnitIds: Set<number>}> = [];
    for (const unit of board.units) {
      if (unit.kind !== UnitKind.CAGE || !unit.distinctDigits) continue;
      const cageIdx = unit.unitId - 27;
      const solns = board.cageSolns[cageIdx];
      if (!solns.length || !solns.every(s => s.includes(d))) continue;
      const dUnitIds = new Set<number>();
      for (const [r, c] of unit.cells as Cell[]) {
        if (board.candidates[r][c].has(d)) dUnitIds.add(typeUnitId(kind, r, c));
      }
      if (!dUnitIds.size) continue;
      cageInfo.push({ cells: unit.cells as Cell[], dUnitIds });
    }

    const matches: _ConfinementMatch[] = [];
    for (let n = 1; n <= this.maxN; n++) {
      for (const combo of combinations(cageInfo, n)) {
        // Pigeonhole requires disjoint cages
        const allFlat = combo.flatMap(info => info.cells);
        if (allFlat.length !== new Set(allFlat.map(([r,c])=>`${r},${c}`)).size) continue;

        const combinedUids = new Set(combo.flatMap(info => [...info.dUnitIds]));
        if (combinedUids.size !== n) continue;

        const allCageCells = new Set(allFlat.map(([r,c])=>`${r},${c}`));
        const unitIdsSorted = [...combinedUids].sort((a,b)=>a-b);
        const unitCellsUnion = unitIdsSorted.flatMap(uid => board.units[uid].cells as Cell[]);

        const elims = unitCellsUnion
          .filter(([r,c]) => !allCageCells.has(`${r},${c}`) && board.candidates[r][c].has(d))
          .map(cell => ({ cell, digit: d }));
        if (!elims.length) continue;

        matches.push({
          digit: d,
          cageCellsList: combo.map(info => info.cells),
          unitIds: unitIdsSorted,
          eliminations: elims,
        });
      }
    }
    return matches;
  }

  apply(ctx: RuleContext): RuleResult {
    const seen = new Set<string>();
    const elims: Elimination[] = [];
    for (const m of this._findAllMatches(ctx.board)) {
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
    for (const m of this._findAllMatches(ctx.board)) {
      const newElims = m.eliminations.filter(e => {
        const k = `${e.cell[0]},${e.cell[1]}:${e.digit}`; if (seen.has(k)) return false; seen.add(k); return true;
      });
      if (!newElims.length) continue;
      const n = m.unitIds.length;
      const board = ctx.board;
      const firstUnit = board.units[m.unitIds[0]];
      const kind = firstUnit.kind;
      const unitLabels = m.unitIds.map(uid => unitLabel(board.units[uid])).join(' and ');
      const removedStr = [...new Set(newElims.map(e => cellLabel(e.cell)))].sort().join(', ');
      const cageDescs = m.cageCellsList.map(cells =>
        '[' + [...cells].sort((a,b)=>a[0]-b[0]||a[1]-b[1]).map(cellLabel).join(', ') + ']'
      ).join(' and ');
      const explanation = n === 1
        ? `Digit ${m.digit} is essential to cage ${cageDescs} and all its candidate placements within the cage are confined to ${unitLabels}. Since ${unitLabels} must contain exactly one ${m.digit}, the cage accounts for it. Eliminating ${m.digit} from ${removedStr}.`
        : `Digit ${m.digit} is essential to cages ${cageDescs}. Every possible placement of ${m.digit} in each cage lies within ${unitLabels}. Those ${n} ${unitTypeLabel(kind)} contain exactly ${n} copies of ${m.digit}, all consumed by the ${n} cages by pigeonhole. Eliminating ${m.digit} from ${removedStr}.`;
      hints.push({
        ruleName: this.name,
        displayName: `Essential digit confined (${n} cage${n > 1 ? 's' : ''})`,
        explanation,
        highlightCells: [...m.cageCellsList.flat(), ...newElims.map(e => e.cell)],
        eliminations: newElims,
        placement: null,
        virtualCageSuggestion: null,
      });
    }
    return hints;
  }
}
