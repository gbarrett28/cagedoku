/**
 * Smoke-tests for defaultRules() — verifies every implemented rule
 * is actually registered in the active rule set.
 *
 * Add an entry here whenever a new rule file is created, before
 * registering it in defaultRules(), so the test fails first.
 */

import { describe, expect, it } from 'vitest';
import { defaultRules } from './index.js';

describe('defaultRules', () => {
  /** All rule names expected in the active rule set. */
  const EXPECTED_RULES = [
    'NakedSingle',
    'CellSolutionElimination',
    'HiddenSingle',
    'LinearElimination',
    'CageCandidateFilter',
    'CageIntersection',
    'SolutionMapFilter',
    'MustContain',
    'MustContainOutie',
    'DeltaConstraint',
    'SumPairConstraint',
    'NakedPair',
    'HiddenPair',
    'NakedHiddenTriple',
    'NakedHiddenQuad',
    'PointingPairs',
    'LockedCandidates',
    'CageConfinement',
    'UnitPartitionFilter',
    'XWing',
    'Swordfish',
    'Jellyfish',
    'XYWing',
    'UniqueRectangle',
    'SimpleColouring',
    'XYZWing',
    'WWing',
    'Skyscraper',
    'TwoStringKite',
  ];

  it('contains every expected rule by name', () => {
    const names = defaultRules().map(r => r.name);
    for (const expected of EXPECTED_RULES) {
      expect(names, `Rule '${expected}' missing from defaultRules()`).toContain(expected);
    }
  });

  it('has no duplicate rule names', () => {
    const names = defaultRules().map(r => r.name);
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });

  it('is sorted by ascending priority', () => {
    const rules = defaultRules();
    for (let i = 1; i < rules.length; i++) {
      expect(rules[i]!.priority).toBeGreaterThanOrEqual(rules[i - 1]!.priority);
    }
  });
});
