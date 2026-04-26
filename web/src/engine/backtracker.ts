/**
 * MRV backtracker fallback for the solver engine.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.backtracker` module.
 *
 * Called when the rule-based engine stalls. Applies MRV (Minimum Remaining
 * Values) cell ordering with forward checking (peer elimination + naked-single
 * cascade) to search for a solution.
 *
 * Works identically for classic and killer sudoku — the cage sum constraints
 * are included in the validity check when cage_total > 0.
 */

import type { BoardState } from './boardState.js';
import type { Cell } from './types.js';

// ---------------------------------------------------------------------------
// Precomputed peer sets: peers[r][c] = all cells sharing a row, col, or box
// ---------------------------------------------------------------------------

const PEERS: readonly (readonly Cell[])[][] = Array.from({length: 9}, (_, r) =>
  Array.from({length: 9}, (__, c) =>
    [
      ...Array.from({length: 9}, (_, c2): Cell => [r, c2] as Cell).filter(([, c2]) => c2 !== c),
      ...Array.from({length: 9}, (_, r2): Cell => [r2, c] as Cell).filter(([r2]) => r2 !== r),
      ...Array.from({length: 9}, (_, k): Cell => [
        (r / 3 | 0) * 3 + (k / 3 | 0),
        (c / 3 | 0) * 3 + (k % 3),
      ] as Cell).filter(([pr, pc]) => !(pr === r && pc === c)),
    ].filter(([pr, pc], i, arr) =>
      arr.findIndex(([qr, qc]) => qr === pr && qc === pc) === i
    )
  )
);

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Find a solution via MRV backtracking from a partially-solved BoardState.
 *
 * Extracts cage constraints, copies current candidate sets, and searches for
 * a valid completion. Forward checking keeps the branching factor small.
 *
 * Returns a 9×9 grid of placed digits, or null if unsolvable from this state.
 */
export function mrvBacktrack(board: BoardState): number[][] | null {
  const cageOf  = Array.from({length: 9}, () => new Array<number>(9).fill(0));
  const cageTotal = new Map<number, number>();
  const cageCells = new Map<number, Cell[]>();

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cid = board.spec.regions[r]![c]!; // 1-based
      cageOf[r]![c] = cid;
      if (!cageCells.has(cid)) cageCells.set(cid, []);
      cageCells.get(cid)!.push([r, c] as Cell);
      const t = board.spec.cageTotals[r]![c]!;
      if (t !== 0) cageTotal.set(cid, t);
    }
  }

  const cands: Set<number>[][] = Array.from({length: 9}, (_, r) =>
    Array.from({length: 9}, (__, c) => new Set(board.cands(r, c))));

  return search(cands, cageOf, cageTotal, cageCells, { n: 0 });
}

// ---------------------------------------------------------------------------
// Internal search
// ---------------------------------------------------------------------------

function cageValid(
  cands: Set<number>[][],
  cid: number,
  cageTotal: Map<number, number>,
  cageCells: Map<number, Cell[]>,
): boolean {
  const total = cageTotal.get(cid);
  if (total === undefined) return true;
  const cells = cageCells.get(cid)!;
  let placedSum = 0, remaining = 0;
  for (const [r, c] of cells) {
    const s = cands[r]![c]!;
    if (s.size === 0) return false;
    if (s.size === 1) placedSum += s.values().next().value as number;
    else remaining++;
  }
  if (placedSum > total) return false;
  if (remaining === 0) return placedSum === total;
  const needed = total - placedSum;
  const minFill = (remaining * (remaining + 1)) >> 1;
  const maxFill = remaining * 9 - ((remaining * (remaining - 1)) >> 1);
  return minFill <= needed && needed <= maxFill;
}

function assign(
  cands: Set<number>[][],
  r: number,
  c: number,
  d: number,
  cageOf: number[][],
  cageTotal: Map<number, number>,
  cageCells: Map<number, Cell[]>,
): boolean {
  cands[r]![c] = new Set([d]);
  const queue: Array<[number, number, number]> = [[r, c, d]];

  while (queue.length > 0) {
    const [r0, c0, d0] = queue.pop()!;
    if (!cageValid(cands, cageOf[r0]![c0]!, cageTotal, cageCells)) return false;
    for (const [r2, c2] of PEERS[r0]![c0]!) {
      const s = cands[r2]![c2]!;
      if (!s.has(d0)) continue;
      s.delete(d0);
      if (s.size === 0) return false;
      if (s.size === 1) {
        const dNew = s.values().next().value as number;
        queue.push([r2, c2, dNew]);
        if (!cageValid(cands, cageOf[r2]![c2]!, cageTotal, cageCells)) return false;
      }
    }
  }
  return true;
}

const MAX_BACKTRACK_NODES = 100_000;

function search(
  cands: Set<number>[][],
  cageOf: number[][],
  cageTotal: Map<number, number>,
  cageCells: Map<number, Cell[]>,
  counter: { n: number },
): number[][] | null {
  if (++counter.n > MAX_BACKTRACK_NODES) return null;

  let minCount = 10;
  let best: [number, number] | null = null;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const n = cands[r]![c]!.size;
      if (n === 0) return null;
      if (n > 1 && n < minCount) { minCount = n; best = [r, c]; }
    }
  }
  if (best === null) {
    return Array.from({length: 9}, (_, r) =>
      Array.from({length: 9}, (__, c) => cands[r]![c]!.values().next().value as number));
  }

  const [r, c] = best;
  for (const d of [...cands[r]![c]!].sort((a, b) => a - b)) {
    const newCands: Set<number>[][] = Array.from({length: 9}, (_, r2) =>
      Array.from({length: 9}, (__, c2) => new Set(cands[r2]![c2]!)));
    if (assign(newCands, r, c, d, cageOf, cageTotal, cageCells)) {
      const result = search(newCands, cageOf, cageTotal, cageCells, counter);
      if (result !== null) return result;
    }
  }
  return null;
}
