/**
 * Tests for LinearElimination — RREF-derived placements and eliminations.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from '../boardState.js';
import { LinearElimination } from './linearElimination.js';
import type { RuleContext } from '../rule.js';
import { Trigger } from '../types.js';
import { makeTrivialSpec, makeTwoCellCageSpec } from '../fixtures.js';

function globalCtx(bs: KillerBoardState): RuleContext {
  return { unit: null, cell: null, board: bs, hint: Trigger.GLOBAL, hintDigit: null };
}

describe('LinearElimination', () => {
  it('does not crash on a fresh trivial board', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    expect(Array.isArray(new LinearElimination().apply(globalCtx(bs)).eliminations)).toBe(true);
  });

  it('trivial board: initialEliminations present in candidates are returned', () => {
    // The trivial spec (81 single-cell cages) determines every cell uniquely via the
    // linear system. The initialEliminations list contains infeasible (cell, digit) pairs.
    // On a fresh board where candidates still contain {1..9}, many are still present.
    const bs = new KillerBoardState(makeTrivialSpec());
    const elims = new LinearElimination().apply(globalCtx(bs)).eliminations;
    expect(elims.length).toBeGreaterThan(0);
  });

  it('near-miss: elimination already absent from candidates is not returned', () => {
    // If all initialEliminations have already been applied (candidates match solutions),
    // apply() returns nothing — the board is consistent and nothing further is eliminated.
    const bs = new KillerBoardState(makeTwoCellCageSpec());
    // Clear all initialEliminations by removing them from candidates first
    for (const e of bs.linearSystem.initialEliminations) {
      bs.candidates[e.cell[0]]?.[e.cell[1]]?.delete(e.digit);
    }
    const result = new LinearElimination().apply(globalCtx(bs));
    expect(result.eliminations).toHaveLength(0);
  });

  it('asHints: returns placement hint when a cell is uniquely determined', () => {
    // Use trivial spec where every cell is determined by the linear system.
    // At least one T1 placement hint should be produced.
    const bs = new KillerBoardState(makeTrivialSpec());
    const ctx = globalCtx(bs);
    const rule = new LinearElimination();
    const elims = rule.apply(ctx).eliminations;
    expect(elims.length).toBeGreaterThan(0);
    const hints = rule.asHints(ctx, [...elims]);
    const placements = hints.filter(h => h.placement !== null);
    expect(placements.length).toBeGreaterThan(0);
    for (const h of placements) {
      expect(h.ruleName).toBe('LinearElimination');
      expect(h.placement).not.toBeNull();
      expect(h.explanation).toContain('uniquely determine');
    }
  });
});
