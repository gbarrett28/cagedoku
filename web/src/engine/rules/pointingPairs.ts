/**
 * PointingPairs — R10: digit confined to one row/col within a box → eliminate from rest.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.pointing_pairs` module.
 *
 * When all candidates for digit d within a box share the same row (or column),
 * d can be eliminated from the rest of that row (or column) outside the box.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel, unitLabel } from './_labels.js';

interface _Match {
  digit: number;
  carriers: Cell[];
  lineUnitId: number;
  eliminations: Elimination[];
}

export class PointingPairs {
  readonly name = 'PointingPairs';
  readonly description =
    'When a digit in a box is confined to one row or column, it can be removed from other cells in that row or column outside the box.';
  readonly priority = 9;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.BOX]);

  private _iterMatches(ctx: RuleContext): _Match[] {
    if (!ctx.unit) return [];
    const board = ctx.board;
    const boxCells = ctx.unit.cells as Cell[];
    const boxCellSet = new Set(boxCells.map(([r,c]) => `${r},${c}`));
    const matches: _Match[] = [];

    for (let d = 1; d <= 9; d++) {
      const carriers = boxCells.filter(([r, c]) => board.candidates[r][c].has(d));
      if (carriers.length < 2) continue;
      const rows = new Set(carriers.map(([r]) => r));
      const cols = new Set(carriers.map(([, c]) => c));

      if (rows.size === 1) {
        const row = carriers[0][0];
        const lineUid = board.rowUnitId(row);
        const elims = (board.units[lineUid].cells as Cell[])
          .filter(([r,c]) => !boxCellSet.has(`${r},${c}`) && board.candidates[r][c].has(d))
          .map(cell => ({ cell, digit: d }));
        if (elims.length) matches.push({ digit: d, carriers, lineUnitId: lineUid, eliminations: elims });
      } else if (cols.size === 1) {
        const col = carriers[0][1];
        const lineUid = board.colUnitId(col);
        const elims = (board.units[lineUid].cells as Cell[])
          .filter(([r,c]) => !boxCellSet.has(`${r},${c}`) && board.candidates[r][c].has(d))
          .map(cell => ({ cell, digit: d }));
        if (elims.length) matches.push({ digit: d, carriers, lineUnitId: lineUid, eliminations: elims });
      }
    }
    return matches;
  }

  apply(ctx: RuleContext): RuleResult {
    const elims = this._iterMatches(ctx).flatMap(m => m.eliminations);
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
    if (!eliminations.length) return [];
    return this._iterMatches(ctx)
      .filter(m => m.eliminations.length)
      .map(m => {
        const board = ctx.board;
        const carriersStr = [...m.carriers].sort((a,b)=>a[0]-b[0]||a[1]-b[1]).map(cellLabel).join(', ');
        const boxLbl = unitLabel(ctx.unit!);
        const lineLbl = unitLabel(board.units[m.lineUnitId]);
        const elimCells = [...m.eliminations].sort((a,b)=>a.cell[0]-b.cell[0]||a.cell[1]-b.cell[1]).map(e=>cellLabel(e.cell)).join(', ');
        return {
          ruleName: this.name,
          displayName: 'Pointing Pairs',
          explanation: `In ${boxLbl}, ${m.digit} can only go in ${carriersStr}. All those cells lie in ${lineLbl}, so ${m.digit} is locked to the intersection of ${boxLbl} and ${lineLbl}. Therefore ${m.digit} can be eliminated from ${elimCells} (the other cells in ${lineLbl} outside ${boxLbl}).`,
          highlightCells: [...m.carriers, ...m.eliminations.map(e => e.cell)],
          eliminations: m.eliminations,
          placement: null,
          virtualCageSuggestion: null,
        };
      });
  }
}
