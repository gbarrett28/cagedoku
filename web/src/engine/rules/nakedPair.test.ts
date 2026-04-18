/**
 * Tests for NakedPair — port of Python's test_naked_pair.py.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { NakedPair } from './nakedPair.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

describe('NakedPair', () => {
  it('eliminates the pair digits from all other row cells', () => {
    const bs = new BoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);

    // Pair cells: both have {4,6}
    bs.candidates[0][0] = new Set([4, 6]);
    bs.candidates[0][1] = new Set([4, 6]);
    // Other cells: have 6 but not 4 (count(4)=2 triggers COUNT_HIT_TWO)
    for (let c = 2; c < 9; c++) {
      bs.candidates[0][c] = new Set([1, 2, 3, 5, 6, 7, 8, 9]);
    }
    // Sync counts
    for (let d = 1; d <= 9; d++) {
      bs.counts[rowUid][d] = [...Array(9).keys()].filter(c => bs.candidates[0][c].has(d)).length;
    }

    const ctx: RuleContext = {
      unit: bs.units[rowUid],
      cell: null,
      board: bs,
      hint: Trigger.COUNT_HIT_TWO,
      hintDigit: 4,
    };
    const elims = new NakedPair().apply(ctx).eliminations;
    const elimMap = new Map<string, Set<number>>();
    for (const e of elims) {
      const key = `${e.cell[0]},${e.cell[1]}`;
      if (!elimMap.has(key)) elimMap.set(key, new Set());
      elimMap.get(key)!.add(e.digit);
    }

    // d2=6 eliminated from (0,2)..(0,8)
    for (let c = 2; c < 9; c++) {
      expect(elimMap.get(`0,${c}`)?.has(6)).toBe(true);
    }
    // Pair cells (0,0) and (0,1) are NOT targets
    expect(elimMap.has('0,0')).toBe(false);
    expect(elimMap.has('0,1')).toBe(false);
  });

  it('returns empty when two cells do not share the same pair', () => {
    const bs = new BoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    bs.candidates[0][0] = new Set([4, 6]);
    bs.candidates[0][1] = new Set([4, 7]); // different second digit
    bs.counts[rowUid][4] = 2;

    const ctx: RuleContext = {
      unit: bs.units[rowUid],
      cell: null,
      board: bs,
      hint: Trigger.COUNT_HIT_TWO,
      hintDigit: 4,
    };
    expect(new NakedPair().apply(ctx).eliminations).toEqual([]);
  });
});
