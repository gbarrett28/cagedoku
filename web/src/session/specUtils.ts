/**
 * Utility functions for converting between PuzzleSpec, PuzzleSpecData, and CageState[].
 *
 * Mirrors Python helpers in api/routers/puzzle.py:
 *   _cage_label, _virtual_cage_key, _spec_to_data, _data_to_spec,
 *   _spec_to_cage_states, _cage_states_to_spec
 */

import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import type { CageState, CellPosition, PuzzleSpecData, VirtualCage } from './types.js';
import type { Cell } from '../engine/types.js';

// ---------------------------------------------------------------------------
// Label generation — Excel-column-style (A, B, ..., Z, AA, AB, ...)
// ---------------------------------------------------------------------------

/**
 * Returns the Excel-column-style label for a 0-based cage index.
 * 0→A, 25→Z, 26→AA, 27→AB, …
 */
export function cageLabel(i: number): string {
  let label = '';
  let n = i;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

// ---------------------------------------------------------------------------
// Virtual cage key — stable identity for a user-defined cage
// ---------------------------------------------------------------------------

/**
 * Builds a stable string key for a virtual cage.
 * Format: "r,c:r,c:...:total" with cells sorted by row then col.
 */
export function virtualCageKey(cells: readonly Cell[], total: number): string {
  const sorted = [...cells].sort(([r1, c1], [r2, c2]) => r1 - r2 || c1 - c2);
  return [...sorted.map(([r, c]) => `${r},${c}`), String(total)].join(':');
}

// ---------------------------------------------------------------------------
// PuzzleSpec ↔ PuzzleSpecData
// ---------------------------------------------------------------------------

/**
 * Converts a PuzzleSpec to the wire-format PuzzleSpecData.
 * regions[row][col] and cageTotals[row][col] — no transposition needed
 * because PuzzleSpec.regions already uses [row][col] ordering in TS.
 */
export function specToData(spec: PuzzleSpec): PuzzleSpecData {
  return {
    regions: spec.regions.map(row => [...row]),
    cageTotals: spec.cageTotals.map(row => [...row]),
  };
}

/**
 * Converts a PuzzleSpecData to a PuzzleSpec.
 * Border arrays are derived from region adjacency: a wall exists between two
 * cells in the same row/column whose cage indices differ.
 */
export function dataToSpec(data: PuzzleSpecData): PuzzleSpec {
  const regions = data.regions.map(row => [...row]);
  const cageTotals = data.cageTotals.map(row => [...row]);

  // borderX[col][rowGap]: wall between rows rowGap and rowGap+1 in column col
  const borderX: boolean[][] = Array.from({ length: 9 }, (_, c) =>
    Array.from({ length: 8 }, (__, rowGap) =>
      regions[rowGap]![c]! !== regions[rowGap + 1]![c]!,
    ),
  );

  // borderY[colGap][row]: wall between columns colGap and colGap+1 in row
  const borderY: boolean[][] = Array.from({ length: 8 }, (_, colGap) =>
    Array.from({ length: 9 }, (__, r) =>
      regions[r]![colGap]! !== regions[r]![colGap + 1]!,
    ),
  );

  return { regions, cageTotals, borderX, borderY };
}

// ---------------------------------------------------------------------------
// CageState ↔ PuzzleSpec
// ---------------------------------------------------------------------------

/**
 * Extracts cage labels, totals, and cell lists from a PuzzleSpec.
 * Cells use 1-based row/col (matching Python and main.ts).
 */
export function specToCageStates(spec: PuzzleSpec): CageState[] {
  // Group cells by cage index (0-based internally)
  const cageMap = new Map<number, { total: number; cells: CellPosition[] }>();
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const idx = spec.regions[r]![c]! - 1; // 0-based
      const total = spec.cageTotals[r]![c]!;
      if (!cageMap.has(idx)) {
        cageMap.set(idx, { total: 0, cells: [] });
      }
      const entry = cageMap.get(idx)!;
      if (total !== 0) entry.total = total;
      entry.cells.push({ row: r + 1, col: c + 1 });
    }
  }

  // Sort by cage index to produce stable label assignment
  return [...cageMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([idx, { total, cells }]) => ({ label: cageLabel(idx), total, cells, userEliminatedSolns: [] }));
}

/**
 * Reconstructs a PuzzleSpec from CageStates and a base PuzzleSpecData.
 * Used when cage totals are edited by the user.
 */
export function cageStatesToSpec(cages: readonly CageState[], base: PuzzleSpecData): PuzzleSpec {
  const regions = base.regions.map(row => [...row]);
  const cageTotals: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));

  for (const cage of cages) {
    // Find the first cell alphabetically to place the total (matches Python's head-cell convention)
    const sorted = [...cage.cells].sort((a, b) => a.row - b.row || a.col - b.col);
    const head = sorted[0]!;
    cageTotals[head.row - 1]![head.col - 1] = cage.total;
  }

  return dataToSpec({ regions, cageTotals });
}

// ---------------------------------------------------------------------------
// Virtual cage key helper (for VirtualCage objects)
// ---------------------------------------------------------------------------

export function virtualCageKeyFromCage(cage: VirtualCage): string {
  return virtualCageKey(cage.cells, cage.total);
}
