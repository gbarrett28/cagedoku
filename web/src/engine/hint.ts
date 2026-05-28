/**
 * HintResult: rich output from a solver rule in coach/hint mode.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.hint` module.
 */

import type { Cell, Elimination } from './types.js';

/** The two colours used for chain-colouring visualisation (user tool and hints). */
export type CellColour = 'blue' | 'green';

/** A named colour group for bipartite-chain hints (e.g. SimpleColouring). */
export interface ColourGroup {
  readonly cells: readonly Cell[];
  readonly colour: CellColour;
}

/** Rich hint produced by a single rule application instance. */
export interface HintResult {
  readonly ruleName: string;
  readonly displayName: string;
  readonly explanation: string;
  /**
   * Elimination-target cells — used for the standard yellow canvas highlight.
   * For colouring rules this contains only the eliminated cells; chain cells
   * live in colourGroups instead.
   */
  readonly highlightCells: readonly Cell[];
  readonly eliminations: readonly Elimination[];
  /** [row, col, digit] if this hint is a placement hint. */
  readonly placement: readonly [number, number, number] | null;
  /** [cells, total] if this hint is a virtual cage suggestion. */
  readonly virtualCageSuggestion: readonly [readonly Cell[], number] | null;
  /** Two colour groups for bipartite-chain rules; absent for all other rules. */
  readonly colourGroups?: readonly ColourGroup[];
}

export function eliminationCount(h: HintResult): number {
  return h.eliminations.length;
}
