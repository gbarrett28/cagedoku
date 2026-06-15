/**
 * XY-Wing — bivalue pivot links two bivalue pincers to eliminate a shared digit.
 *
 * Pivot P = {x, y}. Pincer A = {x, z} sees P. Pincer B = {y, z} sees P.
 *
 * Proof (two cases, exhaustive because P is bivalue):
 *   Case P = x: P sees A → A ≠ x → A = z.
 *   Case P = y: P sees B → B ≠ y → B = z.
 * Either way at least one of {A, B} holds z.
 * Any cell T seeing both A and B cannot hold z.
 *
 * Why P must be bivalue: a trivalue pivot {x, y, z} introduces a third case P = z
 * where neither A nor B is forced to z. T would also need to see P to be blocked —
 * that is XYZ-Wing. XY-Wing must never treat trivalue cells as pivots.
 *
 * Guards verified against proof:
 *   P.size === 2            bivalue pivot (no third P = z case)
 *   sees(P, A/B)            pincers witness pivot (enables forcing in each case)
 *   zA === zB               both pincers carry the same elimination digit z
 *   T ≠ A, T ≠ B           pincers are not targets (they hold z by proof)
 *   sees(T, A) ∧ sees(T, B) T is blocked by whichever pincer holds z
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { dedupElims, sees } from './_helpers.js';
import { cellLabel } from './_labels.js';

export class XYWing {
  readonly name = 'XYWing';
  readonly killerOnly = false;
  readonly displayName = 'XY-Wing';
  readonly description =
    'When three cells form a chain where each shares a candidate with the others, ' +
    'a digit that sees both end cells of the chain can be eliminated.';
  readonly priority = 19;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    const board = ctx.board;
    const elims: Elimination[] = [];

    // Collect all bivalue cells as (cell, d1, d2) with d1 < d2
    const bivalue: [[number, number], number, number][] = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (board.cands(r, c).size === 2) {
          const [d1, d2] = [...board.cands(r, c)].sort((a, b) => a - b) as [number, number];
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
              if (board.cands(r, c).has(z) && sees(r, c, ar, ac) && sees(r, c, br, bc))
                elims.push({ cell: [r, c] as Cell, digit: z });
            }
          }
        }
      }
    }

    return { ...emptyResult(), eliminations: dedupElims(elims) };
  }

  asHints(ctx: RuleContext, _eliminations: readonly Elimination[]): HintResult[] {
    if (!_eliminations.length) return [];
    const board = ctx.board;
    const hints: HintResult[] = [];

    const bivalue: [Cell, number, number][] = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (board.cands(r, c).size === 2) {
          const [d1, d2] = [...board.cands(r, c)].sort((a, b) => a - b) as [number, number];
          bivalue.push([[r, c] as Cell, d1, d2]);
        }

    const seen = new Set<string>();
    for (const [[pr, pc], x, y] of bivalue) {
      const xPincers: [Cell, number][] = [];
      const yPincers: [Cell, number][] = [];
      for (const [[ar, ac], a1, a2] of bivalue) {
        if (ar === pr && ac === pc) continue;
        if (!sees(pr, pc, ar, ac)) continue;
        if (a1 === x && a2 !== y) xPincers.push([[ar, ac] as Cell, a2]);
        else if (a2 === x && a1 !== y) xPincers.push([[ar, ac] as Cell, a1]);
        if (a1 === y && a2 !== x) yPincers.push([[ar, ac] as Cell, a2]);
        else if (a2 === y && a1 !== x) yPincers.push([[ar, ac] as Cell, a1]);
      }
      for (const [pinA, zA] of xPincers) {
        for (const [pinB, zB] of yPincers) {
          if (zA !== zB || (pinA[0] === pinB[0] && pinA[1] === pinB[1])) continue;
          const z = zA;
          const elims: Elimination[] = [];
          for (let r = 0; r < 9; r++)
            for (let c = 0; c < 9; c++) {
              if ((r === pinA[0] && c === pinA[1]) || (r === pinB[0] && c === pinB[1])) continue;
              if (board.cands(r, c).has(z) && sees(r, c, pinA[0], pinA[1]) && sees(r, c, pinB[0], pinB[1]))
                elims.push({ cell: [r, c] as Cell, digit: z });
            }
          if (!elims.length) continue;
          const key = `${pr},${pc}|${pinA}|${pinB}|${z}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const pivot = [pr, pc] as Cell;
          hints.push({
            ruleName: this.name, displayName: 'XY-Wing',
            explanation: `XY-Wing: pivot ${cellLabel(pivot)} links pincers ${cellLabel(pinA)} and ${cellLabel(pinB)} — ${z} can be removed from cells seeing both pincers.`,
            // pivot → highlightCells (orange); pinA=blue, pinB=green so elims see blue∧green
            highlightCells: [pivot, ...elims.map(e => e.cell)],
            eliminations: elims, placement: null, virtualCageSuggestion: null,
            colourGroups: [
              { cells: [pinA], colour: 'blue' },
              { cells: [pinB], colour: 'green' },
            ],
          });
        }
      }
    }
    return hints;
  }
}
