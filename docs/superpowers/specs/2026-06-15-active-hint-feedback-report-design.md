# Active Hint Capture in Feedback Reports

## Problem

`FeedbackReport` (the GitHub issue opened when a user submits in-app feedback)
does not capture which hint was on screen at submission time. The currently
displayed hint (`activeHintItem` in `web/src/main.ts`) is transient UI state —
it is never written into `PuzzleState`, never logged to the action log, and
never serialized into the feedback payload.

This makes "the hint shown right now is wrong" reports ambiguous: with no
turns played (fresh-board / just-confirmed sessions), the report contains only
the static board state and the user's free-text description — there is no
structured record of which rule, cells, or eliminations the hint referred to.

Example: issue #153 ("hidden single rule hint not clear") was submitted with
an empty turn history and a hint actively displayed, but the report contains
no information identifying that hint.

## Design

### 1. Action-log entry (`web/src/main.ts`)

`showHintModal(hint: HintItem)` calls:

```ts
logAction('hint_shown', hint.displayName);
```

This mirrors the existing `logAction('hint_applied', hint.displayName)` call
(main.ts:2377). It appears in the session-trace timeline rendered in the
GitHub issue body, giving timing context (when the hint appeared relative to
other events).

No de-duplication — re-opening the same hint (e.g. via "show again") logs
another `hint_shown` entry. This is consistent with how other repeated actions
(e.g. `cell_entered`) are logged.

### 2. Structured snapshot field (`shared/src/reports/FeedbackReport.ts`)

Add a new optional field to `FeedbackReport`:

```ts
readonly activeHint?: unknown;
```

Typed `unknown` (not `HintItem`) to keep `shared/` independent of `web/`
types — same pattern as `puzzleSpec: unknown`.

`FeedbackReport.is()` type guard: no new validation beyond "if present, no
type constraint" (matches the existing `puzzleSpec` field, which is also
unchecked).

`buildIssue()` renders the field, when present, as a collapsible JSON section
in the issue body, immediately after the puzzle-spec section and before
"### Session trace":

```md
<details>
<summary>Active hint</summary>

```json
{ ...HintItem fields... }
```

</details>
```

When `activeHint` is absent, this section is omitted entirely (no empty
`<details>` block).

### 3. Wiring (`web/src/session/feedbackSubmit.ts`, `web/src/main.ts`)

- `FeedbackPayloadParams` gains `readonly activeHint?: unknown`.
- `buildFeedbackPayload` passes it through using the existing
  spread-if-defined pattern (`...(params.activeHint !== undefined && { activeHint: params.activeHint })`),
  so the field is omitted entirely from the payload when not provided.
- `handleFeedbackSubmit` (main.ts:1629) passes
  `...(activeHintItem !== null && { activeHint: activeHintItem })`.

## Testing

- `web/src/session/feedbackSubmit.test.ts`: `buildFeedbackPayload` includes
  `activeHint` when provided in params, and the field is absent (`'activeHint' in payload === false`)
  when not provided.
- New test for `FeedbackReport.githubAction`/`buildIssue` (in
  `web/src/shared-reports.test.ts` or a new `FeedbackReport.test.ts`):
  - issue body contains an "Active hint" `<details>` section with the JSON
    when `activeHint` is set.
  - issue body omits the "Active hint" section when `activeHint` is absent.

No new tests are needed for the `hint_shown` action-log entry beyond what's
already exercised by existing flows — `formatActionLog()` is generic over
event names, and there is no existing unit test asserting on `showHintModal`'s
action-log side effects (the existing `hint_applied` call has none either).

## Out of scope

- No changes to `HintItem`, `PuzzleState`, or how hints are computed/displayed.
- No de-duplication or filtering of repeated `hint_shown` log entries.
- No changes to the worker's issue-creation flow beyond the new body section
  (labels, title logic unchanged).
