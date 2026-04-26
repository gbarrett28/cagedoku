/**
 * Engine entry point — mirrors Python's `killer_sudoku.solver.engine` module.
 *
 * `solve()` constructs a BoardState, seeds given digits, runs the rule engine,
 * and falls back to MRV backtracking if the engine stalls.
 *
 * `hint()` runs a hint-mode pass and returns the first available hint result.
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

/**
 * Run the full solver engine on a validated PuzzleSpec.
 *
 * Constructs a BoardState with virtual cages (required by LinearElimination)
 * and runs all rules until no further progress is possible.
 *
 * If givenDigits is provided (classic sudoku), pre-eliminates all non-given
 * candidates from fixed cells before seeding the engine.
 *
 * Falls back to MRV backtracking if the rule engine stalls.
 */
export function solve(spec: PuzzleSpec, givenDigits?: number[][]): BoardState {
  const board = new BoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, defaultRules());

  if (givenDigits) {
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

  engine.solve();

  // If engine stalled, fall back to MRV backtracking
  const stalled = Array.from({length: 9}, (_, r) =>
    Array.from({length: 9}, (__, c) => board.cands(r, c).size !== 1)
  ).some(row => row.some(Boolean));

  if (stalled) {
    const solution = mrvBacktrack(board);
    if (solution !== null) {
      for (let r = 0; r < 9; r++)
        for (let c = 0; c < 9; c++)
          board.candidates[r]![c]! = new Set([solution[r]![c]!]);
    }
  }

  return board;
}

/**
 * Run a hint-mode pass on the board and return deduplicated hints.
 *
 * Uses the same rule set as solve() but routes rule output through asHints()
 * instead of applying eliminations.
 */
export function getHints(
  spec: PuzzleSpec,
  givenDigits: number[][] | undefined,
  hintRuleNames: ReadonlySet<string>,
): HintResult[] {
  const board = new BoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, defaultRules(), { hintRules: hintRuleNames });

  if (givenDigits) {
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

  engine.solve();
  return engine.pendingHints;
}
