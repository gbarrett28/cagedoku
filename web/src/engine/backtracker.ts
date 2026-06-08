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

/**
 * Cage-sum data for mrvBacktrack's validity check — built by
 * KillerBoardState.cageConstraints(); plain BoardState has none (null).
 */
export interface CageConstraints {
  readonly cageOf: number[][];
  readonly cageTotal: ReadonlyMap<number, number>;
  readonly cageCells: ReadonlyMap<number, readonly Cell[]>;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Find a solution via MRV backtracking from a partially-solved BoardState.
 *
 * Asks the board for its cage constraints (null for a plain classic board —
 * search() then degrades to pure row/col/box backtracking), copies current
 * candidate sets, and searches for a valid completion. Forward checking keeps
 * the branching factor small.
 *
 * Returns a 9×9 grid of placed digits, or null if unsolvable from this state.
 */
export function mrvBacktrack(board: BoardState): number[][] | null {
  const constraints = board.cageConstraints();
  const cageOf: number[][] = constraints?.cageOf ?? Array.from({length: 9}, () => new Array<number>(9).fill(0));
  const cageTotal: ReadonlyMap<number, number> = constraints?.cageTotal ?? new Map();
  const cageCells: ReadonlyMap<number, readonly Cell[]> = constraints?.cageCells ?? new Map();

  const cands: Set<number>[][] = Array.from({length: 9}, (_, r) =>
    Array.from({length: 9}, (__, c) => new Set(board.cands(r, c))));

  const solution = search(cands, cageOf, cageTotal, cageCells, { n: 0 });
  if (solution !== null && !gridValid(solution)) {
    console.error('mrvBacktrack: search returned an invalid solution — treating as unsolvable');
    return null;
  }
  return solution;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns true iff the 9×9 grid has no duplicate in any row, column, or 3×3 box. */
function gridValid(grid: number[][]): boolean {
  for (let i = 0; i < 9; i++) {
    const rowSeen = new Set<number>(), colSeen = new Set<number>();
    for (let j = 0; j < 9; j++) {
      const rv = grid[i]![j]!;
      const cv = grid[j]![i]!;
      if (rowSeen.has(rv) || colSeen.has(cv)) return false;
      rowSeen.add(rv); colSeen.add(cv);
    }
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const boxSeen = new Set<number>();
      for (let r = br * 3; r < br * 3 + 3; r++) {
        for (let c = bc * 3; c < bc * 3 + 3; c++) {
          const v = grid[r]![c]!;
          if (boxSeen.has(v)) return false;
          boxSeen.add(v);
        }
      }
    }
  }
  return true;
}

/**
 * Check whether a cage's current candidate state is still consistent with its sum constraint.
 *
 * Sums placed digits (singleton candidate sets) and checks that the remaining unplaced
 * cells can still reach the target total using distinct digits 1–9. Returns true if no
 * constraint is violated and the sum remains reachable; returns false immediately if any
 * cell has an empty candidate set or the placed sum already exceeds the total.
 */
function cageValid(
  cands: Set<number>[][],
  cid: number,
  cageTotal: ReadonlyMap<number, number>,
  cageCells: ReadonlyMap<number, readonly Cell[]>,
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

/**
 * Assign digit `d` to cell (r, c) and propagate via unit-arc consistency.
 *
 * Mutates `cands` in place. Eliminates `d` from all peers (same row/col/box);
 * when a peer is reduced to a singleton, enqueues it for further propagation.
 * Validates the affected cage after each step. Returns false (contradiction) if
 * any cell's candidate set becomes empty or any cage constraint is violated;
 * otherwise returns true.
 */
function assign(
  cands: Set<number>[][],
  r: number,
  c: number,
  d: number,
  cageOf: number[][],
  cageTotal: ReadonlyMap<number, number>,
  cageCells: ReadonlyMap<number, readonly Cell[]>,
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

/**
 * Recursive MRV backtracking search over candidate sets.
 *
 * Selects the unassigned cell with the fewest remaining candidates (minimum remaining
 * values heuristic), tries each candidate via `assign`, and recurses. Returns the
 * completed 9×9 grid on success or `null` on contradiction or node-limit breach
 * (`counter.n > MAX_BACKTRACK_NODES`).
 */
function search(
  cands: Set<number>[][],
  cageOf: number[][],
  cageTotal: ReadonlyMap<number, number>,
  cageCells: ReadonlyMap<number, readonly Cell[]>,
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
    // All cells are singletons. Validate rows, columns, and boxes before returning —
    // contradictory board states can leave a wrong singleton due to applyEliminations'
    // size-≤1 guard, producing an all-singleton grid that is not a valid sudoku solution.
    for (let i = 0; i < 9; i++) {
      const rowSeen = new Set<number>(), colSeen = new Set<number>();
      for (let j = 0; j < 9; j++) {
        const rv = cands[i]![j]!.values().next().value as number;
        const cv = cands[j]![i]!.values().next().value as number;
        if (rowSeen.has(rv) || colSeen.has(cv)) return null;
        rowSeen.add(rv); colSeen.add(cv);
      }
    }
    for (let br = 0; br < 3; br++) {
      for (let bc = 0; bc < 3; bc++) {
        const boxSeen = new Set<number>();
        for (let r = br * 3; r < br * 3 + 3; r++) {
          for (let c = bc * 3; c < bc * 3 + 3; c++) {
            const v = cands[r]![c]!.values().next().value as number;
            if (boxSeen.has(v)) return null;
            boxSeen.add(v);
          }
        }
      }
    }
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
