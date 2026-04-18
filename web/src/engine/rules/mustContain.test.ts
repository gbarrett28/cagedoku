/**
 * Tests for MustContain — port of Python's test_must_contain.py.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { MustContain } from './mustContain.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec } from '../fixtures.js';

describe('MustContain', () => {
  it('does not crash on a fresh trivial board (row unit)', () => {
    const bs = new BoardState(makeTrivialSpec());
    const ctx: RuleContext = {
      unit: bs.units[bs.rowUnitId(0)],
      cell: null,
      board: bs,
      hint: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const result = new MustContain().apply(ctx);
    expect(Array.isArray(result.eliminations)).toBe(true);
  });

  it('returns a list of eliminations for every unit type', () => {
    const bs = new BoardState(makeTrivialSpec());
    const rule = new MustContain();
    for (const unit of bs.units) {
      const ctx: RuleContext = {
        unit,
        cell: null,
        board: bs,
        hint: Trigger.COUNT_DECREASED,
        hintDigit: null,
      };
      expect(Array.isArray(rule.apply(ctx).eliminations)).toBe(true);
    }
  });
});
