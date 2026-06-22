/**
 * XYZ-Wing — trivalue pivot links two bivalue pincers; target must see all three.
 *
 * Pivot P = {x, y, z}. Pincer A = {x, z} sees P. Pincer B = {y, z} sees P.
 * Digit z is eliminated from any cell T that sees ALL THREE of P, A, and B.
 *
 * Proof (three cases, exhaustive because P is trivalue over {x, y, z}):
 *   Case P = x: P sees A → A ≠ x → A = z.  T sees A → T ≠ z.
 *   Case P = y: P sees B → B ≠ y → B = z.  T sees B → T ≠ z.
 *   Case P = z:                              T sees P → T ≠ z.
 * T is blocked in every case.
 *
 * Why T must see the pivot: Case P = z relies entirely on the P–T visibility.
 * Without it the third case is unresolved and the elimination is unsound.
 * (Contrast XY-Wing: P is bivalue so Case P = z cannot arise; T need not see P.)
 *
 * Guards verified against proof:
 *   P.size === 3                              trivalue pivot (all three cases covered)
 *   sees(P, A) ∧ sees(P, B)                  pincers see pivot (Cases P = x and P = y)
 *   sees(T, P) ∧ sees(T, A) ∧ sees(T, B)     T blocked in all three cases
 *   T ∉ {P, A, B}                            pattern cells are not targets
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { dedupElims, sees } from './_helpers.js';
import { cellLabel } from './_labels.js';

export class XYZWing {
  readonly name = 'XYZWing';
  readonly killerOnly = false;
  readonly displayName = 'XYZ-Wing';
  readonly description =
    'When a trivalue cell (pivot) sees two bivalue cells (pincers) that each ' +
    'share a candidate with the pivot, the shared candidate can be eliminated ' +
    'from any cell that sees all three cells.';
  readonly priority = 22;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    const board = ctx.board;
    const elims: Elimination[] = [];

    // Collect trivalue cells as potential pivots
    const trivalue: [Cell, number, number, number][] = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (board.cands(r, c).size === 3) {
          const [x, y, z] = [...board.cands(r, c)].sort((a, b) => a - b) as [number, number, number];
          trivalue.push([[r, c] as Cell, x, y, z]);
        }

    // Collect bivalue cells
    const bivalue: [Cell, number, number][] = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (board.cands(r, c).size === 2) {
          const [d1, d2] = [...board.cands(r, c)].sort((a, b) => a - b) as [number, number];
          bivalue.push([[r, c] as Cell, d1, d2]);
        }

    for (const [[pr, pc], x, y, z] of trivalue) {
      // Try each of the 3 digits as the elimination digit.
      // For elimination digit pz: pincer A = {px, pz}, pincer B = {py, pz}.
      for (const [px, py, pz] of [[x,y,z],[x,z,y],[y,z,x]] as [number,number,number][]) {
        const aList: [number, number][] = [];
        const bList: [number, number][] = [];
        for (const [[ar, ac], d1, d2] of bivalue) {
          if (ar === pr && ac === pc) continue;
          if (!sees(pr, pc, ar, ac)) continue;
          if ((d1 === px && d2 === pz) || (d1 === pz && d2 === px)) aList.push([ar, ac]);
          if ((d1 === py && d2 === pz) || (d1 === pz && d2 === py)) bList.push([ar, ac]);
        }
        for (const [ar, ac] of aList) {
          for (const [br, bc] of bList) {
            if (ar === br && ac === bc) continue;
            for (let r = 0; r < 9; r++)
              for (let c = 0; c < 9; c++) {
                if ((r === pr && c === pc) || (r === ar && c === ac) || (r === br && c === bc)) continue;
                if (board.cands(r, c).has(pz) &&
                    sees(r, c, pr, pc) && sees(r, c, ar, ac) && sees(r, c, br, bc))
                  elims.push({ cell: [r, c] as Cell, digit: pz });
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
    const seen = new Set<string>();

    const trivalue: [Cell, number, number, number][] = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (board.cands(r, c).size === 3) {
          const [x, y, z] = [...board.cands(r, c)].sort((a, b) => a - b) as [number, number, number];
          trivalue.push([[r, c] as Cell, x, y, z]);
        }
    const bivalue: [Cell, number, number][] = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (board.cands(r, c).size === 2) {
          const [d1, d2] = [...board.cands(r, c)].sort((a, b) => a - b) as [number, number];
          bivalue.push([[r, c] as Cell, d1, d2]);
        }

    for (const [[pr, pc], x, y, z] of trivalue) {
      for (const [px, py, pz] of [[x,y,z],[x,z,y],[y,z,x]] as [number,number,number][]) {
        const aList: [number, number][] = [];
        const bList: [number, number][] = [];
        for (const [[ar, ac], d1, d2] of bivalue) {
          if (ar === pr && ac === pc) continue;
          if (!sees(pr, pc, ar, ac)) continue;
          if ((d1 === px && d2 === pz) || (d1 === pz && d2 === px)) aList.push([ar, ac]);
          if ((d1 === py && d2 === pz) || (d1 === pz && d2 === py)) bList.push([ar, ac]);
        }
        for (const [ar, ac] of aList) {
          for (const [br, bc] of bList) {
            if (ar === br && ac === bc) continue;
            const elims: Elimination[] = [];
            for (let r = 0; r < 9; r++)
              for (let c = 0; c < 9; c++) {
                if ((r === pr && c === pc) || (r === ar && c === ac) || (r === br && c === bc)) continue;
                if (board.cands(r, c).has(pz) &&
                    sees(r, c, pr, pc) && sees(r, c, ar, ac) && sees(r, c, br, bc))
                  elims.push({ cell: [r, c] as Cell, digit: pz });
              }
            if (!elims.length) continue;
            const key = `${pr},${pc}|${ar},${ac}|${br},${bc}|${pz}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const P = [pr, pc] as Cell;
            const A = [ar, ac] as Cell;
            const B = [br, bc] as Cell;
            const allCands = [...board.cands(pr, pc)].sort((a, b) => a - b);
            hints.push({
              ruleName: this.name, displayName: 'XYZ-Wing',
              explanation: `XYZ-Wing: pivot ${cellLabel(P)} {${allCands.join(',')}} links pincers ${cellLabel(A)} and ${cellLabel(B)} — ${pz} can be removed from cells seeing all three.`,
              // pivot P → highlightCells (orange); A=blue, B=green so elims see blue∧green
              highlightCells: [P, ...elims.map(e => e.cell)],
              eliminations: elims, placement: null, virtualCageSuggestion: null,
              chainCells: [
                { cell: P, digits: allCands },
                { cell: A, digits: [px, pz].sort((a, b) => a - b), colour: 'blue' },
                { cell: B, digits: [py, pz].sort((a, b) => a - b), colour: 'green' },
              ],
            });
          }
        }
      }
    }
    return hints;
  }
}
