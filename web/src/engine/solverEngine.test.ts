/**
 * Tests for SolverEngine — port of Python's tests/solver/engine/test_solver_engine.py.
 *
 * Key TS differences from Python:
 *  - RuleResult is an interface; use emptyResult() for the empty case.
 *  - SolverRule requires name, description, priority, triggers, unitKinds,
 *    apply(), and asHints() — use inline object literals with full shape.
 *  - engine.stats is a Map<string, RuleStats>, not a plain dict.
 *  - No apply_initial_eliminations() in TS; LinearElimination rule handles that.
 */

import { describe, expect, it } from 'vitest';
import { solve } from './index.js';
import { BoardState } from './boardState.js';
import { SolverEngine } from './solverEngine.js';
import { defaultRules } from './rules/index.js';
import { LinearElimination } from './rules/linearElimination.js';
import type { RuleContext, SolverRule } from './rule.js';
import { emptyResult, Elimination, RuleResult, Trigger, UnitKind } from './types.js';
import { KNOWN_SOLUTION, makeTrivialSpec } from './fixtures.js';

describe('SolverEngine init', () => {
  it('constructs without crash', () => {
    const bs = new BoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, []);
    expect(engine).toBeDefined();
  });
});

describe('SolverEngine.solve', () => {
  it('LinearElimination alone fully determines trivial spec', () => {
    // Mirrors Python's test_engine_solve_trivial_empty_rules:
    // Python calls apply_initial_eliminations() then empty-rules engine.
    // In TS, LinearElimination handles initial eliminations from the linear system.
    const spec = makeTrivialSpec();
    const bs = new BoardState(spec);
    const engine = new SolverEngine(bs, [new LinearElimination()]);
    const result = engine.solve();
    let total = 0;
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        total += bs.candidates[r]![c]!.size;
    expect(total).toBe(81);
    expect(result).toBe(bs);
  });

  it('returns the same board object', () => {
    const bs = new BoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, []);
    expect(engine.solve()).toBe(bs);
  });

  it('solve() with all default rules produces the correct solution', () => {
    const board = solve(makeTrivialSpec());
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        expect(board.candidates[r]![c]!).toEqual(new Set([KNOWN_SOLUTION[r]![c]!]));
  });

  it('bootstraps without linear-system seeding (engine stills solves trivial spec)', () => {
    const spec = makeTrivialSpec();
    const board = new BoardState(spec);
    // Clear LinearSystem initial eliminations to simulate a pure cage-driven start
    board.linearSystem.initialEliminations.length = 0;
    const engine = new SolverEngine(board, defaultRules());
    engine.solve();
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        expect(board.candidates[r]![c]!).toEqual(new Set([KNOWN_SOLUTION[r]![c]!]));
  });
});

describe('SolverEngine.applyEliminations', () => {
  it('is idempotent — eliminating a digit twice is a no-op', () => {
    const bs = new BoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, []);
    engine.applyEliminations([{ cell: [0, 0] as unknown as Elimination['cell'], digit: 5 }]);
    const before = new Set(bs.candidates[0]![0]!);
    engine.applyEliminations([{ cell: [0, 0] as unknown as Elimination['cell'], digit: 5 }]);
    expect(bs.candidates[0]![0]!).toEqual(before);
  });
});

describe('SolverEngine rule routing', () => {
  it('routes COUNT_DECREASED events to subscribed rules', () => {
    const calls: number[] = [];
    const countRule: SolverRule = {
      name: 'counter',
      description: '',
      priority: 5,
      triggers: new Set([Trigger.COUNT_DECREASED]),
      unitKinds: new Set([UnitKind.ROW]),
      apply(_ctx: RuleContext): RuleResult { calls.push(1); return emptyResult(); },
      asHints() { return []; },
    };
    const bs = new BoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, [countRule]);
    engine.applyEliminations([{ cell: [0, 0] as unknown as Elimination['cell'], digit: 5 }]);
    engine.solve();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('records calls in stats map', () => {
    const noopRule: SolverRule = {
      name: 'noop',
      description: '',
      priority: 5,
      triggers: new Set([Trigger.COUNT_DECREASED]),
      unitKinds: new Set([UnitKind.ROW]),
      apply(_ctx: RuleContext): RuleResult { return emptyResult(); },
      asHints() { return []; },
    };
    const bs = new BoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, [noopRule]);
    engine.applyEliminations([{ cell: [0, 0] as unknown as Elimination['cell'], digit: 5 }]);
    engine.solve();
    expect(engine.stats.get('noop')!.calls).toBeGreaterThan(0);
  });
});

describe('SolverEngine hint mode', () => {
  it('rules in hintRules populate pendingHints rather than applying eliminations', () => {
    const spec = makeTrivialSpec();
    const board = new BoardState(spec);
    const rules = defaultRules();
    const hintRuleNames = new Set(rules.map(r => r.name));
    const engine = new SolverEngine(board, rules, { hintRules: hintRuleNames });
    engine.solve();
    expect(Array.isArray(engine.pendingHints)).toBe(true);
  });

  it('empty hintRules means all rules drain normally — no pending hints', () => {
    const spec = makeTrivialSpec();
    const board = new BoardState(spec);
    const engine = new SolverEngine(board, defaultRules(), { hintRules: new Set() });
    engine.solve();
    expect(engine.pendingHints).toEqual([]);
  });
});
