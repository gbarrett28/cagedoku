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
export const NEEDS_TRIAGE_FIXTURES: readonly string[] = [  "NakedSingle-trigger-miss-2026-06-22T11-39-45-090Z",
  "CageCandidateFilter-trigger-miss-2026-06-22T11-39-42-997Z",
  "SolutionMapFilter-trigger-miss-2026-06-22T11-39-42-999Z",
  "SolutionMapFilter-trigger-miss-2026-06-22T11-39-46-126Z",
  "CageCandidateFilter-r2-2026-06-23T08-41-18-733Z",
  "SolutionMapFilter-r2-2026-06-23T08-41-18-749Z",
  "CageCandidateFilter-r2-2026-06-24T11-02-03-539Z",
  "CageCandidateFilter-trigger-miss-2026-06-24T20-48-41-401Z",
  "CageCandidateFilter-trigger-miss-2026-06-24T20-48-44-514Z",
  "CageCandidateFilter-trigger-miss-2026-06-24T20-48-46-556Z",
  "CageCandidateFilter-trigger-miss-2026-06-24T20-48-49-630Z",
  "CageIntersection-r2-2026-06-24T11-03-03-694Z",
  "CageIntersection-trigger-miss-2026-06-24T20-48-43-484Z",
  "CageIntersection-trigger-miss-2026-06-24T20-48-44-515Z",
  "CageIntersection-trigger-miss-2026-06-24T20-48-48-607Z",
  "CageIntersection-trigger-miss-2026-06-24T20-48-51-687Z",
  "SolutionMapFilter-r2-2026-06-24T11-02-03-555Z",
  "SolutionMapFilter-trigger-miss-2026-06-24T20-48-41-404Z",
  "SolutionMapFilter-trigger-miss-2026-06-24T20-48-44-518Z",
  "SolutionMapFilter-trigger-miss-2026-06-24T20-48-46-558Z",
  "SolutionMapFilter-trigger-miss-2026-06-24T20-48-49-631Z",
  "SolutionMapFilter-trigger-miss-2026-06-24T20-48-52-704Z",
  "MustContain-r2-2026-06-24T11-03-03-697Z",
  "NakedPair-trigger-miss-2026-06-24T20-48-43-486Z",
  "NakedTriple-trigger-miss-2026-06-24T20-48-45-533Z",
  "PointingPairs-trigger-miss-2026-06-24T20-48-46-566Z",
  "PointingPairs-trigger-miss-2026-06-24T20-48-51-692Z",
  "CageConfinement-r2-2026-06-24T11-03-03-709Z",
  "CageConfinement-trigger-miss-2026-06-24T20-48-41-409Z",
  "UnitPartitionFilter-r2-2026-06-24T11-03-03-710Z",
];
