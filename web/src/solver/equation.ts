/**
 * Cage equation utilities: Phase 2 of the solver.
 *
 * Mirrors Python's `killer_sudoku.solver.equation` module (sol_sums only).
 * The Equation class is not ported — only the rule engine uses sol_sums at
 * inference time; the old Grid/Equation batch-solver path is not used in the
 * browser build.
 */

/** One valid digit assignment for a difference virtual cage. */
export interface DiffSolution {
  /** Sorted ascending digits assigned to positive-role cells. */
  readonly pos: readonly number[];
  /** Sorted ascending digits assigned to negative-role cells. */
  readonly neg: readonly number[];
}

/**
 * Enumerate all sets of n distinct digits > m whose elements sum to v.
 *
 * Mirrors Python's sol_sums(). Used by KillerBoardState to populate cage_solns and
 * by the LinearSystem for virtual cage derivation.
 *
 * @param n    Number of cells in the cage.
 * @param m    Lower bound: digits must be strictly greater than m.
 * @param v    Target sum.
 * @param maxDigit  Upper bound for valid digits (default 9).
 * @returns    Array of solutions; each solution is a sorted ascending `number[]` of distinct digits.
 */
export function solSums(
  n: number,
  m: number,
  v: number,
  maxDigit = 9,
): number[][] {
  const sq = (n * (n - 1)) >> 1;
  const lo = n * (m + 1) + sq;
  const hi = n * maxDigit - sq;
  if (!(lo <= v && v <= hi)) return [];
  if (n === 1) return [[v]];
  const solns: number[][] = [];
  for (let i = m + 1; i < Math.min(maxDigit + 1, v); i++) {
    for (const s of solSums(n - 1, i, v - i, maxDigit)) {
      solns.push([...s, i].sort((a, b) => a - b));
    }
  }
  return solns;
}

/**
 * Enumerate all ways to assign distinct digits to two groups (positive/negative)
 * such that sum(pos) − sum(neg) = target and target >= 0.
 *
 * All posCount + negCount digits are distinct (from 1–9). Each returned
 * DiffSolution has sorted ascending pos and neg arrays.
 */
export function solDiffs(posCount: number, negCount: number, target: number): DiffSolution[] {
  if (target < 0 || posCount < 1 || negCount < 1) return [];
  const n = posCount + negCount;
  if (n > 9) return [];
  const results: DiffSolution[] = [];

  // Enumerate all size-n subsets S of {1..9}
  function pickAll(start: number, chosen: number[]): void {
    if (chosen.length === n) {
      const s = chosen.reduce((a, b) => a + b, 0);
      // sum(pos) = (target + s) / 2 must be a positive integer
      const posSum = (target + s);
      if (posSum % 2 !== 0) return;
      const ps = posSum / 2;
      // Find all subsets of chosen with size=posCount that sum to ps
      function pickPos(idx: number, remaining: number, current: number[]): void {
        if (current.length === posCount) {
          if (remaining !== 0) return;
          const posSet = new Set(current);
          const neg = chosen.filter(d => !posSet.has(d));
          results.push({ pos: [...current].sort((a, b) => a - b), neg: neg.sort((a, b) => a - b) });
          return;
        }
        const left = posCount - current.length;
        if (idx > chosen.length - left) return;
        // Include chosen[idx]
        current.push(chosen[idx]!);
        pickPos(idx + 1, remaining - chosen[idx]!, current);
        current.pop();
        // Skip chosen[idx]
        pickPos(idx + 1, remaining, current);
      }
      pickPos(0, ps, []);
      return;
    }
    const need = n - chosen.length;
    for (let d = start; d <= 9 - need + 1; d++) {
      chosen.push(d);
      pickAll(d + 1, chosen);
      chosen.pop();
    }
  }
  pickAll(1, []);
  return results;
}
