/**
 * HiddenTriple — hidden triple elimination.
 *
 * Mirrors the hidden-triple branch of Python's
 * `killer_sudoku.solver.engine.rules.incomplete.naked_hidden_triple`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { combinations } from './_helpers.js';
import { cellLabel, unitLabel } from './_labels.js';

export class HiddenTriple {
  readonly name = 'HiddenTriple';
  readonly killerOnly = false;
  readonly displayName = 'Hidden Triple';
  readonly description = `
Hidden Triple — pigeonhole elimination at N=3 in a unit.

If three digits d1, d2, d3 each appear in 2 or 3 cells within a unit, and all such cells form a set of exactly three cells C1, C2, C3, then those three cells must collectively hold d1, d2, d3. Any other candidate in C1, C2, or C3 is impossible.

Guards:
  cellsWith.size === 3   the three digits must be confined to exactly 3 cells
  ctx.unit !== null   rule requires a unit context
`.trim();
  readonly priority = 9;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_DECREASED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([
    UnitKind.ROW, UnitKind.COL, UnitKind.BOX,
  ]);

  apply(ctx: RuleContext): RuleResult {
    if (!ctx.unit) return emptyResult();
    const board = ctx.board;
    const cells = ctx.unit.cells as Cell[];
    const elims: Elimination[] = [];

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
        secondaryHighlightCells: cells.filter(([pr, pc]) => !tripleCells.some(([qr, qc]) => qr === pr && qc === pc)),
        eliminations: elims, placement: null, virtualCageSuggestion: null,
        patternDigits: digits,
      }];
    }
    return [];
  }
}
