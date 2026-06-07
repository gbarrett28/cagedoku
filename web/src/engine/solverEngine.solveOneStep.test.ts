/**
 * Tests for SolverEngine.solveOneStep() — RED until implemented.
 */

import { describe, expect, it } from 'vitest';
import { KillerBoardState } from './boardState.js';
import { SolverEngine } from './solverEngine.js';
import { defaultRules } from './rules/index.js';
import { makeTrivialSpec } from './fixtures.js';

describe('SolverEngine.solveOneStep', () => {
  it('returns null when no rules are registered', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, []);
    expect(engine.solveOneStep()).toBeNull();
  });

  it('returns a non-null RuleStep when rules produce mutations on an unsolved board', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, defaultRules());
    const step = engine.solveOneStep();
    expect(step).not.toBeNull();
    expect(step!.ruleName.length).toBeGreaterThan(0);
    expect(step!.highlightCells).toBeDefined();
    expect(step!.eliminations).toBeDefined();
    expect(step!.placements).toBeDefined();
  });

  it('displayName is the space-separated human-readable form of ruleName', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, defaultRules());
    const step = engine.solveOneStep();
    expect(step).not.toBeNull();
    const expected = step!.ruleName.replace(/([A-Z])/g, ' $1').trim();
    expect(step!.displayName).toBe(expected);
  });

  it('highlightCells contains only cells from the step eliminations and placements', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, defaultRules());
    const step = engine.solveOneStep();
    expect(step).not.toBeNull();
    const affected = new Set([
      ...step!.eliminations.map(e => `${e.cell[0]},${e.cell[1]}`),
      ...step!.placements.map(p => `${p.cell[0]},${p.cell[1]}`),
    ]);
    for (const [r, c] of step!.highlightCells) {
      expect(affected.has(`${r},${c}`)).toBe(true);
    }
  });

  it('step has at least one elimination or placement', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, defaultRules());
    const step = engine.solveOneStep();
    expect(step).not.toBeNull();
    expect(step!.eliminations.length + step!.placements.length).toBeGreaterThan(0);
  });
});
