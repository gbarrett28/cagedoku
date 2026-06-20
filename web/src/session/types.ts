/**
 * Core types for the in-browser puzzle session.
 *
 * Mirrors the Python API layer (api/schemas.py, api/routers/puzzle.py)
 * but with no server round-trips — all state lives in memory.
 */

import type { Cell } from '../engine/types.js';
import type { BoardState } from '../engine/boardState.js';
import { KillerBoardState, intersectAll } from '../engine/boardState.js';
import type { DiffSolution } from '../solver/equation.js';
import type { RuleMutation, EliminateCandidateMutation, RuleStep } from './ruleMutation.js';
import { defaultRules } from '../engine/rules/index.js';
import { DISABLED_RULES } from '../engine/rules/disabled-rules.js';
import type { SolverRule } from '../engine/rule.js';
import { findDuplicateCells } from './assertions.js';
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

/**
 * Unified return type for PuzzleStateOps operations: the resulting state, its
 * rendered board, and any rule steps that fired as a result of the action.
 */
export interface SessionResult {
  readonly state: PuzzleState;
  readonly board: BoardState;
  readonly ruleSteps: readonly RuleStep[];
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
  readonly mutations: readonly RuleMutation[];
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
        const g = state.userGrid;
        const newGrid = g.map(row => [...row]);
        newGrid[action.row]![action.col] = action.digit;
        return { ...state, userGrid: newGrid };
      }
      case 'removeDigit': {
        const g = state.userGrid;
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
        return action.mutations.reduce((s, m) => m.apply(s), state);
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
      for (const m of action.mutations) {
        if (m.type === 'eliminateCandidate') {
          const elim = m as EliminateCandidateMutation;
          list.push([elim.row, elim.col, elim.digit]);
        }
      }
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
   * All-zero before /confirm (OCR review phase); use `goldenSolution === null`
   * to detect the unconfirmed state.
   */
  readonly userGrid: number[][];
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

export interface BigApplePuzzleState extends PuzzleState {
  /** Structural discriminant — always `true`. Mirrors `KillerPuzzleState`'s `specData`-presence pattern. */
  readonly bigApple: true;
}

/**
 * Wire format for a serialized `PuzzleState`/`KillerPuzzleState` snapshot
 * (e.g. embedded in a bug report). `kind`/`version` exist only here — the
 * runtime `PuzzleState`/`KillerPuzzleState` types remain untagged.
 */
export type SerializedPuzzleState =
  | (PuzzleState & { readonly kind: 'classic'; readonly version: 1 })
  | (KillerPuzzleState & { readonly kind: 'killer'; readonly version: 1 });

/** UI commands whose availability depends on puzzle state. */
export type Command = 'undo' | 'inspectCage' | 'virtualCage' | 'reveal';

/** Visual colour category for a rendered digit or candidate. */
export type RenderColour = 'black' | 'blue' | 'red' | 'grey' | 'essential';

export interface CandidateRender {
  /** 1-9 */
  readonly digit: number;
  /** 'essential' if this digit is in the must-contain set for its cage, else 'grey'. */
  readonly colour: RenderColour;
}

export interface CellRender {
  /** Non-null if this cell has a placed digit (given or user-entered). */
  readonly placed: { readonly digit: number; readonly colour: RenderColour; readonly locked: boolean } | null;
  /**
   * Empty if `placed !== null`. One entry per digit 1-9 that is a live
   * candidate (board.cands has it, not user-removed). Solver-eliminated and
   * user-removed digits are both omitted — a removed candidate renders blank,
   * same as a solver-eliminated one.
   */
  readonly candidates: readonly CandidateRender[];
}

/** A single edge of the grid where a cage boundary should be drawn. */
export interface BorderSegment {
  readonly row: number;    // 0-8
  readonly col: number;    // 0-8
  readonly edge: 'bottom' | 'right'; // boundary on this cell's bottom or right edge
}

/** A cage-total label anchored at a cage's head cell. */
export interface CageLabelRender {
  readonly row: number;  // 0-8, head cell of the cage
  readonly col: number;  // 0-8
  readonly total: number;
}

export namespace PuzzleState {
  /** Type guard: true for KillerPuzzleState (has cage data). */
  export function isKiller(state: PuzzleState): state is KillerPuzzleState {
    return 'specData' in state;
  }


  /** Type guard: true for BigApplePuzzleState (has the bigApple marker). */
  export function isBigApple(state: PuzzleState): state is BigApplePuzzleState {
    return 'bigApple' in state;
  }

  /** Enabled rules for this puzzle's type: killer yields all; classic excludes `killerOnly`. */
  export function* rules(state: PuzzleState): Iterable<SolverRule> {
    const disabled = new Set(DISABLED_RULES);
    const allRules = defaultRules().filter(r => !disabled.has(r.name));
    yield* isKiller(state) ? allRules : allRules.filter(r => !r.killerOnly);
  }

  /** Commands available to the UI given the current state. */
  export function availableCommands(state: PuzzleState): ReadonlySet<Command> {
    const commands = new Set<Command>();
    const { turns } = state;
    if (turns.length > 0) {
      const last = turns[turns.length - 1]!.action;
      if (!(last.type === 'placeDigit' && last.source === 'given')) commands.add('undo');
    }
    if (isKiller(state)) { commands.add('inspectCage'); commands.add('virtualCage'); }
    if (state.goldenSolution !== null) commands.add('reveal');
    return commands;
  }

  /**
   * Per-cell render attributes for digits and candidates — consolidates the
   * killer/classic, given/user-placed, duplicate-detection, and must-contain
   * highlighting logic that was previously spread across main.ts's drawDigits
   * and drawCandidates.
   */
  export function candidateDisplay(state: PuzzleState, board: BoardState): readonly CellRender[][] {
    const digitGrid: number[][] =
      state.goldenSolution !== null ? state.userGrid : (state.givenDigits ?? state.userGrid);

    const duplicateCells = findDuplicateCells(digitGrid);

    const removedSet = new Set(state.userRemovedCandidates.map(([r, c, d]) => `${r},${c},${d}`));

    return Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c): CellRender => {
        const digit = digitGrid[r]?.[c] ?? 0;
        if (digit > 0) {
          const isDuplicate = duplicateCells.has(`${r},${c}`);
          const isGiven = !isKiller(state) && (state.givenDigits?.[r]?.[c] ?? 0) > 0;
          const colour: RenderColour = isDuplicate ? 'red'
            : (state.goldenSolution !== null && !isGiven) ? 'blue'
            : 'black';
          const locked = !isKiller(state) && isGiven;
          return { placed: { digit, colour, locked }, candidates: [] };
        }

        const mustContain: ReadonlySet<number> = board instanceof KillerBoardState
          ? new Set(intersectAll(board.cageSolns[board.regions[r]![c]!]!.map(s => new Set(s))))
          : new Set();

        const candidates: CandidateRender[] = [];
        for (let d = 1; d <= 9; d++) {
          if (!board.cands(r, c).has(d)) continue;
          if (removedSet.has(`${r},${c},${d}`)) continue;
          candidates.push({ digit: d, colour: mustContain.has(d) ? 'essential' : 'grey' });
        }
        return { placed: null, candidates };
      }),
    );
  }

  /**
   * Cage-boundary edges for drawing killer cage outlines. Empty for classic
   * (no `specData`). Ported from main.ts's drawCageBorders non-draft branch.
   */
  export function cageBoundaries(state: PuzzleState): readonly BorderSegment[] {
    if (!isKiller(state)) return [];
    const regions = state.specData.regions;
    const segments: BorderSegment[] = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (r < 8 && regions[r]![c] !== regions[r + 1]![c]) {
          segments.push({ row: r, col: c, edge: 'bottom' });
        }
        if (c < 8 && regions[r]![c] !== regions[r]![c + 1]) {
          segments.push({ row: r, col: c, edge: 'right' });
        }
      }
    }
    return segments;
  }

  /**
   * Cage-total labels anchored at each cage's head cell. Empty for classic
   * (no `specData`). Ported from main.ts's drawCageTotals.
   */
  export function cageLabels(state: PuzzleState): readonly CageLabelRender[] {
    if (!isKiller(state)) return [];
    const totals = state.specData.cageTotals;
    const labels: CageLabelRender[] = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const total = totals[r]?.[c] ?? 0;
        if (total !== 0) labels.push({ row: r, col: c, total });
      }
    }
    return labels;
  }

  /**
   * A faithful, total snapshot of `state` for bug reports / debugging.
   * Includes `originalImageUrl`/`warpedImageUrl` as-is — callers that need a
   * smaller payload strip those fields from their own copy.
   */
  export function serialize(state: PuzzleState): SerializedPuzzleState {
    return isKiller(state)
      ? { kind: 'killer', version: 1, ...state }
      : { kind: 'classic', version: 1, ...state };
  }

  /**
   * Validates and reconstructs a `PuzzleState`/`KillerPuzzleState` from a
   * `SerializedPuzzleState`. Throws immediately on any shape mismatch — no
   * migration path, no recursive validation of `turns`/`UserAction`/
   * `RuleMutation` variants (a malformed entry surfaces as a runtime error
   * inside `buildEngine`, which is acceptable for this debugging tool).
   */
  export function deserialize(data: unknown): PuzzleState {
    if (typeof data !== 'object' || data === null) {
      throw new Error('PuzzleState.deserialize: data is not an object');
    }
    const v = data as Record<string, unknown>;

    if (v['kind'] !== 'classic' && v['kind'] !== 'killer') {
      throw new Error(`PuzzleState.deserialize: unrecognised kind ${JSON.stringify(v['kind'])}`);
    }
    if (v['version'] !== 1) {
      throw new Error(`PuzzleState.deserialize: unsupported version ${JSON.stringify(v['version'])}`);
    }
    if (!is9x9NumberGrid(v['userGrid'])) {
      throw new Error('PuzzleState.deserialize: userGrid must be a 9x9 number array');
    }
    if (!Array.isArray(v['turns'])) {
      throw new Error('PuzzleState.deserialize: turns must be an array');
    }
    if (!isStringArray(v['alwaysApplyRules'])) {
      throw new Error('PuzzleState.deserialize: alwaysApplyRules must be a string array');
    }
    if (v['goldenSolution'] !== null && !is9x9NumberGrid(v['goldenSolution'])) {
      throw new Error('PuzzleState.deserialize: goldenSolution must be a 9x9 number array or null');
    }
    if (v['givenDigits'] !== null && !is9x9NumberGrid(v['givenDigits'])) {
      throw new Error('PuzzleState.deserialize: givenDigits must be a 9x9 number array or null');
    }
    if (v['originalImageUrl'] !== null && typeof v['originalImageUrl'] !== 'string') {
      throw new Error('PuzzleState.deserialize: originalImageUrl must be a string or null');
    }
    if (!isRemovedCandidatesArray(v['userRemovedCandidates'])) {
      throw new Error('PuzzleState.deserialize: userRemovedCandidates must be an array of [row, col, digit] tuples');
    }

    const base: PuzzleState = {
      userGrid: v['userGrid'] as number[][],
      turns: v['turns'] as readonly Turn[],
      alwaysApplyRules: v['alwaysApplyRules'] as readonly string[],
      goldenSolution: v['goldenSolution'] as number[][] | null,
      givenDigits: v['givenDigits'] as number[][] | null,
      originalImageUrl: v['originalImageUrl'] as string | null,
      userRemovedCandidates: v['userRemovedCandidates'] as readonly [number, number, number][],
    };

    if (v['kind'] === 'classic') return base;

    const specData = v['specData'];
    if (typeof specData !== 'object' || specData === null) {
      throw new Error('PuzzleState.deserialize: specData is required for kind "killer"');
    }
    const sd = specData as Record<string, unknown>;
    if (!is9x9NumberGrid(sd['regions'])) {
      throw new Error('PuzzleState.deserialize: specData.regions must be a 9x9 number array');
    }
    if (!is9x9NumberGrid(sd['cageTotals'])) {
      throw new Error('PuzzleState.deserialize: specData.cageTotals must be a 9x9 number array');
    }
    if (!Array.isArray(v['cageStates'])) {
      throw new Error('PuzzleState.deserialize: cageStates must be an array');
    }
    if (!Array.isArray(v['virtualCages'])) {
      throw new Error('PuzzleState.deserialize: virtualCages must be an array');
    }
    if (v['warpedImageUrl'] !== null && typeof v['warpedImageUrl'] !== 'string') {
      throw new Error('PuzzleState.deserialize: warpedImageUrl must be a string or null');
    }

    const killerState: KillerPuzzleState = {
      ...base,
      specData: { regions: sd['regions'] as number[][], cageTotals: sd['cageTotals'] as number[][] },
      cageStates: v['cageStates'] as readonly CageState[],
      virtualCages: v['virtualCages'] as readonly VirtualCage[],
      warpedImageUrl: v['warpedImageUrl'] as string | null,
    };
    return killerState;
  }

  /** Builds a fresh classic PuzzleState for the OCR review phase (blank grid, no golden solution). */
  export function createClassic(
    givenDigits: number[][] | null,
    alwaysApplyRules: readonly string[],
    originalImageUrl: string | null,
  ): PuzzleState {
    return {
      userGrid: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
      turns: [],
      alwaysApplyRules,
      goldenSolution: null,
      givenDigits,
      originalImageUrl,
      userRemovedCandidates: [],
    };
  }


  /** Builds a fresh Big Apple PuzzleState for the OCR review phase (blank grid, no golden solution). */
  export function createBigApple(
    givenDigits: number[][] | null,
    alwaysApplyRules: readonly string[],
    originalImageUrl: string | null,
  ): BigApplePuzzleState {
    return { ...createClassic(givenDigits, alwaysApplyRules, originalImageUrl), bigApple: true };
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
      userGrid: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
      turns: [],
      alwaysApplyRules,
      goldenSolution: null,
      givenDigits: null,
      originalImageUrl,
      userRemovedCandidates: [],
    };
  }
}

function is9x9NumberGrid(value: unknown): value is number[][] {
  if (!Array.isArray(value) || value.length !== 9) return false;
  for (const row of value as unknown[]) {
    if (!Array.isArray(row) || row.length !== 9) return false;
    for (const cell of row as unknown[]) {
      if (typeof cell !== 'number') return false;
    }
  }
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

function isRemovedCandidatesArray(value: unknown): value is [number, number, number][] {
  if (!Array.isArray(value)) return false;
  return value.every(
    entry => Array.isArray(entry) && entry.length === 3 && entry.every(n => typeof n === 'number'),
  );
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
  /**
   * Dev-only diagnostic: surface rule-bug/trigger-miss telemetry failures
   * (no consent, or upload rejected) as a prefilled bug report instead of
   * dropping them silently. Default: false.
   */
  readonly devSurfaceTelemetryFailures: boolean;
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
  /** Per-cell digit/colour tags for chain-style rules; see HintResult.chainCells. */
  readonly chainCells?: readonly { cell: [number, number]; digits: readonly number[]; colour?: 'blue' | 'green' }[];
  /** Digits key to the rule — marked with squares in highlightCells. See HintResult.patternDigits. */
  readonly patternDigits?: readonly number[];
  /** Cells rendered with a pale-blue wash for unit context; see HintResult.secondaryHighlightCells. */
  readonly secondaryHighlightCells?: readonly [number, number][];
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
  readonly devSurfaceTelemetryFailures: boolean;
  readonly hintableRules: readonly RuleInfo[];
}
