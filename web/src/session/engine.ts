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
import { DISABLED_RULES } from '../engine/rules/disabled-rules.js';
import type { Cell, Elimination, Placement, RuleStep } from '../engine/types.js';
import { NoSolnError } from '../solver/errors.js';
import { dataToSpec, virtualCageKeyFromCage, solutionKey } from './specUtils.js';
import { disableRuleForSession, isRuleDisabledForSession } from './store.js';
import { submitPuzzleReport } from '../image/trainingUpload.js';
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
 *
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
// User-corruption detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the user has placed a wrong digit or manually removed a
 * golden-solution digit from the candidates — i.e. the board state has
 * diverged from the golden solution through user action, not rule error.
 *
 * When true, `buildEngine` omits `goldenSolution` from the engine so rule
 * checks are disabled; there is no point filing a rule-bug report when the
 * board is already inconsistent.
 */
export function isUserCorrupted(state: PuzzleState): boolean {
  const { goldenSolution, userGrid } = state;
  if (goldenSolution === null) return false;

  if (userGrid !== null) {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const placed = userGrid[r]![c]!;
        const golden = goldenSolution[r]![c]!;
        if (placed !== 0 && golden !== 0 && placed !== golden) return true;
      }
    }
  }

  for (const [r, c, d] of userRemoved(state)) {
    if (goldenSolution[r]![c]! === d) return true;
  }

  return false;
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
  { includeHints = false, skipSolve = false }: { includeHints?: boolean; skipSolve?: boolean } = {},
): { board: BoardState; engine: SolverEngine } {
  const spec = dataToSpec(state.specData);
  const board = new BoardState(spec, { includeVirtualCages: false });

  // Apply user-eliminated cage solutions for real cages before any rules run.
  for (let i = 0; i < state.cageStates.length; i++) {
    const eliminated = state.cageStates[i]!.userEliminatedSolns;
    if (eliminated.length === 0) continue;
    const elimKeys = new Set(eliminated.map(solutionKey));
    const solns = board.cageSolns[i]!;
    solns.splice(0, Infinity, ...solns.filter(s => !elimKeys.has(solutionKey(s))));
  }

  // Re-add virtual cages — use state.virtualCages directly so that
  // eliminatedSolns set by eliminateVirtualCageSolution are applied.
  for (const vc of state.virtualCages) {
    board.addVirtualCage(vc.cells, vc.total, vc.eliminatedSolns);
  }

  const _disabled = new Set(DISABLED_RULES);
  const rules = defaultRules().filter(r => !_disabled.has(r.name));
  const alwaysApplySet = new Set(state.alwaysApplyRules);
  // Always include NakedSingle for Classic mode so placement + peer eliminations
  // fire regardless of user settings.
  if (state.puzzleType === 'classic') alwaysApplySet.add('NakedSingle');

  // Non-hint mode: only always-apply rules run.
  // Hint mode: all rules run; always-apply rules apply directly, hint-only rules go to pendingHints.
  const activeRules = includeHints ? rules : rules.filter(r => alwaysApplySet.has(r.name));
  const hintRules = includeHints
    ? new Set(rules.filter(r => !alwaysApplySet.has(r.name)).map(r => r.name))
    : new Set<string>();

  // Golden checks are only meaningful when the user hasn't already corrupted the
  // board. Once a wrong placement or candidate removal is present, rules might
  // legitimately produce any elimination — disabling the checks prevents spurious
  // bug reports that would merely reflect the user's mistake.
  const userCorrupted = isUserCorrupted(state);
  const activeGolden = userCorrupted ? null : state.goldenSolution;

  const onViolation = activeGolden !== null
    ? (ruleName: string, offending: readonly Elimination[]) => {
        if (isRuleDisabledForSession(ruleName)) return;
        disableRuleForSession(ruleName);
        const stalledCandidates = Array.from({ length: 9 }, (_, r) =>
          Array.from({ length: 9 }, (_, c) => [...board.cands(r, c)].sort((a, b) => a - b))
        );
        submitPuzzleReport({
          reason: 'rule-bug',
          ruleName,
          offendingEliminations: offending.map(e => ({ cell: [e.cell[0], e.cell[1]] as [number, number], digit: e.digit })),
          goldenSolution: activeGolden,
          stalledCandidates,
          puzzleType: state.puzzleType,
          regions: spec.regions as number[][],
          cageTotals: spec.cageTotals as number[][],
          actions: state.turns.map(t => t.action),
          givenDigits: state.givenDigits,
        });
      }
    : null;

  const engine = new SolverEngine(board, activeRules, {
    linearSystemActive: true,
    hintRules,
    goldenSolution: activeGolden,
    onViolation,
  });

  // Apply user placements and explicit candidate removals, then solve.
  // All three steps are wrapped in a single try/catch: any step can produce a
  // NoSolnError (e.g. removing the last candidate from a cell), and in every case
  // the board should be returned as-is so the caller can detect the contradiction
  // and offer a Rewind hint.
  try {
    const placementElims = userEliminations(board, state.userGrid);
    if (placementElims.length > 0) engine.applyEliminations(placementElims);

    // autoRemovedCandidates accumulate rule-generated eliminations across turns.
    // If golden checks are active, filter out any stale golden violations before
    // applying — these indicate a rule bug from a prior session that has since
    // been suppressed; re-applying them would corrupt the board before rules run.
    const autoRemoved = state.autoRemovedCandidates ?? [];
    const safeAutoRemoved = activeGolden !== null
      ? autoRemoved.filter(([r, c, d]) => activeGolden[r]?.[c] !== d)
      : autoRemoved;

    const removed = [...userRemoved(state), ...safeAutoRemoved];
    if (removed.length > 0) {
      engine.applyEliminations(
        removed.map(([r, c, d]) => ({ cell: [r, c] as Cell, digit: d })),
      );
    }

    // Fixture stall seed: bring the board to the documented all-rules-exhausted
    // state before running rules. Since the stall is a fixed point of all rules,
    // the subsequent engine.solve() finds nothing left to do.
    if (state.fixtureStalledCandidates != null) {
      const stallElims: Elimination[] = [];
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const keep = new Set(state.fixtureStalledCandidates[r]![c]!);
          for (const d of board.cands(r, c)) {
            if (!keep.has(d)) stallElims.push({ cell: [r, c] as Cell, digit: d });
          }
        }
      }
      if (stallElims.length > 0) engine.applyEliminations(stallElims);
    }

    if (!skipSolve) engine.solve();
  } catch (e) {
    if (!(e instanceof NoSolnError)) throw e;
    // Board is contradictory — return as-is so callers can detect the inconsistency
    // via findLastConsistentTurnIdx / findMissingGoldenCandidate and offer a Rewind hint.
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

// ---------------------------------------------------------------------------
// Rule-by-rule auto-apply animation helpers
// ---------------------------------------------------------------------------

/**
 * Returns the next rule step to be animated, or null when no more rules fire.
 * Builds the engine from scratch (applying autoRemovedCandidates) and returns
 * the first consecutive group of mutations from the same rule.
 */
export function getNextAutoApplyStep(state: PuzzleState): RuleStep | null {
  if (state.userGrid === null) return null;
  // skipSolve: we call engine.solve() manually so we can inspect appliedMutations.
  const { board, engine } = buildEngine(state, { skipSolve: true });

  // Snapshot candidates before the solve mutates the board — used below to filter
  // out eliminations the solver reports but that are already absent.
  const preCands = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => new Set(board.cands(r, c))),
  );

  engine.solve();
  const mutations = engine.appliedMutations;
  if (mutations.length === 0) return null;

  // Walk consecutive same-rule groups; return the first group that has at least
  // one change that will actually modify PuzzleState:
  //   placements — cell is currently empty in userGrid
  //   eliminations — digit was present in the pre-solve candidate set
  let i = 0;
  while (i < mutations.length) {
    const ruleName = mutations[i]!.ruleName;
    const placements: Placement[] = [];
    const eliminations: Elimination[] = [];

    while (i < mutations.length && mutations[i]!.ruleName === ruleName) {
      const m = mutations[i]!;
      i++;
      const r = m['row'] as number;
      const c = m['col'] as number;
      const d = m['digit'] as number;
      if (m.type === 'placement') {
        if (state.userGrid![r]![c] === 0)
          placements.push({ cell: [r, c] as Cell, digit: d });
      } else if (m.type === 'candidate_removed') {
        if (preCands[r]![c]!.has(d))
          eliminations.push({ cell: [r, c] as Cell, digit: d });
      }
    }

    if (placements.length > 0 || eliminations.length > 0) {
      const cellSet = new Map<string, Cell>();
      for (const p of placements) cellSet.set(`${p.cell[0]},${p.cell[1]}`, p.cell);
      for (const e of eliminations) cellSet.set(`${e.cell[0]},${e.cell[1]}`, e.cell);
      return {
        ruleName,
        displayName: ruleName.replace(/([A-Z])/g, ' $1').trim(),
        highlightCells: [...cellSet.values()],
        eliminations,
        placements,
      };
    }
  }

  return null;
}

/**
 * Applies a RuleStep to the state: places digits in userGrid and accumulates
 * eliminations in autoRemovedCandidates so subsequent solver calls do not
 * re-produce them.
 */
export function applyAutoApplyStep(state: PuzzleState, step: RuleStep): PuzzleState {
  const newGrid = state.userGrid!.map(row => [...row]);
  for (const p of step.placements) newGrid[p.cell[0]]![p.cell[1]] = p.digit;
  return {
    ...state,
    userGrid: newGrid,
    autoRemovedCandidates: [
      ...state.autoRemovedCandidates,
      ...step.eliminations.map(e => [e.cell[0], e.cell[1], e.digit] as [number, number, number]),
    ],
  };
}
