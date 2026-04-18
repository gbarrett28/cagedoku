/**
 * Core value types for the solver engine.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.types` module.
 * Pure data — no logic, no imports from the rest of the engine.
 */

/** A cell address: [row, col], both 0-based. */
export type Cell = readonly [number, number];

/** Stringify a Cell for use as a Map key. */
export function cellKey(cell: Cell): string {
  return `${cell[0]},${cell[1]}`;
}

/** The four kinds of units in a killer/classic sudoku grid. */
export enum UnitKind {
  ROW = 0,
  COL = 1,
  BOX = 2,
  CAGE = 3,
}

/** A typed, indexed group of cells (row, col, box, or cage). */
export interface Unit {
  readonly unitId: number;
  readonly kind: UnitKind;
  readonly cells: readonly Cell[];
  /**
   * Whether the cells are guaranteed to hold distinct digits.
   * True for rows, cols, boxes, and burb virtual cages.
   * False for non-burb derived sum constraints.
   */
  readonly distinctDigits: boolean;
}

/** Events that fire when board state changes. */
export enum Trigger {
  CELL_DETERMINED = 0,  // candidates[r][c] became a singleton
  COUNT_HIT_ONE   = 1,  // counts[unit][digit] just reached 1 (hidden single)
  COUNT_HIT_TWO   = 2,  // counts[unit][digit] just reached 2 (pair candidate)
  COUNT_DECREASED = 3,  // counts[unit][digit] decreased (any amount)
  SOLUTION_PRUNED = 4,  // a cage solution was eliminated
  GLOBAL          = 5,  // fires when unit queue is otherwise empty
  CELL_SOLVED     = 6,  // cell solution officially committed (fires after CELL_DETERMINED)
}

/** A single inference: remove digit from a cell's candidate set. */
export interface Elimination {
  readonly cell: Cell;
  readonly digit: number;
}

/** A digit placement in a cell, returned by apply() for placement rules. */
export interface Placement {
  readonly cell: Cell;
  readonly digit: number;
}

/** Direct removal of a cage solution, returned by apply(). */
export interface SolutionElimination {
  readonly cageIdx: number;
  readonly solution: readonly number[];
}

/** A derived sum constraint to register as a virtual cage. */
export interface VirtualCageAddition {
  readonly cells: readonly Cell[];
  readonly total: number;
}

/** Full return type for SolverRule.apply(). */
export interface RuleResult {
  readonly eliminations: readonly Elimination[];
  readonly placements: readonly Placement[];
  readonly solutionEliminations: readonly SolutionElimination[];
  readonly virtualCageAdditions: readonly VirtualCageAddition[];
}

/** Convenience constructor: empty RuleResult (no progress). */
export function emptyResult(): RuleResult {
  return { eliminations: [], placements: [], solutionEliminations: [], virtualCageAdditions: [] };
}

/** True if any result was produced. */
export function hasProgress(r: RuleResult): boolean {
  return (
    r.eliminations.length > 0 ||
    r.placements.length > 0 ||
    r.solutionEliminations.length > 0 ||
    r.virtualCageAdditions.length > 0
  );
}

/** Typed event returned by BoardState mutation methods. */
export interface BoardEvent {
  readonly trigger: Trigger;
  /** Cell for CELL_DETERMINED; unit_id (number) for all other triggers. */
  readonly payload: Cell | number;
  readonly hintDigit: number | null;
}
