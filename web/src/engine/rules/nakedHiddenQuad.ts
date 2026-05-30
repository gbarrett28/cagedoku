/**
 * NakedHiddenQuad — R9b: naked or hidden quad elimination.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.naked_hidden_quad`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { combinations } from './_helpers.js';
import { cellLabel, unitLabel } from './_labels.js';

export class NakedHiddenQuad {
  readonly name = 'NakedHiddenQuad';
  readonly displayName = 'Naked/Hidden Quad';
  readonly description =
    'When four digits are confined to the same four cells in a unit, ' +
    'those cells can only contain those four digits.';
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

    // --- Naked quad ---
    for (const quad of combinations(cells, 4)) {
      const union = new Set<number>();
      for (const [r, c] of quad) for (const d of board.cands(r, c)) union.add(d);
      if (union.size !== 4) continue;
      const quadSet = new Set(quad.map(([r, c]) => `${r},${c}`));
      for (const [r, c] of cells) {
        if (quadSet.has(`${r},${c}`)) continue;
        for (const d of union) {
          if (board.cands(r, c).has(d))
            elims.push({ cell: [r, c] as Cell, digit: d });
        }
      }
    }
    if (elims.length) return { ...emptyResult(), eliminations: elims };

    // --- Hidden quad ---
    const uid = ctx.unit.unitId;
    const candidateDigits = Array.from({ length: 9 }, (_, i) => i + 1)
      .filter(d => board.count(uid, d) > 1 && board.count(uid, d) <= 4);
    for (const dQuad of combinations(candidateDigits, 4)) {
      const cellsWith = new Set<string>();
      const cellMap = new Map<string, [number, number]>();
      for (const d of dQuad) {
        for (const [r, c] of cells) {
          if (board.cands(r, c).has(d)) {
            cellsWith.add(`${r},${c}`);
            cellMap.set(`${r},${c}`, [r, c]);
          }
        }
      }
      if (cellsWith.size !== 4) continue;
      const quadSet = new Set(dQuad);
      for (const [r, c] of cellMap.values()) {
        for (const d of board.cands(r, c)) {
          if (!quadSet.has(d))
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

    // Naked quad
    for (const quad of combinations(cells, 4)) {
      const union = new Set<number>();
      for (const [r, c] of quad) for (const d of board.cands(r, c)) union.add(d);
      if (union.size !== 4) continue;
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

    // Hidden quad
    const candidateDigits = Array.from({ length: 9 }, (_, i) => i + 1)
      .filter(d => board.count(uid, d) > 1 && board.count(uid, d) <= 4);
    for (const dQuad of combinations(candidateDigits, 4)) {
      const cellMap = new Map<string, Cell>();
      for (const d of dQuad)
        for (const [r, c] of cells)
          if (board.cands(r, c).has(d)) cellMap.set(`${r},${c}`, [r, c] as Cell);
      if (cellMap.size !== 4) continue;
      const quadSet = new Set(dQuad);
      const quadCells = [...cellMap.values()];
      const elims = quadCells.flatMap(([r, c]) =>
        [...board.cands(r, c)].filter(d => !quadSet.has(d)).map(d => ({ cell: [r, c] as Cell, digit: d })),
      );
      if (!elims.length) continue;
      const digits = [...dQuad].sort((a, b) => a - b);
      return [{
        ruleName: this.name, displayName: 'Hidden Quad',
        explanation: `Hidden Quad: {${digits.join(',')}} are confined to ${quadCells.map(c => cellLabel(c)).join(', ')} within ${unitLabel(ctx.unit)}. Remove all other candidates from these cells.`,
        highlightCells: [...quadCells, ...elims.map(e => e.cell)],
        eliminations: elims, placement: null, virtualCageSuggestion: null,
      }];
    }
    return [];
  }
}
