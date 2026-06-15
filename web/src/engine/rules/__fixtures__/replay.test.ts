import { describe, expect, it } from 'vitest';
import { boardFromFixture } from './replay.js';
import { ruleBugFixtures } from './index.js';

describe('boardFromFixture', () => {
  it('restores stalledCandidates onto the board', () => {
    const fixture = ruleBugFixtures[0]!;
    const board = boardFromFixture(fixture);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        expect([...board.cands(r, c)].sort((a, b) => a - b)).toEqual(
          [...fixture.stalledCandidates[r]![c]!].sort((a, b) => a - b),
        );
      }
    }
  });

  it('maps fixture regions (1-based) to board.regions (0-based)', () => {
    const fixture = ruleBugFixtures[0]!;
    const board = boardFromFixture(fixture);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        expect(board.regions[r]![c]).toBe(fixture.regions[r]![c]! - 1);
      }
    }
  });
});
