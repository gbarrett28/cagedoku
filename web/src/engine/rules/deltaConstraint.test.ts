/**
 * Tests for DeltaConstraint — port of Python's test_delta_constraint.py.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { DeltaConstraint } from './deltaConstraint.js';
import type { RuleContext } from '../rule.js';
import { cellKey, Trigger } from '../types.js';
import type { Cell } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

describe('DeltaConstraint', () => {
  it('narrows candidates using an injected delta pair (0,0)-(0,1) delta=2', () => {
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[0][0] = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    bs.candidates[0][1] = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Inject a synthetic delta pair: value[(0,0)] - value[(0,1)] = 2
    const cellA = [0, 0] as unknown as Cell;
    const cellB = [0, 1] as unknown as Cell;
    const pair = [cellA, cellB, 2] as unknown as readonly [Cell, Cell, number];
    bs.linearSystem.deltaPairs.push(pair);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pairsMap = (bs.linearSystem as any)._pairsByCell as Map<string, typeof pair[]>;
    const kA = cellKey(cellA);
    const kB = cellKey(cellB);
    if (!pairsMap.has(kA)) pairsMap.set(kA, []);
    if (!pairsMap.has(kB)) pairsMap.set(kB, []);
    pairsMap.get(kA)!.push(pair);
    pairsMap.get(kB)!.push(pair);

    const ctx: RuleContext = {
      unit: bs.units[bs.rowUnitId(0)],
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const elims = new DeltaConstraint().apply(ctx).eliminations;
    const elimMap = new Map<string, Set<number>>();
    for (const e of elims) {
      const key = `${e.cell[0]},${e.cell[1]}`;
      if (!elimMap.has(key)) elimMap.set(key, new Set());
      elimMap.get(key)!.add(e.digit);
    }

    // (0,0) - (0,1) = 2 → (0,0) ≥ 3, so {1,2} eliminated
    const elims00 = elimMap.get('0,0') ?? new Set();
    expect(elims00.has(1)).toBe(true);
    expect(elims00.has(2)).toBe(true);
    // (0,1) ≤ 7, so {8,9} eliminated
    const elims01 = elimMap.get('0,1') ?? new Set();
    expect(elims01.has(8)).toBe(true);
    expect(elims01.has(9)).toBe(true);
  });

  it('subscribes to COUNT_DECREASED but not CELL_DETERMINED', () => {
    const rule = new DeltaConstraint();
    expect(rule.triggers.has(Trigger.COUNT_DECREASED)).toBe(true);
    expect(rule.triggers.has(Trigger.CELL_DETERMINED)).toBe(false);
  });
});
