import { describe, it, expect, beforeEach } from 'vitest';
import { PuzzleState } from './types.js';
import {
  getState,
  setState,
  getStateCandidates,
  setStateCandidates,
  clearSession,
} from './store.js';

function makeState(): PuzzleState {
  return PuzzleState.createClassic(null, [], null);
}

describe('store candidate list', () => {
  beforeEach(() => {
    clearSession();
  });

  it('starts with no candidates', () => {
    expect(getStateCandidates()).toEqual([]);
    expect(getState()).toBeNull();
  });

  it('setStateCandidates replaces the candidate list', () => {
    const a = makeState();
    const b = makeState();
    setStateCandidates([a, b]);
    expect(getStateCandidates()).toEqual([a, b]);
  });

  it('setState sets a singleton candidate list', () => {
    const state = makeState();
    setState(state);
    expect(getStateCandidates()).toEqual([state]);
    expect(getState()).toBe(state);
  });

  it('clearSession empties the candidate list', () => {
    setState(makeState());
    clearSession();
    expect(getStateCandidates()).toEqual([]);
    expect(getState()).toBeNull();
  });
});
