/**
 * Core types for the in-browser puzzle session.
 *
 * Mirrors the Python API layer (api/schemas.py, api/routers/puzzle.py)
 * but with no server round-trips — all state lives in memory.
 */

import type { Cell } from '../engine/types.js';
import type { DiffSolution } from '../solver/equation.js';
export type { DiffSolution };

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
  /** All cells in the cage (positive + negative combined). */
  readonly cells: readonly Cell[];
  readonly total: number;
  /** Sorted digit arrays excluded from the solution set (standard cages only). */
  readonly eliminatedSolns: readonly (readonly number[])[];
  /**
   * Cells that contribute with negative sign: sum(cells\negativeCells) − sum(negativeCells) = total.
   * Undefined or empty = standard cage (all cells positive).
   */
  readonly negativeCells?: readonly Cell[];
  /** DiffSolutions the user has explicitly marked as impossible (diff cages only). */
  readonly eliminatedDiffSolns?: readonly DiffSolution[];
}

/** Builds a stable string key for a virtual cage (moved here from specUtils to avoid circular dep). */
export function virtualCageKey(
  cells: readonly Cell[],
  total: number,
  negativeCells?: readonly Cell[],
): string {
  const sorted = [...cells].sort(([r1, c1], [r2, c2]) => r1 - r2 || c1 - c2);
  const base = [...sorted.map(([r, c]) => `${r},${c}`), String(total)].join(':');
  if (!negativeCells || negativeCells.length === 0) return base;
  const negSorted = [...negativeCells].sort(([r1, c1], [r2, c2]) => r1 - r2 || c1 - c2);
  return `${base}|${negSorted.map(([r, c]) => `${r},${c}`).join(':')}`;
}

export function virtualCageKeyFromCage(cage: VirtualCage): string {
  return virtualCageKey(cage.cells, cage.total, cage.negativeCells);
}

// ---------------------------------------------------------------------------
// Turn history
// ---------------------------------------------------------------------------

/** Snapshot of the board's candidate sets at a point in time. */
export interface BoardSnapshot {
  /** candidates[r][c] as a sorted digit array. */
  readonly candidates: number[][][];
}

// ---------------------------------------------------------------------------
// UserAction — named variant interfaces + dispatch namespace
// ---------------------------------------------------------------------------

export interface PlaceDigitAction {
  readonly type: 'placeDigit';
  readonly row: number;
  readonly col: number;
  readonly digit: number;
  readonly source: 'given' | 'user';
}
export interface RemoveDigitAction {
  readonly type: 'removeDigit';
  readonly row: number;
  readonly col: number;
}
export interface EliminateCandidateAction {
  readonly type: 'eliminateCandidate';
  readonly row: number;
  readonly col: number;
  readonly digit: number;
}
export interface RestoreCandidateAction {
  readonly type: 'restoreCandidate';
  readonly row: number;
  readonly col: number;
  readonly digit: number;
}
export interface ResetCellCandidatesAction {
  readonly type: 'resetCellCandidates';
  readonly row: number;
  readonly col: number;
}
export interface AddVirtualCageAction {
  readonly type: 'addVirtualCage';
  readonly cage: VirtualCage;
}
export interface RemoveVirtualCageAction {
  readonly type: 'removeVirtualCage';
  readonly key: string;
}
export interface ApplyHintAction {
  readonly type: 'applyHint';
  readonly eliminations: readonly [number, number, number][];
}

export type UserAction =
  | PlaceDigitAction | RemoveDigitAction | EliminateCandidateAction
  | RestoreCandidateAction | ResetCellCandidatesAction
  | AddVirtualCageAction | RemoveVirtualCageAction | ApplyHintAction;

function assertNeverAction(action: never): never {
  throw new Error(`Unhandled action type: ${(action as UserAction).type}`);
}

export namespace UserAction {
  /** Apply the action's effect on PuzzleState (grid placement / virtual cage mutation). */
  export function apply(action: UserAction, state: PuzzleState): PuzzleState {
    switch (action.type) {
      case 'placeDigit': {
        const g = state.userGrid ?? Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
        const newGrid = g.map(row => [...row]);
        newGrid[action.row]![action.col] = action.digit;
        return { ...state, userGrid: newGrid };
      }
      case 'removeDigit': {
        const g = state.userGrid ?? Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
        const newGrid = g.map(row => [...row]);
        newGrid[action.row]![action.col] = 0;
        return { ...state, userGrid: newGrid };
      }
      case 'addVirtualCage': {
        if (!PuzzleState.isKiller(state)) throw new Error('addVirtualCage requires a killer puzzle state');
        const updated = { ...state, virtualCages: [...state.virtualCages, action.cage] };
        return updated;
      }
      case 'removeVirtualCage': {
        if (!PuzzleState.isKiller(state)) throw new Error('removeVirtualCage requires a killer puzzle state');
        const key = action.key;
        const updated = { ...state, virtualCages: state.virtualCages.filter(vc => virtualCageKeyFromCage(vc) !== key) };
        return updated;
      }
      case 'eliminateCandidate': {
        const prev = state.userRemovedCandidates ?? [];
        return { ...state, userRemovedCandidates: [...prev, [action.row, action.col, action.digit]] };
      }
      case 'applyHint': {
        const prev = state.userRemovedCandidates ?? [];
        return { ...state, userRemovedCandidates: [...prev, ...action.eliminations] };
      }
      case 'restoreCandidate': {
        const list = [...(state.userRemovedCandidates ?? [])];
        const idx = [...list].reverse().findIndex(([r, c, d]) => r === action.row && c === action.col && d === action.digit);
        if (idx !== -1) list.splice(list.length - 1 - idx, 1);
        return { ...state, userRemovedCandidates: list };
      }
      case 'resetCellCandidates': {
        const { row, col } = action;
        return { ...state, userRemovedCandidates: (state.userRemovedCandidates ?? []).filter(([r, c]) => r !== row || c !== col) };
      }
      default:
        return assertNeverAction(action);
    }
  }

  /** Apply the action's grid mutation in-place (only placeDigit/removeDigit act). */
  export function applyToGrid(action: UserAction, grid: number[][]): void {
    if (action.type === 'placeDigit') { grid[action.row]![action.col] = action.digit; }
    else if (action.type === 'removeDigit') { grid[action.row]![action.col] = 0; }
  }

  /** Update the mutable removed-candidates list for this action (eliminateCandidate/applyHint/restore/reset act). */
  export function updateRemovedList(action: UserAction, list: [number, number, number][]): void {
    if (action.type === 'eliminateCandidate') {
      list.push([action.row, action.col, action.digit]);
    } else if (action.type === 'applyHint') {
      for (const [r, c, d] of action.eliminations) list.push([r, c, d]);
    } else if (action.type === 'restoreCandidate') {
      const idx = [...list].reverse().findIndex(([r, c, d]) => r === action.row && c === action.col && d === action.digit);
      if (idx !== -1) list.splice(list.length - 1 - idx, 1);
    } else if (action.type === 'resetCellCandidates') {
      const { row, col } = action;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]![0] === row && list[i]![1] === col) list.splice(i, 1);
      }
    }
  }

  /** Update the virtual-cage map for this action (addVirtualCage/removeVirtualCage act). */
  export function applyToCages(action: UserAction, cages: Map<string, VirtualCage>): void {
    if (action.type === 'addVirtualCage') {
      cages.set(virtualCageKeyFromCage(action.cage), action.cage);
    } else if (action.type === 'removeVirtualCage') {
      cages.delete(action.key);
    }
  }
}

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
  /**
   * User-visible grid values.
   * userGrid[row][col] is the placed digit (1-9) or 0 if none.
   * Null before /confirm (OCR review phase).
   */
  readonly userGrid: number[][] | null;
  /** Full turn history (oldest first). */
  readonly turns: readonly Turn[];
  /** Rule names that run automatically on every engine pass. */
  readonly alwaysApplyRules: readonly string[];
  /** 9×9 solver solution (0 = unsolvable cell); null before confirm. */
  readonly goldenSolution: number[][] | null;
  /** Pre-fixed digits for classic puzzles; null for pure killer. */
  readonly givenDigits: number[][] | null;
  /** Data URL of the original uploaded image, for display. */
  readonly originalImageUrl: string | null;
  /**
   * [row, col, digit] triples explicitly eliminated by the user (via eliminateCandidate,
   * applyHint, etc.). Maintained by UserAction.apply() so buildEngine() can read a
   * consistent snapshot without replaying turns.
   */
  readonly userRemovedCandidates: readonly [number, number, number][];
}

export interface KillerPuzzleState extends PuzzleState {
  /** Raw puzzle layout. */
  readonly specData: PuzzleSpecData;
  /** Parsed cages (label + total + cells). */
  readonly cageStates: readonly CageState[];
  /** User-entered virtual cages. */
  readonly virtualCages: readonly VirtualCage[];
  /** Data URL of the perspective-corrected grid image. */
  readonly warpedImageUrl: string | null;
  /**
   * When non-null, buildEngine seeds the board from this candidate grid before
   * running rules. Used when loading stall fixtures so the board starts at the
   * documented all-rules-exhausted state rather than being rebuilt from only
   * the user's alwaysApplyRules subset.
   */
  readonly fixtureStalledCandidates?: readonly number[][][] | null;
}

export namespace PuzzleState {
  /** Type guard: true for KillerPuzzleState (has cage data). */
  export function isKiller(state: PuzzleState): state is KillerPuzzleState {
    return 'specData' in state;
  }

  /** Builds a fresh classic PuzzleState for the OCR review phase (blank grid, no golden solution). */
  export function createClassic(
    givenDigits: number[][] | null,
    alwaysApplyRules: readonly string[],
    originalImageUrl: string | null,
  ): PuzzleState {
    return {
      userGrid: null,
      turns: [],
      alwaysApplyRules,
      goldenSolution: null,
      givenDigits,
      originalImageUrl,
      userRemovedCandidates: [],
    };
  }

  /** Builds a fresh killer PuzzleState for the OCR review phase (blank grid, no golden solution). */
  export function createKiller(
    specData: PuzzleSpecData,
    cageStates: readonly CageState[],
    alwaysApplyRules: readonly string[],
    originalImageUrl: string | null,
    warpedImageUrl: string | null,
  ): KillerPuzzleState {
    return {
      specData,
      cageStates,
      virtualCages: [],
      warpedImageUrl,
      userGrid: null,
      turns: [],
      alwaysApplyRules,
      goldenSolution: null,
      givenDigits: null,
      originalImageUrl,
      userRemovedCandidates: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Coach settings
// ---------------------------------------------------------------------------

export interface CoachSettings {
  readonly alwaysApplyRules: readonly string[];
  /** Milliseconds between each auto-placement step when animating. 0 = instant. */
  readonly autoPlacementDelay: number;
  /** Show candidate grid automatically when playing mode starts. Default: true. */
  readonly showCandidatesByDefault: boolean;
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

/** Three-way categorisation of cage solutions shared by CageInfo and VirtualCageInfo. */
export interface SolutionCategorization {
  /** All mathematically valid digit combinations for this cage. */
  readonly allSolutions: readonly (readonly number[])[];
  /** Combinations ruled out by the engine (not by the user). */
  readonly autoImpossible: readonly (readonly number[])[];
  /** Combinations the user has explicitly marked as impossible. */
  readonly userEliminated: readonly (readonly number[])[];
}

export interface CageInfo extends SolutionCategorization {
  readonly cageIdx: number;
  readonly label: string;
  /** 0-based `[row, col]` pairs. */
  readonly cells: readonly [number, number][];
  readonly total: number;
  readonly solutions: readonly (readonly number[])[];
  /** Digits present in every remaining solution. */
  readonly mustContain: number[];
}

export interface VirtualCageInfo extends SolutionCategorization {
  readonly key: string;
  readonly cells: readonly [number, number][];
  readonly total: number;
  /** Remaining solutions (not user-eliminated, not auto-impossible). */
  readonly solutions: readonly (readonly number[])[];
  readonly mustContain: number[];
  // Diff-cage fields — undefined for standard cages.
  /** Negative-role cells (0-based). Defined (possibly empty) only for diff cages. */
  readonly negativeCells?: readonly [number, number][];
  /** All mathematically valid split solutions for this diff cage. */
  readonly allDiffSolutions?: readonly DiffSolution[];
  /** Remaining diff solutions (not user-eliminated). */
  readonly diffSolutions?: readonly DiffSolution[];
  /** Diff solutions the user has explicitly eliminated. */
  readonly eliminatedDiffSolns?: readonly DiffSolution[];
}

export interface CandidatesResponse {
  /** 9×9 grid of cell info, `[row][col]`, 0-based. */
  readonly cells: CellInfo[][];
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
  /** 0-based `[row, col]` pairs — orange pattern-cell highlight. Cells also present in `eliminations` are overwritten yellow. */
  readonly highlightCells: readonly [number, number][];
  readonly eliminations: readonly { cell: [number, number]; digit: number }[];
  readonly eliminationCount: number;
  /** `[row, col, digit]` triple, 0-based, or null if hint is not a direct placement. */
  readonly placement: [number, number, number] | null;
  readonly rewindToTurnIdx: number | null;
  readonly virtualCageSuggestion: VirtualCageSuggestion | null;
  /** Two colour groups for bipartite-chain hints; absent for all other hints. */
  readonly colourGroups?: readonly { cells: readonly [number, number][]; colour: 'blue' | 'green' }[];
  /** Digits key to the rule — marked with squares in highlightCells. See HintResult.patternDigits. */
  readonly patternDigits?: readonly number[];
}

export interface HintsResponse {
  readonly hints: readonly HintItem[];
  /** Present when the golden solution was updated due to a multi-solution puzzle. */
  readonly warning?: string;
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

export interface CageSolutionsResponse extends SolutionCategorization {
  readonly label: string;
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
  readonly autoPlacementDelay: number;
  readonly showEssential: boolean;
  readonly showCandidatesByDefault: boolean;
  readonly hintableRules: readonly RuleInfo[];
}
