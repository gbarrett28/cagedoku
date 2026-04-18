/**
 * XYWing — R15: Three bivalue cells forming a chain.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.xy_wing`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { dedupElims, sees } from './_helpers.js';

export class XYWing {
  readonly name = 'XYWing';
  readonly description =
    'When three cells form a chain where each shares a candidate with the others, ' +
    'a digit that sees both end cells of the chain can be eliminated.';
  readonly priority = 16;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    const board = ctx.board;
    const elims: Elimination[] = [];

    // Collect all bivalue cells as (cell, d1, d2) with d1 < d2
    const bivalue: [[number, number], number, number][] = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (board.candidates[r][c].size === 2) {
          const [d1, d2] = [...board.candidates[r][c]].sort((a, b) => a - b);
          bivalue.push([[r, c], d1, d2]);
        }
      }
    }

    // For each pivot P = {x, y}, find pincers A = {x, z} and B = {y, z}
    // where both pincers see the pivot; eliminate z from cells seeing both A and B
    for (const [[pr, pc], x, y] of bivalue) {
      const xPincers: [[number, number], number][] = []; // (cell, z) sharing x with P
      const yPincers: [[number, number], number][] = []; // (cell, z) sharing y with P

      for (const [[ar, ac], a1, a2] of bivalue) {
        if (ar === pr && ac === pc) continue;
        if (!sees(pr, pc, ar, ac)) continue;
        // A shares x with P but not y
        if (a1 === x && a2 !== y) xPincers.push([[ar, ac], a2]);
        else if (a2 === x && a1 !== y) xPincers.push([[ar, ac], a1]);
        // A shares y with P but not x
        if (a1 === y && a2 !== x) yPincers.push([[ar, ac], a2]);
        else if (a2 === y && a1 !== x) yPincers.push([[ar, ac], a1]);
      }

      // Pair pincers with the same z value and eliminate z from their common witnesses
      for (const [[ar, ac], zA] of xPincers) {
        for (const [[br, bc], zB] of yPincers) {
          if (zA !== zB) continue;
          if (ar === br && ac === bc) continue;
          const z = zA;
          for (let r = 0; r < 9; r++) {
            for (let c = 0; c < 9; c++) {
              if ((r === ar && c === ac) || (r === br && c === bc)) continue;
              if (board.candidates[r][c].has(z) && sees(r, c, ar, ac) && sees(r, c, br, bc))
                elims.push({ cell: [r, c] as unknown as Cell, digit: z });
            }
          }
        }
      }
    }

    return { ...emptyResult(), eliminations: dedupElims(elims) };
  }

  asHints(_ctx: RuleContext, _eliminations: readonly Elimination[]): HintResult[] {
    return [];
  }
}
