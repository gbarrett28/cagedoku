/**
 * Tests for BoardState — port of Python's tests/solver/engine/test_board_state.py.
 */

import { describe, expect, it } from 'vitest';
import { BoardState } from './boardState.js';
import { NoSolnError } from '../solver/errors.js';
import { Trigger, UnitKind } from './types.js';
import { makeTrivialSpec } from './fixtures.js';

describe('BoardState init', () => {
  it('candidates start as full sets', () => {
    const bs = new BoardState(makeTrivialSpec());
    expect(bs.candidates[0]![0]!).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(bs.candidates[8]![8]!).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  it('unit count is 9 rows + 9 cols + 9 boxes + 81 cages for trivial spec', () => {
    const bs = new BoardState(makeTrivialSpec());
    // The trivial spec (all single-cell cages) produces no virtual cages
    expect(bs.units.length).toBe(9 + 9 + 9 + 81);
  });

  it('counts are initialised to unit size for every digit', () => {
    const bs = new BoardState(makeTrivialSpec());
    const row0 = bs.rowUnitId(0);
    for (let d = 1; d <= 9; d++) {
      expect(bs.counts[row0]![d]!).toBe(9);
    }
  });

  it('cell (0,0) belongs to ROW, COL, BOX and CAGE units', () => {
    const bs = new BoardState(makeTrivialSpec());
    const kinds = new Set(bs.cellUnitIds(0, 0).map(uid => bs.units[uid]!.kind));
    expect(kinds).toEqual(new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE]));
  });

  it('unitVersions start at zero', () => {
    const bs = new BoardState(makeTrivialSpec());
    expect(bs.unitVersions.every(v => v === 0)).toBe(true);
  });
});

describe('removeCandidate', () => {
  it('decrements count for the digit in all containing units', () => {
    const bs = new BoardState(makeTrivialSpec());
    const row0 = bs.rowUnitId(0);
    const before = bs.counts[row0]![5]!;
    bs.removeCandidate(0, 0, 5);
    expect(bs.counts[row0]![5]!).toBe(before - 1);
  });

  it('bumps unitVersion for all containing units', () => {
    const bs = new BoardState(makeTrivialSpec());
    const uid = bs.rowUnitId(0);
    bs.removeCandidate(0, 0, 5);
    expect(bs.unitVersions[uid]).toBe(1);
  });

  it('emits COUNT_DECREASED event', () => {
    const bs = new BoardState(makeTrivialSpec());
    const events = bs.removeCandidate(0, 0, 5);
    const triggers = new Set(events.map(e => e.trigger));
    expect(triggers.has(Trigger.COUNT_DECREASED)).toBe(true);
  });

  it('emits CELL_DETERMINED when set becomes singleton', () => {
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[1]![1] = new Set([3, 7]);
    const events = bs.removeCandidate(1, 1, 3);
    const det = events.filter(e => e.trigger === Trigger.CELL_DETERMINED);
    expect(det.length).toBe(1);
    expect(det[0]!.payload).toEqual([1, 1]);
    expect(det[0]!.hintDigit).toBe(7);
  });

  it('throws NoSolnError when removing the last candidate', () => {
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[0]![0] = new Set([5]);
    expect(() => bs.removeCandidate(0, 0, 5)).toThrow(NoSolnError);
  });

  it('emits COUNT_HIT_ONE when count decreases to 1', () => {
    const bs = new BoardState(makeTrivialSpec());
    const row0 = bs.rowUnitId(0);
    // Drive count for digit 9 in row 0 from 9 down to 2
    for (let c = 0; c < 7; c++) {
      bs.removeCandidate(0, c, 9);
    }
    // Next removal: count goes 2 → 1, should fire COUNT_HIT_ONE
    const events = bs.removeCandidate(0, 7, 9);
    const hitOne = events.filter(
      e => e.trigger === Trigger.COUNT_HIT_ONE && e.payload === row0
    );
    expect(hitOne.length).toBe(1);
    expect(hitOne[0]!.hintDigit).toBe(9);
  });

  it('is a no-op when digit is not in candidates', () => {
    const bs = new BoardState(makeTrivialSpec());
    bs.candidates[0]![0] = new Set([5]);
    // Remove a digit that isn't there — should return no events without throwing
    const events = bs.removeCandidate(0, 0, 3);
    expect(events).toEqual([]);
  });
});

describe('removeCageSolution', () => {
  it('emits SOLUTION_PRUNED and removes the solution', () => {
    const bs = new BoardState(makeTrivialSpec());
    const cageIdx = bs.regions[0]![0]!;
    // Manually inject a second fake solution
    bs.cageSolns[cageIdx]!.push([3]);
    const event = bs.removeCageSolution(cageIdx, [3]);
    expect(event.trigger).toBe(Trigger.SOLUTION_PRUNED);
    expect(bs.cageSolns[cageIdx]!.some(s => s.length === 1 && s[0] === 3)).toBe(false);
  });
});

describe('_pruneCageSolutions (internal)', () => {
  it('emits SOLUTION_PRUNED when digit is absent from all cage cells', () => {
    const bs = new BoardState(makeTrivialSpec());
    const cageIdx = bs.regions[0]![0]!;
    bs.cageSolns[cageIdx]!.push([3]);
    // Manually remove digit 3 from all cells in this cage so pruning fires
    const cageUnit = bs.units[27 + cageIdx]!;
    for (const [r, c] of cageUnit.cells) {
      if (bs.candidates[r]![c]!.has(3)) {
        bs.candidates[r]![c]!.delete(3);
        for (const uid of bs.cellUnitIds(r, c)) {
          if (bs.counts[uid]![3]! > 0) bs.counts[uid]![3] = bs.counts[uid]![3]! - 1;
        }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = (bs as any)._pruneCageSolutions(cageIdx, 0, 0, 3) as ReturnType<BoardState['removeCandidate']>;
    const pruned = events.filter((e: { trigger: Trigger }) => e.trigger === Trigger.SOLUTION_PRUNED);
    expect(pruned.length).toBe(1);
  });
});

describe('virtual cages', () => {
  it('trivial spec includes virtual cages from LinearSystem in cageSolns', () => {
    const bs = new BoardState(makeTrivialSpec());
    const nRealCages = Math.max(...bs.regions.flat()) + 1;
    const nVirtual = bs.linearSystem.virtualCages.length;
    expect(bs.cageSolns.length).toBe(nRealCages + nVirtual);
  });

  it('addVirtualCage appends a CAGE unit and cageSolns entry', () => {
    const bs = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const nUnitsBefore = bs.units.length;
    const nSolnsBefore = bs.cageSolns.length;
    const cells = [[0, 0], [0, 1]] as unknown as import('./types.js').Cell[];
    bs.addVirtualCage(cells, 8, []);
    expect(bs.units.length).toBe(nUnitsBefore + 1);
    expect(bs.cageSolns.length).toBe(nSolnsBefore + 1);
    const newUnit = bs.units[bs.units.length - 1]!;
    expect(newUnit.kind).toBe(UnitKind.CAGE);
  });

  it('addVirtualCage excludes eliminated solutions', () => {
    const bs = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const cells = [[0, 0], [0, 1]] as unknown as import('./types.js').Cell[];
    // Total 3 with 2 cells: only solution is [1, 2]; eliminating it leaves []
    bs.addVirtualCage(cells, 3, [[1, 2]]);
    expect(bs.cageSolns[bs.cageSolns.length - 1]).toEqual([]);
  });

  it('addVirtualCage registers new unit in per-cell lookup', () => {
    const bs = new BoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const nUidsBefore = bs.cellUnitIds(0, 0).length;
    const cells = [[0, 0], [0, 1]] as unknown as import('./types.js').Cell[];
    bs.addVirtualCage(cells, 8, []);
    expect(bs.cellUnitIds(0, 0).length).toBe(nUidsBefore + 1);
  });
});
