/**
 * LockedCandidates — R10b: digit in a unit confined to one cage or box.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.locked_candidates` module.
 *
 * Two patterns:
 *  - unit→cage (cage-line reduction): row/col/box d-candidates all in same cage → eliminate from cage outside unit
 *  - unit→box (box-line reduction): row/col d-candidates all in same box → eliminate from box outside row/col
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel, unitLabel } from './_labels.js';

interface _Match {
  digit: number;
  sourceUnitId: number;
  carriers: Cell[];
  targetUnitId: number;
  pattern: 'unit_cage' | 'unit_box';
  eliminations: Elimination[];
}

export class LockedCandidates {
  readonly name = 'LockedCandidates';
  readonly killerOnly = false;
  readonly displayName = 'Locked Candidates';
  readonly description = `\
Locked Candidates — a digit confined to the intersection of two units can be eliminated from the remainder of each unit.

Two patterns:

Cage-line (unit → cage): If all candidates for d in a row, column, or box lie within one cage, then d must be placed inside that cage's intersection with the unit. The cage cannot place d outside the intersection, so d is eliminated from cage cells outside the unit.

Box-line (row/col → box): If all candidates for d in a row or column lie within one 3×3 box, then d is locked to that row/col-box intersection. The box cannot place d outside the intersection, so d is eliminated from box cells outside the row or column.

Proof (box-line, one case, exhaustive because all candidates are inside the box):
  All d-candidates in row R lie in box B → d goes in B∩R → box already has d covered → d ≠ any cell in B outside R.

Guards:
  carriers.length >= 2        at least two candidates needed (one would be a Hidden Single)
  commonCageIds?.size > 0     cage-line: all carriers share a common cage
  boxRows.size === 1 && boxCols.size === 1   box-line: all carriers share one box`.trim();
  readonly priority = 14;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX]);

  private _iterMatches(ctx: RuleContext): _Match[] {
    if (!ctx.unit) return [];
    const board = ctx.board;
    const unitCells = ctx.unit.cells as Cell[];
    const unitCellSet = new Set(unitCells.map(([r,c]) => `${r},${c}`));
    const matches: _Match[] = [];

    for (let d = 1; d <= 9; d++) {
      const carriers = unitCells.filter(([r, c]) => board.cands(r, c).has(d));
      if (carriers.length < 2) continue;

      // Pattern 1: unit → cage
      let commonCageIds: Set<number> | null = null;
      for (const [r, c] of carriers) {
        const cageUids = board.cellUnitIds(r, c).filter((uid: number) => board.units[uid]!.kind === UnitKind.CAGE);
        const cellCages = new Set<number>(cageUids);
        commonCageIds = commonCageIds === null ? cellCages : new Set<number>([...commonCageIds].filter((uid: number) => cellCages.has(uid)));
        if (!commonCageIds.size) break;
      }
      if (commonCageIds?.size) {
        for (const cageUid of commonCageIds) {
          const elims = (board.units[cageUid]!.cells as Cell[])
            .filter(([r,c]) => !unitCellSet.has(`${r},${c}`) && board.cands(r, c).has(d))
            .map(cell => ({ cell, digit: d }));
          if (elims.length) matches.push({ digit: d, sourceUnitId: ctx.unit.unitId, carriers, targetUnitId: cageUid, pattern: 'unit_cage', eliminations: elims });
        }
      }

      // Pattern 2: row/col → box
      if (ctx.unit.kind === UnitKind.ROW || ctx.unit.kind === UnitKind.COL) {
        const boxRows = new Set(carriers.map(([r]) => r / 3 | 0));
        const boxCols = new Set(carriers.map(([,c]) => c / 3 | 0));
        if (boxRows.size === 1 && boxCols.size === 1) {
          const br = [...boxRows][0]!, bc = [...boxCols][0]!;
          const boxUid = board.boxUnitId(br * 3, bc * 3);
          const elims = (board.units[boxUid]!.cells as Cell[])
            .filter(([r,c]) => !unitCellSet.has(`${r},${c}`) && board.cands(r, c).has(d))
            .map(cell => ({ cell, digit: d }));
          if (elims.length) matches.push({ digit: d, sourceUnitId: ctx.unit.unitId, carriers, targetUnitId: boxUid, pattern: 'unit_box', eliminations: elims });
        }
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
      const carriersStr = [...m.carriers].sort((a,b)=>a[0]-b[0]||a[1]-b[1]).map(cellLabel).join(', ');
      const srcLbl = unitLabel(board.units[m.sourceUnitId]!);
      const tgtLbl = unitLabel(board.units[m.targetUnitId]!);
      const elimStr = [...newElims].sort((a,b)=>a.cell[0]-b.cell[0]||a.cell[1]-b.cell[1]).map(e=>cellLabel(e.cell)).join(', ');
      hints.push({
        ruleName: this.name,
        displayName: m.pattern === 'unit_cage' ? 'Locked Candidates (Cage-Line)' : 'Locked Candidates (Box-Line)',
        explanation: m.pattern === 'unit_cage'
          ? `In ${srcLbl}, ${m.digit} can only go in ${carriersStr}. All those cells belong to the same cage (${tgtLbl}). Since ${m.digit} must appear somewhere in ${srcLbl} and all its candidates are inside that cage, ${m.digit} can be eliminated from ${elimStr} (cage cells outside ${srcLbl}).`
          : `In ${srcLbl}, ${m.digit} can only go in ${carriersStr}. All those cells lie within ${tgtLbl}. Since ${m.digit} must appear somewhere in ${srcLbl} and all its candidates are locked to ${tgtLbl}, ${m.digit} can be eliminated from ${elimStr} (the other cells in ${tgtLbl} outside ${srcLbl}).`,
        highlightCells: [...m.carriers, ...newElims.map(e => e.cell)],
        eliminations: newElims,
        placement: null,
        virtualCageSuggestion: null,
      });
    }
    return hints;
  }
}
