# Feedback Submission Testing — Design

## Background

The user saw a "protocol error" when pressing the feedback submit button on the
**production site** (gbarrett28.github.io, talking to the deployed Cloudflare
worker). "Protocol error" (e.g. Chrome's `ERR_HTTP2_PROTOCOL_ERROR`) is the
classic symptom of a Cloudflare Worker throwing an uncaught exception mid-response
— the connection is torn down instead of returning a clean 4xx/5xx.

The recently-merged serialization work (`PuzzleState.serialize`, commit 623a327)
changed `handleFeedbackSubmit` (`web/src/main.ts`) to attach a full structural
dump of the puzzle state — including the entire `turns` history (each turn
carries a `BoardSnapshot` with a `9×9×N` candidates array) — as `puzzleSpec` in
the feedback payload. This is a much larger and more complex payload than before,
and it flows into `JSON.stringify(r.puzzleSpec, null, 2)` inside
`FeedbackReport.buildIssue` (`shared/src/reports/FeedbackReport.ts`) on the
worker. This is the prime suspect for an uncaught exception.

We cannot reproduce the production error directly (no live worker URL/credentials
in this environment), so the goal is to build test coverage that would catch this
class of bug locally, and to cover **all feedback routes** (all `feedbackType` /
`bugCategory` combinations, and the `new-rule` fixture-context path) end to end.

## Current coverage gaps

- `handleFeedbackSubmit` (`web/src/main.ts:1598-1685`) has **zero** test
  coverage — payload construction, the `workerUrl` dev-fallback branch, and the
  success/non-OK/thrown-fetch branches are all untested.
- `worker/src/index.test.ts` mocks `R2Bucket` entirely with `vi.fn()`. The
  feedback path doesn't use R2 at all (`FeedbackReport.storageKey` returns
  `null`), but the mock means **no test exercises a real R2 binding** anywhere
  in the suite.
- The existing `validFeedback` fixture in `worker/src/index.test.ts` uses
  `puzzleSpec: null` and only covers `feedbackType: 'bug'` with
  `bugCategory: 'wrong-behaviour'`. `enhancement`, `new-rule` (with fixture
  context), and `bugCategory: 'inaccurate-description'` are untested on the
  worker side. `FeedbackReport.buildIssue`'s per-variant branches (title
  prefix, labels, `expectedSection`, `fixtureSection`) are correspondingly
  untested.

## Design

### 1. Frontend: extract `handleFeedbackSubmit`'s payload + submission logic

Extract the payload-building and fetch/error-handling portion of
`handleFeedbackSubmit` into a new testable module,
`web/src/session/feedbackSubmit.ts`, following the existing pattern in
`web/src/image/trainingUpload.ts` (which already reads
`VITE_TRAINING_WORKER_URL` and is unit-tested with `vi.stubEnv` +
`vi.spyOn(globalThis, 'fetch')`).

New exported function:

```ts
export type FeedbackSubmitResult =
  | { readonly kind: 'logged' }     // no worker URL configured (dev fallback)
  | { readonly kind: 'success' }    // res.ok
  | { readonly kind: 'http-error'; readonly status: number; readonly body: string }
  | { readonly kind: 'network-error'; readonly message: string };

export async function submitFeedback(payload: FeedbackReport): Promise<FeedbackSubmitResult>
```

`handleFeedbackSubmit` in `main.ts` keeps all DOM reading (form fields,
`PuzzleState.serialize`, `formatActionLog`, `activeFixtureContext`) and the
payload assembly, then calls `submitFeedback(payload)` and maps the result to
the existing `statusEl`/`submitBtn` UI updates (unchanged user-visible
behaviour). This isolates exactly the part the user clicked — "press submit and
something errors" — into a unit-testable function.

**Tests** (`web/src/session/feedbackSubmit.test.ts`, jsdom not required —
pure fetch wrapper):
- No worker URL configured → returns `{ kind: 'logged' }`, `fetch` not called.
- `fetch` resolves with `res.ok === true` → `{ kind: 'success' }`.
- `fetch` resolves with `res.ok === false` (e.g. 400) → `{ kind: 'http-error', status: 400, body: <text> }`.
- `fetch` rejects (network/protocol error — the case the user hit) →
  `{ kind: 'network-error', message: <String(e)> }`, no throw.

### 2. Worker: real R2 binding via Miniflare + full route coverage

Add `miniflare` as a devDependency of `worker/`. Replace the hand-rolled
`vi.fn()` `R2Bucket` in `worker/src/index.test.ts` with a real R2 binding
obtained from a `Miniflare` instance configured with an in-memory R2 namespace
(`r2Buckets: ['TRAINING_BUCKET']`, no `r2Persist` — ephemeral, so nothing to
clean up between test runs; each test gets a fresh `Miniflare` instance in
`beforeEach` and calls `mf.dispose()` in `afterEach`). This makes `put`/`get`/
`list` exercise the real Workers R2 implementation instead of a mock, for every
existing test that currently uses the mock (training-export, stall, rule-bug,
trigger-miss) as well as the new feedback tests below — "actual R2 storage" with
automatic cleanup via Miniflare's per-test disposal (no shared/persistent state
to leak).

`globalThis.fetch` (the GitHub API call) remains mocked via `vi.spyOn` — we must
not create real GitHub issues from tests.

**New feedback-route tests** (extending the "Feedback path" describe block):

- **All `feedbackType` values**: `bug` (with both `bugCategory` values),
  `enhancement`, `new-rule`. For each, assert the GitHub issue POST body's
  `title`/`labels`/`body` reflect the right branch of
  `FeedbackReport.buildIssue` (label set, `[Bug report]`/`[Enhancement request]`/
  `[Rule suggestion]` prefix, `documentation` label only for
  `inaccurate-description`).
- **`new-rule` with fixture context**: include `fixtureName`, `unsolvedCells`,
  `totalCandidates` in the payload; assert the issue title includes the fixture
  name and the body includes the fixture section.
- **`expected` field** (bug reports): assert `expectedSection` appears in the
  issue body when present, absent when not.
- **`exception` field**: assert `exceptionSection` appears when
  `payload.exception` is set.
- **Realistic large `puzzleSpec`**: build a `PuzzleState.serialize(...)` output
  for a killer puzzle with a non-trivial `turns` history (~20-30 turns, each
  with a full `9×9×N` `BoardSnapshot.candidates`), reusing helpers already
  present in `web/src/session/engine.test.ts` (`makeTrivialSpec`,
  `specToData`, `specToCageStates`, `makeTurn`) — these are in the `web`
  package, so this fixture is constructed inline in the worker test using
  plain literals matching the same shape (no cross-package import). POST this
  through the real worker `fetch` handler and assert:
  - response status is `200`
  - `JSON.stringify` of the resulting GitHub issue body does not throw
    (i.e. the call to `globalThis.fetch` for the GitHub issue happens and its
    body is valid JSON with the full `puzzleSpec` embedded)

This last test is the one most likely to catch the production "protocol error"
class of bug locally: if `buildIssue`/`JSON.stringify` ever throws on a large
real-shaped `puzzleSpec`, the worker's `try { await createGitHubIssue(...) }
catch` would swallow it silently today (returning 200) — but the *test*
constructs the issue body the same way and can assert it directly without going
through the worker's catch, OR (preferred) we additionally assert
`consoleSpy` (console.error) was **not** called for this payload, distinguishing
"succeeded cleanly" from "threw and was swallowed".

## Out of scope

- Reproducing the exact production error against the live deployed worker (no
  credentials/URL available here).
- A full Playwright e2e covering the feedback modal UI — the extracted
  `submitFeedback` unit tests give equivalent coverage of the click → submit →
  status-message path without the cost of a second dev server process.
- Testing against the real (cloud) Cloudflare R2 bucket — Miniflare's R2
  implementation is used as "actual R2 storage" instead, since it requires no
  credentials and has no cleanup burden.
