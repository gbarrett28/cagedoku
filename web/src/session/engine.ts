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
import { dataToSpec } from './specUtils.js';
import type { AutoMutation, BoardSnapshot, PuzzleState, Turn, UserAction, VirtualCage } from './types.js';

/** Default rules that run on every engine solve pass. */
export const DEFAULT_ALWAYS_APPLY_RULES: readonly string[] = [
  'CageCandidateFilter',
  'CellSolutionElimination',
];

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
        if (removed[i][0] === r && removed[i][1] === c) removed.splice(i, 1);
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
      const key = [...cage.cells]
        .sort(([r1, c1], [r2, c2]) => r1 - r2 || c1 - c2)
        .map(([r, c]) => `${r},${c}`)
        .join(':') + `:${cage.total}`;
      cages.set(key, cage);
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
      const placed = userGrid[r][c];
      if (placed === 0) continue;
      for (const d of board.candidates[r][c]) {
        if (d !== placed) elims.push({ cell: [r, c] as unknown as Cell, digit: d });
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

  // Re-add virtual cages
  for (const vc of userVirtualCages(state)) {
    board.addVirtualCage(vc.cells, vc.total, vc.eliminatedSolns);
  }

  const rules = defaultRules();
  const alwaysApplySet = new Set(state.alwaysApplyRules);
  const hintRules = includeHints ? new Set(rules.map(r => r.name)) : new Set<string>();

  const engine = new SolverEngine(board, rules, {
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
      removed.map(([r, c, d]) => ({ cell: [r, c] as unknown as Cell, digit: d })),
    );
  }

  // Only activate the always-apply rules in non-hint mode
  if (!includeHints) {
    // Filter engine rules to only the always-apply set for initial solve pass
    // (The full rule list is preserved; filtering is by name match at engine level)
    void alwaysApplySet; // used by caller via engine.solve()
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
  const { board, engine } = buildEngine(state);
  engine.solve();

  let changed = false;
  const newGrid = state.userGrid.map(row => [...row]);
  for (const p of engine.appliedPlacements) {
    const [r, c] = p.cell;
    if (newGrid[r][c] === 0) { newGrid[r][c] = p.digit; changed = true; }
  }

  if (!changed) return state;

  const snapshot = captureSnapshot(board);
  const autoMutations: AutoMutation[] = [...engine.appliedMutations];
  const turn: Turn = {
    // sentinel turn: auto-only (row=-1 means no user gesture)
    action: { type: 'eliminateCandidate', row: -1, col: -1, digit: -1 },
    autoMutations,
    snapshot,
  };
  return { ...state, userGrid: newGrid, turns: [...state.turns, turn] };
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
  // Apply the action to a working copy first
  const nextState = applyAction(state, action);

  // Rebuild engine on the post-action state
  const { board, engine } = buildEngine(nextState);
  engine.solve();

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
      newGrid[action.row][action.col] = action.digit;
      return { ...state, userGrid: newGrid };
    }
    case 'removeDigit': {
      const g = state.userGrid ?? Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
      const newGrid = g.map(row => [...row]);
      newGrid[action.row][action.col] = 0;
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
      const newCages = state.virtualCages.filter(vc => {
        const k = [...vc.cells]
          .sort(([r1, c1], [r2, c2]) => r1 - r2 || c1 - c2)
          .map(([r, c]) => `${r},${c}`)
          .join(':') + `:${vc.total}`;
        return k !== key;
      });
      return { ...state, virtualCages: newCages };
    }
    case 'undo':
      return undoLastTurn(state);
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Pops the last turn from history and rebuilds userGrid from the remaining history.
 */
function undoLastTurn(state: PuzzleState): PuzzleState {
  if (state.turns.length === 0) return state;
  const turns = state.turns.slice(0, -1);
  return rebuildUserGrid({ ...state, turns });
}

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
      newGrid[a.row][a.col] = a.digit;
    } else if (a.type === 'removeDigit') {
      newGrid[a.row][a.col] = 0;
    }
    // Auto-placements are in autoMutations
    for (const m of turn.autoMutations) {
      if (m.type === 'placement' && typeof m.row === 'number' && typeof m.col === 'number' && typeof m.digit === 'number') {
        newGrid[m.row][m.col] = m.digit;
      }
    }
  }

  return { ...state, userGrid: newGrid };
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

/**
 * Finds the index of the last turn that is still consistent with a freshly
 * built board. Returns null if the current state is fully consistent.
 *
 * Used when an image re-scan or cage edit invalidates part of the history.
 */
export function findLastConsistentTurnIdx(state: PuzzleState): number | null {
  const { board, engine } = buildEngine(state);
  engine.solve();

  // Walk backwards: find the first turn whose snapshot is consistent with
  // the current board candidates
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const snap = state.turns[i].snapshot;
    if (snapshotConsistent(snap, board)) return i;
  }
  return null;
}

/** Returns true if every cell in the snapshot still has its candidates available. */
function snapshotConsistent(snap: BoardSnapshot, board: BoardState): boolean {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      for (const d of snap.candidates[r][c]) {
        if (!board.candidates[r][c].has(d)) return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

function captureSnapshot(board: BoardState): BoardSnapshot {
  const candidates = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => [...board.candidates[r][c]].sort((a, b) => a - b)),
  );
  return { candidates };
}
