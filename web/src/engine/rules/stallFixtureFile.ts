import type { PuzzleSpec } from '../../solver/puzzleSpec.js';

/**
 * Committed stall-fixture record — a puzzle the rule engine cannot solve
 * without MRV backtracking.
 *
 * Files live in web/stall-fixtures/<name>.stall.json.
 * Served in dev mode via GET /dev/stall-fixtures (list) and
 * GET /dev/stall-fixtures/:name (individual fixture).
 *
 * See docs/superpowers/specs/2026-05-24-stall-fixture-pipeline-design.md.
 */
export interface StallFixtureFile {
  /** Always 1 for this format. */
  version: 1;
  /** Origin corpus: "guardian", "observer", "r2", etc. */
  source: string;
  /** Unique name derived from image filename or R2 key. */
  name: string;
  /** ISO date (YYYY-MM-DD) when the fixture was created. */
  addedAt: string;
  puzzleType: 'killer' | 'classic';
  /**
   * Repo-root-relative path to the source image.
   * Omitted for R2 uploads (no image in the repo).
   * The image may not exist on the current machine — informational only.
   */
  imagePath?: string;
  /** Full puzzle spec — passed directly to solve(). */
  spec: PuzzleSpec;
  /**
   * 9×9 candidate grid at the moment the rule engine stalled, before
   * backtracking. Each cell is a sorted array of remaining candidates;
   * single-element = already solved.
   */
  stalledCandidates: number[][][];
  /** Count of cells with more than one candidate at stall time. */
  unsolvedCells: number;
  /** Sum of candidate-list lengths across all unsolved cells at stall time. */
  totalCandidates: number;
}
