import { describe, it, expect } from 'vitest';
import { PuzzleState } from './types.js';
import type { KillerPuzzleState, VirtualCage } from './types.js';
import { RuleMutation } from './ruleMutation.js';
import { specToData, specToCageStates, classicSyntheticSpec } from './specUtils.js';

function blankClassicState(): PuzzleState {
  return PuzzleState.createClassic(null, [], null);
}

function blankKillerState(): KillerPuzzleState {
  const spec = classicSyntheticSpec();
  return PuzzleState.createKiller(specToData(spec), specToCageStates(spec), [], null, null);
}

describe('PlaceDigitMutation', () => {
  it('sets the digit at the given cell', () => {
    const state = blankClassicState();
    const mutation = RuleMutation.placeDigit(2, 3, 7);

    expect(mutation.type).toBe('placeDigit');
    const next = mutation.apply(state);

    expect(next.userGrid[2]![3]).toBe(7);
    // Original state is untouched.
    expect(state.userGrid[2]![3]).toBe(0);
  });

  it('does not mutate other cells', () => {
    const state = blankClassicState();
    const next = RuleMutation.placeDigit(0, 0, 5).apply(state);

    expect(next.userGrid[0]![1]).toBe(0);
    expect(next.userGrid[1]![0]).toBe(0);
  });
});

describe('EliminateCandidateMutation', () => {
  it('appends [row, col, digit] to userRemovedCandidates', () => {
    const state = blankClassicState();
    const mutation = RuleMutation.eliminateCandidate(4, 5, 9);

    expect(mutation.type).toBe('eliminateCandidate');
    const next = mutation.apply(state);

    expect(next.userRemovedCandidates).toEqual([[4, 5, 9]]);
    expect(state.userRemovedCandidates).toEqual([]);
  });

  it('preserves existing removed candidates', () => {
    const state = { ...blankClassicState(), userRemovedCandidates: [[0, 0, 1] as [number, number, number]] };
    const next = RuleMutation.eliminateCandidate(1, 1, 2).apply(state);

    expect(next.userRemovedCandidates).toEqual([[0, 0, 1], [1, 1, 2]]);
  });
});

describe('AddVirtualCageMutation', () => {
  const cage: VirtualCage = { cells: [[0, 0], [0, 1]], total: 10, eliminatedSolns: [] };

  it('appends the cage to virtualCages on a killer state', () => {
    const state = blankKillerState();
    const mutation = RuleMutation.addVirtualCage(cage);

    expect(mutation.type).toBe('addVirtualCage');
    const next = mutation.apply(state) as KillerPuzzleState;

    expect(next.virtualCages).toEqual([cage]);
    expect(state.virtualCages).toEqual([]);
  });

  it('throws when applied to a classic state', () => {
    const state = blankClassicState();
    const mutation = RuleMutation.addVirtualCage(cage);

    expect(() => mutation.apply(state)).toThrow();
  });
});

describe('EliminateCageSolutionMutation', () => {
  it("appends the solution to the matching cage's userEliminatedSolns", () => {
    const state = blankKillerState();
    const mutation = RuleMutation.eliminateCageSolution('A', [1, 8]);

    expect(mutation.type).toBe('eliminateCageSolution');
    const next = mutation.apply(state) as KillerPuzzleState;

    const cageA = next.cageStates.find(c => c.label === 'A')!;
    expect(cageA.userEliminatedSolns).toEqual([[1, 8]]);

    // Other cages untouched.
    const cageB = next.cageStates.find(c => c.label === 'B')!;
    expect(cageB.userEliminatedSolns).toEqual([]);

    // Original state is untouched.
    const originalCageA = state.cageStates.find(c => c.label === 'A')!;
    expect(originalCageA.userEliminatedSolns).toEqual([]);
  });

  it('throws when applied to a classic state', () => {
    const state = blankClassicState();
    const mutation = RuleMutation.eliminateCageSolution('A', [1, 8]);

    expect(() => mutation.apply(state)).toThrow();
  });

  it('throws when the cage label does not exist', () => {
    const state = blankKillerState();
    const mutation = RuleMutation.eliminateCageSolution('ZZ', [1, 8]);

    expect(() => mutation.apply(state)).toThrow();
  });
});

describe('RuleMutation.revive', () => {
  it('round-trips placeDigit through JSON', () => {
    const original = RuleMutation.placeDigit(2, 3, 7);
    const revived = RuleMutation.revive(JSON.parse(JSON.stringify(original)));

    const state = blankClassicState();
    expect(revived.apply(state)).toEqual(original.apply(state));
  });

  it('round-trips eliminateCandidate through JSON', () => {
    const original = RuleMutation.eliminateCandidate(4, 5, 9);
    const revived = RuleMutation.revive(JSON.parse(JSON.stringify(original)));

    const state = blankClassicState();
    expect(revived.apply(state)).toEqual(original.apply(state));
  });

  it('round-trips addVirtualCage through JSON', () => {
    const cage: VirtualCage = { cells: [[0, 0], [0, 1]], total: 10, eliminatedSolns: [] };
    const original = RuleMutation.addVirtualCage(cage);
    const revived = RuleMutation.revive(JSON.parse(JSON.stringify(original)));

    const state = blankKillerState();
    expect(revived.apply(state)).toEqual(original.apply(state));
  });

  it('round-trips eliminateCageSolution through JSON', () => {
    const original = RuleMutation.eliminateCageSolution('A', [1, 8]);
    const revived = RuleMutation.revive(JSON.parse(JSON.stringify(original)));

    const state = blankKillerState();
    expect(revived.apply(state)).toEqual(original.apply(state));
  });

  it('throws on an unknown mutation type', () => {
    expect(() => RuleMutation.revive({ type: 'bogus' })).toThrow();
  });
});
