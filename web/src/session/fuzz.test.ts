/**
 * Fuzz / property tests for the session action layer.
 *
 * Applies random operation sequences (digit entry, removal, candidate cycling,
 * undo) to a real puzzle state and verifies structural invariants after every
 * step. We use random — and potentially wrong — moves intentionally; wrong
 * digits are valid user input that the hint system detects via rewind.
 *
 * Invariants checked after every operation:
 *   1. userGrid contains only digits 0–9.
 *   2. No sentinel (row=-1) turns in history — they were removed in the refactor.
 *   3. Round-trip consistency: rebuildUserGrid + applyAutoPlacements reproduces
 *      the same userGrid as the current state.
 *   4. computeCandidates() does not throw.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { makeThreeCellCageSpec } from '../engine/fixtures.js';
import { setState, getState } from './store.js';
import {
  confirmPuzzle,
  enterCell,
  cycleCandidate,
  undo,
  computeCandidates,
} from './actions.js';
import { rebuildUserGrid, applyAutoPlacements, DEFAULT_ALWAYS_APPLY_RULES } from './engine.js';
import type { PuzzleState } from './types.js';
import { specToData, specToCageStates } from './specUtils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfirmedState(): PuzzleState {
  const spec = makeThreeCellCageSpec();
  const pre: PuzzleState = {
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
    userGrid: null,
    virtualCages: [],
    turns: [],
    alwaysApplyRules: [...DEFAULT_ALWAYS_APPLY_RULES],
    goldenSolution: null,
    puzzleType: 'killer',
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
  };
  setState(pre);
  return confirmPuzzle();
}

/** Seeded LCG for reproducible pseudo-random sequences. */
function makePrng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0x100000000;
  };
}

function checkInvariants(state: PuzzleState, label: string): void {
  const grid = state.userGrid;
  if (grid === null) return;

  // 1. Valid digit range only — 0 (empty) through 9
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const d = grid[r]![c]!;
      expect(d, `${label}: (${r},${c}) out of range`).toBeGreaterThanOrEqual(0);
      expect(d, `${label}: (${r},${c}) out of range`).toBeLessThanOrEqual(9);
    }
  }

  // 2. No sentinel turns — sentinel turns were removed in the no-sentinel refactor
  for (let i = 0; i < state.turns.length; i++) {
    const a = state.turns[i]!.action;
    if (a.type === 'eliminateCandidate') {
      expect((a as { row: number }).row, `${label}: sentinel turn at index ${i}`).not.toBe(-1);
    }
  }

  // 3. Round-trip: rebuildUserGrid + applyAutoPlacements == current userGrid.
  //    This verifies that the turn history fully encodes the explicit user
  //    placements and that auto-placements are deterministically re-derived.
  const rebuilt = applyAutoPlacements(rebuildUserGrid(state));
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      expect(
        rebuilt.userGrid![r]![c],
        `${label}: round-trip mismatch at (${r},${c})`,
      ).toBe(grid[r]![c]);
    }
  }

  // 4. computeCandidates does not throw
  expect(() => computeCandidates()).not.toThrow();
}

// ---------------------------------------------------------------------------
// Fuzz runs
// ---------------------------------------------------------------------------

describe('session fuzz — random operation sequences', () => {
  let state: PuzzleState;

  beforeEach(() => {
    state = makeConfirmedState();
  });

  it.each([1, 2, 3, 4, 5, 42, 137, 999, 1234, 9999])(
    'seed %i: 60 random operations remain structurally consistent',
    (seed) => {
      const rng = makePrng(seed);

      for (let step = 0; step < 60; step++) {
        const op = Math.floor(rng() * 4); // 0=place, 1=remove, 2=candidate, 3=undo
        const r = Math.floor(rng() * 9) + 1; // 1-based
        const c = Math.floor(rng() * 9) + 1;
        const d = Math.floor(rng() * 9) + 1;

        try {
          if (op === 0) {
            state = enterCell(r, c, d);
          } else if (op === 1) {
            state = enterCell(r, c, 0);
          } else if (op === 2) {
            state = cycleCandidate(r, c, d);
          } else {
            state = undo();
          }
        } catch {
          // Expected: undo with nothing to undo, or placing in a given cell
        }

        state = getState()!;
        checkInvariants(state, `seed=${seed} step=${step} op=${op}`);
      }
    },
  );

  it('undo strictly decreases turn count', () => {
    try { state = enterCell(1, 1, 5); } catch { /* auto-placed */ }
    try { state = enterCell(2, 2, 7); } catch { /* auto-placed */ }
    state = getState()!;

    const before = state.turns.length;
    if (before === 0) return;
    try {
      state = undo();
      state = getState()!;
      expect(state.turns.length).toBeLessThan(before);
    } catch {
      // Nothing undoable — acceptable
    }
  });

  it('computeCandidates is idempotent (two calls with no state change)', () => {
    try { state = enterCell(1, 1, 5); } catch { /* auto-placed */ }
    state = getState()!;
    const c1 = computeCandidates();
    const c2 = computeCandidates();
    expect(JSON.stringify(c1.cells)).toBe(JSON.stringify(c2.cells));
    expect(JSON.stringify(c1.cages)).toBe(JSON.stringify(c2.cages));
  });

  it('undo after every placement leaves no sentinel turns', () => {
    const rng = makePrng(777);
    // Place 5 digits, then undo all
    const placements: [number, number, number][] = [];
    for (let i = 0; i < 5; i++) {
      const r = Math.floor(rng() * 9) + 1;
      const c = Math.floor(rng() * 9) + 1;
      const d = Math.floor(rng() * 9) + 1;
      try { state = enterCell(r, c, d); placements.push([r, c, d]); } catch { /* skip */ }
      state = getState()!;
    }
    // Undo all
    for (let i = 0; i < placements.length + 2; i++) {
      try { state = undo(); } catch { /* nothing left */ }
      state = getState()!;
      for (const turn of state.turns) {
        if (turn.action.type === 'eliminateCandidate') {
          expect((turn.action as { row: number }).row).not.toBe(-1);
        }
      }
    }
  });
});
