/**
 * NakedQuad — naked quad elimination.
 *
 * Mirrors the naked-quad branch of Python's
 * `killer_sudoku.solver.engine.rules.incomplete.naked_hidden_quad`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { combinations } from './_helpers.js';
import { cellLabel, unitLabel } from './_labels.js';

export class NakedQuad {
  readonly name = 'NakedQuad';
  readonly killerOnly = false;
  readonly displayName = 'Naked Quad';
  readonly description = `
Naked Quad — pigeonhole elimination at N=4 in a unit.

If four cells in a unit have a candidate union of exactly {d1, d2, d3, d4}, those four cells must collectively hold all four digits. By pigeonhole, no other cell in the unit can hold any of these four digits.

Guards:
  union.size === 4   union of candidates across the 4 cells must be exactly 4 digits
  each(cell).size ≥ 2   every cell in the quad must have ≥ 2 candidates (singletons indicate an unresolved NakedSingle)
  ctx.unit !== null   rule requires a unit context
`.trim();
  readonly priority = 10;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([
    UnitKind.ROW, UnitKind.COL, UnitKind.BOX,
  ]);

  apply(ctx: RuleContext): RuleResult {
    if (!ctx.unit) return emptyResult();
    const board = ctx.board;
    const cells = ctx.unit.cells as Cell[];
    const elims: Elimination[] = [];

    for (const quad of combinations(cells, 4)) {
      const union = new Set<number>();
      for (const [r, c] of quad) for (const d of board.cands(r, c)) union.add(d);
      if (union.size !== 4) continue;
      // Skip combos where any cell is a naked single — NakedSingle (priority 0) fires first
      if (quad.some(([r, c]) => board.cands(r, c).size < 2)) continue;
      const quadSet = new Set(quad.map(([r, c]) => `${r},${c}`));
      for (const [r, c] of cells) {
        if (quadSet.has(`${r},${c}`)) continue;
        for (const d of union) {
          if (board.cands(r, c).has(d))
            elims.push({ cell: [r, c] as Cell, digit: d });
        }
      }
    }
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[] {
    if (!eliminations.length || !ctx.unit) return [];
    const board = ctx.board;
    const cells = ctx.unit.cells as Cell[];

    for (const quad of combinations(cells, 4)) {
      const union = new Set<number>();
      for (const [r, c] of quad) for (const d of board.cands(r, c)) union.add(d);
      if (union.size !== 4) continue;
      if (quad.some(([r, c]) => board.cands(r, c).size < 2)) continue;
      const quadSet = new Set(quad.map(([r, c]) => `${r},${c}`));
      const elims = cells.flatMap(([r, c]) =>
        quadSet.has(`${r},${c}`) ? [] :
        [...union].filter(d => board.cands(r, c).has(d)).map(d => ({ cell: [r, c] as Cell, digit: d })),
      );
      if (!elims.length) continue;
      const digits = [...union].sort((a, b) => a - b);
      return [{
        ruleName: this.name, displayName: 'Naked Quad',
        explanation: `Naked Quad {${digits.join(',')}} in ${(quad as Cell[]).map(c => cellLabel(c)).join(', ')} within ${unitLabel(ctx.unit)}. These digits can be removed from all other cells in the unit.`,
        highlightCells: [...quad as Cell[], ...elims.map(e => e.cell)],
        eliminations: elims, placement: null, virtualCageSuggestion: null,
      }];
    }
    return [];
  }
}
