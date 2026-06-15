# Robust rule-bug fixture sync — design

## Problem

The nightly "Sync rule-bug fixtures" workflow (`.github/workflows/rule-regression.yml`)
fails far more often than it succeeds — 10 of the last 14 scheduled runs failed.

**Root cause:** the workflow fetches new fixtures from the live training worker,
writes them into `web/src/engine/rules/__fixtures__/index.ts`, then gates the
commit/push on the full bronze gate (`tsc` + `npm test`). `npm test` includes
`regression.test.ts`, which runs *each fixture's own rule* against it and asserts
no golden-contradicting elimination. But a freshly-reported fixture is, by
definition, a case where a rule may currently be producing a wrong elimination —
that's the whole point of capturing it. If even one newly-fetched fixture fails
its own regression test, the entire job fails, the commit/push step never runs,
and the new fixtures are never persisted to `index.ts`.

Worse: the R2 bucket backing the training worker has **no deletion path** for
`rule-fixtures/<ruleName>/*` objects. A report sits there forever. So:

1. A fixture (`SolutionMapFilter-r2-2026-05-29T07-06-49-234Z`) was investigated,
   found unactionable (pre-existing candidate corruption not traceable from the
   fixture data), and removed from `index.ts` (commit `ed24ec0e`).
2. The very next nightly sync re-fetched the *same* fixture from R2 (it was
   never in `seenFingerprints` again because it's no longer in `index.ts`),
   re-added it to the working tree's `index.ts`, `npm test` failed on it again,
   and the whole job went red — permanently, every night, forever.

## Design

### Flow

1. `GET /rule-fixtures/:ruleName` on the training worker returns
   `{ key: string; fixture: RuleBugFixture }[]` instead of bare fixture bodies —
   exposing each fixture's R2 object key alongside its content. This is a
   read-only, non-sensitive addition; no new auth.
2. `sync-rule-fixtures.ts` fetches `{key, fixture}[]` per rule, dedupes by
   `fixtureFingerprint` as today.
3. **Every newly-seen fixture** is unconditionally:
   - appended to `web/src/engine/rules/__fixtures__/index.ts` (as today), and
   - its `name` appended to a new `web/src/engine/rules/__fixtures__/needs-triage.ts`.

   No test-running or pass/fail check happens in the sync script — everything
   new is marked "needs triage" by default.
4. `regression.test.ts`'s skip condition gains
   `|| NEEDS_TRIAGE_FIXTURES.includes(fixture.name)`, so newly-synced fixtures
   never fail the bronze gate regardless of whether their rule currently has a
   bug.
5. The sync script also writes a manifest of **every key fetched this run**
   (both newly-added and already-deduplicated-as-existing) to
   `/tmp/rule-fixture-keys.txt`, one per line.
6. Bronze gate runs (now always passes for fixture-related reasons) → commit +
   push `index.ts` and `needs-triage.ts`.
7. **Only if the commit/push step succeeds**, a new workflow step drains R2:
   `pip install boto3` then
   `python3 scripts/_r2_delete.py cagedoku-training < /tmp/rule-fixture-keys.txt`,
   using the existing `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` secrets (same
   pattern as `retrain.yml`/`puzzle-spec-review.yml`). This also sweeps out any
   fixtures already duplicated in `index.ts` from before this change — draining
   the existing R2 backlog on the first successful run.
8. Periodically, a human reviews `needs-triage.ts`:
   - if the fixture's rule now passes (no violation), remove its name from
     `needs-triage.ts` — it becomes a live regression test.
   - if there's a real, still-open rule bug worth tracking, move it to
     `KNOWN_FAILING_FIXTURES` with an explanatory comment.
   - if unactionable, delete the fixture entry from `index.ts` entirely and
     remove its name from `needs-triage.ts`. Since its R2 copy was already
     deleted, it cannot resurface.

No new secrets, no new worker auth, no Cloudflare Worker secret provisioning
required.

### Components

- **`worker/src/index.ts`**: `GET /rule-fixtures/:ruleName` handler — wrap each
  listed object as `{ key: obj.key, fixture: <parsed JSON> }`. Update
  `worker/src/index.test.ts` to match the new response shape.
- **`shared/src/fixture.ts`**: add
  ```ts
  export interface FixtureRecord {
    readonly key: string;
    readonly fixture: RuleBugFixture;
  }
  ```
  `fixtureFingerprint` and `fixtureToTypeScript` continue to take a
  `RuleBugFixture` (called on `.fixture`).
- **`web/src/engine/rules/__fixtures__/needs-triage.ts`** (new):
  ```ts
  /**
   * Fixture names freshly synced from R2, not yet reviewed by a human.
   * Populated automatically by `sync-rule-fixtures.ts`. During periodic
   * review: remove an entry if its fixture now passes, move it to
   * `KNOWN_FAILING_FIXTURES` (regression.test.ts) if there's a tracked open
   * bug, or delete the fixture from `index.ts` entirely if unactionable.
   */
  export const NEEDS_TRIAGE_FIXTURES: readonly string[] = [];
  ```
- **`web/src/engine/rules/__fixtures__/regression.test.ts`**: import
  `NEEDS_TRIAGE_FIXTURES`; skip condition becomes
  `!rule || DISABLED_RULES.includes(...) || KNOWN_FAILING_FIXTURES.includes(...) || NEEDS_TRIAGE_FIXTURES.includes(...)`.
- **`web/scripts/sync-rule-fixtures.ts`**:
  - `fetchFixturesForRule` returns `FixtureRecord[]`.
  - Track all fetched keys (new + duplicate) across all rules into a flat
    array; write to `/tmp/rule-fixture-keys.txt` (one key per line) at the end,
    unconditionally (even if `newFixtures.length === 0`, as long as any
    fixtures were fetched at all — to drain pre-existing duplicates).
  - For each new fixture, append to `index.ts` (as today) and append
    `fixture.name` to `needs-triage.ts` (same insert-before-`];` technique).
- **`.github/workflows/rule-regression.yml`**:
  - "Bronze gate" step unchanged.
  - "Commit and push" step gets an `id` so later steps can check its outcome.
  - New step `Drain synced fixtures from R2`, `if: success()` after commit/push,
    with `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` env, `actions/setup-python`,
    `pip install boto3`, then runs `_r2_delete.py` against
    `/tmp/rule-fixture-keys.txt` (skip if the file is empty/absent).

### Edge cases

- **No fixtures fetched at all** (worker returns empty for every rule): manifest
  file is empty or absent; drain step is a no-op.
- **Bronze gate fails for unrelated reasons** (pre-existing `tsc`/test failure
  on master, independent of fixtures): commit/push step doesn't run (or the job
  fails before it), so the drain step (`if: success()`) doesn't run either —
  nothing is deleted from R2, fixtures remain available for the next run.
- **`git diff --cached --quiet` finds nothing to commit** (e.g. fixtures fetched
  were all duplicates already in `index.ts`, and `needs-triage.ts` unchanged):
  the existing "Nothing to commit." branch still counts as success for the
  commit step, so the drain step still runs and cleans up the duplicates.

## Testing

- `worker/src/index.test.ts`: update GET assertions for the new `{key, fixture}`
  response shape.
- `shared/src/fixture.ts` tests (if any): cover `FixtureRecord` type usage.
- `sync-rule-fixtures.ts` has no existing unit tests (it's a CI-only script);
  manual verification via the workflow's `workflow_dispatch` trigger after merge.
- `regression.test.ts`: add a small fixture entry to `NEEDS_TRIAGE_FIXTURES` in
  a test (or verify via the existing empty-array case) that a fixture listed
  there is skipped regardless of its violations.
