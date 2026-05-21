import { describe, it, expect } from 'vitest';
import { solveFromStall } from '../index.js';
import { stallFixtures } from './stall-fixtures.js';

describe('stall fixtures — forward-failing regression tests', () => {
  for (const { name, candidates } of stallFixtures) {
    it(`solves '${name}' without backtracking`, () => {
      const result = solveFromStall(candidates);
      const solvedCount = Array.from({ length: 9 }, (_, r) =>
        Array.from({ length: 9 }, (_, c) => result.board.cands(r, c).size === 1)
      ).flat().filter(Boolean).length;
      console.log(`'${name}': solved ${solvedCount}/81, usedBacktracking=${result.usedBacktracking}`);
      expect(result.usedBacktracking).toBe(false);
      expect(solvedCount).toBe(81);
    });
  }
});
