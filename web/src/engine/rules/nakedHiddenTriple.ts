/**
 * NakedHiddenTriple — R9: naked or hidden triple elimination.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.naked_hidden_triple`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { combinations } from './_helpers.js';
import { cellLabel, unitLabel } from './_labels.js';

export class NakedHiddenTriple {
  readonly name = 'NakedHiddenTriple';
  readonly displayName = 'Naked/Hidden Triple';
  readonly description = `
Naked/Hidden Triple — pigeonhole elimination at N=3 in a unit.

Naked Triple: if three cells in a unit have a candidate union of exactly {d1, d2, d3}, those three cells must collectively hold d1, d2, d3. By pigeonhole, no other cell in the unit can hold any of these three digits → eliminate {d1,d2,d3} from all other unit cells.

Hidden Triple: if three digits d1, d2, d3 each appear in 2 or 3 cells within a unit, and all such cells form a set of exactly three cells C1, C2, C3, then those three cells must collectively hold d1, d2, d3. Any other candidate in C1, C2, or C3 is impossible.

Guards:
  union.size === 3   naked: union of candidates across the 3 cells must be exactly 3 digits
  each(cell).size ≥ 2   naked: every cell in the triple must have ≥ 2 candidates (singletons indicate an unresolved NakedSingle)
  cellsWith.size === 3   hidden: the three digits must be confined to exactly 3 cells
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

    // --- Naked triple: three cells whose union of candidates has exactly 3 digits ---
    for (const triple of combinations(cells, 3)) {
      const union = new Set<number>();
      for (const [r, c] of triple) for (const d of board.cands(r, c)) union.add(d);
      if (union.size !== 3) continue;
      // Skip combos where any cell is a naked single — NakedSingle (priority 1) fires first
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

  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[] {
    if (!eliminations.length || !ctx.unit) return [];
    const board = ctx.board;
    const cells = ctx.unit.cells as Cell[];
    const uid = ctx.unit.unitId;

    // Naked triple: three cells whose candidate union has exactly 3 digits
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

    // Hidden triple: three digits confined to exactly 3 cells
    const candidateDigits = Array.from({ length: 9 }, (_, i) => i + 1)
      .filter(d => board.count(uid, d) > 1 && board.count(uid, d) <= 3);
    for (const dTriple of combinations(candidateDigits, 3)) {
      const cellMap = new Map<string, Cell>();
      for (const d of dTriple)
        for (const [r, c] of cells)
          if (board.cands(r, c).has(d)) cellMap.set(`${r},${c}`, [r, c] as Cell);
      if (cellMap.size !== 3) continue;
      const tripleSet = new Set(dTriple);
      const tripleCells = [...cellMap.values()];
      const elims = tripleCells.flatMap(([r, c]) =>
        [...board.cands(r, c)].filter(d => !tripleSet.has(d)).map(d => ({ cell: [r, c] as Cell, digit: d })),
      );
      if (!elims.length) continue;
      const digits = [...dTriple].sort((a, b) => a - b);
      return [{
        ruleName: this.name, displayName: 'Hidden Triple',
        explanation: `Hidden Triple: {${digits.join(',')}} are confined to ${tripleCells.map(c => cellLabel(c)).join(', ')} within ${unitLabel(ctx.unit)}. Remove all other candidates from these cells.`,
        highlightCells: [...tripleCells, ...elims.map(e => e.cell)],
        eliminations: elims, placement: null, virtualCageSuggestion: null,
      }];
    }
    return [];
  }
}
