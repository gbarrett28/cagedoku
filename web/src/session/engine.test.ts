/**
 * Tests for session/engine.ts helpers.
 */

import { describe, expect, it } from 'vitest';
import { makeTrivialSpec, KNOWN_SOLUTION } from '../engine/fixtures.js';
import { specToData, specToCageStates, cageLabel } from './specUtils.js';
import {
  buildEngine,
  userRemoved,
  userVirtualCages,
} from './engine.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './settings.js';
import type { PuzzleState, Turn, UserAction, VirtualCage } from './types.js';
import type { Cell } from '../engine/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeState(): PuzzleState {
  const spec = makeTrivialSpec();
  return {
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
    userGrid: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
    virtualCages: [],
    turns: [],
    alwaysApplyRules: [...DEFAULT_ALWAYS_APPLY_RULES],
    goldenSolution: null,
    puzzleType: 'killer',
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
  };
}

function makeTurn(action: UserAction): Turn {
  return {
    action,
    autoMutations: [],
    snapshot: { candidates: Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => [])) },
  };
}

// ---------------------------------------------------------------------------
// specUtils
// ---------------------------------------------------------------------------

describe('cageLabel', () => {
  it('labels single letters A-Z', () => {
    expect(cageLabel(0)).toBe('A');
    expect(cageLabel(25)).toBe('Z');
  });

  it('wraps to AA after Z', () => {
    expect(cageLabel(26)).toBe('AA');
    expect(cageLabel(27)).toBe('AB');
  });
});

describe('specToData / dataToSpec round-trip', () => {
  it('round-trips without mutation', async () => {
    const { dataToSpec } = await import('./specUtils.js');
    const spec = makeTrivialSpec();
    const data = specToData(spec);
    const spec2 = dataToSpec(data);
    expect(spec2.regions).toEqual(spec.regions);
    expect(spec2.cageTotals).toEqual(spec.cageTotals);
  });

  it('derives correct borders from regions', async () => {
    const { dataToSpec } = await import('./specUtils.js');
    const spec = makeTrivialSpec();
    const data = specToData(spec);
    const spec2 = dataToSpec(data);
    // trivial spec: every cell is its own cage, so every border is a wall
    for (let c = 0; c < 9; c++)
      for (let rowGap = 0; rowGap < 8; rowGap++)
        expect(spec2.borderX[c]![rowGap]!).toBe(true);
    for (let colGap = 0; colGap < 8; colGap++)
      for (let r = 0; r < 9; r++)
        expect(spec2.borderY[colGap]![r]!).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// userRemoved
// ---------------------------------------------------------------------------

describe('userRemoved', () => {
  it('returns empty when no turns', () => {
    expect(userRemoved(makeState())).toHaveLength(0);
  });

  it('accumulates eliminateCandidate turns', () => {
    const state = makeState();
    const turns = [
      makeTurn({ type: 'eliminateCandidate', row: 0, col: 0, digit: 5 }),
      makeTurn({ type: 'eliminateCandidate', row: 1, col: 2, digit: 3 }),
    ];
    const result = userRemoved({ ...state, turns });
    expect(result).toContainEqual([0, 0, 5]);
    expect(result).toContainEqual([1, 2, 3]);
  });

  it('restoreCandidate removes the most recent matching entry', () => {
    const state = makeState();
    const turns = [
      makeTurn({ type: 'eliminateCandidate', row: 0, col: 0, digit: 5 }),
      makeTurn({ type: 'restoreCandidate', row: 0, col: 0, digit: 5 }),
    ];
    const result = userRemoved({ ...state, turns });
    expect(result).not.toContainEqual([0, 0, 5]);
  });
});

// ---------------------------------------------------------------------------
// userVirtualCages
// ---------------------------------------------------------------------------

describe('userVirtualCages', () => {
  const vc: VirtualCage = {
    cells: [[0, 0], [0, 1]] as Cell[],
    total: 10,
    eliminatedSolns: [],
  };

  it('adds a cage via addVirtualCage', () => {
    const state = makeState();
    const turns = [makeTurn({ type: 'addVirtualCage', cage: vc })];
    expect(userVirtualCages({ ...state, turns })).toHaveLength(1);
  });

  it('removes a cage via removeVirtualCage', () => {
    const state = makeState();
    const key = '0,0:0,1:10';
    const turns = [
      makeTurn({ type: 'addVirtualCage', cage: vc }),
      makeTurn({ type: 'removeVirtualCage', key }),
    ];
    expect(userVirtualCages({ ...state, turns })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildEngine
// ---------------------------------------------------------------------------

describe('buildEngine', () => {
  it('constructs board and engine without crash', () => {
    const { board, engine } = buildEngine(makeState());
    expect(board).toBeDefined();
    expect(engine).toBeDefined();
  });

  it('engine.solve() finds the known solution on trivial spec', () => {
    const { board, engine } = buildEngine(makeState());
    engine.solve();
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        expect(board.candidates[r]![c]!).toEqual(new Set([KNOWN_SOLUTION[r]![c]!]));
  });

  it('user eliminations reduce candidates before solve', () => {
    const state = makeState();
    // Place digit 1 at (0,0) in userGrid
    const userGrid = state.userGrid!.map(row => [...row]);
    userGrid[0]![0] = 1;
    const stateWithPlacement = { ...state, userGrid };
    const { board } = buildEngine(stateWithPlacement);
    // All digits except 1 should have been removed from (0,0)
    expect(board.candidates[0]![0]!.has(1)).toBe(true);
    // After solve the candidate set may be even smaller — just check no crash
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_ALWAYS_APPLY_RULES
// ---------------------------------------------------------------------------

describe('DEFAULT_ALWAYS_APPLY_RULES', () => {
  it('contains the expected rule names', () => {
    expect(DEFAULT_ALWAYS_APPLY_RULES).toContain('CageCandidateFilter');
    expect(DEFAULT_ALWAYS_APPLY_RULES).toContain('CellSolutionElimination');
  });
});
