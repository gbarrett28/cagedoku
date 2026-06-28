import { describe, expect, it } from 'vitest';
import { PuzzleState } from '../session/types.js';
import { specToData, specToCageStates } from '../session/specUtils.js';
import { computeSpecHash } from './specHash.js';

// Minimal 9x9 killer spec: one cage covering all cells, total=45 at (0,0)
function makeMinimalSpec() {
  const regions = Array.from({ length: 9 }, () => new Array<number>(9).fill(1));
  const cageTotals = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  cageTotals[0]![0] = 45;
  // PuzzleSpec uses [col][row] for regions/cageTotals
  const regionsColRow = Array.from({ length: 9 }, (_, c) =>
    Array.from({ length: 9 }, (__, r) => regions[r]![c]!),
  );
  const totalsColRow = Array.from({ length: 9 }, (_, c) =>
    Array.from({ length: 9 }, (__, r) => cageTotals[r]![c]!),
  );
  return { regions: regionsColRow, cageTotals: totalsColRow };
}

function makeKillerState() {
  const spec = makeMinimalSpec();
  // Build borderX / borderY manually for a single-cage grid (no internal walls)
  const borderX: boolean[][] = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(false));
  const borderY: boolean[][] = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false));
  const fullSpec = { ...spec, borderX, borderY };
  const specData = specToData(fullSpec);
  return PuzzleState.createKiller(specData, specToCageStates(fullSpec), [], null, null);
}

function makeClassicState() {
  const givenDigits = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => ((r * 9 + c) % 9) + 1),
  );
  return {
    userGrid: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
    turns: [],
    alwaysApplyRules: [],
    goldenSolution: null,
    givenDigits,
    originalImageUrl: null,
    warpedImageUrl: null,
    userRemovedCandidates: [],
  } as PuzzleState;
}

describe('computeSpecHash', () => {
  it('returns null for null state', async () => {
    expect(await computeSpecHash(null)).toBeNull();
  });

  it('returns a 64-character hex string for a killer state', async () => {
    const hash = await computeSpecHash(makeKillerState());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a 64-character hex string for a classic state', async () => {
    const hash = await computeSpecHash(makeClassicState());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same killer state produces same hash', async () => {
    const h1 = await computeSpecHash(makeKillerState());
    const h2 = await computeSpecHash(makeKillerState());
    expect(h1).toBe(h2);
  });

  it('is deterministic — same classic state produces same hash', async () => {
    const h1 = await computeSpecHash(makeClassicState());
    const h2 = await computeSpecHash(makeClassicState());
    expect(h1).toBe(h2);
  });

  it('produces different hashes for killer and classic states', async () => {
    const killerHash = await computeSpecHash(makeKillerState());
    const classicHash = await computeSpecHash(makeClassicState());
    expect(killerHash).not.toBe(classicHash);
  });
});
