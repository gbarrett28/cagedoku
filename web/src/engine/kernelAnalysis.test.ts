import { describe, it, expect } from 'vitest';
import { analyseKernels, KERNEL_ANALYSIS_MAX_NODES } from './kernelAnalysis.js';
import { makeTrivialSpec, KNOWN_SOLUTION } from './fixtures.js';

describe('analyseKernels', () => {
  it('exposes the default node budget constant', () => {
    expect(KERNEL_ANALYSIS_MAX_NODES).toBeGreaterThan(0);
  });

  it('returns empty result when stalledCandidates are all solved', () => {
    const spec = makeTrivialSpec();
    const stalledCandidates = KNOWN_SOLUTION.map(row => row.map(d => [d]));
    const solution = KNOWN_SOLUTION.map(row => [...row]);
    const result = analyseKernels(spec, stalledCandidates, solution);
    expect(result.budgetExhausted).toBe(false);
    expect(result.intersectionCells).toHaveLength(0);
    expect(result.ambiguousCells).toHaveLength(0);
    expect(result.kernelStates).toHaveLength(0);
  });

  it('exhausts budget immediately when maxNodes=0', () => {
    const spec = makeTrivialSpec();
    const stalledCandidates = KNOWN_SOLUTION.map(row => row.map(d => [d]));
    const solution = KNOWN_SOLUTION.map(row => [...row]);
    const result = analyseKernels(spec, stalledCandidates, solution, 0);
    expect(result.budgetExhausted).toBe(true);
    expect(result.nodesExplored).toBe(0);
    expect(result.kernelStates).toHaveLength(0);
  });

  it('returns valid cell coordinates in intersection and ambiguous arrays', () => {
    const spec = makeTrivialSpec();
    const stalledCandidates = KNOWN_SOLUTION.map(row => row.map(d => [d]));
    const solution = KNOWN_SOLUTION.map(row => [...row]);
    const result = analyseKernels(spec, stalledCandidates, solution);
    expect(Array.isArray(result.intersectionCells)).toBe(true);
    expect(Array.isArray(result.ambiguousCells)).toBe(true);
    for (const [r, c] of result.intersectionCells) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(9);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(9);
    }
    // ambiguousCells must be a subset of intersectionCells
    const intersectionSet = new Set(result.intersectionCells.map(([r, c]) => `${r},${c}`));
    for (const [r, c] of result.ambiguousCells) {
      expect(intersectionSet.has(`${r},${c}`)).toBe(true);
    }
  });

  it('nodesExplored does not exceed maxNodes', () => {
    const spec = makeTrivialSpec();
    const stalledCandidates = KNOWN_SOLUTION.map(row => row.map(d => [d]));
    const solution = KNOWN_SOLUTION.map(row => [...row]);
    for (const budget of [0, 1, 5]) {
      const result = analyseKernels(spec, stalledCandidates, solution, budget);
      expect(result.nodesExplored).toBeLessThanOrEqual(budget);
    }
  });

  it('kernelStates are valid 9×9 candidate grids', () => {
    const spec = makeTrivialSpec();
    const stalledCandidates = KNOWN_SOLUTION.map(row => row.map(d => [d]));
    const solution = KNOWN_SOLUTION.map(row => [...row]);
    const result = analyseKernels(spec, stalledCandidates, solution);
    for (const ks of result.kernelStates) {
      expect(ks).toHaveLength(9);
      for (const row of ks) {
        expect(row).toHaveLength(9);
        for (const cell of row) {
          expect(cell.length).toBeGreaterThanOrEqual(1);
          for (const d of cell) {
            expect(d).toBeGreaterThanOrEqual(1);
            expect(d).toBeLessThanOrEqual(9);
          }
        }
      }
    }
  });
});

