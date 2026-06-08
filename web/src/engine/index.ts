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
import { mrvBacktrack } from './backtracker.js';
import { SolverEngine, KillerSolverEngine } from './solverEngine.js';
import type { HintResult } from './hint.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import { defaultRules } from './rules/index.js';
import { DISABLED_RULES } from './rules/disabled-rules.js';
import { Cell, Elimination } from './types.js';

export { BoardState, KillerBoardState } from './boardState.js';
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
 * Falls back to MRV backtracking if the rule engine stalls.
 * When backtracking is used, `stalledCandidates` in the result holds the
 * candidate grid as it was at the moment the engine stalled.
 */
export function solve(spec: PuzzleSpec, givenDigits?: number[][]): SolveResult {
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  const engine = new KillerSolverEngine(board, defaultRules());

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
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
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
