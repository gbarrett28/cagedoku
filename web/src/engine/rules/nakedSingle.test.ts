/**
 * Tests for NakedSingle — port of Python's test_naked_single.py.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { SolverEngine } from '../solverEngine.js';
import { defaultRules } from './index.js';
import { NakedSingle } from './nakedSingle.js';
import type { RuleContext } from '../rule.js';
import { Cell, Trigger } from '../types.js';
import { KNOWN_SOLUTION, makeTrivialSpec } from '../fixtures.js';

describe('NakedSingle', () => {
  it('returns no eliminations (recognition-only rule)', () => {
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[0]![0]! = new Set([5]);
    const ctx: RuleContext = {
      unit: null,
      cell: [0, 0] as unknown as import('../types.js').Cell,
      board: bs,
      hint: Trigger.CELL_DETERMINED,
      hintDigit: 5,
    };
    expect(new NakedSingle().apply(ctx).eliminations).toEqual([]);
  });

  it('declares CELL_DETERMINED as its trigger', () => {
    expect(new NakedSingle().triggers.has(Trigger.CELL_DETERMINED)).toBe(true);
  });

  it('returns empty placement when ctx.cell is null', () => {
    const bs = new BoardState(makeTrivialSpec());
    const ctx: RuleContext = {
      unit: null,
      cell: null,
      board: bs,
      hint: Trigger.CELL_DETERMINED,
      hintDigit: 5,
    };
    expect(new NakedSingle().apply(ctx).placements).toEqual([]);
  });

  it('returns empty placement when ctx.hintDigit is null', () => {
    const bs = new BoardState(makeTrivialSpec());
    const ctx: RuleContext = {
      unit: null,
      cell: [0, 0] as unknown as import('../types.js').Cell,
      board: bs,
      hint: Trigger.CELL_DETERMINED,
      hintDigit: null,
    };
    expect(new NakedSingle().apply(ctx).placements).toEqual([]);
  });

  it('asHints includes peer cells in eliminations (not highlightCells) and mentions them in explanation', () => {
    const bs = new BoardState(makeTrivialSpec());
    const d = 5;
    bs.candidates[0]![0]! = new Set([d]); // naked single at (0,0)
    // Row 0, col 0, and box 0 peers all start with d in their candidates (trivialSpec)
    const ctx: RuleContext = {
      unit: null,
      cell: [0, 0] as Cell,
      board: bs,
      hint: Trigger.CELL_DETERMINED,
      hintDigit: d,
    };
    const hints = new NakedSingle().asHints(ctx, []);
    expect(hints).toHaveLength(1);
    const hint = hints[0]!;
    // Only the placement cell appears in highlightCells (orange)
    expect(hint.highlightCells).toHaveLength(1);
    expect(hint.highlightCells.some(([r, c]) => r === 0 && c === 0)).toBe(true);
    // Peer cells appear as eliminations (yellow), not in highlightCells
    expect(hint.highlightCells.some(([r, c]) => r === 0 && c !== 0)).toBe(false);
    expect(hint.eliminations.some(e => e.cell[0] === 0 && e.cell[1] !== 0 && e.digit === d)).toBe(true);
    expect(hint.explanation).toContain(`removes ${d} from`);
  });

  it('asHints produces placement hints when running hint-only against trivial spec', () => {
    const spec = makeTrivialSpec();
    const bs = new BoardState(spec);
    const rules = defaultRules();
    const engine = new SolverEngine(bs, rules, { hintRules: new Set(['NakedSingle']) });
    engine.solve();
    const placements = engine.pendingHints.filter(h => h.placement !== null);
    // Every cell determined by cage rules emits CELL_DETERMINED → NakedSingle hint
    expect(placements.some(
      h => h.placement![0] === 0 && h.placement![1] === 0 && h.placement![2] === KNOWN_SOLUTION[0]![0]!
    )).toBe(true);
  });
});
