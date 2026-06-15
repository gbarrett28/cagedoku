/**
 * NakedTriple — naked triple elimination.
 *
 * Mirrors the naked-triple branch of Python's
 * `killer_sudoku.solver.engine.rules.incomplete.naked_hidden_triple`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { combinations } from './_helpers.js';
import { cellLabel, unitLabel } from './_labels.js';

export class NakedTriple {
  readonly name = 'NakedTriple';
  readonly killerOnly = false;
  readonly displayName = 'Naked Triple';
  readonly description = `
Naked Triple — pigeonhole elimination at N=3 in a unit.

If three cells in a unit have a candidate union of exactly {d1, d2, d3}, those three cells must collectively hold d1, d2, d3. By pigeonhole, no other cell in the unit can hold any of these three digits → eliminate {d1,d2,d3} from all other unit cells.

Guards:
  union.size === 3   union of candidates across the 3 cells must be exactly 3 digits
  each(cell).size ≥ 2   every cell in the triple must have ≥ 2 candidates (singletons indicate an unresolved NakedSingle)
  ctx.unit !== null   rule requires a unit context
`.trim();
  readonly priority = 8;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([
    UnitKind.ROW, UnitKind.COL, UnitKind.BOX,
  ]);

  apply(ctx: RuleContext): RuleResult {
    if (!ctx.unit) return emptyResult();
    const board = ctx.board;
    const cells = ctx.unit.cells as Cell[];
    const elims: Elimination[] = [];

    for (const triple of combinations(cells, 3)) {
      const union = new Set<number>();
      for (const [r, c] of triple) for (const d of board.cands(r, c)) union.add(d);
      if (union.size !== 3) continue;
      // Skip combos where any cell is a naked single — NakedSingle (priority 0) fires first
      if (triple.some(([r, c]) => board.cands(r, c).size < 2)) continue;
      const tripleSet = new Set(triple.map(([r, c]) => `${r},${c}`));
      for (const [r, c] of cells) {
        if (tripleSet.has(`${r},${c}`)) continue;
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

    for (const triple of combinations(cells, 3)) {
      const union = new Set<number>();
      for (const [r, c] of triple) for (const d of board.cands(r, c)) union.add(d);
      if (union.size !== 3) continue;
      if (triple.some(([r, c]) => board.cands(r, c).size < 2)) continue;
      const tripleSet = new Set(triple.map(([r, c]) => `${r},${c}`));
      const elims = cells.flatMap(([r, c]) =>
        tripleSet.has(`${r},${c}`) ? [] :
        [...union].filter(d => board.cands(r, c).has(d)).map(d => ({ cell: [r, c] as Cell, digit: d })),
      );
      if (!elims.length) continue;
      const digits = [...union].sort((a, b) => a - b);
      return [{
        ruleName: this.name, displayName: 'Naked Triple',
        explanation: `Naked Triple {${digits.join(',')}} in ${triple.map(([r, c]) => cellLabel([r, c] as Cell)).join(', ')} within ${unitLabel(ctx.unit)}. These digits can be removed from all other cells in the unit.`,
        highlightCells: [...triple as Cell[], ...elims.map(e => e.cell)],
        eliminations: elims, placement: null, virtualCageSuggestion: null,
      }];
    }
    return [];
  }
}
