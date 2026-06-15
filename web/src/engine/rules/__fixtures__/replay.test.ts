import { describe, expect, it } from 'vitest';
import { boardFromFixture } from './replay.js';
import { PuzzleState } from '../../../session/types.js';
import { KNOWN_SOLUTION } from '../../fixtures.js';
import type { RuleBugFixture } from '../../../../../shared/src/fixture.js';

describe('boardFromFixture', () => {
  it('replays a serialized session and reproduces the board at report time', () => {
    const userGrid = KNOWN_SOLUTION.map(row => [...row]);
    userGrid[0]![0] = 0;
    const state: PuzzleState = {
      ...PuzzleState.createClassic(null, [], null),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      userGrid,
    };
    const fixture: RuleBugFixture = {
      version: 2,
      source: 'r2',
      name: 'test-fixture',
      addedAt: '2026-01-01',
      ruleName: 'NakedSingle',
      puzzleType: 'classic',
      state: PuzzleState.serialize(state),
    };

    const { board, state: replayed } = boardFromFixture(fixture);

    expect(replayed.goldenSolution).toEqual(KNOWN_SOLUTION);
    expect([...board.cands(0, 0)]).toEqual([KNOWN_SOLUTION[0]![0]!]);
  });
});
