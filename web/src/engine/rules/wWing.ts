/**
 * W-Wing — two bivalue cells {p,q} connected through a strong link on p.
 *
 * Strong link on p: unit U has exactly two cells X and Y that can hold p.
 * Wing A = {p,q} sees X (or Y). Wing B = {p,q} sees the other end. A ≠ B.
 * Digit q is eliminated from any cell T that sees both A and B.
 *
 * Proof (two cases, exhaustive because the strong link is binary):
 *   Case p at X: A sees X → A ≠ p → A = q.  T sees A → T ≠ q.
 *   Case p at Y: B sees Y → B ≠ p → B = q.  T sees B → T ≠ q.
 *
 * Guards verified against proof:
 *   linkCells.length === 2                       strong link exists (exactly two p-cells)
 *   wing.size === 2 ∧ wing.has(p)               wings are bivalue on {p,q} (forcing is tight)
 *   (aSeesX ∧ bSeesY) ∨ (aSeesY ∧ bSeesX)      complementary connection — soundness guard:
 *       each wing is tied to a different end; if both see the same end the far-end
 *       case leaves both wings uncommitted and the proof fails
 *   sees(T, A) ∧ sees(T, B)                     T blocked by whichever wing holds q
 *
 * Anti-redundancy guard: `sees(A, B)` → skip. If A and B see each other they form
 * a naked pair on {p,q}; the same eliminations are already covered by that rule.
 *
 * Uses COUNT_HIT_TWO trigger — fires only when a digit's count in a unit drops to 2,
 * creating a new strong link, rather than scanning the whole board on every change.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { dedupElims, sees } from './_helpers.js';
import { cellLabel, unitLabel } from './_labels.js';

export class WWing {
  readonly name = 'WWing';
  readonly description =
    'When two cells with the same two candidates are each connected to one end ' +
    'of a strong link on one of those candidates, the other candidate can be ' +
    'eliminated from any cell that sees both bivalue cells.';
  readonly priority = 20;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_HIT_TWO]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX]);

  apply(ctx: RuleContext): RuleResult {
    if (!ctx.unit || ctx.hintDigit === null) return emptyResult();
    const board = ctx.board;
    const p = ctx.hintDigit;
    const cells = ctx.unit.cells as Cell[];

    // Strong link: the two cells in this unit that can still contain p
    const linkCells = cells.filter(([r, c]) => board.cands(r, c).has(p));
    if (linkCells.length !== 2) return emptyResult();
    const [[xr, xc], [yr, yc]] = linkCells as [[number, number], [number, number]];

    // Collect all bivalue cells {p, q} for each possible q
    const bivalue: [[number, number], number][] = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++) {
        if (board.cands(r, c).size !== 2 || !board.cands(r, c).has(p)) continue;
        const q = [...board.cands(r, c)].find(d => d !== p)!;
        bivalue.push([[r, c], q]);
      }

    const elims: Elimination[] = [];
    for (const [[ar, ac], qa] of bivalue) {
      for (const [[br, bc], qb] of bivalue) {
        if (qa !== qb) continue;
        if (ar === br && ac === bc) continue;
        if (sees(ar, ac, br, bc)) continue; // wings must not see each other
        const q = qa;

        const aSeesX = sees(ar, ac, xr, xc);
        const aSeesY = sees(ar, ac, yr, yc);
        const bSeesX = sees(br, bc, xr, xc);
        const bSeesY = sees(br, bc, yr, yc);

        if (!((aSeesX && bSeesY) || (aSeesY && bSeesX))) continue;

        for (let r = 0; r < 9; r++)
          for (let c = 0; c < 9; c++) {
            if ((r === ar && c === ac) || (r === br && c === bc)) continue;
            if (board.cands(r, c).has(q) && sees(r, c, ar, ac) && sees(r, c, br, bc))
              elims.push({ cell: [r, c] as Cell, digit: q });
          }
      }
    }
    return { ...emptyResult(), eliminations: dedupElims(elims) };
  }

  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[] {
    if (!eliminations.length || !ctx.unit || ctx.hintDigit === null) return [];
    const board = ctx.board;
    const p = ctx.hintDigit;
    const cells = ctx.unit.cells as Cell[];

    const linkCells = cells.filter(([r, c]) => board.cands(r, c).has(p));
    if (linkCells.length !== 2) return [];
    const [[xr, xc], [yr, yc]] = linkCells as [[number, number], [number, number]];

    const bivalue: [[number, number], number][] = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++) {
        if (board.cands(r, c).size !== 2 || !board.cands(r, c).has(p)) continue;
        const q = [...board.cands(r, c)].find(d => d !== p)!;
        bivalue.push([[r, c], q]);
      }

    const hints: HintResult[] = [];
    const seen = new Set<string>();
    for (const [[ar, ac], qa] of bivalue) {
      for (const [[br, bc], qb] of bivalue) {
        if (qa !== qb || (ar === br && ac === bc) || sees(ar, ac, br, bc)) continue;
        const q = qa;
        const aSeesX = sees(ar, ac, xr, xc); const aSeesY = sees(ar, ac, yr, yc);
        const bSeesX = sees(br, bc, xr, xc); const bSeesY = sees(br, bc, yr, yc);
        if (!((aSeesX && bSeesY) || (aSeesY && bSeesX))) continue;

        const elims: Elimination[] = [];
        for (let r = 0; r < 9; r++)
          for (let c = 0; c < 9; c++) {
            if ((r === ar && c === ac) || (r === br && c === bc)) continue;
            if (board.cands(r, c).has(q) && sees(r, c, ar, ac) && sees(r, c, br, bc))
              elims.push({ cell: [r, c] as Cell, digit: q });
          }
        if (!elims.length) continue;

        const key = `${ar},${ac}|${br},${bc}|${q}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const A = [ar, ac] as Cell; const B = [br, bc] as Cell;
        const X = [xr, xc] as Cell; const Y = [yr, yc] as Cell;
        // Chain A→X→Y→B: A=blue, X=green, Y=blue, B=green
        hints.push({
          ruleName: this.name, displayName: 'W-Wing',
          explanation: `W-Wing: ${cellLabel(A)} and ${cellLabel(B)} both {${p},${q}} are connected via strong link on ${p} in ${unitLabel(ctx.unit)} (${cellLabel(X)}–${cellLabel(Y)}). Digit ${q} eliminated from cells seeing both.`,
          highlightCells: elims.map(e => e.cell),
          eliminations: elims, placement: null, virtualCageSuggestion: null,
          colourGroups: [{ cells: [A, Y], colour: 'blue' }, { cells: [X, B], colour: 'green' }],
        });
      }
    }
    return hints;
  }
}
