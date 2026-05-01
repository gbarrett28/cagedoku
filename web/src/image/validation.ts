/**
 * Union-find cage validation: Stage 2 of the image pipeline.
 *
 * Mirrors Python's `killer_sudoku.image.validation.validate_cage_layout`.
 * Takes raw border arrays from the clustering stage and produces a validated
 * PuzzleSpec, or throws if the cage layout is inconsistent.
 */

import { ProcessingError } from '../solver/errors.js';
import { buildBrdrs } from '../solver/puzzleSpec.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';



/**
 * Build a string key for a cell to use as a Map key.
 * Using a string key avoids reference-equality pitfalls with arrays.
 */
function rowColKey(row: number, col: number): string {
  return `${row},${col}`;
}

/**
 * Union-find cage regions, validate each cage, and return a PuzzleSpec.
 *
 * Connected components are found by union-find directly on borderX/borderY,
 * avoiding the coordinate-convention pitfalls of the brdrs (9,9,4) expansion.
 *
 * Three consistency checks are applied:
 *   - region_reassigned: two cage heads map to the same connected component.
 *   - invalid_cage: the declared cage total is outside the achievable range for
 *     the connected-component size (too small or too large).
 *   - unassigned_region: at least one cell belongs to a component with no cage
 *     head, meaning the cage-total array is incomplete.
 *
 * @param cageTotals - (9, 9) array [col][row]; non-zero at the top-left of each cage.
 * @param borderX - (9, 8) horizontal cage-wall flags [col][rowGap].
 *   borderX[col][rowGap] = true means a wall between rows rowGap and rowGap+1.
 * @param borderY - (8, 9) vertical cage-wall flags [colGap][row].
 *   borderY[colGap][row] = true means a wall between cols colGap and colGap+1.
 * @returns A fully-validated PuzzleSpec ready for the solver.
 * @throws {ProcessingError} if cage heads clash or a cell is left unassigned.
 * @throws {Error} if a cage total is outside the achievable range for its size.
 */
export function validateCageLayout(
  cageTotals: number[][],
  borderX: boolean[][],
  borderY: boolean[][],
): PuzzleSpec {
  // Union-find: rmap[rowColKey] -> representative cell key.
  // members[repKey] -> set of cell keys in that component.
  const rmap = new Map<string, string>();
  const members = new Map<string, Set<string>>();

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const k = rowColKey(r, c);
      rmap.set(k, k);
      members.set(k, new Set([k]));
    }
  }

  function find(k: string): string {
    return rmap.get(k)!;
  }

  function union(ak: string, bk: string): void {
    const ra = find(ak);
    const rb = find(bk);
    if (ra === rb) return;
    // Always keep the lexicographically smaller key as representative.
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    for (const p of members.get(drop)!) {
      rmap.set(p, keep);
    }
    const keepSet = members.get(keep)!;
    for (const p of members.get(drop)!) {
      keepSet.add(p);
    }
    members.delete(drop);
  }

  // Merge cells across open horizontal borders (no wall between rows).
  // borderX[col][rowGap] = true means wall between rows rowGap and rowGap+1 in col.
  for (let col = 0; col < 9; col++) {
    for (let rowGap = 0; rowGap < 8; rowGap++) {
      if (!borderX[col]![rowGap]!) {
        union(rowColKey(rowGap, col), rowColKey(rowGap + 1, col));
      }
    }
  }

  // Merge cells across open vertical borders (no wall between columns).
  // borderY[colGap][row] = true means wall between colGap and colGap+1 in row.
  for (let colGap = 0; colGap < 8; colGap++) {
    for (let row = 0; row < 9; row++) {
      if (!borderY[colGap]![row]!) {
        union(rowColKey(row, colGap), rowColKey(row, colGap + 1));
      }
    }
  }

  const brdrs = buildBrdrs(borderX, borderY);

  // (9×9) regions array, [row][col], 1-based cage indices.
  const regions: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  let reg = 0;

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (cageTotals[row]![col]! !== 0) {
        const repKey = find(rowColKey(row, col));
        const component = members.get(repKey)!;

        // Check no cell in this component has already been assigned.
        for (const k of component) {
          const [r, c] = k.split(',').map(Number) as [number, number];
          if (regions[r]![c]! !== 0) {
            throw new ProcessingError('region reassigned', regions, brdrs);
          }
        }

        reg += 1;
        const n = component.size;
        const lo = (n * (n + 1)) / 2;
        const hi = (n * (19 - n)) / 2;
        const total = cageTotals[row]![col]!;
        if (total < lo || total > hi) {
          throw new Error(
            `cagesize=${n}, total=${total} at row=${row + 1},col=${col + 1}: must be in [${lo}, ${hi}]`,
          );
        }

        for (const k of component) {
          const [r, c] = k.split(',').map(Number) as [number, number];
          regions[r]![c] = reg;
        }
      }
    }
  }

  // Check all cells have been assigned to a cage.
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (regions[r]![c]! === 0) {
        throw new ProcessingError('unassigned region', regions, brdrs);
      }
    }
  }

  return { regions, cageTotals, borderX, borderY };
}

/**
 * Clamp cage totals that are outside the achievable range for their cage size.
 *
 * Runs the same union-find as validateCageLayout to determine cage sizes, then
 * sets any head-cell total that is below lo or above hi to lo (the minimum).
 * Returns the repaired array and a list of human-readable warnings.
 *
 * Use this as a fallback when validateCageLayout throws an invalid_cage error:
 *   const { repaired, warnings } = repairCageTotals(totals, bx, by);
 *   spec = validateCageLayout(repaired, bx, by);
 */
export function repairCageTotals(
  cageTotals: number[][],
  borderX: boolean[][],
  borderY: boolean[][],
): { repaired: number[][]; warnings: string[] } {
  const rmap = new Map<string, string>();
  const members = new Map<string, Set<string>>();
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const k = rowColKey(r, c);
      rmap.set(k, k);
      members.set(k, new Set([k]));
    }
  }
  const find = (k: string) => rmap.get(k)!;
  const union = (ak: string, bk: string) => {
    const ra = find(ak); const rb = find(bk);
    if (ra === rb) return;
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    for (const p of members.get(drop)!) rmap.set(p, keep);
    const ks = members.get(keep)!;
    for (const p of members.get(drop)!) ks.add(p);
    members.delete(drop);
  };
  for (let col = 0; col < 9; col++)
    for (let rowGap = 0; rowGap < 8; rowGap++)
      if (!borderX[col]![rowGap]!) union(rowColKey(rowGap, col), rowColKey(rowGap + 1, col));
  for (let colGap = 0; colGap < 8; colGap++)
    for (let row = 0; row < 9; row++)
      if (!borderY[colGap]![row]!) union(rowColKey(row, colGap), rowColKey(row, colGap + 1));

  const repaired = cageTotals.map(row => [...row]);
  const warnings: string[] = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const total = repaired[row]![col]!;
      if (total === 0) continue;
      const n = members.get(find(rowColKey(row, col)))!.size;
      const lo = (n * (n + 1)) / 2;
      const hi = (n * (19 - n)) / 2;
      if (total < lo || total > hi) {
        const clamped = total < lo ? lo : hi;
        repaired[row]![col] = clamped;
        warnings.push(`row=${row + 1},col=${col + 1}: read ${total}, clamped to ${clamped} (${n}-cell cage range [${lo}, ${hi}])`);
      }
    }
  }
  return { repaired, warnings };
}
