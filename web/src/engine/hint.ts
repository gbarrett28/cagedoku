/**
 * HintResult: rich output from a solver rule in coach/hint mode.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.hint` module.
 */

import type { Cell, Elimination } from './types.js';

/** Rich hint produced by a single rule application instance. */
export interface HintResult {
  readonly ruleName: string;
  readonly displayName: string;
  readonly explanation: string;
  /** Every cell involved in the reasoning — used for canvas highlighting. */
  readonly highlightCells: readonly Cell[];
  readonly eliminations: readonly Elimination[];
  /** [row, col, digit] if this hint is a placement hint. */
  readonly placement: readonly [number, number, number] | null;
  /** [cells, total] if this hint is a virtual cage suggestion. */
  readonly virtualCageSuggestion: readonly [readonly Cell[], number] | null;
}

export function eliminationCount(h: HintResult): number {
  return h.eliminations.length;
}
