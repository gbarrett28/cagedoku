/**
 * Session-level engine helpers.
 *
 * Mirrors Python helpers in api/routers/puzzle.py:
 *   _build_engine, _apply_auto_placements, _record_turn,
 *   _rebuild_user_grid, _user_eliminations, _user_removed,
 *   _user_virtual_cages, _find_last_consistent_turn_idx
 *
 * Key design decisions:
 * - Engine state is NOT serialised. On every state change the board is
 *   rebuilt from scratch by replaying the Turn history.
 * - User eliminations are derived by diffing the rebuilt board against
 *   the saved userGrid (explicit placements) and walking Turn history
 *   (explicit candidate removals).
 * - Virtual cages are re-added in turn order so the linear system starts
 *   from a clean slate each time.
 */

import { BoardState } from '../engine/boardState.js';
import { SolverEngine } from '../engine/solverEngine.js';
import { defaultRules } from '../engine/rules/index.js';
import type { Cell, Elimination } from '../engine/types.js';
import { NoSolnError } from '../solver/errors.js';
import { dataToSpec, virtualCageKeyFromCage } from './specUtils.js';
import type { AutoMutation, BoardSnapshot, PuzzleState, Turn, UserAction, VirtualCage } from './types.js';

// ---------------------------------------------------------------------------
// Derive user state from turn history
// ---------------------------------------------------------------------------

/**
 * Returns all (row, col, digit) triples explicitly removed by the user via
 * 'eliminateCandidate' actions, minus any subsequently restored.
 * May include duplicates — the engine deduplicates via Set semantics.
 */
export function userRemoved(state: PuzzleState): [number, number, number][] {
  const removed: [number, number, number][] = [];
  for (const turn of state.turns) {
    const a = turn.action;
    if (a.type === 'eliminateCandidate') {
      removed.push([a.row, a.col, a.digit]);
    } else if (a.type === 'applyHint') {
      for (const triple of a.eliminations) removed.push([...triple]);
    } else if (a.type === 'restoreCandidate') {
      const idx = [...removed].reverse().findIndex(([r, c, d]) => r === a.row && c === a.col && d === a.digit);
      if (idx !== -1) removed.splice(removed.length - 1 - idx, 1);
    } else if (a.type === 'resetCellCandidates') {
      const r = a.row; const c = a.col;
      for (let i = removed.length - 1; i >= 0; i--) {
        if (removed[i]![0] === r && removed[i]![1] === c) removed.splice(i, 1);
      }
    }
  }
  return removed;
}

/**
 * Returns all virtual cages currently in effect (added but not yet removed).
 */
export function userVirtualCages(state: PuzzleState): VirtualCage[] {
  const cages = new Map<string, VirtualCage>();
  for (const turn of state.turns) {
    if (turn.action.type === 'addVirtualCage') {
      const cage = turn.action.cage;
      cages.set(virtualCageKeyFromCage(cage), cage);
    } else if (turn.action.type === 'removeVirtualCage') {
      cages.delete(turn.action.key);
    }
  }
  return [...cages.values()];
}

/**
 * Derives explicit user candidate eliminations from the userGrid.
 * A digit is considered "user eliminated" if it is absent from the board's
 * candidate set but was not removed by any automatic rule — i.e. it was
 * placed by the user in the same row/col/box.
 *
 * In practice, the engine already applies placement-driven eliminations, so
 * this function only contributes eliminations from explicit userGrid placements
 * that differ from what the engine would have deduced.
 */
export function userEliminations(board: BoardState, userGrid: number[][] | null): Elimination[] {
  if (userGrid === null) return [];
  const elims: Elimination[] = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const placed = userGrid[r]![c]!;
      if (placed === 0) continue;
      for (const d of board.cands(r, c)) {
        if (d !== placed) elims.push({ cell: [r, c] as Cell, digit: d });
      }
    }
  }
  return elims;
}

// ---------------------------------------------------------------------------
// Engine construction
// ---------------------------------------------------------------------------

/**
 * Builds a fresh BoardState + SolverEngine from the current PuzzleState.
 *
 * Steps (mirrors Python's _build_engine):
 * 1. Parse PuzzleSpec from specData
 * 2. Create BoardState (includeVirtualCages=false to skip linear derivation)
 * 3. Re-add all virtual cages from turn history
 * 4. Apply user explicit candidate eliminations
 * 5. Apply user grid placements (eliminate all other candidates in the cell)
 * 6. Apply the explicitly removed candidates from turn history
 * 7. Construct SolverEngine with the alwaysApply rules active
 *
 * @param state   Current puzzle state
 * @param includeHints  If true, all rules generate hints instead of applying changes
 */
export function buildEngine(
  state: PuzzleState,
  { includeHints = false }: { includeHints?: boolean } = {},
): { board: BoardState; engine: SolverEngine } {
  const spec = dataToSpec(state.specData);
  const board = new BoardState(spec, { includeVirtualCages: false });

  // Apply user-eliminated cage solutions for real cages before any rules run.
  for (let i = 0; i < state.cageStates.length; i++) {
    const eliminated = state.cageStates[i]!.userEliminatedSolns;
    if (eliminated.length === 0) continue;
    const elimKeys = new Set(eliminated.map(s => [...s].sort((a, b) => a - b).join(',')));
    const solns = board.cageSolns[i]!;
    solns.splice(0, Infinity, ...solns.filter(s => !elimKeys.has([...s].sort((a, b) => a - b).join(','))));
  }

  // Re-add virtual cages — use state.virtualCages directly so that
  // eliminatedSolns set by eliminateVirtualCageSolution are applied.
  for (const vc of state.virtualCages) {
    board.addVirtualCage(vc.cells, vc.total, vc.eliminatedSolns);
  }

  const rules = defaultRules();
  const alwaysApplySet = new Set(state.alwaysApplyRules);
  // Always include CellSolutionElimination for Classic mode so row/col/box peer
  // eliminations fire regardless of user settings.
  if (state.puzzleType === 'classic') alwaysApplySet.add('CellSolutionElimination');

  // Non-hint mode: only always-apply rules run.
  // Hint mode: all rules run; always-apply rules apply directly, hint-only rules go to pendingHints.
  const activeRules = includeHints ? rules : rules.filter(r => alwaysApplySet.has(r.name));
  const hintRules = includeHints
    ? new Set(rules.filter(r => !alwaysApplySet.has(r.name)).map(r => r.name))
    : new Set<string>();

  const engine = new SolverEngine(board, activeRules, {
    linearSystemActive: true,
    hintRules,
  });

  // Apply user placements as eliminations (all non-placed digits in each solved cell)
  const placementElims = userEliminations(board, state.userGrid);
  if (placementElims.length > 0) engine.applyEliminations(placementElims);

  // Apply explicit user-removed candidates
  const removed = userRemoved(state);
  if (removed.length > 0) {
    engine.applyEliminations(
      removed.map(([r, c, d]) => ({ cell: [r, c] as Cell, digit: d })),
    );
  }

  // Solve immediately — mirrors Python's _build_engine which calls engine.solve() before returning.
  // All callers receive a fully-reduced board; none need to call engine.solve() themselves.
  try {
    engine.solve();
  } catch (e) {
    if (!(e instanceof NoSolnError)) throw e;
    // Board is contradictory — return as-is so callers can detect the inconsistency
    // via findLastConsistentTurnIdx and offer a Rewind hint.
  }

  return { board, engine };
}

// ---------------------------------------------------------------------------
// Auto-placement pass
// ---------------------------------------------------------------------------

/**
 * Runs the always-apply rules against the current state and returns an
 * updated PuzzleState with any newly placed digits committed to userGrid.
 */
export function applyAutoPlacements(state: PuzzleState): PuzzleState {
  if (state.userGrid === null) return state; // no-op before confirm
  const { engine } = buildEngine(state); // engine.solve() called inside buildEngine

  let changed = false;
  const newGrid = state.userGrid.map(row => [...row]);
  for (const p of engine.appliedPlacements) {
    const [r, c] = p.cell;
    if (newGrid[r]![c]! === 0) { newGrid[r]![c] = p.digit; changed = true; }
  }

  // Update userGrid only — no sentinel turn. Mirrors Python _apply_auto_placements.
  return changed ? { ...state, userGrid: newGrid } : state;
}

/**
 * Applies exactly one pending auto-placement to userGrid and returns the
 * updated state, or null if there are no more cells to auto-place.
 * Used by the UI animation loop when autoPlacementDelay > 0.
 */
export function applyNextAutoPlacement(state: PuzzleState): PuzzleState | null {
  if (state.userGrid === null) return null;
  const { engine } = buildEngine(state);
  for (const p of engine.appliedPlacements) {
    const [r, c] = p.cell;
    if (state.userGrid[r]![c]! === 0) {
      const newGrid = state.userGrid.map(row => [...row]);
      newGrid[r]![c] = p.digit;
      return { ...state, userGrid: newGrid };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turn recording
// ---------------------------------------------------------------------------

/**
 * Records a user action, runs the engine, and returns the updated PuzzleState.
 * This is the primary state-transition function — every user gesture goes through here.
 */
export function recordTurn(
  state: PuzzleState,
  action: UserAction,
): PuzzleState {
  const nextState = applyAction(state, action);
  const { board, engine } = buildEngine(nextState); // engine.solve() called inside buildEngine
  const autoMutations: AutoMutation[] = [...engine.appliedMutations];
  const snapshot = captureSnapshot(board);
  const turn: Turn = { action, autoMutations, snapshot };
  return { ...nextState, turns: [...nextState.turns, turn] };
}

/**
 * Applies a UserAction to the state without running the engine.
 * Returns the intermediate state before auto-mutations.
 */
function applyAction(state: PuzzleState, action: UserAction): PuzzleState {
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
    case 'eliminateCandidate':
    case 'restoreCandidate':
    case 'resetCellCandidates':
    case 'applyHint':
      return state;
    case 'addVirtualCage':
      return { ...state, virtualCages: [...state.virtualCages, action.cage] };
    case 'removeVirtualCage': {
      const key = action.key;
      const newCages = state.virtualCages.filter(vc => virtualCageKeyFromCage(vc) !== key);
      return { ...state, virtualCages: newCages };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// User grid rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuilds userGrid by replaying all turns.
 * Called after undo or when resynchronising state.
 */
export function rebuildUserGrid(state: PuzzleState): PuzzleState {
  if (state.userGrid === null) return state;
  const newGrid: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));

  for (const turn of state.turns) {
    const a = turn.action;
    if (a.type === 'placeDigit') {
      newGrid[a.row]![a.col] = a.digit;
    } else if (a.type === 'removeDigit') {
      newGrid[a.row]![a.col] = 0;
    }
  }

  // Rebuild virtualCages from the add/remove turn history, but preserve any
  // eliminatedSolns that were set via eliminateVirtualCageSolution (stored in
  // state.virtualCages, not in turns) for cages that still exist after replay.
  const existingElims = new Map(
    state.virtualCages.map(vc => [virtualCageKeyFromCage(vc), vc.eliminatedSolns]),
  );
  const rebuiltVCs = userVirtualCages(state);
  const mergedVCs = rebuiltVCs.map(vc => {
    const key = virtualCageKeyFromCage(vc);
    return { ...vc, eliminatedSolns: existingElims.get(key) ?? vc.eliminatedSolns };
  });

  return { ...state, userGrid: newGrid, virtualCages: mergedVCs };
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

/**
 * Returns the turn index to rewind to when the user has placed a wrong digit,
 * or null if the current state contains no mistakes.
 *
 * Compares every non-zero cell in userGrid against goldenSolution. If a
 * conflict is found, walks forward through turns to find the earliest
 * placeDigit turn that introduced a currently-wrong digit. rewind(idx) will
 * then trim history to [0, idx) — before the first error.
 */
export function findLastConsistentTurnIdx(state: PuzzleState): number | null {
  const { goldenSolution, userGrid } = state;
  if (goldenSolution === null || userGrid === null) return null;

  // Build map of currently-wrong cells: key → wrong digit placed there
  const wrongCells = new Map<string, number>();
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const placed = userGrid[r]![c]!;
      const golden = goldenSolution[r]![c]!;
      if (placed !== 0 && golden !== 0 && placed !== golden) {
        wrongCells.set(`${r},${c}`, placed);
      }
    }
  }
  if (wrongCells.size === 0) return null;

  // Walk forward to find the earliest turn that placed a currently-wrong digit
  let firstBadIdx: number | null = null;
  for (let i = 0; i < state.turns.length; i++) {
    const a = state.turns[i]!.action;
    if (a.type !== 'placeDigit') continue;
    const key = `${a.row},${a.col}`;
    const wrongDigit = wrongCells.get(key);
    if (wrongDigit !== undefined && a.digit === wrongDigit) {
      firstBadIdx = firstBadIdx === null ? i : Math.min(firstBadIdx, i);
      wrongCells.delete(key);
      if (wrongCells.size === 0) break;
    }
  }
  return firstBadIdx;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

function captureSnapshot(board: BoardState): BoardSnapshot {
  const candidates = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => [...board.cands(r, c)].sort((a, b) => a - b)),
  );
  return { candidates };
}
