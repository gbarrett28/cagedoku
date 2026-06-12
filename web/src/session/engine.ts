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

import { BoardState, KillerBoardState } from '../engine/boardState.js';
import { SolverEngine, KillerSolverEngine, toDisplayName } from '../engine/solverEngine.js';
import { defaultRules } from '../engine/rules/index.js';
import { DISABLED_RULES } from '../engine/rules/disabled-rules.js';
import type { Cell, Elimination } from '../engine/types.js';
import { cellKey } from '../engine/types.js';
import type { SolverRule } from '../engine/rule.js';
import { NoSolnError } from '../solver/errors.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import { dataToSpec, virtualCageKeyFromCage, solutionKey } from './specUtils.js';
import { disableRuleForSession, isRuleDisabledForSession, hasTriggerMissBeenReported, markTriggerMissReported } from './store.js';
import { submitRuleBugReport, submitTriggerMissReport } from '../image/trainingUpload.js';
import { findTriggerMisses } from '../engine/triggerValidator.js';
import { RuleMutation } from './ruleMutation.js';
import type { RuleStep } from './ruleMutation.js';
import { UserAction, PuzzleState } from './types.js';
import type { AutoMutation, BoardSnapshot, Turn, VirtualCage } from './types.js';

// ---------------------------------------------------------------------------
// Background trigger-miss validation
// ---------------------------------------------------------------------------

let _validationTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a brute-force trigger validation to run after the current JS task.
 * Cancels any previously scheduled validation so only the most recent board
 * state is checked (avoids stale or redundant reports during rapid interaction).
 */
function scheduleTriggerValidation(
  board: BoardState,
  rules: readonly SolverRule[],
  golden: readonly (readonly number[])[],
  state: PuzzleState,
  spec: PuzzleSpec | null,
): void {
  if (_validationTimer !== null) clearTimeout(_validationTimer);
  _validationTimer = setTimeout(() => {
    _validationTimer = null;
    runTriggerValidation(board, rules, golden, state, spec);
  }, 0);
}

function runTriggerValidation(
  board: BoardState,
  rules: readonly SolverRule[],
  golden: readonly (readonly number[])[],
  state: PuzzleState,
  spec: PuzzleSpec | null,
): void {
  const { misses, violations } = findTriggerMisses(board, rules, golden);
  if (misses.length === 0 && violations.length === 0) return;

  // Compute once — shared by both miss reports and violation reports.
  const stalledCandidates = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => [...board.cands(r, c)].sort((a, b) => a - b)),
  );

  for (const miss of misses) {
    const key = `${miss.ruleName}:${miss.missedContext}`;
    if (hasTriggerMissBeenReported(key)) continue;
    markTriggerMissReported(key);
    submitTriggerMissReport({
      ruleName: miss.ruleName,
      missedContext: miss.missedContext,
      missedEliminations: miss.eliminations.map(e => ({ cell: e.cell, digit: e.digit })),
      stalledCandidates,
      goldenSolution: golden as number[][],
      puzzleType: PuzzleState.isKiller(state) ? 'killer' : 'classic',
      regions: (spec?.regions ?? []) as number[][],
      cageTotals: (spec?.cageTotals ?? []) as number[][],
    });
  }

  // Brute-force violations: a rule whose trigger never fires but whose apply()
  // would eliminate a golden digit. The normal onViolation path in SolverEngine
  // never sees these — this is the only detection point.
  for (const violation of violations) {
    if (isRuleDisabledForSession(violation.ruleName)) continue;
    disableRuleForSession(violation.ruleName);
    submitRuleBugReport({
      ruleName: violation.ruleName,
      offendingEliminations: violation.offendingEliminations.map(e => ({ cell: e.cell, digit: e.digit })),
      goldenSolution: golden as number[][],
      stalledCandidates,
      puzzleType: PuzzleState.isKiller(state) ? 'killer' : 'classic',
      regions: (spec?.regions ?? []) as number[][],
      cageTotals: (spec?.cageTotals ?? []) as number[][],
    });
  }
}

// ---------------------------------------------------------------------------
// Derive user state from turn history
// ---------------------------------------------------------------------------

/**
 * Returns all (row, col, digit) triples explicitly removed by the user.
 * Read directly from the state snapshot — no turn replay needed.
 */
export function userRemoved(state: PuzzleState): readonly [number, number, number][] {
  return state.userRemovedCandidates;
}

/**
 * Returns all virtual cages currently in effect (added but not yet removed).
 */
export function userVirtualCages(state: PuzzleState): VirtualCage[] {
  const cages = new Map<string, VirtualCage>();
  for (const turn of state.turns) {
    UserAction.applyToCages(turn.action, cages);
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
export function userEliminations(board: BoardState, userGrid: number[][]): Elimination[] {
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

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const placed = userGrid[r]![c]!;
      const golden = goldenSolution[r]![c]!;
      if (placed !== 0 && golden !== 0 && placed !== golden) return true;
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
 * Builds a fresh KillerBoardState + SolverEngine from the current PuzzleState.
 *
 * Steps (mirrors Python's _build_engine):
 * 1. Parse PuzzleSpec from specData
 * 2. Create KillerBoardState (includeVirtualCages=false to skip linear derivation)
 * 3. Re-add all virtual cages from turn history
 * 4. Apply user explicit candidate eliminations
 * 5. Apply user grid placements (eliminate all other candidates in the cell)
 * 6. Apply the explicitly removed candidates from turn history
 * 7. Construct SolverEngine with the alwaysApply rules active
 *
 * @param state   Current puzzle state
 * @param includeHints  If true, all rules generate hints instead of applying changes
 */
/** Context needed to brute-force validate the board against a golden solution. */
export interface ValidationContext {
  readonly rules: readonly SolverRule[];
  readonly golden: readonly (readonly number[])[];
  readonly spec: PuzzleSpec | null;
}

export function buildEngine(
  state: PuzzleState,
  { includeHints = false, skipSolve = false, skipValidation = false }: { includeHints?: boolean; skipSolve?: boolean; skipValidation?: boolean } = {},
): { board: BoardState; engine: SolverEngine; ruleSteps: readonly RuleStep[]; validationContext: ValidationContext | null } {
  const spec: PuzzleSpec | null = PuzzleState.isKiller(state) ? dataToSpec(state.specData) : null;

  const _disabled = new Set(DISABLED_RULES);
  const allRules = defaultRules().filter(r => !_disabled.has(r.name));
  const rules = PuzzleState.isKiller(state)
    ? allRules
    : allRules.filter(r => !r.killerOnly);
  const alwaysApplySet = new Set(state.alwaysApplyRules);

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

  const makeOnViolation = (board: BoardState) =>
    activeGolden !== null
      ? (ruleName: string, offending: readonly Elimination[]) => {
          if (isRuleDisabledForSession(ruleName)) return;
          disableRuleForSession(ruleName);
          const stalledCandidates = Array.from({ length: 9 }, (_, r) =>
            Array.from({ length: 9 }, (_, c) => [...board.cands(r, c)].sort((a, b) => a - b))
          );
          submitRuleBugReport({
            ruleName,
            offendingEliminations: offending.map(e => ({ cell: [e.cell[0], e.cell[1]] as [number, number], digit: e.digit })),
            goldenSolution: activeGolden,
            stalledCandidates,
            puzzleType: PuzzleState.isKiller(state) ? 'killer' : 'classic',
            regions: (spec?.regions ?? []) as number[][],
            cageTotals: (spec?.cageTotals ?? []) as number[][],
          });
        }
      : null;

  const { board, engine }: { board: BoardState; engine: SolverEngine } = PuzzleState.isKiller(state)
    ? (() => {
        if (!PuzzleState.isKiller(state)) throw new Error('unreachable');
        const killerSpec = dataToSpec(state.specData);
        const board = new KillerBoardState(killerSpec, { includeVirtualCages: false });

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
          board.addVirtualCage(vc.cells, vc.total, vc.eliminatedSolns, {
            ...(vc.negativeCells !== undefined && { negativeCells: vc.negativeCells }),
            ...(vc.eliminatedDiffSolns !== undefined && { eliminatedDiffSolns: vc.eliminatedDiffSolns }),
          });
        }

        const engine = new KillerSolverEngine(board, activeRules, {
          hintRules,
          goldenSolution: activeGolden,
          onViolation: makeOnViolation(board),
        });
        return { board, engine };
      })()
    : (() => {
        const board = new BoardState();
        const engine = new SolverEngine(board, activeRules, {
          hintRules,
          goldenSolution: activeGolden,
          onViolation: makeOnViolation(board),
        });
        return { board, engine };
      })();

  // Apply user placements and explicit candidate removals, then solve.
  // All three steps are wrapped in a single try/catch: any step can produce a
  // NoSolnError (e.g. removing the last candidate from a cell), and in every case
  // the board should be returned as-is so the caller can detect the contradiction
  // and offer a Rewind hint.
  let _solveCompleted = false;
  let preCands: Set<number>[][] = [];
  try {
    const placementElims = userEliminations(board, state.userGrid);
    if (placementElims.length > 0) engine.applyEliminations(placementElims);

    const removed = userRemoved(state);
    if (removed.length > 0) {
      engine.applyEliminations(
        removed.map(([r, c, d]) => ({ cell: [r, c] as Cell, digit: d })),
      );
    }

    // Eliminate each placed digit from row/col/box/cage peers unconditionally.
    // Applied after userRemoved so explicit user candidate removals take effect
    // first. This is a fundamental sudoku constraint independent of NakedSingle.
    const peerElims: Elimination[] = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const d = state.userGrid[r]![c]!;
        if (d > 0) peerElims.push(...board.peerEliminations(r, c, d));
      }
    }
    if (peerElims.length > 0) engine.applyEliminations(peerElims);

    // Fixture stall seed: bring the board to the documented all-rules-exhausted
    // state before running rules. Since the stall is a fixed point of all rules,
    // the subsequent engine.solve() finds nothing left to do.
    if (PuzzleState.isKiller(state) && state.fixtureStalledCandidates != null) {
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

    // Snapshot candidates before solve() — used to filter rule mutations down
    // to those that change the pre-solve candidate set when building ruleSteps.
    preCands = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (__, c) => new Set(board.cands(r, c))),
    );

    if (!skipSolve) engine.solve();
    _solveCompleted = true;
  } catch (e) {
    if (!(e instanceof NoSolnError)) throw e;
    // Board is contradictory — return as-is so callers can detect the inconsistency
    // via findLastConsistentTurnIdx / findMissingGoldenCandidate and offer a Rewind hint.
  }

  // Schedule a background brute-force check for trigger misses. Only runs when
  // a golden solution is present and the board is not user-corrupted, so we can
  // distinguish valid missed progress from wrong-rule bugs. Runs once per user
  // action (debounced); no UX impact since it executes after the current task.
  // Callers that need to schedule validation against a different state (e.g.
  // recordTurn, using finalState) pass skipValidation and schedule it themselves.
  if (_solveCompleted && !includeHints && !skipValidation && activeGolden !== null) {
    scheduleTriggerValidation(board, activeRules, activeGolden, state, spec);
  }

  const ruleSteps: readonly RuleStep[] = (_solveCompleted && !skipSolve)
    ? buildRuleSteps(state, engine.appliedMutations, preCands)
    : [];

  const validationContext: ValidationContext | null = activeGolden !== null
    ? { rules: activeRules, golden: activeGolden, spec }
    : null;

  return { board, engine, ruleSteps, validationContext };
}

// ---------------------------------------------------------------------------
// Rule-step construction
// ---------------------------------------------------------------------------

/**
 * Groups consecutive same-rule entries from `engine.appliedMutations` into
 * `RuleStep`s, converting each mutation record into a `RuleMutation`.
 *
 * Filters out mutations that wouldn't actually change `state`:
 *  - placements for cells already filled in `userGrid`
 *  - eliminations for digits not present in `preCands` (the pre-solve
 *    candidate snapshot) — already absent, so re-removing is a no-op
 *
 * A step is omitted entirely if all of its mutations are filtered out.
 */
function buildRuleSteps(
  state: PuzzleState,
  mutations: readonly AutoMutation[],
  preCands: readonly (readonly Set<number>[])[],
): RuleStep[] {
  const steps: RuleStep[] = [];
  let i = 0;
  while (i < mutations.length) {
    const ruleName = mutations[i]!.ruleName;
    const ruleMutations: RuleMutation[] = [];
    const highlightCells = new Map<string, Cell>();

    while (i < mutations.length && mutations[i]!.ruleName === ruleName) {
      const m = mutations[i]!;
      i++;
      switch (m.type) {
        case 'placement': {
          const r = m['row'] as number;
          const c = m['col'] as number;
          const d = m['digit'] as number;
          if (state.userGrid[r]![c] === 0) {
            ruleMutations.push(RuleMutation.placeDigit(r, c, d));
            highlightCells.set(cellKey([r, c]), [r, c]);
          }
          break;
        }
        case 'candidate_removed': {
          const r = m['row'] as number;
          const c = m['col'] as number;
          const d = m['digit'] as number;
          if (preCands[r]![c]!.has(d)) {
            ruleMutations.push(RuleMutation.eliminateCandidate(r, c, d));
            highlightCells.set(cellKey([r, c]), [r, c]);
          }
          break;
        }
        case 'virtual_cage_added': {
          if (PuzzleState.isKiller(state)) {
            const cells = m['cells'] as readonly Cell[];
            const total = m['total'] as number;
            ruleMutations.push(RuleMutation.addVirtualCage({ cells, total, eliminatedSolns: [] }));
            for (const cell of cells) highlightCells.set(cellKey(cell), cell);
          }
          break;
        }
        case 'solution_eliminated': {
          if (PuzzleState.isKiller(state) && (m['cageIdx'] as number) < state.cageStates.length) {
            const cageState = state.cageStates[m['cageIdx'] as number]!;
            const solution = m['solution'] as readonly number[];
            ruleMutations.push(RuleMutation.eliminateCageSolution(cageState.label, solution));
            for (const pos of cageState.cells) {
              const cell: Cell = [pos.row - 1, pos.col - 1];
              highlightCells.set(cellKey(cell), cell);
            }
          }
          break;
        }
      }
    }

    if (ruleMutations.length > 0) {
      steps.push({
        ruleName,
        displayName: toDisplayName(ruleName),
        highlightCells: [...highlightCells.values()],
        mutations: ruleMutations,
      });
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Rule-step folding
// ---------------------------------------------------------------------------

/**
 * Runs buildEngine() once and folds every ruleStep mutation (placements,
 * candidate eliminations, virtual cages, cage-solution eliminations) onto
 * state via RuleMutation.apply(), using the same machinery
 * AnimationPlayer.stateAtCursor uses for per-step animation.
 *
 * Calling this on its own output is a no-op: buildEngine on the folded state
 * produces an empty ruleSteps list (the deductions are now reflected in
 * userGrid/userRemovedCandidates, so preCands no longer contains them).
 */
export function applyRuleSteps(state: PuzzleState): { state: PuzzleState; ruleSteps: readonly RuleStep[] } {
  const { ruleSteps } = buildEngine(state, { skipValidation: true });
  const folded = ruleSteps.flatMap(s => s.mutations).reduce((s, m) => m.apply(s), state);
  return { state: folded, ruleSteps };
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
): { state: PuzzleState; ruleSteps: readonly RuleStep[]; baseState: PuzzleState } {
  const baseState = UserAction.apply(action, state);
  const { ruleSteps, board, engine, validationContext } = buildEngine(baseState, { skipValidation: true }); // engine.solve() called inside buildEngine
  const folded = ruleSteps.flatMap(s => s.mutations).reduce((s, m) => m.apply(s), baseState);
  const autoMutations: AutoMutation[] = [...engine.appliedMutations];
  const snapshot = captureSnapshot(board);
  const turn: Turn = { action, autoMutations, snapshot };
  const finalState = { ...folded, turns: [...baseState.turns, turn] };
  if (validationContext !== null) {
    scheduleTriggerValidation(board, validationContext.rules, validationContext.golden, finalState, validationContext.spec);
  }
  return { state: finalState, ruleSteps, baseState };
}

// ---------------------------------------------------------------------------
// User grid rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuilds userGrid by replaying all turns.
 * Called after undo or when resynchronising state.
 */
export function rebuildUserGrid(state: PuzzleState): PuzzleState {
  if (state.goldenSolution === null) return state;
  const newGrid: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const removedList: [number, number, number][] = [];

  for (const turn of state.turns) {
    UserAction.applyToGrid(turn.action, newGrid);
    UserAction.updateRemovedList(turn.action, removedList);
  }

  if (!PuzzleState.isKiller(state)) {
    return { ...state, userGrid: newGrid, userRemovedCandidates: removedList };
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

  const result = { ...state, userGrid: newGrid, virtualCages: mergedVCs, userRemovedCandidates: removedList };
  return result;
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
  if (goldenSolution === null) return null;

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
 * Builds the engine from scratch (applying userRemovedCandidates) and returns
 * the first ruleStep produced by `buildEngine`.
 */
export function getNextAutoApplyStep(state: PuzzleState): RuleStep | null {
  if (state.goldenSolution === null) return null;
  const { ruleSteps } = buildEngine(state);
  return ruleSteps[0] ?? null;
}

/** Applies every mutation in a RuleStep to the state, in order. */
export function applyAutoApplyStep(state: PuzzleState, step: RuleStep): PuzzleState {
  return step.mutations.reduce((s, mutation) => mutation.apply(s), state);
}
