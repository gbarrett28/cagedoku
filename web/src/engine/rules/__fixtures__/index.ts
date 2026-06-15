/**
 * Rule-bug stall fixtures, each a complete `SerializedPuzzleState` (full turn
 * history) captured by `RuleBugReport`/`TriggerMissReport`.
 *
 * Populated by the nightly `npx vite-node scripts/sync-rule-fixtures.ts`
 * action. See `docs/architecture.md` § "Rule-bug fixture pipeline" and
 * `docs/debugging-fixtures.md`.
 */

import type { RuleBugFixture } from '../../../../../shared/src/fixture.js';

export const ruleBugFixtures: readonly RuleBugFixture[] = [];
