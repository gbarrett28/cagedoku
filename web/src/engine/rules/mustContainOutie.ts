/**
 * MustContainOutie — R4b: single external cell with candidates ⊆ must-contain restricts outie.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.must_contain_outie` module.
 *
 * When exactly one cage cell lies outside a unit (the outie) and exactly one
 * external cell in the unit has candidates ⊆ must-contain set of the cage,
 * the outie's candidates are restricted to that external cell's candidates.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel, unitLabel } from './_labels.js';
import type { Unit } from '../types.js';

interface _Match {
  cageCells: Cell[];
  must: Set<number>;
  unit: Unit;
  outie: Cell;
  externalCell: Cell;
  xCands: Set<number>;
  eliminations: Elimination[];
}

function findMatch(
  cageCells: Cell[],
  must: Set<number>,
  unit: Unit,
  board: RuleContext['board'],
): _Match | null {
  const unitCellSet = new Set((unit.cells as Cell[]).map(([r,c]) => `${r},${c}`));
  const cageCellSet = new Set(cageCells.map(([r,c]) => `${r},${c}`));
  const inside = cageCells.filter(([r,c]) => unitCellSet.has(`${r},${c}`));
  const outside = cageCells.filter(([r,c]) => !unitCellSet.has(`${r},${c}`));
  if (outside.length !== 1 || !inside.length) return null;
  const outie = outside[0]!;
  const outieCands = board.cands(outie[0], outie[1]);
  if (!outieCands.size) return null;

  const qualifying = (unit.cells as Cell[]).filter(([r,c]) => {
    if (cageCellSet.has(`${r},${c}`)) return false;
    const cands = board.cands(r, c);
    return cands.size > 0 && cands.isSubsetOf(must);
  });
  if (qualifying.length !== 1) return null;

  const [xr, xc] = qualifying[0]!;
  const xCands = board.cands(xr, xc);
  const elims = [...outieCands].filter(d => !xCands.has(d))
    .map(d => ({ cell: outie, digit: d }));
  if (!elims.length) return null;

  return { cageCells, must, unit, outie, externalCell: qualifying[0]!, xCands, eliminations: elims };
}

export class MustContainOutie {
  readonly name = 'MustContainOutie';
  readonly description =
    'Extension of must-contain: when a digit required by a cage can only be placed in cells shared with an adjacent cage, constrains the adjacent cage.';
  readonly priority = 4;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE]);

  private _iterMatches(ctx: RuleContext): _Match[] {
    if (!ctx.unit) return [];
    const board = ctx.board;
    const matches: _Match[] = [];

    if (ctx.unit.kind === UnitKind.CAGE) {
      if (!ctx.unit.distinctDigits) return [];
      const cageCells = ctx.unit.cells as Cell[];
      const cageIdx = ctx.unit.unitId - 27;
      const must = cageMust(board.cageSolns[cageIdx]!);
      if (!must) return [];
      const seen = new Set<number>();
      for (const [r, c] of cageCells) {
        for (const uid of board.cellUnitIds(r, c)) {
          const unit = board.units[uid]!;
          if (unit.kind === UnitKind.CAGE || seen.has(uid)) continue;
          seen.add(uid);
          const m = findMatch(cageCells, must, unit, board);
          if (m) matches.push(m);
        }
      }
    } else {
      const seen = new Set<number>();
      for (const [r, c] of ctx.unit.cells as Cell[]) {
        for (const uid of board.cellUnitIds(r, c)) {
          const other = board.units[uid]!;
          if (other.kind !== UnitKind.CAGE || !other.distinctDigits) continue;
          const cageIdx = other.unitId - 27;
          if (seen.has(cageIdx)) continue;
          seen.add(cageIdx);
          const must = cageMust(board.cageSolns[cageIdx]!);
          if (!must) continue;
          const m = findMatch(other.cells as Cell[], must, ctx.unit, board);
          if (m) matches.push(m);
        }
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
    const seen = new Set<string>();
    const hints: HintResult[] = [];
    for (const m of this._iterMatches(ctx)) {
      const newElims = m.eliminations.filter(e => {
        const k = `${e.cell[0]},${e.cell[1]}:${e.digit}`; if (seen.has(k)) return false; seen.add(k); return true;
      });
      if (!newElims.length) continue;
      const cageLabels = [...m.cageCells].sort((a,b)=>a[0]-b[0]||a[1]-b[1]).map(cellLabel).join(', ');
      const uLbl = unitLabel(m.unit);
      const extLbl = cellLabel(m.externalCell);
      const outieLbl = cellLabel(m.outie);
      const mustStr = '{' + [...m.must].sort().join(', ') + '}';
      const xCandsStr = '{' + [...m.xCands].sort().join(', ') + '}';
      const removed = [...new Set(newElims.map(e => e.digit))].sort().join(', ');
      const insideCells = m.cageCells.filter(([r,c]) => (m.unit.cells as Cell[]).some(([ur,uc])=>ur===r&&uc===c));
      const insideStr = [...insideCells].sort((a,b)=>a[0]-b[0]||a[1]-b[1]).map(cellLabel).join(', ');
      hints.push({
        ruleName: this.name,
        displayName: 'Outie restricted by external cell',
        explanation: `Cage [${cageLabels}] must contain ${mustStr}. Cell ${extLbl} has candidates ${xCandsStr} — all digits are in the cage's must-contain set. Since ${extLbl} is in ${uLbl} along with cage cells ${insideStr}, whichever digit ${extLbl} holds is blocked from those cells by ${uLbl} uniqueness. The cage must therefore place that digit at the outie ${outieLbl} (the only cage cell outside ${uLbl}). So ${outieLbl}'s candidates are restricted to ${xCandsStr}, eliminating ${removed}.`,
        highlightCells: [...m.cageCells, m.externalCell],
        eliminations: newElims,
        placement: null,
        virtualCageSuggestion: null,
      });
    }
    return hints;
  }
}

function cageMust(solns: number[][]): Set<number> | null {
  if (!solns.length) return null;
  const must = new Set<number>(solns[0]);
  for (const s of solns.slice(1)) { for (const d of must) { if (!s.includes(d)) must.delete(d); } }
  return must.size ? must : null;
}
