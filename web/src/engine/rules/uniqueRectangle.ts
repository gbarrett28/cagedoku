/**
 * UniqueRectangle — R16: Unique Rectangle types 1 and 2.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.unique_rectangle`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { combinations, dedupElims, sees } from './_helpers.js';

export class UniqueRectangle {
  readonly name = 'UniqueRectangle';
  readonly description =
    'When four cells forming a rectangle would create two identical solutions, ' +
    'eliminates candidates that would cause the ambiguity.';
  readonly priority = 17;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    const board = ctx.board;
    const elims: Elimination[] = [];

    const rows = Array.from({ length: 9 }, (_, i) => i);
    const cols = Array.from({ length: 9 }, (_, i) => i);

    for (const [r1, r2] of combinations(rows, 2)) {
      for (const [c1, c2] of combinations(cols, 2)) {
        const corners: [number, number][] = [[r1, c1], [r1, c2], [r2, c1], [r2, c2]];
        const cands = corners.map(([r, c]) => board.candidates[r][c]);

        // Union of all candidates across all four corners
        const allCands = new Set<number>();
        for (const s of cands) for (const d of s) allCands.add(d);
        if (allCands.size < 2) continue;

        for (const [a, b] of combinations([...allCands].sort((x, y) => x - y), 2)) {
          // --- Type 1: exactly three corners are {a, b} ---
          const roofIndices = cands.reduce<number[]>(
            (acc, s, i) => (s.size === 2 && s.has(a) && s.has(b) ? [...acc, i] : acc),
            [],
          );
          if (roofIndices.length === 3) {
            const floorIdx = [0, 1, 2, 3].find(i => !roofIndices.includes(i))!;
            const [fr, fc] = corners[floorIdx];
            for (const d of [a, b]) {
              if (board.candidates[fr][fc].has(d))
                elims.push({ cell: [fr, fc] as unknown as Cell, digit: d });
            }
          }

          // --- Type 2: two corners are {a,b}, two have {a,b,x} for same x ---
          const baseIndices = cands.reduce<number[]>(
            (acc, s, i) => (s.size === 2 && s.has(a) && s.has(b) ? [...acc, i] : acc),
            [],
          );
          const extraIndices = cands.reduce<number[]>(
            (acc, s, i) =>
              s.size === 3 && s.has(a) && s.has(b) ? [...acc, i] : acc,
            [],
          );
          if (baseIndices.length === 2 && extraIndices.length === 2) {
            const extra0 = new Set([...cands[extraIndices[0]]].filter(d => d !== a && d !== b));
            const extra1 = new Set([...cands[extraIndices[1]]].filter(d => d !== a && d !== b));
            if (extra0.size === 1 && [...extra0][0] === [...extra1][0]) {
              const x = [...extra0][0];
              const [ear, eac] = corners[extraIndices[0]];
              const [ebr, ebc] = corners[extraIndices[1]];
              for (let r = 0; r < 9; r++) {
                for (let c = 0; c < 9; c++) {
                  if ((r === ear && c === eac) || (r === ebr && c === ebc)) continue;
                  if (board.candidates[r][c].has(x) && sees(r, c, ear, eac) && sees(r, c, ebr, ebc))
                    elims.push({ cell: [r, c] as unknown as Cell, digit: x });
                }
              }
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
