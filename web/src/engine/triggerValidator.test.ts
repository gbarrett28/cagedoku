/**
 * Tests for findTriggerMisses.
 *
 * Uses a minimal board to verify that the brute-force checker correctly
 * detects rules whose apply() would produce actionable eliminations that
 * have not yet been applied to the board, and rules whose apply() would
 * violate the golden solution (brute-force violations).
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
// Trigger miss tests
// ---------------------------------------------------------------------------

describe('findTriggerMisses — misses', () => {
  it('detects a NakedSingle miss when a singleton cell has peers still carrying the digit', () => {
    const board = new BoardState(makeTrivialSpec());
    // Make [0,0] a singleton {5}; all peers in row 0 / col 0 / box 0 still have {1..9}.
    makeSingleton(board, 0, 0, 5);

    const { misses } = findTriggerMisses(board, [new NakedSingle()]);

    expect(misses).toHaveLength(1);
    const miss = misses[0]!;
    expect(miss.ruleName).toBe('NakedSingle');
    expect(miss.missedContext).toBe('CELL_DETERMINED:r1c1');
    expect(miss.eliminations.length).toBeGreaterThan(0);
    expect(miss.eliminations.every(e => e.digit === 5)).toBe(true);
  });

  it('returns empty misses after a full solve (no remaining actionable eliminations)', () => {
    const board = new BoardState(makeTrivialSpec());
    const rules = [new NakedSingle()];
    new SolverEngine(board, rules, {}).solve();

    const { misses } = findTriggerMisses(board, rules);
    expect(misses).toHaveLength(0);
  });

  it('returns empty misses when the rule result has only already-absent digits', () => {
    const board = new BoardState(makeTrivialSpec());
    makeSingleton(board, 0, 0, 5); // incidentally removes 9

    const staleRule = stubGlobalRule('StaleRule', [{ cell: [0, 0] as Cell, digit: 9 }]);
    const { misses } = findTriggerMisses(board, [staleRule]);
    expect(misses).toHaveLength(0);
  });

  it('detects a miss when a valid (non-golden) elimination has not been applied', () => {
    const board = new BoardState(makeTrivialSpec());
    const validRule = stubGlobalRule('ValidRule', [{ cell: [0, 0] as Cell, digit: 9 }]);

    const { misses } = findTriggerMisses(board, [validRule], KNOWN_SOLUTION);
    expect(misses).toHaveLength(1);
    expect(misses[0]!.ruleName).toBe('ValidRule');
    expect(misses[0]!.eliminations).toEqual([{ cell: [0, 0], digit: 9 }]);
  });

  it('returns empty misses and no violations when no golden solution is provided and digit is present', () => {
    const board = new BoardState(makeTrivialSpec());
    // Without golden we cannot classify digit 5 as a violation — it is reported as a miss.
    const rule = stubGlobalRule('AnyRule', [{ cell: [0, 0] as Cell, digit: 5 }]);

    const { misses, violations } = findTriggerMisses(board, [rule]);
    expect(misses).toHaveLength(1);
    expect(violations).toHaveLength(0);
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
      apply: () => { callCount++; return emptyResult(); },
      asHints: () => [],
    };

    findTriggerMisses(board, [unitScopedRule]);
    expect(callCount).toBe(9); // 9 rows × 1 trigger
  });
});

// ---------------------------------------------------------------------------
// Brute-force violation tests
// ---------------------------------------------------------------------------

describe('findTriggerMisses — brute-force violations', () => {
  it('reports a violation when the brute-force finds a golden-digit elimination', () => {
    const board = new BoardState(makeTrivialSpec());
    // Digit 5 is the golden solution for [0,0].
    const wrongRule = stubGlobalRule('WrongRule', [{ cell: [0, 0] as Cell, digit: 5 }]);

    const { misses, violations } = findTriggerMisses(board, [wrongRule], KNOWN_SOLUTION);
    expect(misses).toHaveLength(0);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.ruleName).toBe('WrongRule');
    expect(violations[0]!.missedContext).toBe('GLOBAL');
    expect(violations[0]!.offendingEliminations).toEqual([{ cell: [0, 0], digit: 5 }]);
  });

  it('reports a violation (not a miss) when the context is tainted by a golden violation', () => {
    const board = new BoardState(makeTrivialSpec());
    // Mixed: eliminate both 9 (valid) and 5 (golden violation) from [0,0].
    const mixedRule = stubGlobalRule('MixedRule', [
      { cell: [0, 0] as Cell, digit: 9 }, // valid
      { cell: [0, 0] as Cell, digit: 5 }, // golden violation
    ]);

    const { misses, violations } = findTriggerMisses(board, [mixedRule], KNOWN_SOLUTION);
    expect(misses).toHaveLength(0);          // tainted context → not a miss
    expect(violations).toHaveLength(1);
    expect(violations[0]!.offendingEliminations).toEqual([{ cell: [0, 0], digit: 5 }]);
  });

  it('does not report a violation when the golden digit is already absent from the board', () => {
    const board = new BoardState(makeTrivialSpec());
    // Remove the golden digit 5 from [0,0] first — the rule can no longer do harm.
    makeSingleton(board, 0, 0, 3); // leaves {3}, so 5 is gone

    const wrongRule = stubGlobalRule('WrongRule', [{ cell: [0, 0] as Cell, digit: 5 }]);
    const { violations } = findTriggerMisses(board, [wrongRule], KNOWN_SOLUTION);
    expect(violations).toHaveLength(0); // 5 is already absent → no live violation
  });

  it('returns empty violations when no golden solution is provided', () => {
    const board = new BoardState(makeTrivialSpec());
    const rule = stubGlobalRule('Rule', [{ cell: [0, 0] as Cell, digit: 5 }]);

    const { violations } = findTriggerMisses(board, [rule]); // no golden
    expect(violations).toHaveLength(0);
  });
});
