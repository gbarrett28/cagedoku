/**
 * Error type for inconsistent cage layouts produced by image processing.
 *
 * Carries the partially-assembled state at the time of failure so callers can
 * render a diagnostic overlay without re-running the pipeline.
 */

/** (9, 9, 4) per-cell border flags: [row][col][direction], True = wall present. */
export type Brdrs = boolean[][][];

/** (9, 9) cell value grid: [row][col]. */
export type Grid9x9 = number[][];

/**
 * Raised when image-processing produces an inconsistent cage layout.
 *
 * Mirrors Python's `ProcessingError` from `killer_sudoku.solver.grid`.
 */
export class ProcessingError extends Error {
  /** Human-readable description of the inconsistency. */
  readonly msg: string;
  /** The partially-assigned region array at the time of failure. */
  readonly regions: Grid9x9;
  /** The border array passed to the validator. */
  readonly brdrs: Brdrs;

  constructor(msg: string, regions: Grid9x9, brdrs: Brdrs) {
    super(msg);
    this.name = 'ProcessingError';
    this.msg = msg;
    this.regions = regions;
    this.brdrs = brdrs;
  }
}

/** Thrown when a solver operation would leave a cell with no valid candidates. */
export class NoSolnError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'NoSolnError';
  }
}
