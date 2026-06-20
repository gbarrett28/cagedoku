import { describe, it, expect } from 'vitest';
import { solveFromStall, solveFromCandidates, detectBigApple } from './index.js';
import { makeTrivialSpec, makeClassicGivenDigits, makeBigAppleGivenDigits } from './fixtures.js';

describe('solveFromStall', () => {
  it('returns usedBacktracking=false and 81 solved cells for a fully-solved grid', () => {
    // Each cell has exactly one candidate — already solved, nothing for rules to do.
    const solved: number[][][] = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => {
        const d = ((r * 3 + Math.floor(r / 3) + c) % 9) + 1;
        return [d];
      })
    );
    const result = solveFromStall(solved);
    const solvedCount = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => result.board.cands(r, c).size === 1)
    ).flat().filter(Boolean).length;
    expect(result.usedBacktracking).toBe(false);
    expect(solvedCount).toBe(81);
  });

  it('does not set stalledCandidates when grid is already fully solved', () => {
    const solved: number[][][] = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => {
        const d = ((r * 3 + Math.floor(r / 3) + c) % 9) + 1;
        return [d];
      })
    );
    const result = solveFromStall(solved);
    expect(result.stalledCandidates).toBeUndefined();
  });
});

describe('solveFromCandidates', () => {
  it('returns usedBacktracking=false and 81 solved cells for a fully-solved grid', () => {
    // Each cell has exactly one candidate — already solved, nothing for rules to do.
    const solved: number[][][] = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => {
        const d = ((r * 3 + Math.floor(r / 3) + c) % 9) + 1;
        return [d];
      })
    );
    const result = solveFromCandidates(makeTrivialSpec(), solved);
    const solvedCount = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => result.board.cands(r, c).size === 1)
    ).flat().filter(Boolean).length;
    expect(result.usedBacktracking).toBe(false);
    expect(solvedCount).toBe(81);
  });

  it('does not set stalledCandidates when grid is already fully solved', () => {
    const solved: number[][][] = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => {
        const d = ((r * 3 + Math.floor(r / 3) + c) % 9) + 1;
        return [d];
      })
    );
    const result = solveFromCandidates(makeTrivialSpec(), solved);
    expect(result.stalledCandidates).toBeUndefined();
  });
});

describe('detectBigApple', () => {
  it('returns false for an all-blank grid (both passes stall identically)', () => {
    const blank = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    expect(detectBigApple(blank)).toBe(false);
  });

  it('returns false when classic rules alone already solve the grid', () => {
    expect(detectBigApple(makeClassicGivenDigits())).toBe(false);
  });

  it('returns true for a deadly-rectangle grid that only windows can resolve', () => {
    expect(detectBigApple(makeBigAppleGivenDigits())).toBe(true);
  });
});
