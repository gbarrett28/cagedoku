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

import { describe, expect, it, vi } from 'vitest';
import { solve } from './index.js';
import { BoardState, KillerBoardState } from './boardState.js';
import { SolverEngine, KillerSolverEngine } from './solverEngine.js';
import { defaultRules } from './rules/index.js';
import { LinearElimination } from './rules/linearElimination.js';
import type { RuleContext, SolverRule } from './rule.js';
import { Cell, emptyResult, Elimination, RuleResult, SolutionElimination, Trigger, UnitKind, VirtualCageAddition } from './types.js';
import { KNOWN_SOLUTION, makeTrivialSpec } from './fixtures.js';
import type { HintResult } from './hint.js';

describe('SolverEngine init', () => {
  it('constructs without crash', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
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
    const bs = new KillerBoardState(spec);
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
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, []);
    expect(engine.solve()).toBe(bs);
  });

  it('solve() with all default rules produces the correct solution', () => {
    const { board } = solve(makeTrivialSpec());
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        expect(board.candidates[r]![c]!).toEqual(new Set([KNOWN_SOLUTION[r]![c]!]));
  });

  it('bootstraps without linear-system seeding (engine stills solves trivial spec)', () => {
    const spec = makeTrivialSpec();
    const board = new KillerBoardState(spec);
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
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, []);
    engine.applyEliminations([{ cell: [0, 0] as unknown as Elimination['cell'], digit: 5 }]);
    const before = new Set(bs.candidates[0]![0]!);
    engine.applyEliminations([{ cell: [0, 0] as unknown as Elimination['cell'], digit: 5 }]);
    expect(bs.candidates[0]![0]!).toEqual(before);
  });
});

describe('SolverEngine — _onCellDetermined virtual hook', () => {
  it('base SolverEngine never touches LinearSystem when given a plain BoardState', () => {
    const plain = new BoardState();
    const engine = new SolverEngine(plain, []);
    // Eliminate 8 of (0,0)'s 9 candidates, leaving exactly one — this fires
    // CELL_DETERMINED, which _routeEvents forwards to _onCellDetermined. A plain
    // BoardState has no `linearSystem` property; if the hook were anything other
    // than the base no-op, this would throw a TypeError instead of completing.
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    expect(() => engine.applyEliminations(eliminations)).not.toThrow();
    expect(plain.cands(0, 0)).toEqual(new Set([9]));
  });
});

describe('KillerSolverEngine — _onCellDetermined override', () => {
  it('delegates to LinearSystem.substituteLiveRows on cell determination', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const engine = new KillerSolverEngine(board, []);
    const substituteLiveRowsSpy = vi.spyOn(board.linearSystem, 'substituteLiveRows');
    // Eliminate 8 of (0,0)'s 9 candidates, leaving exactly digit 9 — this fires
    // CELL_DETERMINED for cell [0,0] with value 9, which the override forwards
    // to LinearSystem.substituteLiveRows with that exact (cell, value) pair.
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    engine.applyEliminations(eliminations);
    expect(substituteLiveRowsSpy).toHaveBeenCalledWith([0, 0], 9);
  });
});

describe('KillerSolverEngine._onCellDetermined — bookkeeping only', () => {
  it('pushes a multi-cell distinct substituteLiveRows result onto pendingVirtualCages', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const engine = new KillerSolverEngine(board, []);
    vi.spyOn(board.linearSystem, 'substituteLiveRows').mockReturnValue([
      [[[1, 1], [1, 2]] as Cell[], 10, true],
    ]);
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    engine.applyEliminations(eliminations);
    expect(board.linearSystem.pendingVirtualCages).toEqual([
      { cells: [[1, 1], [1, 2]], total: 10 },
    ]);
  });

  it('drops a non-distinct substituteLiveRows result entirely', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const engine = new KillerSolverEngine(board, []);
    vi.spyOn(board.linearSystem, 'substituteLiveRows').mockReturnValue([
      [[[1, 1], [1, 2]] as Cell[], 10, false],
    ]);
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    engine.applyEliminations(eliminations);
    expect(board.linearSystem.pendingVirtualCages).toEqual([]);
  });

  it('skips a result whose cell-set already matches an existing unit', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const engine = new KillerSolverEngine(board, []);
    // Row 1 (unitId 1) covers all of row index 1 — reuse its cell-set.
    const rowCells = board.units[1]!.cells as Cell[];
    vi.spyOn(board.linearSystem, 'substituteLiveRows').mockReturnValue([
      [rowCells, 45, true],
    ]);
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    engine.applyEliminations(eliminations);
    expect(board.linearSystem.pendingVirtualCages).toEqual([]);
  });

  it('eager golden-check: a single-cell result contradicting golden reports a violation', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const violations: string[] = [];
    const engine = new KillerSolverEngine(board, [], {
      goldenSolution: KNOWN_SOLUTION,
      onViolation: (name) => violations.push(name),
    });
    const gold = KNOWN_SOLUTION[1]![1]!;
    const wrong = gold === 1 ? 2 : 1;
    vi.spyOn(board.linearSystem, 'substituteLiveRows').mockReturnValue([
      [[[1, 1]] as Cell[], wrong, true],
    ]);
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    engine.applyEliminations(eliminations);
    expect(violations).toEqual(['DerivedVirtualCage']);
  });

  it('eager golden-check: throws when no onViolation handler is set', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const engine = new KillerSolverEngine(board, [], { goldenSolution: KNOWN_SOLUTION });
    const gold = KNOWN_SOLUTION[1]![1]!;
    const wrong = gold === 1 ? 2 : 1;
    vi.spyOn(board.linearSystem, 'substituteLiveRows').mockReturnValue([
      [[[1, 1]] as Cell[], wrong, true],
    ]);
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    expect(() => engine.applyEliminations(eliminations)).toThrow();
  });

  it('a single-cell distinct result is golden-checked but never pushed onto pendingVirtualCages (it is a Naked Single, not a virtual cage)', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const violations: string[] = [];
    const engine = new KillerSolverEngine(board, [], {
      goldenSolution: KNOWN_SOLUTION,
      onViolation: (name) => violations.push(name),
    });
    const gold = KNOWN_SOLUTION[1]![1]!;
    const wrong = gold === 1 ? 2 : 1;
    // wrong !== the existing single-cell cage's solved total (gold), so the
    // existingTotals dedup alone would not prevent this from being queued.
    vi.spyOn(board.linearSystem, 'substituteLiveRows').mockReturnValue([
      [[[1, 1]] as Cell[], wrong, true],
    ]);
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    engine.applyEliminations(eliminations);
    expect(violations).toEqual(['DerivedVirtualCage']);
    expect(board.linearSystem.pendingVirtualCages).toEqual([]);
  });
});

describe('SolverEngine._checkAgainstGolden', () => {
  class TestEngine extends KillerSolverEngine {
    checkGolden(ruleName: string, cell: Cell, digit: number): void {
      this._checkAgainstGolden(ruleName, cell, digit);
    }
  }

  it('does nothing when no goldenSolution is set', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new TestEngine(bs, []);
    expect(() => engine.checkGolden('Test', [0, 0] as Cell, 999)).not.toThrow();
  });

  it('does nothing when the digit matches the golden solution', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new TestEngine(bs, [], { goldenSolution: KNOWN_SOLUTION });
    const gold = KNOWN_SOLUTION[0]![0]!;
    expect(() => engine.checkGolden('Test', [0, 0] as Cell, gold)).not.toThrow();
  });

  it('throws when the digit contradicts golden and no onViolation is set', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new TestEngine(bs, [], { goldenSolution: KNOWN_SOLUTION });
    const gold = KNOWN_SOLUTION[0]![0]!;
    const wrong = gold === 1 ? 2 : 1;
    expect(() => engine.checkGolden('Test', [0, 0] as Cell, wrong)).toThrow();
  });

  it('calls onViolation instead of throwing when provided', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const violations: string[] = [];
    const engine = new TestEngine(bs, [], {
      goldenSolution: KNOWN_SOLUTION,
      onViolation: (name) => violations.push(name),
    });
    const gold = KNOWN_SOLUTION[0]![0]!;
    const wrong = gold === 1 ? 2 : 1;
    expect(() => engine.checkGolden('Test', [0, 0] as Cell, wrong)).not.toThrow();
    expect(violations).toEqual(['Test']);
  });
});

describe('SolverEngine rule routing', () => {
  it('routes COUNT_DECREASED events to subscribed rules', () => {
    const calls: number[] = [];
    const countRule: SolverRule = {
      name: 'counter', displayName: 'counter',
      description: '',
      priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.COUNT_DECREASED]),
      unitKinds: new Set([UnitKind.ROW]),
      apply(_ctx: RuleContext): RuleResult { calls.push(1); return emptyResult(); },
      asHints() { return []; },
    };
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, [countRule]);
    engine.applyEliminations([{ cell: [0, 0] as unknown as Elimination['cell'], digit: 5 }]);
    engine.solve();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('records calls in stats map', () => {
    const noopRule: SolverRule = {
      name: 'noop', displayName: 'noop',
      description: '',
      priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.COUNT_DECREASED]),
      unitKinds: new Set([UnitKind.ROW]),
      apply(_ctx: RuleContext): RuleResult { return emptyResult(); },
      asHints() { return []; },
    };
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, [noopRule]);
    engine.applyEliminations([{ cell: [0, 0] as unknown as Elimination['cell'], digit: 5 }]);
    engine.solve();
    expect(engine.stats.get('noop')!.calls).toBeGreaterThan(0);
  });
});

describe('KillerSolverEngine solution eliminations', () => {
  it('_onSolutionElimination: removes a cage solution, records mutation, re-enqueues SOLUTION_PRUNED rules', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const cageIdx = bs.regions[0]![0]!;
    const initialSolns = bs.cageSolns[cageIdx]!.length;
    expect(initialSolns).toBeGreaterThan(0);
    const targetSoln = [...bs.cageSolns[cageIdx]![0]!];

    let fired = false;
    const se: SolutionElimination = { cageIdx, solution: targetSoln };
    const prunedCalls: number[] = [];
    const seRule: SolverRule = {
      name: 'seStub', displayName: 'seStub', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(_ctx: RuleContext): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), solutionEliminations: [se] };
      },
      asHints() { return []; },
    };
    // SOLUTION_PRUNED subscriber — exercises KillerSolverEngine._onSolutionElimination's enqueue path
    const pruneRule: SolverRule = {
      name: 'pruneWatcher', displayName: 'pruneWatcher', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.SOLUTION_PRUNED]), unitKinds: new Set([UnitKind.CAGE]),
      apply(_ctx: RuleContext): RuleResult { prunedCalls.push(1); return emptyResult(); },
      asHints() { return []; },
    };

    const engine = new KillerSolverEngine(bs, [seRule, pruneRule]);
    engine.solve();

    expect(bs.cageSolns[cageIdx]!.length).toBe(initialSolns - 1);
    const mutation = engine.appliedMutations.find(m => m.type === 'solution_eliminated');
    expect(mutation).toBeDefined();
    expect(mutation!['solution']).toEqual(targetSoln);
    expect(prunedCalls.length).toBeGreaterThan(0); // line 282 was reached
  });
});

describe('SolverEngine virtual cage additions', () => {
  it('records a virtual cage addition produced by a rule', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const vca: VirtualCageAddition = {
      cells: [[0, 0] as Cell, [0, 1] as Cell],
      total: 10,
    };
    let fired = false;
    const rule: SolverRule = {
      name: 'vcaStub', displayName: 'vcaStub', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(_ctx: RuleContext): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), virtualCageAdditions: [vca] };
      },
      asHints() { return []; },
    };

    const engine = new SolverEngine(bs, [rule]);
    engine.solve();

    expect(engine.appliedVirtualCages).toHaveLength(1);
    const mutation = engine.appliedMutations.find(m => m.type === 'virtual_cage_added');
    expect(mutation).toBeDefined();
    expect(mutation!['cells']).toEqual(vca.cells);
    expect(mutation!['total']).toBe(vca.total);
  });
});

describe('SolverEngine.solve — applies virtualCageAdditions', () => {
  it('calls addVirtualCage, shifts pendingVirtualCages, and evaluates the new unit', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const gold = KNOWN_SOLUTION;
    const cells = [[0, 0], [0, 1]] as Cell[];
    const total = gold[0]![0]! + gold[0]![1]!;
    bs.linearSystem.pendingVirtualCages.push({ cells, total });

    let fired = false;
    const vca = { cells, total };
    const rule: SolverRule = {
      name: 'vcaStub', displayName: 'vcaStub', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(_ctx: RuleContext): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), virtualCageAdditions: [vca] };
      },
      asHints() { return []; },
    };

    const unitsBefore = bs.units.length;
    const engine = new KillerSolverEngine(bs, [rule], { goldenSolution: gold });
    engine.solve();

    expect(bs.units.length).toBe(unitsBefore + 1);
    expect(bs.linearSystem.pendingVirtualCages).toEqual([]);
    expect(engine.appliedVirtualCages).toEqual([vca]);
    const mutation = engine.appliedMutations.find(m => m.type === 'virtual_cage_added');
    expect(mutation).toBeDefined();
  });

  it('golden-check: a virtualCageAddition whose cells sum to the wrong total is not applied', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const gold = KNOWN_SOLUTION;
    const cells = [[0, 0], [0, 1]] as Cell[];
    const wrongTotal = gold[0]![0]! + gold[0]![1]! + 1;
    bs.linearSystem.pendingVirtualCages.push({ cells, total: wrongTotal });

    let fired = false;
    const vca = { cells, total: wrongTotal };
    const rule: SolverRule = {
      name: 'badVcaRule', displayName: 'badVcaRule', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(_ctx: RuleContext): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), virtualCageAdditions: [vca] };
      },
      asHints() { return []; },
    };

    const unitsBefore = bs.units.length;
    const violations: string[] = [];
    const engine = new KillerSolverEngine(bs, [rule], {
      goldenSolution: gold,
      onViolation: (name) => violations.push(name),
    });
    engine.solve();

    expect(violations).toEqual(['badVcaRule']);
    expect(bs.units.length).toBe(unitsBefore);
    expect(engine.appliedVirtualCages).toEqual([]);
  });

  it('golden-check: throws when no onViolation handler is set', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const gold = KNOWN_SOLUTION;
    const cells = [[0, 0], [0, 1]] as Cell[];
    const wrongTotal = gold[0]![0]! + gold[0]![1]! + 1;
    bs.linearSystem.pendingVirtualCages.push({ cells, total: wrongTotal });

    let fired = false;
    const vca = { cells, total: wrongTotal };
    const rule: SolverRule = {
      name: 'badVcaRule', displayName: 'badVcaRule', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(_ctx: RuleContext): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), virtualCageAdditions: [vca] };
      },
      asHints() { return []; },
    };

    const engine = new KillerSolverEngine(bs, [rule], { goldenSolution: gold });
    expect(() => engine.solve()).toThrow();
  });
});

describe('SolverEngine candidate soundness assertion', () => {
  it('throws when a rule eliminates the correct solution digit from a cell', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    // KNOWN_SOLUTION[0][0] = 5; cell (0,0) starts with candidates {1..9}
    let fired = false;
    const badRule: SolverRule = {
      name: 'badRule', displayName: 'badRule', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(_ctx: RuleContext): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), eliminations: [{ cell: [0, 0] as Cell, digit: KNOWN_SOLUTION[0]![0]! }] };
      },
      asHints() { return []; },
    };
    const engine = new SolverEngine(bs, [badRule], { goldenSolution: KNOWN_SOLUTION });
    expect(() => engine.solve()).toThrow();
  });

  it('does not throw when a rule eliminates a non-solution digit', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const gold = KNOWN_SOLUTION[0]![0]!;
    const safe = gold === 1 ? 2 : 1;
    let fired = false;
    const safeRule: SolverRule = {
      name: 'safeRule', displayName: 'safeRule', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(_ctx: RuleContext): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), eliminations: [{ cell: [0, 0] as Cell, digit: safe }] };
      },
      asHints() { return []; },
    };
    const engine = new SolverEngine(bs, [safeRule], { goldenSolution: KNOWN_SOLUTION });
    expect(() => engine.solve()).not.toThrow();
  });

  it('does not throw when no goldenSolution is provided', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    let fired = false;
    const badRule: SolverRule = {
      name: 'badRule', displayName: 'badRule', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(_ctx: RuleContext): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), eliminations: [{ cell: [0, 0] as Cell, digit: KNOWN_SOLUTION[0]![0]! }] };
      },
      asHints() { return []; },
    };
    const engine = new SolverEngine(bs, [badRule]); // no goldenSolution
    expect(() => engine.solve()).not.toThrow();
  });
});

describe('SolverEngine violation reporting — _violationFired', () => {
  function makeBadRule(name: string, cell: Cell, digit: number): SolverRule {
    let fired = false;
    return {
      name, displayName: name, description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), eliminations: [{ cell, digit }] };
      },
      asHints() { return []; },
    };
  }

  it('calls onViolation for the first violating rule and suppresses its result', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const violations: string[] = [];
    const gold = KNOWN_SOLUTION[0]![0]!;
    const badRule = makeBadRule('badRule', [0, 0] as Cell, gold);
    const engine = new SolverEngine(bs, [badRule], {
      goldenSolution: KNOWN_SOLUTION,
      onViolation: (name) => violations.push(name),
    });
    engine.solve();
    expect(violations).toEqual(['badRule']);
    // Elimination was suppressed — candidate still present
    expect(bs.cands(0, 0).has(gold)).toBe(true);
  });

  it('only reports the first violating rule when two rules both violate in the same solve pass', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const violations: string[] = [];
    const gold0 = KNOWN_SOLUTION[0]![0]!;
    const gold1 = KNOWN_SOLUTION[0]![1]!;
    const badRule1 = makeBadRule('badRule1', [0, 0] as Cell, gold0);
    const badRule2 = makeBadRule('badRule2', [0, 1] as Cell, gold1);
    const engine = new SolverEngine(bs, [badRule1, badRule2], {
      goldenSolution: KNOWN_SOLUTION,
      onViolation: (name) => violations.push(name),
    });
    engine.solve();
    expect(violations).toEqual(['badRule1']);
    // Both rules' results suppressed
    expect(bs.cands(0, 0).has(gold0)).toBe(true);
    expect(bs.cands(0, 1).has(gold1)).toBe(true);
  });

  it('resets _violationFired between successive solve() calls', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const violations: string[] = [];
    let callCount = 0;
    const badRule: SolverRule = {
      name: 'badRule', displayName: 'badRule', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(): RuleResult {
        callCount++;
        const gold = KNOWN_SOLUTION[0]![0]!;
        // Fire on calls 1 and 2 (each solve() sees a fresh board clone, but here
        // we test that the flag is reset so onViolation is called again on the 2nd solve)
        if (callCount <= 2)
          return { ...emptyResult(), eliminations: [{ cell: [0, 0] as Cell, digit: gold }] };
        return emptyResult();
      },
      asHints() { return []; },
    };
    const engine = new SolverEngine(bs, [badRule], {
      goldenSolution: KNOWN_SOLUTION,
      onViolation: (name) => violations.push(name),
    });
    engine.solve();
    engine.solve(); // second call — _violationFired should be reset
    expect(violations).toEqual(['badRule', 'badRule']);
  });
});

describe('SolverEngine hint mode', () => {
  it('rules in hintRules populate pendingHints rather than applying eliminations', () => {
    const spec = makeTrivialSpec();
    const board = new KillerBoardState(spec);
    const rules = defaultRules();
    const hintRuleNames = new Set(rules.map(r => r.name));
    const engine = new SolverEngine(board, rules, { hintRules: hintRuleNames });
    engine.solve();
    expect(Array.isArray(engine.pendingHints)).toBe(true);
  });

  it('empty hintRules means all rules drain normally — no pending hints', () => {
    const spec = makeTrivialSpec();
    const board = new KillerBoardState(spec);
    const engine = new SolverEngine(board, defaultRules(), { hintRules: new Set() });
    engine.solve();
    expect(engine.pendingHints).toEqual([]);
  });
});

describe('SolverEngine golden check — hint-rule violations', () => {
  function makeHintRule(name: string, cell: Cell, digit: number): SolverRule {
    let fired = false;
    return {
      name, displayName: name, description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), eliminations: [{ cell, digit }] };
      },
      asHints(_ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[] {
        return eliminations.map(e => ({
          ruleName: name, displayName: name, explanation: 'test hint',
          highlightCells: [e.cell], eliminations: [e], placement: null, virtualCageSuggestion: null,
        }));
      },
    };
  }

  it('suppresses the hint and calls onViolation when a hint rule eliminates a golden candidate', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const violations: string[] = [];
    const gold = KNOWN_SOLUTION[0]![0]!;
    const badHintRule = makeHintRule('badHintRule', [0, 0] as Cell, gold);
    const engine = new SolverEngine(bs, [badHintRule], {
      goldenSolution: KNOWN_SOLUTION,
      onViolation: (name) => violations.push(name),
      hintRules: new Set(['badHintRule']),
    });
    engine.solve();
    expect(engine.pendingHints).toHaveLength(0);
    expect(violations).toEqual(['badHintRule']);
  });

  it('does not call onViolation and the hint appears when a hint rule produces only safe eliminations', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const violations: string[] = [];
    const gold = KNOWN_SOLUTION[0]![0]!;
    const safe = gold === 1 ? 2 : 1;
    const safeHintRule = makeHintRule('safeHintRule', [0, 0] as Cell, safe);
    const engine = new SolverEngine(bs, [safeHintRule], {
      goldenSolution: KNOWN_SOLUTION,
      onViolation: (name) => violations.push(name),
      hintRules: new Set(['safeHintRule']),
    });
    engine.solve();
    expect(engine.pendingHints).toHaveLength(1);
    expect(violations).toHaveLength(0);
  });

  it('suppresses and reports hint violation even when a prior always-apply rule already set _violationFired', () => {
    // Hint rules must always be reported so they are disabled for the session —
    // they cannot cascade like always-apply rules, so sharing _violationFired
    // would leave a bad hint rule enabled.
    const bs = new KillerBoardState(makeTrivialSpec());
    const violations: string[] = [];
    const gold0 = KNOWN_SOLUTION[0]![0]!;
    const gold1 = KNOWN_SOLUTION[0]![1]!;

    let alwaysFired = false;
    const badAlwaysRule: SolverRule = {
      name: 'badAlways', displayName: 'badAlways', description: '', priority: 1,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(): RuleResult {
        if (alwaysFired) return emptyResult();
        alwaysFired = true;
        return { ...emptyResult(), eliminations: [{ cell: [0, 0] as Cell, digit: gold0 }] };
      },
      asHints() { return []; },
    };
    const badHintRule = makeHintRule('badHintRule', [0, 1] as Cell, gold1);
    // Priority 1 < 5 so always-apply fires first, setting _violationFired.
    const engine = new SolverEngine(bs, [badAlwaysRule, badHintRule], {
      goldenSolution: KNOWN_SOLUTION,
      onViolation: (name) => violations.push(name),
      hintRules: new Set(['badHintRule']),
    });
    engine.solve();
    expect(engine.pendingHints).toHaveLength(0);
    // Both the always-apply rule and the hint rule must be reported independently.
    expect(violations).toContain('badAlways');
    expect(violations).toContain('badHintRule');
  });
});
