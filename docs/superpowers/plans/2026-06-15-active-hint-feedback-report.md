# Active Hint Feedback Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feedback bug reports capture the hint that was actively displayed at submission time, both as a timestamped action-log entry and as a structured JSON snapshot in the GitHub issue body.

**Architecture:** Add an optional `activeHint?: unknown` field to `FeedbackReport` (shared package), rendered as a collapsible JSON section in the issue body. Thread it through `buildFeedbackPayload` in `web/src/session/feedbackSubmit.ts`. In `web/src/main.ts`, log a `hint_shown` action whenever a hint is displayed, and pass the currently-active `HintItem` into the feedback payload on submission.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Add `activeHint` field to `FeedbackReport` and render it in the issue body

**Files:**
- Modify: `shared/src/reports/FeedbackReport.ts`
- Test: `web/src/shared-reports.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `web/src/shared-reports.test.ts`, inside a new `describe('FeedbackReport.githubAction', ...)` block placed after the existing `describe('parseAnyReport', ...)` block (after its closing `});` on line 138). First add the import at the top of the file alongside the existing import:

```ts
import { parseAnyReport, assertNeverReport, FeedbackReport } from '../../shared/src/reports/index.js';
```

(replace the existing line 2 import with this one).

Then add the new describe block:

```ts
describe('FeedbackReport.githubAction', () => {
  const feedbackBase = {
    ...base,
    reportType: 'feedback' as const,
    feedbackType: 'bug' as const,
    description: 'Something broke',
    actionLog: 'action1\naction2',
    puzzleSpec: null,
    viewport: '1280x800',
    config: { alwaysApplyRules: [], autoPlacementDelay: 0 },
  };

  it('includes an "Active hint" section with the JSON snapshot when activeHint is set', () => {
    const activeHint = { ruleName: 'HiddenSingle', displayName: 'Hidden Single', explanation: 'x' };
    const report: FeedbackReport = { ...feedbackBase, activeHint };
    const { body } = FeedbackReport.githubAction(report);
    expect(body).toContain('Active hint');
    expect(body).toContain('"ruleName": "HiddenSingle"');
  });

  it('omits the "Active hint" section when activeHint is not set', () => {
    const report: FeedbackReport = { ...feedbackBase };
    const { body } = FeedbackReport.githubAction(report);
    expect(body).not.toContain('Active hint');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/shared-reports.test.ts`
Expected: FAIL — `activeHint` does not exist on type `FeedbackReport` (TS error) and/or the body does not contain "Active hint".

- [ ] **Step 3: Add the `activeHint` field and rendering**

In `shared/src/reports/FeedbackReport.ts`, add the field to the interface (after `totalCandidates`):

```ts
export interface FeedbackReport extends ReportBase {
  readonly reportType: 'feedback';
  readonly feedbackType: 'bug' | 'enhancement' | 'new-rule';
  readonly bugCategory?: 'wrong-behaviour' | 'inaccurate-description';
  readonly description: string;
  readonly expected?: string;
  readonly actionLog: string;
  readonly puzzleSpec: unknown;
  readonly viewport: string;
  readonly config: { readonly alwaysApplyRules: readonly string[]; readonly autoPlacementDelay: number };
  readonly exception?: string;
  readonly fixtureName?: string;
  readonly unsolvedCells?: number;
  readonly totalCandidates?: number;
  readonly activeHint?: unknown;
}
```

In `buildIssue`, add a rendered section for `activeHint` (mirroring the existing `specJson` block for `puzzleSpec`). Add this near the other `const ... = ...` declarations, after `fixtureSection`:

```ts
    const activeHintSection = r.activeHint !== undefined
      ? `\n<details>\n<summary>Active hint</summary>\n\n\`\`\`json\n${JSON.stringify(r.activeHint, null, 2)}\n\`\`\`\n\n</details>\n`
      : '';
```

Then insert `${activeHintSection}` into the template literal, immediately after `${specJson}` and before `### Session trace`:

```ts
${rules}
- Step delay: ${delay}
${specJson}${activeHintSection}
### Session trace
```

(The existing line is `${specJson}\n### Session trace` — change it to `${specJson}${activeHintSection}\n### Session trace`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/shared-reports.test.ts`
Expected: PASS — all tests including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add shared/src/reports/FeedbackReport.ts web/src/shared-reports.test.ts
git commit -m "feat: render active hint snapshot in feedback issue body"
```

---

### Task 2: Thread `activeHint` through `buildFeedbackPayload`

**Files:**
- Modify: `web/src/session/feedbackSubmit.ts`
- Test: `web/src/session/feedbackSubmit.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `web/src/session/feedbackSubmit.test.ts`, inside the existing `describe('buildFeedbackPayload', ...)` block, after the `'includes expected, exception, and fixture-context fields when provided'` test:

```ts
  it('includes activeHint when provided, omits it when not', () => {
    const activeHint = { ruleName: 'HiddenSingle', displayName: 'Hidden Single' };
    const withHint = buildFeedbackPayload({ ...baseParams, activeHint });
    expect(withHint.activeHint).toEqual(activeHint);

    const withoutHint = buildFeedbackPayload(baseParams);
    expect('activeHint' in withoutHint).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session/feedbackSubmit.test.ts`
Expected: FAIL — `activeHint` does not exist on type `FeedbackPayloadParams` (TS error).

- [ ] **Step 3: Add `activeHint` to `FeedbackPayloadParams` and `buildFeedbackPayload`**

In `web/src/session/feedbackSubmit.ts`, add to `FeedbackPayloadParams` (after `fixtureContext`):

```ts
export interface FeedbackPayloadParams {
  readonly feedbackType: 'bug' | 'enhancement' | 'new-rule';
  readonly bugCategory?: 'wrong-behaviour' | 'inaccurate-description';
  readonly description: string;
  readonly expected?: string;
  readonly actionLog: string;
  readonly puzzleSpec: unknown;
  readonly viewport: string;
  readonly config: { readonly alwaysApplyRules: readonly string[]; readonly autoPlacementDelay: number };
  readonly exception?: string;
  readonly fixtureContext?: { readonly name: string; readonly unsolvedCells: number; readonly totalCandidates: number };
  readonly activeHint?: unknown;
  readonly appVersion: string;
  readonly userAgent: string;
}
```

In `buildFeedbackPayload`, add a spread-if-defined entry after the `fixtureContext` spread:

```ts
    ...(params.fixtureContext !== undefined && {
      fixtureName: params.fixtureContext.name,
      unsolvedCells: params.fixtureContext.unsolvedCells,
      totalCandidates: params.fixtureContext.totalCandidates,
    }),
    ...(params.activeHint !== undefined && { activeHint: params.activeHint }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/session/feedbackSubmit.test.ts`
Expected: PASS — all tests including the new one.

- [ ] **Step 5: Commit**

```bash
git add web/src/session/feedbackSubmit.ts web/src/session/feedbackSubmit.test.ts
git commit -m "feat: thread activeHint through buildFeedbackPayload"
```

---

### Task 3: Log `hint_shown` and pass the active hint into the feedback submission

**Files:**
- Modify: `web/src/main.ts`

- [ ] **Step 1: Add the `hint_shown` action-log call**

In `web/src/main.ts`, in `showHintModal` (currently starting at line 982), add a `logAction` call as the first line of the function body:

```ts
function showHintModal(hint: HintItem): void {
  logAction('hint_shown', hint.displayName);
  activeHintItem = hint;
  hintHighlightCells = new Set(hint.highlightCells.map(([r, c]) => `${r},${c}`));
  hintElimCells = new Set(hint.eliminations.map(({ cell: [r, c] }) => `${r},${c}`));
  hintColourGroups = hint.colourGroups ?? [];
  redrawGrid();
  el<HTMLElement>('hint-modal-title').textContent = hint.displayName;
  el<HTMLElement>('hint-modal-explanation').textContent = hint.explanation;
```

(leave the rest of the function unchanged).

- [ ] **Step 2: Pass `activeHintItem` into the feedback payload**

In `web/src/main.ts`, in `handleFeedbackSubmit` (starting at line 1599), the `buildFeedbackPayload` call currently ends with:

```ts
    ...(exceptionForSubmission !== null && { exception: exceptionForSubmission }),
    ...(fixtureCtx !== null && { fixtureContext: fixtureCtx }),
  });
```

Add a new spread entry after `fixtureCtx`:

```ts
    ...(exceptionForSubmission !== null && { exception: exceptionForSubmission }),
    ...(fixtureCtx !== null && { fixtureContext: fixtureCtx }),
    ...(activeHintItem !== null && { activeHint: activeHintItem }),
  });
```

- [ ] **Step 3: Run the bronze gate**

Run: `bash scripts/run-bronze-gate.sh`
Expected: `tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, and `npm test` all pass, producing `.bronze-gate-ok`.

- [ ] **Step 4: Commit**

```bash
git add web/src/main.ts
git commit -m "feat: log hint_shown and include active hint in feedback reports"
```

---

### Task 4: Update architecture docs and clean up spec

**Files:**
- Modify: `docs/architecture.md`
- Delete: `docs/superpowers/specs/2026-06-15-active-hint-feedback-report-design.md`
- Delete: `docs/superpowers/plans/2026-06-15-active-hint-feedback-report.md` (this file, once all steps above are checked off)

- [ ] **Step 1: Document the feedback report's active-hint capture**

Open `docs/architecture.md` and find the section documenting the feedback/bug-report mechanism (search for "FeedbackReport" or "feedback report"). Add a short paragraph describing:
- `showHintModal` logs a `hint_shown` action-log entry (rule display name) whenever a hint is shown.
- `FeedbackReport.activeHint`, when present, holds the full `HintItem` that was displayed at submission time, rendered as a JSON "Active hint" section in the GitHub issue.

Use the existing doc's style and level of detail for the surrounding feedback-report description — match its phrasing/structure rather than introducing a new format.

- [ ] **Step 2: Run the bronze gate**

Run: `bash scripts/run-bronze-gate.sh`
Expected: all checks pass (doc-only change plus the already-passing code from Tasks 1-3).

- [ ] **Step 3: Delete the spec file and commit docs + spec deletion**

```bash
git rm docs/superpowers/specs/2026-06-15-active-hint-feedback-report-design.md
git add docs/architecture.md
git commit -m "docs: document active-hint capture in feedback reports"
```

- [ ] **Step 4: Delete this plan file**

Once every checkbox above (including this one) is checked, delete this plan file as part of the final commit before merge:

```bash
git rm docs/superpowers/plans/2026-06-15-active-hint-feedback-report.md
git commit -m "chore: remove completed plan"
```
