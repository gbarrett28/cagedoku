/**
 * Tests for KillerBoardState — port of Python's tests/solver/engine/test_board_state.py.
 */

import { describe, expect, it } from 'vitest';
import { BoardState, KillerBoardState } from './boardState.js';
import { NoSolnError } from '../solver/errors.js';
import { Trigger, UnitKind } from './types.js';
import { HiddenSingle } from './rules/hiddenSingle.js';
import { LockedCandidates } from './rules/lockedCandidates.js';
import type { RuleContext } from './rule.js';
import { makeTrivialSpec } from './fixtures.js';

describe('KillerBoardState init', () => {
  it('candidates start as full sets', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    expect(bs.candidates[0]![0]!).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(bs.candidates[8]![8]!).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  it('unit count is 9 rows + 9 cols + 9 boxes + 81 cages for trivial spec', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    // The trivial spec (all single-cell cages) produces no virtual cages
    expect(bs.units.length).toBe(9 + 9 + 9 + 81);
  });

  it('counts are initialised to unit size for every digit', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const row0 = bs.rowUnitId(0);
    for (let d = 1; d <= 9; d++) {
      expect(bs.counts[row0]![d]!).toBe(9);
    }
  });

  it('cell (0,0) belongs to ROW, COL, BOX and CAGE units', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const kinds = new Set(bs.cellUnitIds(0, 0).map(uid => bs.units[uid]!.kind));
    expect(kinds).toEqual(new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE]));
  });

  it('unitVersions start at zero', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    expect(bs.unitVersions.every(v => v === 0)).toBe(true);
  });
});

describe('BoardState (plain) construction', () => {
  it('builds exactly 27 row/col/box units and no cage units', () => {
    const bs = new BoardState();
    expect(bs.units.length).toBe(27);
    expect(bs.units.every(u => u.kind !== UnitKind.CAGE)).toBe(true);
  });

  it('candidates start as full sets', () => {
    const bs = new BoardState();
    expect(bs.candidates[0]![0]!).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(bs.candidates[8]![8]!).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  it('counts are initialised to unit size for every digit', () => {
    const bs = new BoardState();
    const row0 = bs.rowUnitId(0);
    for (let d = 1; d <= 9; d++) {
      expect(bs.counts[row0]![d]!).toBe(9);
    }
  });

  it('cell (0,0) belongs to ROW, COL and BOX units only — no CAGE', () => {
    const bs = new BoardState();
    const kinds = new Set(bs.cellUnitIds(0, 0).map(uid => bs.units[uid]!.kind));
    expect(kinds).toEqual(new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX]));
  });

  it('cageConstraints returns null', () => {
    const bs = new BoardState();
    expect(bs.cageConstraints()).toBeNull();
  });

  it('removeCandidate works without any cage bookkeeping', () => {
    const bs = new BoardState();
    const events = bs.removeCandidate(0, 0, 9);
    expect(events.some(e => e.trigger === Trigger.COUNT_DECREASED)).toBe(true);
    expect(bs.cands(0, 0).has(9)).toBe(false);
  });

  it('extraPeers returns empty for every cell by default', () => {
    const bs = new BoardState();
    expect(bs.extraPeers(0, 0)).toEqual([]);
    expect(bs.extraPeers(4, 4)).toEqual([]);
    expect(bs.extraPeers(8, 8)).toEqual([]);
  });
});

describe('Cage-aware rule hints never mention cages against a plain BoardState', () => {
  it('HiddenSingle.asHints uses the non-cage explanation for a row unit', () => {
    const bs = new BoardState();
    for (let c = 1; c < 9; c++) bs.cands(0, c).delete(1);
    const rowUid = bs.rowUnitId(0);
    const ctx: RuleContext = { unit: bs.units[rowUid] ?? null, cell: null, board: bs, hint: Trigger.COUNT_HIT_ONE, hintDigit: 1 };
    const rule = new HiddenSingle();
    const hints = rule.asHints(ctx, [...rule.apply(ctx).eliminations]);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.explanation.toLowerCase()).not.toContain('cage');
    expect(hints[0]!.displayName.toLowerCase()).not.toContain('cage');
  });

  it('LockedCandidates.asHints uses the box-line explanation, never the cage-line one', () => {
    const bs = new BoardState();
    // Digit 5 in row 0 is confined to cols 0-2 (box 0) — forces a box-line elimination.
    for (let c = 3; c < 9; c++) bs.cands(0, c).delete(5);
    const rowUid = bs.rowUnitId(0);
    const ctx: RuleContext = { unit: bs.units[rowUid] ?? null, cell: null, board: bs, hint: Trigger.COUNT_DECREASED, hintDigit: null };
    const rule = new LockedCandidates();
    const hints = rule.asHints(ctx, [...rule.apply(ctx).eliminations]);
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) {
      expect(hint.displayName).toBe('Locked Candidates (Box-Line)');
      expect(hint.explanation.toLowerCase()).not.toContain('cage');
    }
  });
});

describe('removeCandidate', () => {
  it('decrements count for the digit in all containing units', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const row0 = bs.rowUnitId(0);
    const before = bs.counts[row0]![5]!;
    bs.removeCandidate(0, 0, 5);
    expect(bs.counts[row0]![5]!).toBe(before - 1);
  });

  it('bumps unitVersion for all containing units', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const uid = bs.rowUnitId(0);
    bs.removeCandidate(0, 0, 5);
    expect(bs.unitVersions[uid]).toBe(1);
  });

  it('emits COUNT_DECREASED event', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const events = bs.removeCandidate(0, 0, 5);
    const triggers = new Set(events.map(e => e.trigger));
    expect(triggers.has(Trigger.COUNT_DECREASED)).toBe(true);
  });

  it('emits CELL_DETERMINED when set becomes singleton', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    bs.candidates[1]![1] = new Set([3, 7]);
    const events = bs.removeCandidate(1, 1, 3);
    const det = events.filter(e => e.trigger === Trigger.CELL_DETERMINED);
    expect(det.length).toBe(1);
    expect(det[0]!.payload).toEqual([1, 1]);
    expect(det[0]!.hintDigit).toBe(7);
  });

  it('throws NoSolnError when removing the last candidate', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    bs.candidates[0]![0] = new Set([5]);
    expect(() => bs.removeCandidate(0, 0, 5)).toThrow(NoSolnError);
  });

  it('emits COUNT_HIT_ONE when count decreases to 1', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
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
    const bs = new KillerBoardState(makeTrivialSpec());
    bs.candidates[0]![0] = new Set([5]);
    // Remove a digit that isn't there — should return no events without throwing
    const events = bs.removeCandidate(0, 0, 3);
    expect(events).toEqual([]);
  });
});

describe('restoreCandidates', () => {
  it('reduces candidates to exactly the given set', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const candidates: number[][][] = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => (r === 0 && c === 0) ? [1, 2, 3] : [...bs.cands(r, c)]));
    bs.restoreCandidates(candidates);
    expect(bs.cands(0, 0)).toEqual(new Set([1, 2, 3]));
  });

  it('is a no-op for cells whose candidates already match', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const before = bs.cands(1, 1).size;
    const candidates: number[][][] = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => [...bs.cands(r, c)]));
    bs.restoreCandidates(candidates);
    expect(bs.cands(1, 1).size).toBe(before);
  });

  it('prunes cage solutions via the KillerBoardState removeCandidate override', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const cageIdx = bs.regions[0]![0]!;
    const before = bs.cageSolns[cageIdx]!.length;
    const candidates: number[][][] = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => (r === 0 && c === 0) ? [bs.cands(0, 0).values().next().value!] : [...bs.cands(r, c)]));
    bs.restoreCandidates(candidates);
    expect(bs.cageSolns[cageIdx]!.length).toBeLessThanOrEqual(before);
  });
});

describe('removeCageSolution', () => {
  it('emits SOLUTION_PRUNED and removes the solution', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
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
    const bs = new KillerBoardState(makeTrivialSpec());
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
    const events = (bs as any)._pruneCageSolutions(cageIdx, 0, 0, 3) as ReturnType<KillerBoardState['removeCandidate']>;
    const pruned = events.filter((e: { trigger: Trigger }) => e.trigger === Trigger.SOLUTION_PRUNED);
    expect(pruned.length).toBe(1);
  });
});

describe('virtual cages', () => {
  it('trivial spec includes virtual cages from LinearSystem in cageSolns', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const nRealCages = Math.max(...bs.regions.flat()) + 1;
    const nVirtual = bs.linearSystem.virtualCages.length;
    expect(bs.cageSolns.length).toBe(nRealCages + nVirtual);
  });

  it('addVirtualCage appends a CAGE unit and cageSolns entry', () => {
    const bs = new KillerBoardState(makeTrivialSpec(), { includeVirtualCages: false });
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
    const bs = new KillerBoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const cells = [[0, 0], [0, 1]] as unknown as import('./types.js').Cell[];
    // Total 3 with 2 cells: only solution is [1, 2]; eliminating it leaves []
    bs.addVirtualCage(cells, 3, [[1, 2]]);
    expect(bs.cageSolns[bs.cageSolns.length - 1]).toEqual([]);
  });

  it('addVirtualCage registers new unit in per-cell lookup', () => {
    const bs = new KillerBoardState(makeTrivialSpec(), { includeVirtualCages: false });
    const nUidsBefore = bs.cellUnitIds(0, 0).length;
    const cells = [[0, 0], [0, 1]] as unknown as import('./types.js').Cell[];
    bs.addVirtualCage(cells, 8, []);
    expect(bs.cellUnitIds(0, 0).length).toBe(nUidsBefore + 1);
  });
});
