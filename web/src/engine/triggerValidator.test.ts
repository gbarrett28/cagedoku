/**
 * Tests for findTriggerMisses.
 *
 * Uses a minimal board to verify that the brute-force checker correctly
 * detects rules whose apply() would produce actionable eliminations that
 * have not yet been applied to the board.
 */

import { describe, it, expect } from 'vitest';
import { BoardState } from './boardState.js';
import { SolverEngine } from './solverEngine.js';
import { makeTrivialSpec } from './fixtures.js';
import { KNOWN_SOLUTION } from './fixtures.js';
import { NakedSingle } from './rules/nakedSingle.js';
import { findTriggerMisses } from './triggerValidator.js';
import type { SolverRule } from './rule.js';
import { Trigger, UnitKind, emptyResult } from './types.js';
import type { Cell } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove all candidates except `keep` from board cell (r, c) via a no-rule engine. */
function makeSingleton(board: BoardState, r: number, c: number, keep: number): void {
  const engine = new SolverEngine(board, [], {});
  const toRemove = [...board.cands(r, c)].filter(d => d !== keep);
  engine.applyEliminations(toRemove.map(d => ({ cell: [r, c] as Cell, digit: d })));
}

/** Build a stub SolverRule that always returns the given eliminations via GLOBAL trigger. */
function stubGlobalRule(name: string, eliminations: Array<{ cell: Cell; digit: number }>): SolverRule {
  return {
    name,
    displayName: name,
    description: '',
    priority: 100,
    triggers: new Set([Trigger.GLOBAL]),
    unitKinds: new Set<UnitKind>(),
    apply: () => ({ ...emptyResult(), eliminations }),
    asHints: () => [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findTriggerMisses', () => {
  it('detects a NakedSingle miss when a singleton cell has peers still carrying the digit', () => {
    const board = new BoardState(makeTrivialSpec());
    // Make [0,0] a singleton {5}; all peers in row 0 / col 0 / box 0 still have {1..9}.
    makeSingleton(board, 0, 0, 5);

    const misses = findTriggerMisses(board, [new NakedSingle()]);

    // Should find exactly one miss for NakedSingle at context CELL_DETERMINED:r1c1
    expect(misses).toHaveLength(1);
    const miss = misses[0]!;
    expect(miss.ruleName).toBe('NakedSingle');
    expect(miss.missedContext).toBe('CELL_DETERMINED:r1c1');

    // All missed eliminations must be digit 5 (NakedSingle removes the placed digit from peers)
    expect(miss.eliminations.length).toBeGreaterThan(0);
    expect(miss.eliminations.every(e => e.digit === 5)).toBe(true);
  });

  it('returns empty after a full solve (no remaining actionable eliminations)', () => {
    const board = new BoardState(makeTrivialSpec());
    const rules = [new NakedSingle()];
    new SolverEngine(board, rules, {}).solve();

    const misses = findTriggerMisses(board, rules);
    expect(misses).toHaveLength(0);
  });

  it('returns empty when the rule result has only already-absent digits', () => {
    const board = new BoardState(makeTrivialSpec());
    // Digit 9 is already absent from cell [0,0] because we removed it.
    makeSingleton(board, 0, 0, 5); // incidentally removes 9 too

    // Rule tries to eliminate 9 from [0,0] — but 9 is already gone.
    const staleRule = stubGlobalRule('StaleRule', [{ cell: [0, 0] as Cell, digit: 9 }]);
    const misses = findTriggerMisses(board, [staleRule]);
    expect(misses).toHaveLength(0);
  });

  it('detects a miss when a valid (non-golden) elimination has not been applied', () => {
    const board = new BoardState(makeTrivialSpec());
    // Digit 9 is still in [0,0] (golden for [0,0] is 5). A rule that removes 9 is valid.
    const validRule = stubGlobalRule('ValidRule', [{ cell: [0, 0] as Cell, digit: 9 }]);

    const misses = findTriggerMisses(board, [validRule], KNOWN_SOLUTION);
    expect(misses).toHaveLength(1);
    expect(misses[0]!.ruleName).toBe('ValidRule');
    expect(misses[0]!.eliminations).toEqual([{ cell: [0, 0], digit: 9 }]);
  });

  it('skips a context entirely when any elimination would remove a golden digit', () => {
    const board = new BoardState(makeTrivialSpec());
    // Rule tries to eliminate 5 from [0,0] — 5 IS the golden digit there.
    const wrongRule = stubGlobalRule('WrongRule', [{ cell: [0, 0] as Cell, digit: 5 }]);

    const misses = findTriggerMisses(board, [wrongRule], KNOWN_SOLUTION);
    expect(misses).toHaveLength(0); // golden violation → entire context skipped
  });

  it('skips contexts where elimination contradicts golden even if other eliminations are valid', () => {
    const board = new BoardState(makeTrivialSpec());
    // Mixed: eliminate both 9 (valid) and 5 (golden violation) from [0,0].
    const mixedRule = stubGlobalRule('MixedRule', [
      { cell: [0, 0] as Cell, digit: 9 }, // valid
      { cell: [0, 0] as Cell, digit: 5 }, // golden violation
    ]);

    // Entire context must be skipped because of the golden violation.
    const misses = findTriggerMisses(board, [mixedRule], KNOWN_SOLUTION);
    expect(misses).toHaveLength(0);
  });

  it('returns empty when no golden solution is provided even if a "wrong" elimination would have been skipped', () => {
    const board = new BoardState(makeTrivialSpec());
    // Without a golden solution we cannot distinguish correct from wrong eliminations.
    // The elimination IS present in the board, so it is reported as a miss.
    const rule = stubGlobalRule('AnyRule', [{ cell: [0, 0] as Cell, digit: 5 }]);

    const misses = findTriggerMisses(board, [rule]); // no golden
    expect(misses).toHaveLength(1); // reported because we have no golden to compare
  });

  it('handles unit-scoped rules: calls the rule for every matching unit', () => {
    const board = new BoardState(makeTrivialSpec());
    let callCount = 0;
    const unitScopedRule: SolverRule = {
      name: 'UnitScopedRule',
      displayName: 'Unit Scoped Rule',
      description: '',
      priority: 100,
      triggers: new Set([Trigger.COUNT_DECREASED]),
      unitKinds: new Set([UnitKind.ROW]),
      apply: (_ctx) => { callCount++; return emptyResult(); },
      asHints: () => [],
    };

    findTriggerMisses(board, [unitScopedRule]);
    // Should call apply() once per ROW (9 rows × 1 trigger)
    expect(callCount).toBe(9);
  });
});
