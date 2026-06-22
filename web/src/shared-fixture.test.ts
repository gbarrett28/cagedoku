import { describe, it, expect } from 'vitest';
import { fixtureFingerprint } from '../../shared/src/fixture.js';
import type { RuleBugFixture } from '../../shared/src/fixture.js';

const grid9x9 = Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (__, c) => ((r * 3 + Math.floor(r / 3) + c) % 9) + 1));

function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'classic',
    version: 1,
    userGrid: grid9x9,
    turns: [],
    alwaysApplyRules: [],
    goldenSolution: grid9x9,
    givenDigits: null,
    originalImageUrl: null,
    userRemovedCandidates: [],
    ...overrides,
  };
}

function makeFixture(overrides: Partial<RuleBugFixture> = {}): RuleBugFixture {
  return {
    version: 2,
    source: 'r2',
    name: 'TestRule-r2-2026-01-01T00-00-00-000Z',
    addedAt: '2026-01-01',
    puzzleType: 'killer',
    ruleName: 'TestRule',
    state: makeState(),
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

  it('differs when the puzzle state differs', () => {
    const a = makeFixture();
    const otherGrid = grid9x9.map(row => [...row]);
    otherGrid[0]![0] = otherGrid[0]![0]! === 9 ? 1 : otherGrid[0]![0]! + 1;
    const b = makeFixture({ state: makeState({ userGrid: otherGrid }) });
    expect(fixtureFingerprint(a)).not.toBe(fixtureFingerprint(b));
  });
});
