/**
 * Kernel DFS analysis for stalled puzzles.
 *
 * A "kernel" is a stall state from which no single-cell pin (fixing one unsolved
 * cell to its solution value) produces a new distinct stall. Every pin from a
 * kernel either solves the puzzle outright or lands on an already-seen state.
 *
 * After the DFS, the intersection of cells unsolved in every kernel identifies
 * "always stuck" cells. Cells in that intersection that are confirmed ambiguous
 * (a non-solution candidate pattern still yields a fully-solved board) are the
 * prime suspects for OCR-dropped given digits.
 */

import { solveFromCandidates } from './index.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';

/** Default DFS node budget for real-time browser analysis. */
export const KERNEL_ANALYSIS_MAX_NODES = 500;

export interface KernelAnalysisResult {
  /** Number of states popped from the DFS stack (source excluded). */
  readonly nodesExplored: number;
  /** True when the budget was exhausted before the DFS completed. */
  readonly budgetExhausted: boolean;
  /**
   * Cells unsolved in every discovered kernel — "always stuck" regardless of
   * which other cells were pinned first.
   */
  readonly intersectionCells: readonly [number, number][];
  /**
   * Subset of intersectionCells confirmed ambiguous: eliminating the solution
   * digit and running the engine still yields a fully-solved board, meaning
   * the puzzle has multiple valid completions if that cell's value is unknown.
   * These are the most likely OCR-dropped given digits.
   */
  readonly ambiguousCells: readonly [number, number][];
}

export function analyseKernels(
  spec: PuzzleSpec,
  stalledCandidates: number[][][],
  solution: number[][],
  maxNodes: number = KERNEL_ANALYSIS_MAX_NODES,
): KernelAnalysisResult {
  const seen = new Set<string>();
  const stack: number[][][][] = [];
  const kernels: number[][][][] = [];
  let nodesExplored = 0;
  let budgetExhausted = false;

  const sourceKey = JSON.stringify(stalledCandidates);
  seen.add(sourceKey);
  stack.push(stalledCandidates.map(row => row.map(cell => [...cell])));

  while (stack.length > 0) {
    if (nodesExplored >= maxNodes) { budgetExhausted = true; break; }
    const current = stack.pop()!;
    nodesExplored++;
    let isKernel = true;

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (current[r]![c]!.length <= 1) continue;

        const pinned = current.map(row => row.map(cell => [...cell]));
        pinned[r]![c] = [solution[r]![c]!];

        const result = solveFromCandidates(spec, pinned);
        if (!result.usedBacktracking) continue;

        isKernel = false;

        const sc = result.stalledCandidates!;
        const key = JSON.stringify(sc);
        if (seen.has(key)) continue;

        seen.add(key);
        stack.push(sc.map(row => row.map(cell => [...cell])));
      }
    }

    if (!isKernel || JSON.stringify(current) === sourceKey) continue;
    kernels.push(current);
  }

  if (kernels.length === 0) {
    return { nodesExplored, budgetExhausted, intersectionCells: [], ambiguousCells: [] };
  }

  // Compute the intersection of unsolved cell positions across all kernels.
  let intersection: Set<string> | null = null;
  for (const sc of kernels) {
    const here = new Set<string>();
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (sc[r]![c]!.length > 1) here.add(`${r},${c}`);
    if (intersection === null) { intersection = here; continue; }
    for (const k of intersection) if (!here.has(k)) intersection.delete(k);
  }
  intersection ??= new Set<string>();

  const intersectionCells: [number, number][] = [...intersection].map(
    k => k.split(',').map(Number) as [number, number],
  );

  // For each intersection cell, check if any non-solution candidate pattern still
  // solves the puzzle — that would confirm the cell is ambiguous (OCR-dropped digit).
  const ambiguousCellKeys = new Set<string>();
  for (const cellKey of intersection) {
    const [r, c] = cellKey.split(',').map(Number) as [number, number];
    const testedPatterns = new Set<string>();
    for (const sc of kernels) {
      if (ambiguousCellKeys.has(cellKey)) break;
      if (sc[r]![c]!.length <= 1) continue;
      const altCands = sc[r]![c]!.filter(d => d !== solution[r]![c]!);
      if (altCands.length === 0) continue;
      const patternKey = altCands.join(',');
      if (testedPatterns.has(patternKey)) continue;
      testedPatterns.add(patternKey);
      const testGrid = sc.map(row => row.map(cell => [...cell]));
      testGrid[r]![c] = altCands;
      const altResult = solveFromCandidates(spec, testGrid);
      let allSolved = true;
      for (let rr = 0; rr < 9 && allSolved; rr++)
        for (let cc = 0; cc < 9 && allSolved; cc++)
          if (altResult.board.cands(rr, cc).size !== 1) allSolved = false;
      if (allSolved) ambiguousCellKeys.add(cellKey);
    }
  }

  const ambiguousCells: [number, number][] = [...ambiguousCellKeys].map(
    k => k.split(',').map(Number) as [number, number],
  );

  return { nodesExplored, budgetExhausted, intersectionCells, ambiguousCells };
}
