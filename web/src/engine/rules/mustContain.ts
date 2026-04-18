/**
 * MustContain — R5: cage must-contain digits confined to overlap → eliminate from unit.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.must_contain` module.
 *
 * If the intersection of all cage solutions gives a set of "must-contain"
 * digits, and a must-contain digit has no candidates outside the overlap of
 * the cage with the current unit, that digit is confined to the overlap and
 * can be eliminated from the rest of the unit.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel, unitLabel } from './_labels.js';

export class MustContain {
  readonly name = 'MustContain';
  readonly description =
    'When a digit must appear in a cage and is confined to cells that overlap another unit, it can be eliminated from that unit\'s other cells.';
  readonly priority = 4;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE]);

  private _iterMatches(ctx: RuleContext): Array<{unit: typeof ctx.unit; cageUnitId: number; overlap: Cell[]; confinedDigits: Set<number>; eliminations: Elimination[]}> {
    if (!ctx.unit?.distinctDigits) return [];
    const board = ctx.board;
    const unitCells = ctx.unit.cells as Cell[];
    const unitCellSet = new Set(unitCells.map(([r,c]) => `${r},${c}`));
    const seen = new Set<number>();
    const matches = [];

    for (const [r, c] of unitCells) {
      for (const uid of board.cellUnitIds(r, c)) {
        const other = board.units[uid];
        if (other.kind !== UnitKind.CAGE) continue;
        const cageIdx = other.unitId - 27;
        if (seen.has(cageIdx)) continue;
        seen.add(cageIdx);

        const otherCells = other.cells as Cell[];
        const overlap = otherCells.filter(([cr,cc]) => unitCellSet.has(`${cr},${cc}`));
        if (!overlap.length || overlap.length === unitCells.length) continue;

        const otherElsewhere = new Set<number>();
        for (const [cr, cc] of otherCells.filter(([cr,cc]) => !unitCellSet.has(`${cr},${cc}`)))
          for (const d of board.candidates[cr][cc]) otherElsewhere.add(d);

        const solns = board.cageSolns[cageIdx];
        if (!solns.length) continue;
        const must = new Set<number>(solns[0]);
        for (const s of solns.slice(1)) { for (const d of must) { if (!s.includes(d)) must.delete(d); } }

        const confined = new Set([...must].filter(d => !otherElsewhere.has(d)));
        if (!confined.size) continue;

        const elims = unitCells
          .filter(([er,ec]) => !new Set(overlap.map(([r,c])=>`${r},${c}`)).has(`${er},${ec}`))
          .flatMap(([er,ec]) => [...confined].filter(d => board.candidates[er][ec].has(d))
            .map(d => ({ cell: [er, ec] as unknown as Cell, digit: d })));
        if (elims.length) matches.push({ unit: ctx.unit, cageUnitId: uid, overlap, confinedDigits: confined, eliminations: elims });
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
      const board = ctx.board;
      const cageLabels = [...(board.units[m.cageUnitId].cells as Cell[])].sort((a,b)=>a[0]-b[0]||a[1]-b[1]).map(cellLabel).join(', ');
      const overlapStr = [...m.overlap].sort((a,b)=>a[0]-b[0]||a[1]-b[1]).map(cellLabel).join(', ');
      const uLbl = unitLabel(m.unit!);
      const digits = [...m.confinedDigits].sort().join(', ');
      const elimCells = [...newElims].sort((a,b)=>a.cell[0]-b.cell[0]||a.cell[1]-b.cell[1]).map(e=>cellLabel(e.cell)).join(', ');
      hints.push({
        ruleName: this.name,
        displayName: 'Must Contain',
        explanation: `Cage [${cageLabels}] must contain {${digits}} in every remaining solution, and those digits can only be placed within the cage at ${overlapStr} — the intersection with ${uLbl}. Since {${digits}} must appear in the cage and is confined to ${uLbl}, it can be eliminated from ${elimCells}.`,
        highlightCells: [...m.overlap, ...newElims.map(e => e.cell)],
        eliminations: newElims,
        placement: null,
        virtualCageSuggestion: null,
      });
    }
    return hints;
  }
}
