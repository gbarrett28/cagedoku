/**
 * Engine entry point — mirrors Python's `killer_sudoku.solver.engine` module.
 *
 * `solve()` constructs a BoardState, seeds given digits, runs the rule engine,
 * and falls back to MRV backtracking if the engine stalls.
 *
 * `solveFromStall()` loads a pre-computed candidate grid and re-runs the rule
 * engine from that state — useful for replaying known stall states against new rules.
 *
 * `getHints()` runs a hint-mode pass and returns the first available hint result.
 */

import { BoardState } from './boardState.js';
import { mrvBacktrack } from './backtracker.js';
import { SolverEngine } from './solverEngine.js';
import type { HintResult } from './hint.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import { defaultRules } from './rules/index.js';
import { Cell, Elimination } from './types.js';

export { BoardState } from './boardState.js';
export { SolverEngine } from './solverEngine.js';
export { defaultRules } from './rules/index.js';
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

/** Build a classic spec for use as a neutral board container in solveFromStall.
 *  Nine row-cages (total=45 each), all vertical walls, no horizontal walls. */
function makeClassicSpec(): PuzzleSpec {
  const cageTotals = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  for (let r = 0; r < 9; r++) cageTotals[r]![0] = 45;
  return {
    regions: Array.from({ length: 9 }, (_, r) => new Array<number>(9).fill(r + 1)),
    cageTotals,
    borderX: Array.from({ length: 9 }, () => new Array<boolean>(8).fill(true)),
    borderY: Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false)),
  };
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
  const board = new BoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, defaultRules());

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
  const board = new BoardState(makeClassicSpec(), { includeVirtualCages: false });
  const engine = new SolverEngine(board, defaultRules());

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
  const board = new BoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, defaultRules());

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
  const board = new BoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, defaultRules(), { hintRules: hintRuleNames });

  if (givenDigits) seedGivenDigits(engine, board, givenDigits);

  engine.solve();
  return engine.pendingHints;
}
