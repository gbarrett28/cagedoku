/**
 * Engine entry point — mirrors Python's `killer_sudoku.solver.engine` module.
 *
 * `solve()` constructs a KillerBoardState, seeds given digits, runs the rule engine,
 * and falls back to MRV backtracking if the engine stalls.
 *
 * `solveFromStall()` loads a pre-computed candidate grid and re-runs the rule
 * engine from that state — useful for replaying known stall states against new rules.
 *
 * `getHints()` runs a hint-mode pass and returns the first available hint result.
 */

import { BoardState, KillerBoardState } from './boardState.js';
import { BigAppleBoardState } from './bigAppleBoardState.js';
import { mrvBacktrack } from './backtracker.js';
import { SolverEngine, KillerSolverEngine } from './solverEngine.js';
import type { HintResult } from './hint.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import { defaultRules } from './rules/index.js';
import { DISABLED_RULES } from './rules/disabled-rules.js';
import { Cell, Elimination } from './types.js';
import { hasDuplicateDigits } from '../session/assertions.js';

export { BoardState, KillerBoardState, intersectAll } from './boardState.js';
export { SolverEngine } from './solverEngine.js';
export { defaultRules } from './rules/index.js';
export { mrvBacktrack } from './backtracker.js';
export type { HintResult } from './hint.js';

function seedGivenDigits(engine: SolverEngine, board: BoardState, givenDigits: number[][]): void {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const d = givenDigits[r]![c]!;
      if (d > 0) {
        const elims: Elimination[] = [];
        for (let other = 1; other <= 9; other++) {
          if (other !== d && board.cands(r, c).has(other))
            elims.push({ cell: [r, c] as Cell, digit: other });
        }
        if (elims.length) engine.applyEliminations(elims);
      }
    }
  }
}

export interface SolveResult {
  board: BoardState;
  /** True when constraint propagation alone could not fully solve the puzzle
   *  and MRV backtracking was required to find a complete assignment. */
  usedBacktracking: boolean;
  /** Candidate grid captured before backtracking. Only present when usedBacktracking === true.
   *  Each cell is a sorted array of remaining candidates; single-element = solved. */
  stalledCandidates?: number[][][];
}

function checkStalled(board: BoardState): boolean {
  return Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => board.cands(r, c).size !== 1)
  ).some(row => row.some(Boolean));
}


/**
 * Heuristic Big Apple detector: runs classic-only constraint propagation; if
 * it stalls before every cell is solved, retries with the 4 extra window
 * units (BigAppleBoardState). Concludes "Big Apple" only if the window retry
 * completes the grid. Backtracking is deliberately excluded from both passes
 * — brute-force search would solve a valid classic puzzle regardless of
 * windows, making it useless as a discriminator.
 */
/**
 * Heuristic Big Apple detector: runs classic-only constraint propagation; if
 * it stalls before every cell is solved, retries with the 4 extra window
 * units (BigAppleBoardState). If window rules also stall, falls back to
 * MRV backtracking constrained to the window board — returning true if any
 * Big Apple solution exists. Backtracking is excluded from the classic pass
 * because brute-force finds classic solutions regardless of windows; the
 * window pass may use it because we are testing whether Big Apple constraints
 * (not just classic ones) can resolve the puzzle.
 */
export function detectBigApple(givenDigits: number[][]): boolean {
  const classicBoard = new BoardState();
  const classicEngine = new SolverEngine(classicBoard, defaultRules().filter(r => !r.killerOnly));
  seedGivenDigits(classicEngine, classicBoard, givenDigits);
  classicEngine.solve();
  if (!checkStalled(classicBoard)) return false;

  const windowBoard = new BigAppleBoardState();
  const windowEngine = new SolverEngine(windowBoard, defaultRules().filter(r => !r.killerOnly));
  seedGivenDigits(windowEngine, windowBoard, givenDigits);
  windowEngine.solve();
  if (!checkStalled(windowBoard)) return true;

  // Window rules stalled — fall back to backtracking on the window board.
  // A non-null result means at least one Big Apple solution exists.
  return mrvBacktrack(windowBoard) !== null;
}

export type ClassicSolveAssessment =
  | { bucket: 'clean' }
  | { bucket: 'backtracked' }
  | { bucket: 'notSolved'; reason: string };

/**
 * Assess whether a set of classic given digits has a unique solution.
 *
 * Reuses the same propagation pass as detectBigApple. If propagation fully
 * solves the board → clean. If it stalls, falls back to MRV backtracking:
 * solution found → backtracked; null returned → notSolved.
 */
/**
 * Seeds given digits and runs the folklore rule engine (no killer-only rules,
 * no backtracking). `solvedByRulesAlone: true` is a sound proof that the
 * grid has a unique solution — every cell's value was logically forced.
 * Does not check `hasDuplicateDigits` — callers must gate on that themselves.
 */
export function solveClassicByRulesOnly(givenDigits: number[][]): { board: BoardState; solvedByRulesAlone: boolean } {
  const board = new BoardState();
  const engine = new SolverEngine(board, defaultRules().filter(r => !r.killerOnly));
  seedGivenDigits(engine, board, givenDigits);
  engine.solve();
  return { board, solvedByRulesAlone: !checkStalled(board) };
}

export function assessClassicSolvability(givenDigits: number[][]): ClassicSolveAssessment {
  if (hasDuplicateDigits(givenDigits)) {
    return { bucket: 'notSolved', reason: 'duplicate given digits' };
  }
  const { board, solvedByRulesAlone } = solveClassicByRulesOnly(givenDigits);
  if (solvedByRulesAlone) return { bucket: 'clean' };
  const solution = mrvBacktrack(board);
  if (solution !== null) return { bucket: 'backtracked' };
  return { bucket: 'notSolved', reason: 'no solution found' };
}

function snapshotCandidates(board: BoardState): number[][][] {
  return Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => [...board.cands(r, c)].sort((a, b) => a - b))
  );
}

function runWithBacktrack(board: BoardState, stalled: boolean): SolveResult {
  if (!stalled) return { board, usedBacktracking: false };
  const stalledCandidates = snapshotCandidates(board);
  const solution = mrvBacktrack(board);
  if (solution !== null) {
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        board.candidates[r]![c]! = new Set([solution[r]![c]!]);
  }
  return { board, usedBacktracking: true, stalledCandidates };
}

/**
 * Run the full solver engine on a validated PuzzleSpec.
 *
 * Constructs KillerBoardState with virtual cages (required by LinearElimination
 * to prune via other cage rules; matches Python's batch-solve
 * killer_sudoku.solver.engine.solve(), which uses include_virtual_cages=True --
 * as opposed to the interactive-coaching path (getHints/_build_engine), which
 * deliberately omits them so algebraically-derived cages surface as opt-in
 * hints rather than silently narrowing candidates during play).
 *
 * Falls back to MRV backtracking if the rule engine stalls.
 * When backtracking is used, `stalledCandidates` in the result holds the
 * candidate grid as it was at the moment the engine stalled.
 */
export function solve(spec: PuzzleSpec, givenDigits?: number[][]): SolveResult {
  const board = new KillerBoardState(spec, { includeVirtualCages: true });
  const engine = new KillerSolverEngine(board, defaultRules());

  if (givenDigits) seedGivenDigits(engine, board, givenDigits);

  engine.solve();

  return runWithBacktrack(board, checkStalled(board));
}

/**
 * Run the full classic rule engine on a Big Apple puzzle (classic rules plus
 * the 4 extra window units). Falls back to MRV backtracking if it stalls.
 */
export function solveBigApple(givenDigits?: number[][]): SolveResult {
  const board = new BigAppleBoardState();
  const engine = new SolverEngine(board, defaultRules().filter(r => !r.killerOnly));

  if (givenDigits) seedGivenDigits(engine, board, givenDigits);

  engine.solve();

  return runWithBacktrack(board, checkStalled(board));
}

/**
 * Load a pre-computed candidate grid and run the full rule engine from that state.
 *
 * `candidates` is a 9×9 array where each cell is a sorted array of remaining
 * candidates. Single-element arrays represent solved cells. This is the format
 * produced by `solve().stalledCandidates`.
 *
 * Useful for replaying known stall states against the current rule set to verify
 * whether a newly added rule makes progress.
 */
export function solveFromStall(candidates: number[][][]): SolveResult {
  const board = new BoardState();
  const engine = new SolverEngine(board, defaultRules().filter(r => !r.killerOnly));

  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++) {
      const keep = new Set(candidates[r]![c]!);
      const elims: Elimination[] = [];
      for (let d = 1; d <= 9; d++)
        if (!keep.has(d) && board.cands(r, c).has(d))
          elims.push({ cell: [r, c] as Cell, digit: d });
      if (elims.length) engine.applyEliminations(elims);
    }

  engine.solve();

  return runWithBacktrack(board, checkStalled(board));
}

/**
 * Load a pre-computed candidate grid onto the actual puzzle spec board and
 * run the full rule engine from that state.
 *
 * Unlike `solveFromStall`, this function uses the original puzzle spec so that
 * cage-specific rules (sum constraints, cage intersections, etc.) fire in
 * addition to standard row/column/box rules. Use this when the spec is known —
 * for example, when generating focused fixtures from a committed stall fixture.
 *
 * `candidates` is a 9×9 array where each cell is a sorted array of remaining
 * candidates. Single-element arrays represent solved cells.
 */
export function solveFromCandidates(spec: PuzzleSpec, candidates: number[][][]): SolveResult {
  const board = new KillerBoardState(spec, { includeVirtualCages: true });
  const engine = new KillerSolverEngine(board, defaultRules());

  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++) {
      const keep = new Set(candidates[r]![c]!);
      const elims: Elimination[] = [];
      for (let d = 1; d <= 9; d++)
        if (!keep.has(d) && board.cands(r, c).has(d))
          elims.push({ cell: [r, c] as Cell, digit: d });
      if (elims.length) engine.applyEliminations(elims);
    }

  engine.solve();

  return runWithBacktrack(board, checkStalled(board));
}

/**
 * Run a hint-mode pass on the board and return deduplicated hints.
 */
export function getHints(
  spec: PuzzleSpec,
  givenDigits: number[][] | undefined,
  hintRuleNames: ReadonlySet<string>,
): HintResult[] {
  const _disabled = new Set(DISABLED_RULES);
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  const engine = new KillerSolverEngine(board, defaultRules().filter(r => !_disabled.has(r.name)), { hintRules: hintRuleNames });

  if (givenDigits) seedGivenDigits(engine, board, givenDigits);

  engine.solve();
  return engine.pendingHints;
}
