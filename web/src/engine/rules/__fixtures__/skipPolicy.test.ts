/**
 * Tests for shouldSkipFixture.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RuleBugFixture } from '../../../../../shared/src/fixture.js';
import type { SolverRule } from '../../rule.js';

vi.mock('./needs-triage.js', () => ({
  NEEDS_TRIAGE_FIXTURES: ['Triage-r2-2026-01-01T00-00-00-000Z'],
}));

vi.mock('../disabled-rules.js', () => ({
  DISABLED_RULES: ['SomeDisabledRule'],
}));

import { shouldSkipFixture } from './skipPolicy.js';

function makeFixture(overrides: Partial<RuleBugFixture> = {}): RuleBugFixture {
  return {
    version: 2,
    source: 'r2',
    name: 'Example-r2-2026-01-01T00-00-00-000Z',
    addedAt: '2026-01-01',
    ruleName: 'NakedPair',
    puzzleType: 'classic',
    state: null,
    ...overrides,
  };
}

const nakedPairRule = { name: 'NakedPair' } as SolverRule;

describe('shouldSkipFixture', () => {
  it('skips when no matching rule is found', () => {
    expect(shouldSkipFixture(makeFixture(), undefined, [])).toBe(true);
  });

  it('does not skip a fixture with a matching rule and no triage/known-failing entry', () => {
    expect(shouldSkipFixture(makeFixture(), nakedPairRule, [])).toBe(false);
  });

  it('skips a fixture listed in knownFailingFixtures', () => {
    const fixture = makeFixture({ name: 'KnownBad-r2-2026-01-01T00-00-00-000Z' });
    expect(shouldSkipFixture(fixture, nakedPairRule, ['KnownBad-r2-2026-01-01T00-00-00-000Z'])).toBe(true);
  });

  it('skips a fixture for a globally disabled rule', () => {
    const fixture = makeFixture({ ruleName: 'SomeDisabledRule' });
    const rule = { name: 'SomeDisabledRule' } as SolverRule;
    expect(shouldSkipFixture(fixture, rule, [])).toBe(true);
  });

  it('skips a fixture listed in NEEDS_TRIAGE_FIXTURES', () => {
    const fixture = makeFixture({ name: 'Triage-r2-2026-01-01T00-00-00-000Z' });
    expect(shouldSkipFixture(fixture, nakedPairRule, [])).toBe(true);
  });
});
