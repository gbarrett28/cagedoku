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
   * Pattern cells — rendered orange on the canvas. Cells that are also in
   * `eliminations` will be overwritten yellow. For colouring rules, chain cells
   * live in `colourGroups` and should not appear here.
   */
  readonly highlightCells: readonly Cell[];
  readonly eliminations: readonly Elimination[];
  /** [row, col, digit] if this hint is a placement hint. */
  readonly placement: readonly [number, number, number] | null;
  /** [cells, total] if this hint is a virtual cage suggestion. */
  readonly virtualCageSuggestion: readonly [readonly Cell[], number] | null;
  /** Two colour groups for bipartite-chain rules; absent for all other rules. */
  readonly colourGroups?: readonly ColourGroup[];
  /**
   * Cells rendered with a pale-blue wash to give unit context for the deduction
   * (e.g. "this is the unit in which the digit/tuple is unique"). Distinct from
   * `highlightCells` (orange/yellow) and `colourGroups` (chain-colouring blue/green).
   */
  readonly secondaryHighlightCells?: readonly Cell[];
  /**
   * Digits key to the rule's reasoning — marked with squares in `highlightCells`.
   * Absent for most rules; the renderer then derives them from `eliminations`
   * (or `placement[2]` for placement hints). Set explicitly only when pattern
   * digits differ from elimination digits (Hidden Single/Pair/Triple/Quad).
   */
  readonly patternDigits?: readonly number[];
}

export function eliminationCount(h: HintResult): number {
  return h.eliminations.length;
}
