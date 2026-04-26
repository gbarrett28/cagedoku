/**
 * NakedHiddenTriple — R9: naked or hidden triple elimination.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.naked_hidden_triple`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { combinations } from './_helpers.js';

export class NakedHiddenTriple {
  readonly name = 'NakedHiddenTriple';
  readonly description =
    'When three digits are confined to the same three cells in a unit, ' +
    'those cells can only contain those three digits.';
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

    // --- Naked triple: three cells whose union of candidates has exactly 3 digits ---
    for (const triple of combinations(cells, 3)) {
      const union = new Set<number>();
      for (const [r, c] of triple) for (const d of board.cands(r, c)) union.add(d);
      if (union.size !== 3) continue;
      const tripleSet = new Set(triple.map(([r, c]) => `${r},${c}`));
      for (const [r, c] of cells) {
        if (tripleSet.has(`${r},${c}`)) continue;
        for (const d of union) {
          if (board.cands(r, c).has(d))
            elims.push({ cell: [r, c] as Cell, digit: d });
        }
      }
    }
    if (elims.length) return { ...emptyResult(), eliminations: elims };

    // --- Hidden triple: three digits each appearing in 2-3 cells, covering exactly 3 cells ---
    const uid = ctx.unit.unitId;
    const candidateDigits = Array.from({ length: 9 }, (_, i) => i + 1)
      .filter(d => board.count(uid, d) > 1 && board.count(uid, d) <= 3);
    for (const dTriple of combinations(candidateDigits, 3)) {
      const cellsWith = new Set<string>();
      const cellMap = new Map<string, [number, number]>();
      for (const d of dTriple) {
        for (const [r, c] of cells) {
          if (board.cands(r, c).has(d)) {
            cellsWith.add(`${r},${c}`);
            cellMap.set(`${r},${c}`, [r, c]);
          }
        }
      }
      if (cellsWith.size !== 3) continue;
      const tripleSet = new Set(dTriple);
      for (const [r, c] of cellMap.values()) {
        for (const d of board.cands(r, c)) {
          if (!tripleSet.has(d))
            elims.push({ cell: [r, c] as Cell, digit: d });
        }
      }
    }
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(_ctx: RuleContext, _eliminations: readonly Elimination[]): HintResult[] {
    return [];
  }
}
