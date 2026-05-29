/**
 * UniqueRectangle — R16: Unique Rectangle types 1 and 2.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.unique_rectangle`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { combinations, dedupElims, sees } from './_helpers.js';
import { cellLabel } from './_labels.js';

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

    for (const rPair of combinations(rows, 2)) {
      const [r1, r2] = rPair as [number, number];
      for (const cPair of combinations(cols, 2)) {
        const [c1, c2] = cPair as [number, number];
        const corners: [number, number][] = [[r1, c1], [r1, c2], [r2, c1], [r2, c2]];
        const boxes = new Set(corners.map(([r, c]) => Math.floor(r / 3) * 3 + Math.floor(c / 3)));
        if (boxes.size !== 2) continue;
        const cands = corners.map(([r, c]) => board.cands(r, c));

        // Union of all candidates across all four corners
        const allCands = new Set<number>();
        for (const s of cands) for (const d of s) allCands.add(d);
        if (allCands.size < 2) continue;

        for (const abPair of combinations([...allCands].sort((x, y) => x - y), 2)) {
          const [a, b] = abPair as [number, number];
          // --- Type 1: exactly three corners are {a, b} ---
          const roofIndices = cands.reduce<number[]>(
            (acc, s, i) => (s.size === 2 && s.has(a) && s.has(b) ? [...acc, i] : acc),
            [],
          );
          if (roofIndices.length === 3) {
            const floorIdx = [0, 1, 2, 3].find(i => !roofIndices.includes(i))!;
            const [fr, fc] = corners[floorIdx]!;
            for (const d of [a, b]) {
              if (board.cands(fr, fc).has(d))
                elims.push({ cell: [fr, fc] as Cell, digit: d });
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
            const extra0 = new Set([...cands[extraIndices[0]!]!].filter(d => d !== a && d !== b));
            const extra1 = new Set([...cands[extraIndices[1]!]!].filter(d => d !== a && d !== b));
            if (extra0.size === 1 && [...extra0][0] === [...extra1][0]) {
              const x = [...extra0][0]!;
              const [ear, eac] = corners[extraIndices[0]!]!;
              const [ebr, ebc] = corners[extraIndices[1]!]!;
              for (let r = 0; r < 9; r++) {
                for (let c = 0; c < 9; c++) {
                  if ((r === ear && c === eac) || (r === ebr && c === ebc)) continue;
                  if (board.cands(r, c).has(x) && sees(r, c, ear, eac) && sees(r, c, ebr, ebc))
                    elims.push({ cell: [r, c] as Cell, digit: x });
                }
              }
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
    const rows = Array.from({ length: 9 }, (_, i) => i);
    const cols = Array.from({ length: 9 }, (_, i) => i);

    for (const [r1, r2] of combinations(rows, 2) as [number, number][]) {
      for (const [c1, c2] of combinations(cols, 2) as [number, number][]) {
        const corners: Cell[] = [[r1, c1], [r1, c2], [r2, c1], [r2, c2]];
        const boxes = new Set(corners.map(([r, c]) => Math.floor(r / 3) * 3 + Math.floor(c / 3)));
        if (boxes.size !== 2) continue;
        const cands = corners.map(([r, c]) => board.cands(r, c));
        const allCands = new Set<number>();
        for (const s of cands) for (const d of s) allCands.add(d);
        if (allCands.size < 2) continue;

        for (const [a, b] of combinations([...allCands].sort((x, y) => x - y), 2) as [number, number][]) {
          // Type 1: three corners are {a,b}; eliminate {a,b} from floor
          const roofIdx = cands.reduce<number[]>((acc, s, i) =>
            s.size === 2 && s.has(a) && s.has(b) ? [...acc, i] : acc, []);
          if (roofIdx.length === 3) {
            const floorIdx = [0, 1, 2, 3].find(i => !roofIdx.includes(i))!;
            const floor = corners[floorIdx]!;
            const elims = [a, b].filter(d => board.cands(floor[0], floor[1]).has(d))
              .map(d => ({ cell: floor, digit: d }));
            if (elims.length) {
              hints.push({
                ruleName: this.name, displayName: 'Unique Rectangle',
                explanation: `Unique Rectangle (Type 1): {${a},${b}} locked in ${roofIdx.map(i => cellLabel(corners[i]!)).join(', ')}. Remove {${a},${b}} from floor cell ${cellLabel(floor)}.`,
                highlightCells: [...corners, ...elims.map(e => e.cell)],
                eliminations: elims, placement: null, virtualCageSuggestion: null,
              });
            }
          }

          // Type 2: two {a,b} corners, two {a,b,x} corners sharing same x
          const baseIdx = cands.reduce<number[]>((acc, s, i) =>
            s.size === 2 && s.has(a) && s.has(b) ? [...acc, i] : acc, []);
          const extraIdx = cands.reduce<number[]>((acc, s, i) =>
            s.size === 3 && s.has(a) && s.has(b) ? [...acc, i] : acc, []);
          if (baseIdx.length === 2 && extraIdx.length === 2) {
            const extra0 = [...cands[extraIdx[0]!]!].filter(d => d !== a && d !== b);
            const extra1 = [...cands[extraIdx[1]!]!].filter(d => d !== a && d !== b);
            if (extra0.length === 1 && extra0[0] === extra1[0]) {
              const x = extra0[0]!;
              const [ea, eb] = [corners[extraIdx[0]!]!, corners[extraIdx[1]!]!] as [Cell, Cell];
              const elims: Elimination[] = [];
              for (let r = 0; r < 9; r++)
                for (let c = 0; c < 9; c++) {
                  if ((r === ea[0] && c === ea[1]) || (r === eb[0] && c === eb[1])) continue;
                  if (board.cands(r, c).has(x) && sees(r, c, ea[0], ea[1]) && sees(r, c, eb[0], eb[1]))
                    elims.push({ cell: [r, c] as Cell, digit: x });
                }
              if (elims.length) {
                hints.push({
                  ruleName: this.name, displayName: 'Unique Rectangle',
                  explanation: `Unique Rectangle (Type 2): extra digit ${x} in ${cellLabel(ea)} and ${cellLabel(eb)} — remove ${x} from cells seeing both.`,
                  highlightCells: [...corners, ...elims.map(e => e.cell)],
                  eliminations: elims, placement: null, virtualCageSuggestion: null,
                });
              }
            }
          }
        }
      }
    }
    return hints;
  }
}
