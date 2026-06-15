import { describe, it, expect } from 'vitest';
import { fixtureFingerprint } from '../../shared/src/fixture.js';
import type { RuleBugFixture } from '../../shared/src/fixture.js';

const grid9x9 = Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (__, c) => ((r * 3 + Math.floor(r / 3) + c) % 9) + 1));
const candidates9x9 = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => [1, 2, 3]));
const regions9x9 = Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, () => r + 1));
const cageTotals9x9 = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));

function makeFixture(overrides: Partial<RuleBugFixture> = {}): RuleBugFixture {
  return {
    version: 1,
    source: 'r2',
    name: 'TestRule-r2-2026-01-01T00-00-00-000Z',
    addedAt: '2026-01-01',
    puzzleType: 'killer',
    ruleName: 'TestRule',
    regions: regions9x9,
    cageTotals: cageTotals9x9,
    stalledCandidates: candidates9x9,
    goldenSolution: grid9x9,
    unsolvedCells: 81,
    totalCandidates: 243,
    ...overrides,
  };
}

describe('fixtureFingerprint', () => {
  it('is identical for fixtures describing the same puzzle state', () => {
    const a = makeFixture({ name: 'TestRule-r2-2026-01-01T00-00-00-000Z', addedAt: '2026-01-01' });
    const b = makeFixture({ name: 'TestRule-r2-2026-02-02T00-00-00-000Z', addedAt: '2026-02-02', source: 'trigger-miss' });
    expect(fixtureFingerprint(a)).toBe(fixtureFingerprint(b));
  });

  it('differs when the rule name differs', () => {
    const a = makeFixture({ ruleName: 'TestRule' });
    const b = makeFixture({ ruleName: 'OtherRule' });
    expect(fixtureFingerprint(a)).not.toBe(fixtureFingerprint(b));
  });

  it('differs when the stalled candidates differ', () => {
    const a = makeFixture();
    const otherCandidates = candidates9x9.map(row => row.map(cell => [...cell]));
    otherCandidates[0]![0] = [4, 5];
    const b = makeFixture({ stalledCandidates: otherCandidates });
    expect(fixtureFingerprint(a)).not.toBe(fixtureFingerprint(b));
  });
});
