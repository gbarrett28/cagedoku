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
  // COUNT_HIT_TWO: catches pairs where a digit's unit-count reaches 2 (fast path).
  // GLOBAL: catches pairs where both digits have unit-count > 2 but two cells have
  //   narrowed to exactly the same two candidates (e.g. {1,5} in r6c0 and r6c6 while
  //   1 or 5 also appear in other cells of the unit).
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_HIT_TWO, Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX]);

  private _findPair(ctx: RuleContext): [Cell, Cell, number, number] | null {
    if (!ctx.unit) return null;
    const board = ctx.board;
    const cells = ctx.unit.cells as Cell[];

    if (ctx.hintDigit !== null) {
      // COUNT_HIT_TWO path: hintDigit's count in this unit just reached 2.
      const d1 = ctx.hintDigit;
      const d1Cells = cells.filter(([r, c]) => board.cands(r, c).has(d1));
      if (d1Cells.length !== 2) return null;
      const [c1, c2] = [d1Cells[0]!, d1Cells[1]!];
      const cands1 = board.cands(c1[0], c1[1]);
      const cands2 = board.cands(c2[0], c2[1]);
      if (cands1.size !== 2 || cands1.size !== cands2.size) return null;
      for (const d of cands1) { if (!cands2.has(d)) return null; }
      const d2 = [...cands1].find(d => d !== d1)!;
      return [c1, c2, Math.min(d1, d2), Math.max(d1, d2)];
    }

    // GLOBAL path: scan all cells with exactly 2 candidates for matching pairs.
    const twos = cells.filter(([r, c]) => board.cands(r, c).size === 2);
    for (let i = 0; i < twos.length - 1; i++) {
      const c1 = twos[i]!;
      const cands1 = board.cands(c1[0], c1[1]);
      for (let j = i + 1; j < twos.length; j++) {
        const c2 = twos[j]!;
        const cands2 = board.cands(c2[0], c2[1]);
        let same = true;
        for (const d of cands1) { if (!cands2.has(d)) { same = false; break; } }
        if (same) {
          const [dLo, dHi] = [...cands1].sort((a, b) => a - b) as [number, number];
          return [c1, c2, dLo, dHi];
        }
      }
    }
    return null;
  }

  apply(ctx: RuleContext): RuleResult {
    const pair = this._findPair(ctx);
    if (!pair || !ctx.unit) return emptyResult();
    const [c1, c2, dLo, dHi] = pair;
    const c1k = `${c1[0]},${c1[1]}`, c2k = `${c2[0]},${c2[1]}`;
    const elims: Elimination[] = (ctx.unit.cells as Cell[])
      .filter(([r,c]) => `${r},${c}` !== c1k && `${r},${c}` !== c2k)
      .flatMap(([r,c]) => [dLo, dHi].filter(d => ctx.board.cands(r, c).has(d))
        .map(d => ({ cell: [r, c] as Cell, digit: d })));
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
