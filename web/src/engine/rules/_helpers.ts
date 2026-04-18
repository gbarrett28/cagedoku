/**
 * Shared helpers for rule implementations.
 *
 * Not part of the public rule API — imported only by sibling rule modules.
 */

import type { Cell, Elimination } from '../types.js';

/**
 * Return true if (r1,c1) and (r2,c2) share a row, column, or 3×3 box.
 * Mirrors Python's _sees() used in xy_wing, simple_colouring, unique_rectangle.
 */
export function sees(r1: number, c1: number, r2: number, c2: number): boolean {
  if (r1 === r2 || c1 === c2) return true;
  return (r1 / 3 | 0) === (r2 / 3 | 0) && (c1 / 3 | 0) === (c2 / 3 | 0);
}

/**
 * Return all k-element subsets of arr.
 * Mirrors Python's itertools.combinations(arr, k).
 */
export function combinations<T>(arr: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [
    ...combinations(rest, k - 1).map(c => [first, ...c]),
    ...combinations(rest, k),
  ];
}

/**
 * Remove duplicate eliminations (same cell + digit), preserving order.
 * Mirrors Python's list(dict.fromkeys(elims)).
 */
export function dedupElims(elims: Elimination[]): Elimination[] {
  const seen = new Set<string>();
  return elims.filter(e => {
    const key = `${e.cell[0]},${e.cell[1]}:${e.digit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Compare two cell arrays as sorted sets (order-independent equality).
 * Used by HiddenPair to check whether two digits occupy the same pair of cells.
 */
export function sameCellSet(a: readonly Cell[], b: readonly Cell[]): boolean {
  if (a.length !== b.length) return false;
  const key = (c: Cell) => c[0] * 9 + c[1];
  const sa = [...a].sort((x, y) => key(x) - key(y));
  const sb = [...b].sort((x, y) => key(x) - key(y));
  return sa.every((c, i) => c[0] === sb[i][0] && c[1] === sb[i][1]);
}
