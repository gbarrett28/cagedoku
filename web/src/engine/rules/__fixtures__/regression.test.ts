/**
 * Generic regression gate for rule-bug fixtures: replays each fixture's
 * serialized session against its own rule and asserts no
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
 *
 * Remove an entry once the underlying rule bug is fixed.
 */
const KNOWN_FAILING_FIXTURES: readonly string[] = [];

describe('rule-bug fixture regression', () => {
  if (ruleBugFixtures.length === 0) {
    it.skip('no fixtures recorded', () => {});
  }

  const rules = defaultRules();
  for (const fixture of ruleBugFixtures) {
    const rule = rules.find(r => r.name === fixture.ruleName);
    const itFixture = !rule || DISABLED_RULES.includes(fixture.ruleName) || KNOWN_FAILING_FIXTURES.includes(fixture.name)
      ? it.skip
      : it;
    itFixture(`${fixture.name}: ${fixture.ruleName} produces no golden-contradicting elimination`, () => {
      const { board, state } = boardFromFixture(fixture);
      const { violations } = findTriggerMisses(board, [rule!], state.goldenSolution);
      expect(violations).toEqual([]);
    });
  }
});
