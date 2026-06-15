/**
 * Fixture names freshly synced from R2, not yet reviewed by a human.
 *
 * Populated automatically by `sync-rule-fixtures.ts`: every newly-seen
 * fixture is appended to `index.ts` and its name appended here, so the
 * bronze gate never fails on a freshly-reported (possibly still-buggy)
 * fixture.
 *
 * During periodic review of an entry:
 * - if the fixture's rule now passes (no violation), remove its name from
 *   this list — it becomes a live regression test.
 * - if there's a real, still-open rule bug worth tracking, move it to
 *   `KNOWN_FAILING_FIXTURES` in `regression.test.ts` with an explanatory
 *   comment.
 * - if unactionable, delete the fixture entry from `index.ts` entirely and
 *   remove its name from this list.
 */
export const NEEDS_TRIAGE_FIXTURES: readonly string[] = [];
