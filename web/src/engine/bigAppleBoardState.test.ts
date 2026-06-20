/**
 * Tests for BigAppleBoardState — window unit registration and extraPeers.
 */

import { describe, expect, it } from 'vitest';
import { BigAppleBoardState } from './bigAppleBoardState.js';
import { UnitKind } from './types.js';

describe('BigAppleBoardState construction', () => {
  it('builds 27 row/col/box units plus 4 window units (31 total)', () => {
    const bs = new BigAppleBoardState();
    expect(bs.units.length).toBe(31);
  });

  it('all 4 extra units are UnitKind.BOX', () => {
    const bs = new BigAppleBoardState();
    const extra = bs.units.slice(27);
    expect(extra).toHaveLength(4);
    expect(extra.every(u => u.kind === UnitKind.BOX)).toBe(true);
  });

  it('window units cover the documented 0-based coordinates', () => {
    const bs = new BigAppleBoardState();
    const cellSets = bs.units.slice(27).map(u =>
      new Set((u.cells as [number, number][]).map(([r, c]) => `${r},${c}`)));

    const expectWindow = (r0: number, c0: number) => {
      const expected = new Set<string>();
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) expected.add(`${r0 + dr},${c0 + dc}`);
      expect(cellSets.some(s => s.size === 9 && [...expected].every(k => s.has(k)))).toBe(true);
    };
    expectWindow(1, 1); // top-left
    expectWindow(5, 1); // bottom-left
    expectWindow(1, 5); // top-right
    expectWindow(5, 5); // bottom-right
  });

  it('cell (1,1) belongs to ROW, COL, standard BOX, and the top-left window — 2 BOX-kind units', () => {
    const bs = new BigAppleBoardState();
    const kinds = bs.cellUnitIds(1, 1).map(uid => bs.units[uid]!.kind);
    expect(kinds.filter(k => k === UnitKind.BOX)).toHaveLength(2);
  });

  it('cell (0,0) belongs to no window — exactly 1 BOX-kind unit', () => {
    const bs = new BigAppleBoardState();
    const kinds = bs.cellUnitIds(0, 0).map(uid => bs.units[uid]!.kind);
    expect(kinds.filter(k => k === UnitKind.BOX)).toHaveLength(1);
  });
});

describe('BigAppleBoardState.extraPeers', () => {
  it('returns the other 8 cells of cell (1,1)\'s window', () => {
    const bs = new BigAppleBoardState();
    const peers = new Set(bs.extraPeers(1, 1).map(([r, c]) => `${r},${c}`));
    expect(peers.size).toBe(8);
    expect(peers.has('1,1')).toBe(false);
    expect(peers.has('3,3')).toBe(true); // bottom-right corner of the same window
    expect(peers.has('5,5')).toBe(false); // different window
  });

  it('returns [] for a cell outside every window', () => {
    const bs = new BigAppleBoardState();
    expect(bs.extraPeers(0, 0)).toEqual([]);
    expect(bs.extraPeers(4, 4)).toEqual([]); // centre cell, in no window
  });
});
