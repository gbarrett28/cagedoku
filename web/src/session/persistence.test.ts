// @vitest-environment jsdom

/**
 * Tests for session/persistence.ts — saveSession/loadSession round-trip.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { saveSession, loadSession, clearPersistedSession } from './persistence.js';
import { PuzzleState } from './types.js';

afterEach(() => {
  clearPersistedSession();
});

describe('saveSession / loadSession — Big Apple', () => {
  it('round-trips a confirmed BigApplePuzzleState, stripping originalImageUrl', () => {
    const givenDigits = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    givenDigits[0]![0] = 5;
    const base = PuzzleState.createBigApple(givenDigits, ['nakedSingle'], 'data:image/png;base64,xyz');
    const confirmed: PuzzleState = {
      ...base,
      userGrid: givenDigits,
      goldenSolution: Array.from({ length: 9 }, () => new Array<number>(9).fill(1)),
    };

    saveSession(confirmed, new Map([['0,0', 'blue']]));
    const loaded = loadSession();

    expect(loaded).not.toBeNull();
    expect(PuzzleState.isBigApple(loaded!.state)).toBe(true);
    expect(loaded!.state.originalImageUrl).toBeNull();
    expect(loaded!.state.userGrid).toEqual(givenDigits);
    expect(loaded!.state.goldenSolution).toEqual(confirmed.goldenSolution);
    expect(loaded!.cellColours.get('0,0')).toBe('blue');
  });
});
