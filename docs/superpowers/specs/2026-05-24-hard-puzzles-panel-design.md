# Hard Puzzles Panel — Design Spec

**Date:** 2026-05-24
**Status:** Approved

## Overview

Expose the stall fixture corpus to all users as a "Hard Puzzles" panel, accessible via a 🔥 button in the header. Users can load any fixture directly into the solver. A "Rule suggestion" feedback type lets users report rule ideas through the existing Cloudflare Worker pipeline, with the fixture reference captured automatically.

---

## Sub-project 1: Static serving in production

### Problem

The stall fixtures currently live in `web/stall-fixtures/` and are served only by the Vite dev middleware (`apply: 'serve'`). They are absent from the production build.

### Solution

Remove `apply: 'serve'` from `stallFixturesPlugin` in `vite.config.ts`. Add a `generateBundle` Rollup hook that emits two kinds of assets into `dist/`:

- `stall-fixtures/index.json` — sorted metadata array (all `StallFixtureFile` fields except `spec` and `stalledCandidates`), sorted by `(unsolvedCells ASC, totalCandidates ASC)`
- `stall-fixtures/<name>.stall.json` — full fixture JSON for each fixture

The dev middleware is updated to serve the same URL scheme:
- `GET /stall-fixtures/index.json` — metadata list
- `GET /stall-fixtures/:name.stall.json` — full fixture

All fetch calls in `main.ts` use relative URLs (`./stall-fixtures/index.json`, `./stall-fixtures/${name}.stall.json`) so they resolve correctly at any GitHub Pages subpath.

### What changes

| File | Change |
|---|---|
| `web/vite.config.ts` | Drop `apply: 'serve'`; add `generateBundle` hook; update middleware URLs |
| `web/src/main.ts` | Update fetch URLs from `/dev/stall-fixtures` to `./stall-fixtures/…` |

---

## Sub-project 2: Home screen 🔥 toggle

### UI

A 🔥 button is added to the header alongside the existing help / config / feedback buttons. It toggles between two mutually exclusive views:

- **Upload view** (default): the existing `#upload-panel`
- **Fixture view**: a new `#fixture-panel` containing the fixture list table

Pressing 🔥 when in upload view switches to fixture view. Pressing 🔥 again (or any action that starts a new puzzle via the normal pipeline) returns to upload view.

### Fixture panel

- Fetches `./stall-fixtures/index.json` on first open; result is cached in memory for the session
- Table columns: Name | Unsolved cells | Total candidates | Source
- Sorted by `(unsolvedCells ASC, totalCandidates ASC)` (already sorted in `index.json`)
- Clicking a row:
  1. Fetches `./stall-fixtures/${name}.stall.json`
  2. Calls `loadSpecDirect(fixture.spec)`
  3. Sets `currentFixtureName`, `currentFixtureUnsolvedCells`, `currentFixtureTotalCandidates`
  4. Transitions to the solution screen (existing playing-mode flow)

### Fixture state

Three module-level variables track the active fixture:

```ts
let currentFixtureName: string | null = null;
let currentFixtureUnsolvedCells: number | null = null;
let currentFixtureTotalCandidates: number | null = null;
```

All three are set together when a fixture row is clicked and cleared to `null` when any puzzle is loaded via the normal image pipeline (`handleProcess`).

### What changes

| File | Change |
|---|---|
| `web/index.html` | Add 🔥 button to header; add `#fixture-panel` section (hidden by default) |
| `web/src/main.ts` | Toggle logic; fixture fetch + load; state variables; clear on normal load |

---

## Sub-project 3: "Rule suggestion" feedback type

### Modal change

A third radio option is added to the existing feedback modal:

```html
<label><input type="radio" name="feedback-type" id="feedback-type-new-rule" value="new-rule"> Rule suggestion</label>
```

When selected:
- Bug-specific fields (`#feedback-bug-fields`) are hidden — same behaviour as Enhancement
- Description label changes to *"Describe the rule you think would unlock this puzzle"*
- If `currentFixtureName` is non-null, a fixture reference block is silently included in the submission payload

Submission is identical to bug/enhancement: same "Send feedback" button, same `handleFeedbackSubmit` function, same POST to the Cloudflare Worker.

### Payload changes

`FeedbackReport` (version 3) gains three optional fields:

```ts
fixtureName?: string;
unsolvedCells?: number;
totalCandidates?: number;
```

These are populated from `currentFixtureName / currentFixtureUnsolvedCells / currentFixtureTotalCandidates` when the type is `'new-rule'` and a fixture is active. They are omitted otherwise.

### Worker changes

**`worker/src/validate.ts`**

- `FeedbackReport.feedbackType` becomes `'bug' | 'enhancement' | 'new-rule'`
- Add optional `fixtureName?: string`, `unsolvedCells?: number`, `totalCandidates?: number`
- `isFeedbackReport` updated to accept `'new-rule'` and to validate the optional fields when present

**`worker/src/index.ts`** — `createFeedbackIssue`:

- Label list: `'new-rule'` type → labels include `'feedback'` and `'new-rule'`  (instead of `'enhancement'`)
- Title format for `'new-rule'`: `[Rule suggestion] <fixtureName>: <snippet>` when fixture present; `[Rule suggestion] <snippet>` otherwise
- Issue body: when `fixtureName` is present, a fixture reference block is prepended:

  ```
  **Fixture:** `<fixtureName>`
  **Unsolved cells:** <N>
  **Total candidates:** <N>
  ```

- Bug-specific sections (category line, expected behaviour, exception) are omitted for `'new-rule'`
- Session trace and config sections are retained (useful context for developers)

The worker must be redeployed after changes (`wrangler deploy` from `worker/`).

### What changes

| File | Change |
|---|---|
| `web/index.html` | Add `feedback-type-new-rule` radio; add `feedback-type-new-rule` change handler target |
| `web/src/main.ts` | Handle new radio in change listeners; include fixture fields in payload when active |
| `worker/src/validate.ts` | Expand `FeedbackReport` type and `isFeedbackReport` validator |
| `worker/src/index.ts` | Handle `'new-rule'` in `createFeedbackIssue` |

---

## Implementation Order

1. Static serving (Sub-project 1) — self-contained Vite config change; unblocks the panel
2. Home screen toggle (Sub-project 2) — depends on Sub-project 1 (needs `./stall-fixtures/index.json`)
3. Rule suggestion feedback (Sub-project 3) — independent of 1 and 2; can be done in parallel, but logically follows the panel

---

## Out of scope

- Filtering or searching the fixture list
- Showing fixture details (candidate grid) before loading
- User accounts or personalisation
