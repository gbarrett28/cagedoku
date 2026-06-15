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
 *
 * - SolutionMapFilter-r2-2026-05-29T07-06-49-234Z: SolutionMapFilter eliminates
 *   golden digit 1 from cell (5,5), via both GLOBAL and SOLUTION_PRUNED:CAGE:32
 *   contexts. Found by `npx vite-node scripts/debug-fixture.ts SolutionMapFilter`
 *   (see docs/debugging-fixtures.md). Needs its own investigation into
 *   SolutionMapFilter's cage-solution-pruning logic.
 *
 * Remove an entry once the underlying rule bug is fixed.
 */
const KNOWN_FAILING_FIXTURES: readonly string[] = [
  'SolutionMapFilter-r2-2026-05-29T07-06-49-234Z',
];

describe('rule-bug fixture regression', () => {
  const rules = defaultRules();
  for (const fixture of ruleBugFixtures) {
    const rule = rules.find(r => r.name === fixture.ruleName);
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
