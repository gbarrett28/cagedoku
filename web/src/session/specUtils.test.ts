import { describe, it, expect } from 'vitest';
import { classicSyntheticSpec } from './specUtils.js';

describe('classicSyntheticSpec', () => {
  it('builds 9 row-cages each summing to 45, with all internal vertical borders present', () => {
    const spec = classicSyntheticSpec();
    expect(spec.regions).toHaveLength(9);
    for (let r = 0; r < 9; r++) {
      expect(spec.regions[r]).toEqual(new Array(9).fill(r + 1));
      expect(spec.cageTotals[r]![0]).toBe(45);
      for (let c = 1; c < 9; c++) expect(spec.cageTotals[r]![c]).toBe(0);
    }
    expect(spec.borderX).toEqual(Array.from({ length: 9 }, () => new Array(8).fill(true)));
    expect(spec.borderY).toEqual(Array.from({ length: 8 }, () => new Array(9).fill(false)));
  });
});
