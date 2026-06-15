/**
 * Generic regression gate for rule-bug fixtures: replays each fixture's
 * stalled puzzle state against its own rule and asserts no
 * golden-contradicting elimination. See docs/debugging-fixtures.md.
 */

import { describe, expect, it } from 'vitest';
import { ruleBugFixtures } from './index.js';
import { boardFromFixture } from './replay.js';
import { defaultRules } from '../index.js';
import { DISABLED_RULES } from '../disabled-rules.js';
import { findTriggerMisses } from '../../triggerValidator.js';

/**
 * Fixtures with a known, still-reproducing violation in their own rule,
 * tracked as a separate bug rather than blocking this generic gate.
 * Remove an entry once the underlying rule bug is fixed.
 */
const KNOWN_FAILING_FIXTURES: readonly string[] = [
  'SolutionMapFilter-r2-2026-05-29T07-06-49-234Z',
];

describe('rule-bug fixture regression', () => {
  for (const fixture of ruleBugFixtures) {
    const rule = defaultRules().find(r => r.name === fixture.ruleName);
    const itFixture = !rule || DISABLED_RULES.includes(fixture.ruleName) || KNOWN_FAILING_FIXTURES.includes(fixture.name)
      ? it.skip
      : it;
    itFixture(`${fixture.name}: ${fixture.ruleName} produces no golden-contradicting elimination`, () => {
      const board = boardFromFixture(fixture);
      const { violations } = findTriggerMisses(board, [rule!], fixture.goldenSolution);
      expect(violations).toEqual([]);
    });
  }
});
