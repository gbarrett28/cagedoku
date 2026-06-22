/**
 * Tests for UnitPartitionFilter — cross-cage DFS compatibility filter.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { UnitPartitionFilter } from './unitPartitionFilter.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeBoxCageSpec, makeTrivialSpec } from '../fixtures.js';

function globalCtx(bs: KillerBoardState): RuleContext {
  return { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
}

describe('UnitPartitionFilter', () => {
  it('does not crash on a fresh trivial board', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    expect(Array.isArray(new UnitPartitionFilter().apply(globalCtx(bs)).eliminations)).toBe(true);
  });

  it('trivial board (81 single-cell cages partition every unit) → eliminations present', () => {
    // Each row is partitioned by 9 single-cell cages. Each cage has exactly one solution.
    // Only the known digit is feasible per cell; all other candidates are eliminated.
    const bs = new KillerBoardState(makeTrivialSpec());
    const result = new UnitPartitionFilter().apply(globalCtx(bs));
    // At least one elimination must be produced (fresh board has all {1..9} as candidates)
    expect(result.eliminations.length).toBeGreaterThan(0);
  });

  it('near-miss: box-cage spec — each box has one cage, partition.length===1 → no match', () => {
    // makeBoxCageSpec: each 3×3 box is a single 9-cell cage.
    // For any box unit: only 1 cage covers it → partition.length = 1 → rule skips it.
    // For any row/col unit: the box cages each span 3 rows/cols, none fits entirely
    // within a row or column → no eligible sub-cages → no partition → no match.
    const bs = new KillerBoardState(makeBoxCageSpec());
    const result = new UnitPartitionFilter().apply(globalCtx(bs));
    expect(result.eliminations).toHaveLength(0);
  });
});
