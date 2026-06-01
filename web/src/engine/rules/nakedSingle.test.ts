/**
 * Tests for NakedSingle — port of Python's test_naked_single.py.
 *
 * NakedSingle is the combined placement+elimination rule (formerly NakedSingle +
 * CellSolutionElimination). Its apply() returns both the placement and all peer
 * eliminations in a single RuleResult.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from '../boardState.js';
import { SolverEngine } from '../solverEngine.js';
import { defaultRules } from './index.js';
import { NakedSingle } from './nakedSingle.js';
import type { RuleContext } from '../rule.js';
import { Cell, Trigger } from '../types.js';
import { KNOWN_SOLUTION, makeTrivialSpec } from '../fixtures.js';
import type { PuzzleSpec } from '../../solver/puzzleSpec.js';
import { DISABLED_RULES } from './disabled-rules.js';
import { ruleBugFixtures } from './__fixtures__/index.js';

/** Spec where (2,5) and (3,6) share one 2-cell distinct cage (sum=3, digits {1,2}).
 *  They share NO row, col, or box, so any elimination between them must come from the cage. */
function makeDistinctCageSpec(): PuzzleSpec {
  const sharedId = 1;
  let nextId = 2;
  const regions: number[][] = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => {
      if ((r === 2 && c === 5) || (r === 3 && c === 6)) return sharedId;
      return nextId++;
    }),
  );
  const cageTotals: number[][] = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => {
      if (r === 2 && c === 5) return 3;
      if (r === 3 && c === 6) return 0;
      return (r * 9 + c) % 9 + 1;
    }),
  );
  const borderX = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(true));
  const borderY = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(true));
  return { regions, cageTotals, borderX, borderY };
}

describe('NakedSingle', () => {
  it('returns peer eliminations from apply() (combined placement+elimination rule)', () => {
    // NakedSingle now handles both the placement AND peer eliminations in one step.
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[0]![0]! = new Set([5]);
    const ctx: RuleContext = {
      unit: null,
      cell: [0, 0] as unknown as Cell,
      board: bs,
      hint: Trigger.CELL_DETERMINED,
      hintDigit: 5,
    };
    const result = new NakedSingle().apply(ctx);
    // Must return the placement
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]!.digit).toBe(5);
    // Must also return peer eliminations
    expect(result.eliminations.length).toBeGreaterThan(0);
    expect(result.eliminations.every(e => e.digit === 5)).toBe(true);
    // Row peers (0,1)..(0,8) must all be in eliminations
    for (let c = 1; c < 9; c++) {
      expect(result.eliminations.some(e => e.cell[0] === 0 && e.cell[1] === c)).toBe(true);
    }
    // Col peers (1,0)..(8,0)
    for (let r = 1; r < 9; r++) {
      expect(result.eliminations.some(e => e.cell[0] === r && e.cell[1] === 0)).toBe(true);
    }
  });

  it('eliminates solved digit from distinct-cage peers that share no row/col/box', () => {
    // (2,5) and (3,6) are cage-mates only — different row, col, and box.
    const bs = new BoardState(makeDistinctCageSpec());
    bs.candidates[3]![6]! = new Set([1]);
    const ctx: RuleContext = {
      unit: null,
      cell: [3, 6] as Cell,
      board: bs,
      hint: Trigger.CELL_DETERMINED,
      hintDigit: 1,
    };
    const elims = new NakedSingle().apply(ctx).eliminations;
    expect(elims.some(e => e.cell[0] === 2 && e.cell[1] === 5 && e.digit === 1)).toBe(true);
  });

  it('does NOT eliminate from non-distinct virtual cage peer sharing no row/col/box', () => {
    const bs = new BoardState(makeTrivialSpec());
    bs.addVirtualCage([[2, 5] as Cell, [3, 6] as Cell], 10, [], { distinct: false });
    bs.candidates[3]![6]! = new Set([1]);
    const ctx: RuleContext = {
      unit: null,
      cell: [3, 6] as Cell,
      board: bs,
      hint: Trigger.CELL_DETERMINED,
      hintDigit: 1,
    };
    const elims = new NakedSingle().apply(ctx).eliminations;
    const eliminatesViaCage = elims.some(e => e.cell[0] === 2 && e.cell[1] === 5 && e.digit === 1);
    expect(eliminatesViaCage).toBe(false);
  });

  it('does not produce duplicate eliminations when a peer shares multiple units', () => {
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[0]![0]! = new Set([5]);
    const ctx: RuleContext = {
      unit: null,
      cell: [0, 0] as unknown as Cell,
      board: bs,
      hint: Trigger.CELL_DETERMINED,
      hintDigit: 5,
    };
    const elims = new NakedSingle().apply(ctx).eliminations;
    const keys = elims.map(e => `${e.cell[0]},${e.cell[1]}`);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('declares CELL_DETERMINED as its trigger', () => {
    expect(new NakedSingle().triggers.has(Trigger.CELL_DETERMINED)).toBe(true);
  });

  it('returns empty result when ctx.cell is null', () => {
    const bs = new BoardState(makeTrivialSpec());
    const ctx: RuleContext = {
      unit: null,
      cell: null,
      board: bs,
      hint: Trigger.CELL_DETERMINED,
      hintDigit: 5,
    };
    const result = new NakedSingle().apply(ctx);
    expect(result.placements).toEqual([]);
    expect(result.eliminations).toEqual([]);
  });

  it('returns empty result when ctx.hintDigit is null', () => {
    const bs = new BoardState(makeTrivialSpec());
    const ctx: RuleContext = {
      unit: null,
      cell: [0, 0] as unknown as Cell,
      board: bs,
      hint: Trigger.CELL_DETERMINED,
      hintDigit: null,
    };
    const result = new NakedSingle().apply(ctx);
    expect(result.placements).toEqual([]);
    expect(result.eliminations).toEqual([]);
  });

  it('asHints uses passed eliminations and mentions them in explanation', () => {
    const bs = new BoardState(makeTrivialSpec());
    const d = 5;
    bs.candidates[0]![0]! = new Set([d]);
    const ctx: RuleContext = {
      unit: null,
      cell: [0, 0] as Cell,
      board: bs,
      hint: Trigger.CELL_DETERMINED,
      hintDigit: d,
    };
    // Pass the eliminations from apply() directly — asHints should use them
    const rule = new NakedSingle();
    const elims = rule.apply(ctx).eliminations;
    const hints = rule.asHints(ctx, elims);
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
    expect(placements.some(
      h => h.placement![0] === 0 && h.placement![1] === 0 && h.placement![2] === KNOWN_SOLUTION[0]![0]!
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule-bug regression fixtures (formerly CellSolutionElimination fixtures)
// ---------------------------------------------------------------------------

function boardFromStallCandidates(stalledCandidates: number[][][]): BoardState {
  const spec = {
    regions: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, () => r + 1)),
    cageTotals: Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, (_, c) => (c === 0 ? 45 : 0))),
    borderX: Array.from({ length: 9 }, () => Array.from({ length: 8 }, () => true)),
    borderY: Array.from({ length: 8 }, () => Array.from({ length: 9 }, () => false)),
  };
  const board = new BoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, []);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const keep = new Set(stalledCandidates[r]![c]!);
      const elims: Array<{ cell: Cell; digit: number }> = [];
      for (let d = 1; d <= 9; d++) {
        if (!keep.has(d) && board.cands(r, c).has(d))
          elims.push({ cell: [r, c] as Cell, digit: d });
      }
      if (elims.length) engine.applyEliminations(elims);
    }
  }
  return board;
}

// CellSolutionElimination was merged into NakedSingle; its fixtures are no longer fetched
// by sync-rule-fixtures.js (propagation-rule bugs are caught by the golden check, not here).
const nsFixtures = ruleBugFixtures.filter(f => f.ruleName === 'NakedSingle');
const itNS = DISABLED_RULES.includes('NakedSingle') ? it.skip : it;

if (nsFixtures.length > 0) {
  describe('NakedSingle — rule-bug regression fixtures', () => {
    for (const fixture of nsFixtures) {
      itNS(`${fixture.name}: no elimination contradicts golden solution`, () => {
        const board = boardFromStallCandidates(fixture.stalledCandidates);
        const rule = new NakedSingle();
        for (let r = 0; r < 9; r++) {
          for (let c = 0; c < 9; c++) {
            if (board.cands(r, c).size !== 1) continue;
            const d = [...board.cands(r, c)][0]!;
            const ctx: RuleContext = {
              board, unit: null, cell: [r, c] as Cell,
              hint: Trigger.CELL_DETERMINED, hintDigit: d,
            };
            const result = rule.apply(ctx);
            for (const e of result.eliminations) {
              const [er, ec] = e.cell;
              expect(fixture.goldenSolution[er]![ec]).not.toBe(e.digit);
            }
          }
        }
      });
    }
  });
}
