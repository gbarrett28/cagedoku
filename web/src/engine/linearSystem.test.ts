/**
 * Tests for LinearSystem virtual-cage derivation.
 */

import { describe, expect, it } from 'vitest';
import { LinearSystem } from './linearSystem.js';
import { makeThreeCellCageSpec, makeRowCageSpec, makeOutieSpec } from './fixtures.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';

const specs: ReadonlyArray<[string, PuzzleSpec]> = [
  ['three-cell cage spec', makeThreeCellCageSpec()],
  ['row cage spec', makeRowCageSpec()],
  ['outie spec', makeOutieSpec()],
];

describe('LinearSystem._deriveNonburbVirtualCages', () => {
  it.each(specs)('derives virtual cages with precomputedSolns: null for %s', (_name, spec) => {
    const ls = new LinearSystem(spec);
    expect(ls.virtualCages.length).toBeGreaterThan(0);
    for (const vc of ls.virtualCages) {
      expect(vc.precomputedSolns).toBeNull();
    }
  });

  it.each(specs)('every derived virtual cage cell set is non-empty and within bounds for %s', (_name, spec) => {
    const ls = new LinearSystem(spec);
    for (const vc of ls.virtualCages) {
      expect(vc.cells.length).toBeGreaterThan(0);
      expect(vc.cells.length).toBeLessThanOrEqual(9);
      for (const [r, c] of vc.cells) {
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(8);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(8);
      }
    }
  });
});
