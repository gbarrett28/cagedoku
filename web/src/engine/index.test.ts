import { describe, it, expect } from 'vitest';
import { solveFromStall, solveFromCandidates, detectBigApple, solveBigApple } from './index.js';
import {
  makeTrivialSpec, makeClassicGivenDigits, makeBigAppleGivenDigits, makeBigAppleMisreadGivenDigits,
  BIG_APPLE_SOLUTION,
} from './fixtures.js';

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

  it('returns false when a misread given masks an otherwise-detectable Big Apple grid', () => {
    expect(detectBigApple(makeBigAppleMisreadGivenDigits())).toBe(false);
  });

  it('returns true once the misread given is corrected back', () => {
    const grid = makeBigAppleMisreadGivenDigits();
    grid[1]![4] = 6;
    expect(detectBigApple(grid)).toBe(true);
  });
});

describe('solveBigApple', () => {
  it('fully solves a deadly-rectangle grid using window constraints, without backtracking', () => {
    const result = solveBigApple(makeBigAppleGivenDigits());
    expect(result.usedBacktracking).toBe(false);
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        expect([...result.board.cands(r, c)]).toEqual([BIG_APPLE_SOLUTION[r]![c]!]);
  });

  it('falls back to backtracking when given no digits', () => {
    const result = solveBigApple();
    expect(result.usedBacktracking).toBe(true);
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        expect(result.board.cands(r, c).size).toBe(1);
  });
});
