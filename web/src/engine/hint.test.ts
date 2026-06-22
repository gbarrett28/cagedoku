import { describe, it, expect } from 'vitest';
import { findChainCell, HintResult } from './hint.js';

function baseHint(overrides: Partial<HintResult>): HintResult {
  return {
    ruleName: 'Test',
    displayName: 'Test',
    explanation: 'test',
    highlightCells: [],
    eliminations: [],
    placement: null,
    virtualCageSuggestion: null,
    ...overrides,
  };
}

describe('findChainCell', () => {
  it('returns null when the hint has no chainCells', () => {
    const hint = baseHint({});
    expect(findChainCell(hint, [0, 0])).toBeNull();
  });

  it('returns null when the cell has no matching entry', () => {
    const hint = baseHint({
      chainCells: [{ cell: [1, 1], digits: [5], colour: 'blue' }],
    });
    expect(findChainCell(hint, [0, 0])).toBeNull();
  });

  it('returns the matching entry, with its own digits and colour', () => {
    const hint = baseHint({
      chainCells: [
        { cell: [1, 1], digits: [5], colour: 'blue' },
        { cell: [2, 2], digits: [6, 7] },
      ],
    });
    expect(findChainCell(hint, [1, 1])).toEqual({ cell: [1, 1], digits: [5], colour: 'blue' });
    expect(findChainCell(hint, [2, 2])).toEqual({ cell: [2, 2], digits: [6, 7] });
  });
});
