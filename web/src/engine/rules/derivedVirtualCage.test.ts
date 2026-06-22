/**
 * Tests for DerivedVirtualCage — drains LinearSystem.pendingVirtualCages.
 */

import { describe, expect, it } from 'vitest';
import { DerivedVirtualCage } from './derivedVirtualCage.js';
import { KillerBoardState } from '../boardState.js';
import { makeTrivialSpec } from '../fixtures.js';
import type { Cell } from '../types.js';
import { Trigger } from '../types.js';
import type { KillerRuleContext } from '../rule.js';

function makeCtx(board: KillerBoardState): KillerRuleContext {
  return { unit: null, cell: null, board, hint: Trigger.GLOBAL, hintDigit: null };
}

describe('DerivedVirtualCage', () => {
  it('returns emptyResult when pendingVirtualCages is empty', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const rule = new DerivedVirtualCage();
    const result = rule.applyKiller(makeCtx(board));
    expect(result.virtualCageAdditions).toEqual([]);
  });

  it('returns exactly one virtualCageAddition (the first entry) when non-empty', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    board.linearSystem.pendingVirtualCages.push(
      { cells: [[0, 0], [0, 1]] as Cell[], total: 10 },
      { cells: [[1, 0], [1, 1]] as Cell[], total: 12 },
    );
    const rule = new DerivedVirtualCage();
    const result = rule.applyKiller(makeCtx(board));
    expect(result.virtualCageAdditions).toEqual([
      { cells: [[0, 0], [0, 1]], total: 10 },
    ]);
    // Pure: does not mutate the queue itself.
    expect(board.linearSystem.pendingVirtualCages).toHaveLength(2);
  });

  it('asHintsKiller surfaces every pending entry as a virtual cage suggestion', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    board.linearSystem.pendingVirtualCages.push(
      { cells: [[0, 0], [0, 1]] as Cell[], total: 10 },
      { cells: [[1, 0], [1, 1]] as Cell[], total: 12 },
    );
    const rule = new DerivedVirtualCage();
    const hints = rule.asHintsKiller(makeCtx(board), []);
    expect(hints).toHaveLength(2);
    expect(hints[0]!.virtualCageSuggestion).toEqual([[[0, 0], [0, 1]], 10]);
    expect(hints[1]!.virtualCageSuggestion).toEqual([[[1, 0], [1, 1]], 12]);
  });
});
