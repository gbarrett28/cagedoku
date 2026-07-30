/**
 * HintResult: rich output from a solver rule in coach/hint mode.
 *
 */

import type { Cell, Elimination } from './types.js';

/** The two colours used for chain-colouring visualisation (user tool and hints). */
export type CellColour = 'blue' | 'green';

/**
 * A structurally significant cell in a chain-style hint (XY-Wing, W-Wing,
 * Two-String Kite, Skyscraper, Simple Colouring), tagged with the digit(s)
 * that matter for *that* cell and an optional wash colour. Lets different
 * chain cells carry different digits, unlike a single rule-wide
 * `patternDigits` list.
 */
export interface ChainCell {
  readonly cell: Cell;
  readonly digits: readonly number[];
  readonly colour?: CellColour;
}

/** Rich hint produced by a single rule application instance. */
export interface HintResult {
  readonly ruleName: string;
  readonly displayName: string;
  readonly explanation: string;
  /**
   * Pattern cells — rendered orange on the canvas. Cells that are also in
   * `eliminations` will be overwritten yellow. For colouring rules, chain cells
   * live in `chainCells` and should not appear here.
   */
  readonly highlightCells: readonly Cell[];
  readonly eliminations: readonly Elimination[];
  /** [row, col, digit] if this hint is a placement hint. */
  readonly placement: readonly [number, number, number] | null;
  /** [cells, total] if this hint is a virtual cage suggestion. */
  readonly virtualCageSuggestion: readonly [readonly Cell[], number] | null;
  /**
   * Per-cell digit/colour tags for chain-style rules. When a cell in
   * `highlightCells` has a matching entry here, the renderer marks that
   * cell's own `digits` instead of falling back to the rule-wide
   * `patternDigits` list, and washes it with the entry's `colour` (if set).
   * Absent for non-chain rules.
   */
  readonly chainCells?: readonly ChainCell[];
  /**
   * Cells rendered with a pale-blue wash to give unit context for the deduction
   * (e.g. "this is the unit in which the digit/tuple is unique"). Distinct from
   * `highlightCells` (orange/yellow) and `chainCells` (chain-colouring blue/green).
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

/** Looks up the `ChainCell` entry for `cell` in `hint.chainCells`, or null if absent. */
export function findChainCell(hint: HintResult, cell: Cell): ChainCell | null {
  if (!hint.chainCells) return null;
  const [r, c] = cell;
  return hint.chainCells.find(cc => cc.cell[0] === r && cc.cell[1] === c) ?? null;
}
