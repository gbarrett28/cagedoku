/**
 * Cage equation utilities: Phase 2 of the solver.
 *
 * Mirrors Python's `killer_sudoku.solver.equation` module (sol_sums only).
 * The Equation class is not ported — only the rule engine uses sol_sums at
 * inference time; the old Grid/Equation batch-solver path is not used in the
 * browser build.
 */

/**
 * Enumerate all sets of n distinct digits > m whose elements sum to v.
 *
 * Mirrors Python's sol_sums(). Used by BoardState to populate cage_solns and
 * by the LinearSystem for virtual cage derivation.
 *
 * @param n    Number of cells in the cage.
 * @param m    Lower bound: digits must be strictly greater than m.
 * @param v    Target sum.
 * @param maxDigit  Upper bound for valid digits (default 9).
 * @returns    Array of digit sets, each represented as a sorted number[].
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
