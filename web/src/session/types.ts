/**
 * Core types for the in-browser puzzle session.
 *
 * Mirrors the Python API layer (api/schemas.py, api/routers/puzzle.py)
 * but with no server round-trips — all state lives in memory.
 */

import type { Cell } from '../engine/types.js';

// ---------------------------------------------------------------------------
// Puzzle specification interchange format
// ---------------------------------------------------------------------------

/**
 * Wire format for PuzzleSpec — matches Python's PuzzleSpecData Pydantic model.
 * regions[row][col] and cageTotals[row][col] use row-major order (same as Python numpy layout).
 */
export interface PuzzleSpecData {
  readonly regions: number[][];
  readonly cageTotals: number[][];
}

// ---------------------------------------------------------------------------
// Cage model
// ---------------------------------------------------------------------------

export interface CellPosition {
  /** 1-based row (matching Python and the existing main.ts convention). */
  readonly row: number;
  /** 1-based column. */
  readonly col: number;
}

export interface CageState {
  readonly label: string;
  readonly total: number;
  readonly cells: readonly CellPosition[];
  /** Digit combos the user has marked as impossible for this cage. */
  readonly userEliminatedSolns: readonly (readonly number[])[];
}

export interface VirtualCage {
  readonly cells: readonly Cell[];
  readonly total: number;
  /** Sorted digit arrays excluded from the solution set. */
  readonly eliminatedSolns: readonly (readonly number[])[];
}

// ---------------------------------------------------------------------------
// Turn history
// ---------------------------------------------------------------------------

/** Snapshot of the board's candidate sets at a point in time. */
export interface BoardSnapshot {
  /** candidates[r][c] as a sorted digit array. */
  readonly candidates: number[][][];
}

export type UserAction =
  | { readonly type: 'placeDigit'; readonly row: number; readonly col: number; readonly digit: number; readonly source: 'given' | 'user' }
  | { readonly type: 'removeDigit'; readonly row: number; readonly col: number }
  | { readonly type: 'eliminateCandidate'; readonly row: number; readonly col: number; readonly digit: number }
  | { readonly type: 'restoreCandidate'; readonly row: number; readonly col: number; readonly digit: number }
  | { readonly type: 'resetCellCandidates'; readonly row: number; readonly col: number }
  | { readonly type: 'addVirtualCage'; readonly cage: VirtualCage }
  | { readonly type: 'removeVirtualCage'; readonly key: string }
  | { readonly type: 'applyHint'; readonly eliminations: readonly [number, number, number][] }
  | { readonly type: 'undo' };

export interface AutoMutation {
  readonly ruleName: string;
  readonly type: string;
  readonly [k: string]: unknown;
}

export interface Turn {
  readonly action: UserAction;
  readonly autoMutations: readonly AutoMutation[];
  readonly snapshot: BoardSnapshot;
}

// ---------------------------------------------------------------------------
// Puzzle session state
// ---------------------------------------------------------------------------

export interface PuzzleState {
  /** Raw puzzle layout. */
  readonly specData: PuzzleSpecData;
  /** Parsed cages (label + total + cells). */
  readonly cageStates: readonly CageState[];
  /**
   * User-visible grid values.
   * userGrid[row][col] is the placed digit (1-9) or 0 if none.
   * Null before /confirm (OCR review phase).
   */
  readonly userGrid: number[][] | null;
  /** User-entered virtual cages. */
  readonly virtualCages: readonly VirtualCage[];
  /** Full turn history (oldest first). */
  readonly turns: readonly Turn[];
  /** Rule names that run automatically on every engine pass. */
  readonly alwaysApplyRules: readonly string[];

  /** 9×9 solver solution (0 = unsolvable cell); null before confirm. */
  readonly goldenSolution: number[][] | null;
  /** 'killer' (cage overlay) or 'classic' (no cage overlay). */
  readonly puzzleType: 'killer' | 'classic';
  /** Pre-fixed digits for classic puzzles; null for killer. */
  readonly givenDigits: number[][] | null;
  /** Data URL of the original uploaded image, for display. */
  readonly originalImageUrl: string | null;
  /** Data URL of the perspective-corrected grid image; null for killers. */
  readonly warpedImageUrl: string | null;
}

// ---------------------------------------------------------------------------
// Coach settings
// ---------------------------------------------------------------------------

export interface CoachSettings {
  readonly alwaysApplyRules: readonly string[];
}

// ---------------------------------------------------------------------------
// Candidates response — mirrors Python GET /candidates
// ---------------------------------------------------------------------------

export interface CellInfo {
  /** Solver-deduced candidates (includes user_removed for strikethrough rendering). */
  readonly candidates: number[];
  /** Digits explicitly removed by the user. */
  readonly userRemoved: number[];
}

export interface CageInfo {
  readonly cageIdx: number;
  readonly cells: readonly [number, number][];  // 0-based [row, col]
  readonly total: number;
  readonly solutions: readonly (readonly number[])[];
  /** Digits present in every remaining solution. */
  readonly mustContain: number[];
}

export interface VirtualCageInfo {
  readonly key: string;
  readonly cells: readonly [number, number][];
  readonly total: number;
  readonly solutions: readonly (readonly number[])[];   // remaining (not eliminated, not auto-impossible)
  readonly allSolutions: readonly (readonly number[])[]; // all mathematically valid combinations
  readonly autoImpossible: readonly (readonly number[])[]; // ruled out by engine
  readonly userEliminated: readonly (readonly number[])[]; // eliminated by user
  readonly mustContain: number[];
}

export interface CandidatesResponse {
  readonly cells: CellInfo[][];       // 9 rows × 9 cols, 0-based
  readonly cages: CageInfo[];
  readonly virtualCages: VirtualCageInfo[];
}

// ---------------------------------------------------------------------------
// Hints response — mirrors Python GET /hints
// ---------------------------------------------------------------------------

export interface VirtualCageSuggestion {
  readonly cells: readonly [number, number][];
  readonly total: number;
}

export interface HintItem {
  readonly ruleName: string;
  readonly displayName: string;
  readonly explanation: string;
  readonly highlightCells: readonly [number, number][];  // 0-based [row, col]
  readonly eliminations: readonly { cell: [number, number]; digit: number }[];
  readonly eliminationCount: number;
  readonly placement: [number, number, number] | null;  // [row, col, digit]
  readonly rewindToTurnIdx: number | null;
  readonly virtualCageSuggestion: VirtualCageSuggestion | null;
}

export interface HintsResponse {
  readonly hints: readonly HintItem[];
}

// ---------------------------------------------------------------------------
// Solve response — mirrors Python POST /solve
// ---------------------------------------------------------------------------

export interface SolveResponse {
  readonly solved: boolean;
  readonly grid: number[][];
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Cage solutions response — mirrors Python GET /cage/:label/solutions
// ---------------------------------------------------------------------------

export interface CageSolutionsResponse {
  readonly label: string;
  readonly allSolutions: readonly (readonly number[])[];
  readonly autoImpossible: readonly (readonly number[])[];
  readonly userEliminated: readonly (readonly number[])[];
}

// ---------------------------------------------------------------------------
// Settings response — mirrors Python GET /api/settings
// ---------------------------------------------------------------------------

export interface RuleInfo {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
}

export interface SettingsResponse {
  readonly alwaysApplyRules: readonly string[];
  readonly showEssential: boolean;
  readonly hintableRules: readonly RuleInfo[];
}
