import { describe, it, expect } from 'vitest';
import { PuzzleState } from './types.js';
import type { PuzzleSpecData, CageState } from './types.js';

const specData: PuzzleSpecData = {
  regions: Array.from({ length: 9 }, (_, r) => new Array(9).fill(r + 1)),
  cageTotals: Array.from({ length: 9 }, () => new Array(9).fill(0)),
};

const cageStates: CageState[] = [
  { label: 'a', total: 10, cells: [{ row: 1, col: 1 }, { row: 1, col: 2 }], userEliminatedSolns: [] },
];

describe('PuzzleState.createClassic', () => {
  it('builds a base PuzzleState with no cage data', () => {
    const state = PuzzleState.createClassic([[1, 0, 0, 0, 0, 0, 0, 0, 0]], ['nakedSingle'], null);
    expect(state.userGrid).toEqual(Array.from({ length: 9 }, () => new Array<number>(9).fill(0)));
    expect(state.goldenSolution).toBeNull();
    expect(state.givenDigits).toEqual([[1, 0, 0, 0, 0, 0, 0, 0, 0]]);
    expect(state.alwaysApplyRules).toEqual(['nakedSingle']);
    expect(state.turns).toEqual([]);
    expect(state.userRemovedCandidates).toEqual([]);
    expect(PuzzleState.isKiller(state)).toBe(false);
  });
});

describe('PuzzleState.createKiller', () => {
  it('builds a KillerPuzzleState with cage data and no givens', () => {
    const state = PuzzleState.createKiller(specData, cageStates, ['nakedSingle'], null, null);
    expect(state.specData).toBe(specData);
    expect(state.cageStates).toBe(cageStates);
    expect(state.virtualCages).toEqual([]);
    expect(state.givenDigits).toBeNull();
    expect(state.userGrid).toEqual(Array.from({ length: 9 }, () => new Array<number>(9).fill(0)));
    expect(PuzzleState.isKiller(state)).toBe(true);
  });
});

describe('PuzzleState.isKiller', () => {
  it('narrows to KillerPuzzleState only when specData is present', () => {
    const classic = PuzzleState.createClassic(null, [], null);
    const killer = PuzzleState.createKiller(specData, cageStates, [], null, null);
    expect(PuzzleState.isKiller(classic)).toBe(false);
    expect(PuzzleState.isKiller(killer)).toBe(true);
  });
});
