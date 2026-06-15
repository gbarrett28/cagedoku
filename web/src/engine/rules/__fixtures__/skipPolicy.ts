/**
 * Shared skip policy for rule-bug fixture regression tests.
 */

import type { RuleBugFixture } from '../../../../../shared/src/fixture.js';
import type { SolverRule } from '../../rule.js';
import { DISABLED_RULES } from '../disabled-rules.js';
import { NEEDS_TRIAGE_FIXTURES } from './needs-triage.js';

/**
 * Whether a rule-bug fixture's regression test should be skipped: no matching
 * rule, the rule is globally disabled, the fixture has a tracked open bug
 * (`knownFailingFixtures`), or it's freshly synced and not yet triaged.
 */
export function shouldSkipFixture(
  fixture: RuleBugFixture,
  rule: SolverRule | undefined,
  knownFailingFixtures: readonly string[],
): boolean {
  return !rule
    || DISABLED_RULES.includes(fixture.ruleName)
    || knownFailingFixtures.includes(fixture.name)
    || NEEDS_TRIAGE_FIXTURES.includes(fixture.name);
}
