/**
 * SimpleColouring — R18: Single-digit chain colouring.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.simple_colouring`.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { dedupElims, sees } from './_helpers.js';

export class SimpleColouring {
  readonly name = 'SimpleColouring';
  readonly description =
    'Uses chains of cells where a digit can only go in one of two places to ' +
    'eliminate that digit from cells that see both ends of the chain.';
  readonly priority = 18;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    const board = ctx.board;
    const elims: Elimination[] = [];

    for (let d = 1; d <= 9; d++) {
      // Build conjugate-pair adjacency graph: units where d appears in exactly 2 cells
      const adj = new Map<string, string[]>();
      const cellKey = (r: number, c: number) => `${r},${c}`;
      const addEdge = (r1: number, c1: number, r2: number, c2: number) => {
        const a = cellKey(r1, c1), b = cellKey(r2, c2);
        if (!adj.has(a)) adj.set(a, []);
        if (!adj.has(b)) adj.set(b, []);
        adj.get(a)!.push(b);
        adj.get(b)!.push(a);
      };

      // Row conjugate pairs
      for (let r = 0; r < 9; r++) {
        const cols = Array.from({ length: 9 }, (_, c) => c).filter(c => board.cands(r, c).has(d));
        if (cols.length === 2) addEdge(r, cols[0]!, r, cols[1]!);
      }
      // Column conjugate pairs
      for (let c = 0; c < 9; c++) {
        const rows = Array.from({ length: 9 }, (_, r) => r).filter(r => board.cands(r, c).has(d));
        if (rows.length === 2) addEdge(rows[0]!, c, rows[1]!, c);
      }
      // Box conjugate pairs
      for (let br = 0; br < 3; br++) {
        for (let bc = 0; bc < 3; bc++) {
          const boxCells: [number, number][] = [];
          for (let dr = 0; dr < 3; dr++)
            for (let dc = 0; dc < 3; dc++) {
              const r = br * 3 + dr, c = bc * 3 + dc;
              if (board.cands(r, c).has(d)) boxCells.push([r, c]);
            }
          if (boxCells.length === 2) addEdge(boxCells[0]![0], boxCells[0]![1], boxCells[1]![0], boxCells[1]![1]);
        }
      }

      // BFS 2-colouring per connected component
      const colour = new Map<string, number>();
      const componentOf = new Map<string, number>();
      let compId = 0;

      for (const start of adj.keys()) {
        if (componentOf.has(start)) continue;
        const queue: string[] = [start];
        componentOf.set(start, compId);
        colour.set(start, 0);
        let head = 0;
        while (head < queue.length) {
          const cell = queue[head++]!;
          for (const nb of adj.get(cell)!) {
            if (!colour.has(nb)) colour.set(nb, 1 - colour.get(cell)!);
            if (!componentOf.has(nb)) {
              componentOf.set(nb, compId);
              queue.push(nb);
            }
          }
        }
        compId++;
      }

      // Build per-component colour sets as arrays of [r, c]
      const compColours = new Map<number, [[number, number][], [number, number][]]>();
      for (const [key, cid] of componentOf) {
        if (!compColours.has(cid)) compColours.set(cid, [[], []]);
        const [r, c] = key.split(',').map(Number) as [number, number];
        compColours.get(cid)![colour.get(key)!]!.push([r, c]);
      }

      for (const [c0Cells, c1Cells] of compColours.values()) {
        if (!c0Cells.length || !c1Cells.length) continue;

        // Wrap: two same-colour cells see each other → eliminate that colour
        const hasConflict = (cells: [number, number][]) =>
          cells.some(([r1, c1], i) =>
            cells.slice(i + 1).some(([r2, c2]) => sees(r1, c1, r2, c2)),
          );

        if (hasConflict(c0Cells)) {
          for (const [r, c] of c0Cells)
            if (board.cands(r, c).has(d))
              elims.push({ cell: [r, c] as Cell, digit: d });
          continue;
        }
        if (hasConflict(c1Cells)) {
          for (const [r, c] of c1Cells)
            if (board.cands(r, c).has(d))
              elims.push({ cell: [r, c] as Cell, digit: d });
          continue;
        }

        // Trap: uncoloured cell sees both colours → eliminate
        const allColoured = new Set([...c0Cells, ...c1Cells].map(([r, c]) => cellKey(r, c)));
        for (let r = 0; r < 9; r++) {
          for (let c = 0; c < 9; c++) {
            if (allColoured.has(cellKey(r, c))) continue;
            if (!board.cands(r, c).has(d)) continue;
            const seesC0 = c0Cells.some(([cr, cc]) => sees(r, c, cr, cc));
            const seesC1 = c1Cells.some(([cr, cc]) => sees(r, c, cr, cc));
            if (seesC0 && seesC1)
              elims.push({ cell: [r, c] as Cell, digit: d });
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
