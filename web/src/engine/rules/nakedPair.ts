/**
 * NakedPair — R7: two cells locked to the same two candidates → eliminate from unit peers.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.naked_pair` module.
 *
 * When exactly two cells in a ROW/COL/BOX share the same two candidates and no
 * others, those two digits can be removed from all other cells in that unit.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel, unitLabel } from './_labels.js';

export class NakedPair {
  readonly name = 'NakedPair';
  readonly description =
    'When exactly two cells in a unit share the same two candidates and no others, those digits can be removed from all other cells in that unit.';
  readonly priority = 6;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_HIT_TWO]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX]);

  private _findPair(ctx: RuleContext): [Cell, Cell, number, number] | null {
    if (!ctx.unit || ctx.hintDigit === null) return null;
    const board = ctx.board;
    const cells = ctx.unit.cells as Cell[];
    const d1 = ctx.hintDigit;
    const d1Cells = cells.filter(([r, c]) => board.candidates[r][c].has(d1));
    if (d1Cells.length !== 2) return null;
    const [c1, c2] = d1Cells;
    const cands1 = board.candidates[c1[0]][c1[1]];
    const cands2 = board.candidates[c2[0]][c2[1]];
    if (cands1.size !== 2 || cands1.size !== cands2.size) return null;
    for (const d of cands1) { if (!cands2.has(d)) return null; }
    const d2 = [...cands1].find(d => d !== d1)!;
    return [c1, c2, Math.min(d1, d2), Math.max(d1, d2)];
  }

  apply(ctx: RuleContext): RuleResult {
    const pair = this._findPair(ctx);
    if (!pair || !ctx.unit) return emptyResult();
    const [c1, c2, dLo, dHi] = pair;
    const c1k = `${c1[0]},${c1[1]}`, c2k = `${c2[0]},${c2[1]}`;
    const elims: Elimination[] = (ctx.unit.cells as Cell[])
      .filter(([r,c]) => `${r},${c}` !== c1k && `${r},${c}` !== c2k)
      .flatMap(([r,c]) => [dLo, dHi].filter(d => ctx.board.candidates[r][c].has(d))
        .map(d => ({ cell: [r, c] as unknown as Cell, digit: d })));
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
    if (!eliminations.length) return [];
    const pair = this._findPair(ctx);
    if (!pair || !ctx.unit) return [];
    const [c1, c2, dLo, dHi] = pair;
    return [{
      ruleName: this.name,
      displayName: 'Naked Pair',
      explanation: `${cellLabel(c1)} and ${cellLabel(c2)} both have only {${dLo},${dHi}} as candidates in ${unitLabel(ctx.unit)}. These digits can be eliminated from all other cells in that unit.`,
      highlightCells: [c1, c2, ...eliminations.map(e => e.cell)],
      eliminations,
      placement: null,
      virtualCageSuggestion: null,
    }];
  }
}
