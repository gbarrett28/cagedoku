/**
 * Tests for engine/workQueue.ts — priority work queue with dedup.
 * Port of Python's tests/solver/engine/test_work_queue.py.
 */

import { describe, expect, it } from 'vitest';
import { SolverQueue, isStale } from './workQueue.js';
import { Trigger, UnitKind } from './types.js';
import type { SolverRule, RuleContext } from './rule.js';
import type { HintResult } from './hint.js';
import type { Elimination, Cell } from './types.js';

// ---------------------------------------------------------------------------
// Minimal fake rule for queue construction — behaviour under test is the
// queue's dedup/priority logic, not the rule itself.
// ---------------------------------------------------------------------------

function fakeRule(name = 'fake'): SolverRule {
  return {
    name,
    description: '',
    priority: 0,
    triggers: new Set([Trigger.COUNT_DECREASED]),
    unitKinds: new Set([UnitKind.ROW]),
    apply(_ctx: RuleContext) { return { eliminations: [], solutionEliminations: [], placements: [], virtualCageAdditions: [] }; },
    asHints(_ctx: RuleContext, _elims: readonly Elimination[]): HintResult[] { return []; },
  };
}

const RULE = fakeRule();

// ---------------------------------------------------------------------------
// enqueueUnit dedup
// ---------------------------------------------------------------------------

describe('SolverQueue — enqueueUnit dedup', () => {
  it('keeps lower priority when same (ruleIdx, unitId) enqueued twice', () => {
    const q = new SolverQueue();
    q.enqueueUnit(10, RULE, 0, 5, 0, Trigger.COUNT_DECREASED, null);
    q.enqueueUnit(5, RULE, 0, 5, 0, Trigger.COUNT_DECREASED, null);  // lower priority wins
    const item = q.pop();
    expect(item.priority).toBe(5);
    expect(q.empty()).toBe(true);  // ghost from priority=10 was discarded
  });

  it('ignores second enqueue when existing priority is already lower', () => {
    const q = new SolverQueue();
    q.enqueueUnit(5, RULE, 0, 5, 0, Trigger.COUNT_DECREASED, null);
    q.enqueueUnit(10, RULE, 0, 5, 0, Trigger.COUNT_DECREASED, null);  // higher priority — ignored
    const item = q.pop();
    expect(item.priority).toBe(5);
    expect(q.empty()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enqueueCell dedup
// ---------------------------------------------------------------------------

describe('SolverQueue — enqueueCell dedup', () => {
  it('ignores second enqueue for the same (ruleIdx, cell)', () => {
    const q = new SolverQueue();
    const cell: Cell = [3, 4];
    q.enqueueCell(10, RULE, 0, cell, Trigger.CELL_DETERMINED, null);
    q.enqueueCell(5, RULE, 0, cell, Trigger.CELL_DETERMINED, null);  // ignored
    const item = q.pop();
    expect(item.priority).toBe(10);  // first enqueue wins
    expect(q.empty()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------

describe('SolverQueue — priority ordering', () => {
  it('pops items in ascending priority order (lowest first = highest priority)', () => {
    const q = new SolverQueue();
    q.enqueueUnit(30, RULE, 0, 0, 0, Trigger.COUNT_DECREASED, null);
    q.enqueueUnit(10, RULE, 1, 1, 0, Trigger.COUNT_DECREASED, null);
    q.enqueueUnit(20, RULE, 2, 2, 0, Trigger.COUNT_DECREASED, null);
    expect(q.pop().priority).toBe(10);
    expect(q.pop().priority).toBe(20);
    expect(q.pop().priority).toBe(30);
    expect(q.empty()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enqueueGlobal dedup
// ---------------------------------------------------------------------------

describe('SolverQueue — enqueueGlobal dedup', () => {
  it('ignores second global enqueue for the same ruleIdx', () => {
    const q = new SolverQueue();
    q.enqueueGlobal(10, RULE, 0);
    q.enqueueGlobal(5, RULE, 0);  // ignored — first wins
    expect(q.pop().priority).toBe(10);
    expect(q.empty()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

describe('isStale', () => {
  it('returns false for CELL_DETERMINED trigger (never stale)', () => {
    const item = {
      priority: 0, rule: RULE, ruleIdx: 0,
      unitId: 3, unitVersion: 7,
      cell: null,
      trigger: Trigger.CELL_DETERMINED,
      hintDigit: null,
    };
    expect(isStale(item, [0, 0, 0, 99])).toBe(false);  // version mismatch — still not stale
  });

  it('returns false for GLOBAL trigger (never stale)', () => {
    const item = {
      priority: 0, rule: RULE, ruleIdx: 0,
      unitId: 0, unitVersion: 0,
      cell: null,
      trigger: Trigger.GLOBAL,
      hintDigit: null,
    };
    expect(isStale(item, [99])).toBe(false);
  });

  it('detects stale item when unit version is unchanged', () => {
    // An item is stale if the unit version recorded at enqueue still matches
    // the current version (meaning no progress has been made in that unit).
    const item = {
      priority: 0, rule: RULE, ruleIdx: 0,
      unitId: 2, unitVersion: 5,
      cell: null,
      trigger: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const versions = [0, 0, 5, 0];  // unitVersions[2] still = 5 — unchanged
    expect(isStale(item, versions)).toBe(true);
  });

  it('not stale when unit version has advanced', () => {
    const item = {
      priority: 0, rule: RULE, ruleIdx: 0,
      unitId: 2, unitVersion: 5,
      cell: null,
      trigger: Trigger.COUNT_DECREASED,
      hintDigit: null,
    };
    const versions = [0, 0, 6, 0];  // unitVersions[2] = 6, advanced from 5
    expect(isStale(item, versions)).toBe(false);
  });
});
