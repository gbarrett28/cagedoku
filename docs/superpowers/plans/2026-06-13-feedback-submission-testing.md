# Feedback Submission Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix the production bug where every feedback submission fails with `400: Bad request: unrecognised schema` (missing `reportType: 'feedback'`), and add test coverage for the whole feedback-submission path — frontend payload construction/submission and worker route handling for every `feedbackType`/`bugCategory` combination — using a real (Miniflare) R2 binding instead of hand-rolled mocks.

**Architecture:** Extract a new `web/src/session/feedbackSubmit.ts` module with two pure/testable pieces: `buildFeedbackPayload()` (constructs a correctly-typed `FeedbackReport`, fixing the missing `reportType`) and `submitFeedback()` (the fetch/error-handling wrapper, mirroring `trainingUpload.ts`'s pattern). `main.ts`'s `handleFeedbackSubmit` becomes a thin DOM-reading caller. On the worker side, replace the `vi.fn()` R2Bucket mock in `worker/src/index.test.ts` with a real R2 binding from `miniflare`, and add tests covering every feedback route variant plus a realistic large `puzzleSpec`.

**Tech Stack:** TypeScript, Vitest, Miniflare (Cloudflare Workers local R2 emulation).

---

### Task 1: Create `feedbackSubmit.ts` with `buildFeedbackPayload` and `submitFeedback`

**Files:**
- Create: `web/src/session/feedbackSubmit.ts`
- Create: `web/src/session/feedbackSubmit.test.ts`

- [x] **Step 1: Write the failing test file**

Create `web/src/session/feedbackSubmit.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildFeedbackPayload, submitFeedback } from './feedbackSubmit.js';
import type { FeedbackPayloadParams } from './feedbackSubmit.js';
import { parseAnyReport } from '../../../shared/src/reports/index.js';

const baseParams: FeedbackPayloadParams = {
  feedbackType: 'bug',
  bugCategory: 'wrong-behaviour',
  description: 'The hint was incorrect',
  actionLog: 'load\nhint',
  puzzleSpec: null,
  viewport: '1280x800',
  config: { alwaysApplyRules: [], autoPlacementDelay: 0 },
  appVersion: '2026-06-13 10:00',
  userAgent: 'test-agent',
};

describe('buildFeedbackPayload', () => {
  it.each<[string, FeedbackPayloadParams]>([
    ['bug / wrong-behaviour', { ...baseParams, feedbackType: 'bug', bugCategory: 'wrong-behaviour' }],
    ['bug / inaccurate-description', { ...baseParams, feedbackType: 'bug', bugCategory: 'inaccurate-description' }],
    ['enhancement', (() => { const { bugCategory: _b, ...rest } = baseParams; return { ...rest, feedbackType: 'enhancement' as const }; })()],
    ['new-rule', (() => { const { bugCategory: _b, ...rest } = baseParams; return { ...rest, feedbackType: 'new-rule' as const }; })()],
  ])('produces a payload parseAnyReport recognises as feedback (%s)', (_label, params) => {
    const payload = buildFeedbackPayload(params);
    const parsed = parseAnyReport(payload);
    expect(parsed?.reportType).toBe('feedback');
  });

  it('omits optional fields entirely when not provided', () => {
    const { bugCategory: _b, ...rest } = baseParams;
    const payload = buildFeedbackPayload({ ...rest, feedbackType: 'enhancement' });
    expect('bugCategory' in payload).toBe(false);
    expect('expected' in payload).toBe(false);
    expect('exception' in payload).toBe(false);
    expect('fixtureName' in payload).toBe(false);
    expect('unsolvedCells' in payload).toBe(false);
    expect('totalCandidates' in payload).toBe(false);
  });

  it('includes expected, exception, and fixture-context fields when provided', () => {
    const payload = buildFeedbackPayload({
      ...baseParams,
      expected: 'The hint should say X',
      exception: 'TypeError: boom',
      fixtureContext: { name: 'TwoStringKite-1', unsolvedCells: 12, totalCandidates: 34 },
    });
    expect(payload.expected).toBe('The hint should say X');
    expect(payload.exception).toBe('TypeError: boom');
    expect(payload.fixtureName).toBe('TwoStringKite-1');
    expect(payload.unsolvedCells).toBe(12);
    expect(payload.totalCandidates).toBe(34);
  });
});

describe('submitFeedback', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('returns { kind: "logged" } and does not call fetch when no worker URL is configured', async () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await submitFeedback(buildFeedbackPayload(baseParams));

    expect(result).toEqual({ kind: 'logged' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns { kind: "success" } when fetch resolves ok', async () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://worker.example.com');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK', { status: 200 }));

    const result = await submitFeedback(buildFeedbackPayload(baseParams));

    expect(result).toEqual({ kind: 'success' });
  });

  it('returns { kind: "http-error" } with status and body when fetch resolves not-ok', async () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://worker.example.com');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Bad request: unrecognised schema', { status: 400 }),
    );

    const result = await submitFeedback(buildFeedbackPayload(baseParams));

    expect(result).toEqual({ kind: 'http-error', status: 400, body: 'Bad request: unrecognised schema' });
  });

  it('returns { kind: "network-error" } when fetch rejects', async () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://worker.example.com');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await submitFeedback(buildFeedbackPayload(baseParams));

    expect(result.kind).toBe('network-error');
    expect((result as { kind: 'network-error'; message: string }).message).toContain('Failed to fetch');
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/session/feedbackSubmit.test.ts`
Expected: FAIL — `Cannot find module './feedbackSubmit.js'` (or similar resolution error), since the module doesn't exist yet.

- [x] **Step 3: Implement `feedbackSubmit.ts`**

Create `web/src/session/feedbackSubmit.ts`:

```typescript
import type { FeedbackReport } from '../../../shared/src/reports/FeedbackReport.js';

export type { FeedbackReport } from '../../../shared/src/reports/FeedbackReport.js';

// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

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
  readonly appVersion: string;
  readonly userAgent: string;
}

/** Builds a `FeedbackReport` ready to POST to the training worker. */
export function buildFeedbackPayload(params: FeedbackPayloadParams): FeedbackReport {
  return {
    reportType: 'feedback',
    reportedAt: new Date().toISOString(),
    appVersion: params.appVersion,
    userAgent: params.userAgent,
    feedbackType: params.feedbackType,
    description: params.description,
    actionLog: params.actionLog,
    puzzleSpec: params.puzzleSpec,
    viewport: params.viewport,
    config: params.config,
    ...(params.bugCategory !== undefined && { bugCategory: params.bugCategory }),
    ...(params.expected !== undefined && { expected: params.expected }),
    ...(params.exception !== undefined && { exception: params.exception }),
    ...(params.fixtureContext !== undefined && {
      fixtureName: params.fixtureContext.name,
      unsolvedCells: params.fixtureContext.unsolvedCells,
      totalCandidates: params.fixtureContext.totalCandidates,
    }),
  };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export type FeedbackSubmitResult =
  | { readonly kind: 'logged' }
  | { readonly kind: 'success' }
  | { readonly kind: 'http-error'; readonly status: number; readonly body: string }
  | { readonly kind: 'network-error'; readonly message: string };

/** POSTs a feedback payload to the training worker. Falls back to logging to
 *  the console when no worker URL is configured (dev). */
export async function submitFeedback(payload: FeedbackReport): Promise<FeedbackSubmitResult> {
  const workerUrl = import.meta.env['VITE_TRAINING_WORKER_URL'] as string | undefined;
  if (!workerUrl) {
    console.log('[Feedback]', payload);
    return { kind: 'logged' };
  }

  try {
    const res = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { kind: 'success' };
    const body = await res.text();
    return { kind: 'http-error', status: res.status, body };
  } catch (e) {
    return { kind: 'network-error', message: String(e) };
  }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/session/feedbackSubmit.test.ts`
Expected: PASS — all `buildFeedbackPayload` and `submitFeedback` tests green, including the `parseAnyReport(...)?.reportType === 'feedback'` regression checks.

- [x] **Step 5: Commit**

```bash
git add web/src/session/feedbackSubmit.ts web/src/session/feedbackSubmit.test.ts
git commit -m "feat: add feedbackSubmit module with reportType fix and tests"
```

---

### Task 2: Refactor `handleFeedbackSubmit` in `main.ts` to use the new module

**Files:**
- Modify: `web/src/main.ts:1598-1685`

- [x] **Step 1: Add the import**

In `web/src/main.ts`, add to the import section (near the other `./session/...` imports, e.g. after the `loadSettings` import on line 11):

```typescript
import { buildFeedbackPayload, submitFeedback } from './session/feedbackSubmit.js';
```

- [x] **Step 2: Replace the body of `handleFeedbackSubmit`**

Replace lines 1598-1685 (the entire `handleFeedbackSubmit` function) with:

```typescript
async function handleFeedbackSubmit(): Promise<void> {
  const description = el<HTMLTextAreaElement>('feedback-description').value.trim();
  if (!description) {
    el<HTMLElement>('feedback-status').textContent = 'Please enter a description.';
    el<HTMLTextAreaElement>('feedback-description').focus();
    return;
  }

  const isBug = el<HTMLInputElement>('feedback-type-bug').checked;
  const isNewRule = el<HTMLInputElement>('feedback-type-new-rule').checked;
  const feedbackType: 'bug' | 'enhancement' | 'new-rule' = isBug ? 'bug' : isNewRule ? 'new-rule' : 'enhancement';
  const bugCategory = isBug
    ? (el<HTMLInputElement>('bug-cat-wrong').checked ? 'wrong-behaviour' : 'inaccurate-description')
    : undefined;
  const expected = isBug ? el<HTMLTextAreaElement>('feedback-expected').value.trim() || undefined : undefined;

  const puzzleSpec = currentState !== null
    ? {
        ...PuzzleState.serialize(currentState),
        originalImageUrl: null,
        ...(PuzzleState.isKiller(currentState) ? { warpedImageUrl: null } : {}),
      }
    : null;

  const settings = loadSettings();

  // When a fixture is active and the user is filing a rule suggestion, attach
  // the fixture reference so it lands in the GitHub issue body.
  const fixtureCtx = isNewRule ? activeFixtureContext() : null;

  const payload = buildFeedbackPayload({
    feedbackType,
    description,
    actionLog: formatActionLog(),
    puzzleSpec,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    config: { alwaysApplyRules: settings.alwaysApplyRules, autoPlacementDelay: settings.autoPlacementDelay },
    appVersion: __BUILD_TIME__,
    userAgent: navigator.userAgent,
    ...(bugCategory !== undefined && { bugCategory }),
    ...(expected !== undefined && { expected }),
    ...(exceptionForSubmission !== null && { exception: exceptionForSubmission }),
    ...(fixtureCtx !== null && { fixtureContext: fixtureCtx }),
  });

  const statusEl = el<HTMLElement>('feedback-status');
  const submitBtn = el<HTMLButtonElement>('feedback-submit-btn');
  submitBtn.disabled = true;
  statusEl.textContent = 'Sending…';
  statusEl.className = 'status';

  const result = await submitFeedback(payload);
  switch (result.kind) {
    case 'logged':
      statusEl.textContent = 'Feedback logged to console (no worker URL configured).';
      break;
    case 'success':
      exceptionForSubmission = null;
      statusEl.textContent = 'Thank you — feedback submitted.';
      setTimeout(() => { el<HTMLDialogElement>('feedback-modal').close(); }, 1500);
      break;
    case 'http-error':
      statusEl.textContent = `Submission failed (${result.status}): ${result.body}`;
      statusEl.className = 'status error';
      break;
    case 'network-error':
      statusEl.textContent = `Submission failed: ${result.message}`;
      statusEl.className = 'status error';
      break;
  }
  submitBtn.disabled = false;
}
```

- [x] **Step 3: Run TypeScript checks**

Run: `cd web && npx tsc --noEmit`
Expected: no errors. (If `bugCategory`/`expected`/`exceptionForSubmission`/`fixtureCtx` spreads cause an `exactOptionalPropertyTypes` complaint, double-check each uses the `...(cond && { key: value })` form — this matches the pattern already used elsewhere in `main.ts` for `fixtureCtx`.)

- [x] **Step 4: Run the full unit test suite**

Run: `cd web && npx vitest run`
Expected: all tests pass (no existing test directly exercises `handleFeedbackSubmit`, so this just confirms nothing else broke).

- [x] **Step 5: Manually verify in the browser**

Run: `cd web && npm run dev -- --port 5175` (if not already running), open the app, click the feedback (✉) button, type a description, and submit. With no `VITE_TRAINING_WORKER_URL` configured, the status should read "Feedback logged to console (no worker URL configured)." — same as before the refactor. Check the browser console: the logged `[Feedback]` payload object must now include `reportType: 'feedback'`.

- [x] **Step 6: Commit**

```bash
git add web/src/main.ts
git commit -m "fix: use feedbackSubmit module in handleFeedbackSubmit (adds missing reportType)"
```

---

### Task 3: Replace the worker's mocked R2Bucket with a real Miniflare binding

**Files:**
- Modify: `worker/package.json`
- Modify: `worker/src/index.test.ts`

- [x] **Step 1: Add `miniflare` as a devDependency**

Run:
```bash
cd worker && npm install --save-dev miniflare
```
Expected: `worker/package.json` gains `"miniflare": "^4.x.x"` under `devDependencies`, and `worker/package-lock.json` is updated.

- [x] **Step 2: Replace the `makeEnv` helper to use a real R2 binding**

In `worker/src/index.test.ts`, replace the imports (lines 1-3) and `makeEnv` helper (lines 9-22):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import worker from './index.js';
import type { Env } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mf: Miniflare;

function makeEnv(overrides: Partial<Env> = {}): Promise<Env> {
  return mf.getR2Bucket('TRAINING_BUCKET').then((bucket) => ({
    TRAINING_BUCKET: bucket,
    GITHUB_TOKEN: 'fake-token',
    GITHUB_REPO: 'test/repo',
    GITHUB_ISSUE_NUMBER: '1',
    MAX_PENDING_UPLOADS: '50',
    ENVIRONMENT: 'development',
    ...overrides,
  }));
}
```

- [x] **Step 3: Add Miniflare lifecycle hooks inside the top-level `describe` block**

In `worker/src/index.test.ts`, inside `describe('Worker fetch handler', () => { ... })`, replace the existing `beforeEach`/`afterEach` (lines 81-87):

```typescript
describe('Worker fetch handler', () => {
  beforeEach(() => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("unused"); } };',
      r2Buckets: ['TRAINING_BUCKET'],
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 201 }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await mf.dispose();
  });
```

- [x] **Step 4: Update every call site that builds `env` via `makeEnv()` to `await` it**

`makeEnv` is now async. In `worker/src/index.test.ts`, every `const env = makeEnv(...)` becomes `const env = await makeEnv(...)`, and every inline `makeEnv(...)` passed directly to `worker.fetch(req, makeEnv())` becomes `worker.fetch(req, await makeEnv())`. The affected lines (by their current line numbers, all inside `it(...)` callbacks which are already `async`):

- Line 92: `worker.fetch(makeRequest({ method: 'GET' }), makeEnv())` → `worker.fetch(makeRequest({ method: 'GET' }), await makeEnv())`
- Line 117-118: `makeRequest({ method: 'OPTIONS', origin: 'https://gbarrett28.github.io' }), makeEnv(),` → `..., await makeEnv(),`
- Line 126-127: `makeEnv({ ENVIRONMENT: 'production' })` → `await makeEnv({ ENVIRONMENT: 'production' })`
- Line 134: `makeEnv({ ENVIRONMENT: 'production' })` → `await makeEnv({ ENVIRONMENT: 'production' })`
- Line 145: `makeEnv()` → `await makeEnv()`
- Line 157: `makeEnv()` → `await makeEnv()`
- Line 165: `makeEnv()` → `await makeEnv()`
- Line 189: `const env = makeEnv();` → `const env = await makeEnv();`
- Line 212: `const env = makeEnv();` → `const env = await makeEnv();`
- Line 231: `makeEnv({ ENVIRONMENT: 'production' })` → `await makeEnv({ ENVIRONMENT: 'production' })`
- Line 240: `const env = makeEnv();` → `const env = await makeEnv();`
- Line 265-267: `makeEnv(),` → `await makeEnv(),`
- Line 281: `makeEnv(),` → `await makeEnv(),`
- Line 296: `makeEnv(),` → `await makeEnv(),`

- [x] **Step 5: Rewrite the `GET /rule-fixtures/:ruleName` test to use the real bucket**

Replace the test at lines 96-110:

```typescript
  it('GET /rule-fixtures/:ruleName returns 200 with JSON array', async () => {
    const env = await makeEnv();
    await env.TRAINING_BUCKET.put('rule-fixtures/TwoStringKite/fix-1.json', JSON.stringify({ name: 'fix-1' }));

    const req = new Request('https://worker.example.com/rule-fixtures/TwoStringKite', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({ name: 'fix-1' });
  });
```

- [x] **Step 6: Rewrite the "429 when pending upload count is at the cap" test**

Replace the test at lines 171-184:

```typescript
  it('returns 429 when pending upload count is at the cap', async () => {
    const env = await makeEnv({ MAX_PENDING_UPLOADS: '2' });
    await env.TRAINING_BUCKET.put('training/existing-1.json', 'x');
    await env.TRAINING_BUCKET.put('training/existing-2.json', 'x');

    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validExport }),
      env,
    );
    expect(res.status).toBe(429);
  });
```

- [x] **Step 7: Rewrite the "stores payload in R2 and posts GitHub comment" assertions**

Replace lines 188-206 (the body of the "happy path" test, after the `await makeEnv()` change from Step 4):

```typescript
  it('stores payload in R2 and posts GitHub comment on valid upload', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validExport }),
      env,
    );
    expect(res.status).toBe(200);

    const listed = await env.TRAINING_BUCKET.list({ prefix: 'training/' });
    expect(listed.objects).toHaveLength(1);
    const key = listed.objects[0]!.key;
    expect(key).toMatch(/^training\/2026-05-07T00:00:00\.000Z-[0-9a-f-]+\.json$/);
    const obj = await env.TRAINING_BUCKET.get(key);
    const body = JSON.parse(await obj!.text()) as Record<string, unknown>;
    expect(body).toMatchObject({ reportType: 'training-export', sampleCount: 1 });

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(githubCall[0]).toContain('/issues/1/comments');
    expect(githubCall[1].headers).toMatchObject({ Authorization: 'Bearer fake-token' });
  });
```

- [x] **Step 8: Rewrite the "stores stall state in R2" assertions**

Replace lines 239-259 (the body of the stall-state test, after the `await makeEnv()` change from Step 4):

```typescript
  it('stores stall state in R2 and posts GitHub comment', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validStallState }),
      env,
    );
    expect(res.status).toBe(200);

    const listed = await env.TRAINING_BUCKET.list({ prefix: 'stall/' });
    expect(listed.objects).toHaveLength(1);
    const key = listed.objects[0]!.key;
    expect(key).toMatch(/^stall\/2026-05-21T10:00:00\.000Z-[0-9a-f-]+\.json$/);
    const obj = await env.TRAINING_BUCKET.get(key);
    const body = JSON.parse(await obj!.text()) as Record<string, unknown>;
    expect(body).toMatchObject({ reportType: 'stall', puzzleType: 'classic' });

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(githubCall[0]).toContain('/issues/1/comments');
    const commentBody = JSON.parse(githubCall[1].body as string) as { body: string };
    expect(commentBody.body).toContain('Stall state');
    expect(commentBody.body).toContain('stall/');
  });
```

- [x] **Step 9: Run the worker test suite**

Run: `cd worker && npm test`
Expected: PASS — all tests green, including the rewritten R2 tests, now exercising a real Miniflare R2 binding instead of `vi.fn()`. Each test gets a fresh in-memory `Miniflare` instance (no persistence configured), so there is nothing to clean up between tests — `mf.dispose()` in `afterEach` releases it.

- [x] **Step 10: Commit**

```bash
git add worker/package.json worker/package-lock.json worker/src/index.test.ts
git commit -m "test: use real Miniflare R2 binding in worker tests instead of mocks"
```

---

### Task 4: Cover all feedback route variants on the worker

**Files:**
- Modify: `worker/src/index.test.ts`

- [x] **Step 1: Add fixtures for every `feedbackType`/`bugCategory` combination**

In `worker/src/index.test.ts`, after the existing `validFeedback` constant (around line 61-74), add:

```typescript
const validFeedbackInaccurate = {
  ...validFeedback,
  bugCategory: 'inaccurate-description' as const,
};

const validFeedbackEnhancement = (() => {
  const { bugCategory: _b, expected: _e, ...rest } = validFeedback as typeof validFeedback & { expected?: string };
  return { ...rest, feedbackType: 'enhancement' as const, description: 'Add a dark mode toggle' };
})();

const validFeedbackNewRule = (() => {
  const { bugCategory: _b, expected: _e, ...rest } = validFeedback as typeof validFeedback & { expected?: string };
  return {
    ...rest,
    feedbackType: 'new-rule' as const,
    description: 'This puzzle needs a Skyscraper rule',
    fixtureName: 'TwoStringKite-1',
    unsolvedCells: 12,
    totalCandidates: 34,
  };
})();
```

- [x] **Step 2: Write the new tests**

In the "Feedback path" describe block (after the existing two `it(...)` blocks, around line 289), add:

```typescript
  it.each<[string, Record<string, unknown>, string, string[]]>([
    ['bug / wrong-behaviour', validFeedback, '[Bug report]', ['feedback', 'bug']],
    ['bug / inaccurate-description', validFeedbackInaccurate, '[Bug report]', ['feedback', 'bug', 'documentation']],
    ['enhancement', validFeedbackEnhancement, '[Enhancement request]', ['feedback', 'enhancement']],
    ['new-rule', validFeedbackNewRule, '[Rule suggestion]', ['feedback', 'new-rule']],
  ])('creates a GitHub issue with the right title prefix and labels for %s', async (_label, body, titlePrefix, labels) => {
    const env = await makeEnv();
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body }),
      env,
    );
    expect(res.status).toBe(200);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(githubCall[0]).toMatch(/\/repos\/test\/repo\/issues$/);
    const issue = JSON.parse(githubCall[1].body as string) as { title: string; body: string; labels: string[] };
    expect(issue.title.startsWith(titlePrefix)).toBe(true);
    expect(issue.labels).toEqual(labels);
  });

  it('includes the expected-behaviour section for bug reports with `expected` set', async () => {
    const env = await makeEnv();
    await worker.fetch(makeRequest({ contentType: 'application/json', body: validFeedback }), env);

    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const issue = JSON.parse(githubCall[1].body as string) as { body: string };
    expect(issue.body).toContain('### Expected behaviour');
    expect(issue.body).toContain(validFeedback.expected);
  });

  it('includes the fixture section and fixture name in the title for new-rule reports', async () => {
    const env = await makeEnv();
    await worker.fetch(makeRequest({ contentType: 'application/json', body: validFeedbackNewRule }), env);

    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const issue = JSON.parse(githubCall[1].body as string) as { title: string; body: string };
    expect(issue.title).toContain('TwoStringKite-1');
    expect(issue.body).toContain('**Fixture:** `TwoStringKite-1`');
    expect(issue.body).toContain('**Unsolved cells:** 12');
    expect(issue.body).toContain('**Total candidates:** 34');
  });

  it('includes an Exception section when `exception` is set', async () => {
    const env = await makeEnv();
    const body = { ...validFeedback, exception: 'TypeError: something broke\n  at foo (bar.ts:1:1)' };
    await worker.fetch(makeRequest({ contentType: 'application/json', body }), env);

    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const issue = JSON.parse(githubCall[1].body as string) as { body: string };
    expect(issue.body).toContain('## Exception');
    expect(issue.body).toContain('TypeError: something broke');
  });
```

- [x] **Step 3: Run the worker test suite**

Run: `cd worker && npm test`
Expected: PASS — all new feedback-route tests green.

- [x] **Step 4: Commit**

```bash
git add worker/src/index.test.ts
git commit -m "test: cover all feedback route variants (feedbackType, bugCategory, fixture context, exception)"
```

---

### Task 5: Realistic large `puzzleSpec` feedback test

**Files:**
- Modify: `worker/src/index.test.ts`

- [x] **Step 1: Add a helper that builds a large `SerializedPuzzleState`-shaped `puzzleSpec`**

In `worker/src/index.test.ts`, near the other fixture constants, add a helper that builds a realistic killer `puzzleSpec` with a long `turns` history. This is constructed with plain literals matching `SerializedPuzzleState`'s shape (the worker only treats `puzzleSpec` as `unknown`, so no cross-package import of `web`'s types is needed):

```typescript
function makeLargePuzzleSpec(turnCount: number): Record<string, unknown> {
  const candidates = Array.from({ length: 9 }, () =>
    Array.from({ length: 9 }, () => [1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const turns = Array.from({ length: turnCount }, (_, i) => ({
    action: { type: 'placeDigit', row: i % 9, col: (i * 3) % 9, digit: (i % 9) + 1, source: 'user' as const },
    autoMutations: [],
    snapshot: { candidates },
  }));
  const grid9x9 = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => ((r * 3 + Math.floor(r / 3) + c) % 9) + 1));
  const regions9x9 = Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, () => r + 1));
  const cageTotals9x9 = Array.from({ length: 9 }, () => new Array<number>(9).fill(15));

  return {
    kind: 'killer',
    version: 1,
    specData: { regions: regions9x9, cageTotals: cageTotals9x9 },
    cageStates: [],
    userGrid: grid9x9,
    virtualCages: [],
    turns,
    alwaysApplyRules: [],
    goldenSolution: grid9x9,
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
    userRemovedCandidates: [],
  };
}
```

- [x] **Step 2: Write the test**

Still in the "Feedback path" describe block:

```typescript
  it('handles a feedback report with a large, realistic puzzleSpec (full turn history) without error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = await makeEnv();
    const body = { ...validFeedback, puzzleSpec: makeLargePuzzleSpec(25) };

    const res = await worker.fetch(makeRequest({ contentType: 'application/json', body }), env);

    expect(res.status).toBe(200);
    expect(consoleSpy).not.toHaveBeenCalled();

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const issue = JSON.parse(githubCall[1].body as string) as { body: string };
    expect(issue.body).toContain('<summary>Puzzle spec</summary>');
    expect(issue.body).toContain('"turns"');
  });
```

- [x] **Step 3: Run the worker test suite**

Run: `cd worker && npm test`
Expected: PASS. `consoleSpy` not being called confirms `FeedbackReport.githubAction` → `buildIssue` → `JSON.stringify(r.puzzleSpec, ...)` completed without throwing for a realistically-sized payload (a throw here would be caught by the worker's `try { await createGitHubIssue(...) } catch (err) { console.error(...) }` and would still return 200, but `consoleSpy` would have been called — this test distinguishes "succeeded cleanly" from "threw and was swallowed").

- [x] **Step 4: Commit**

```bash
git add worker/src/index.test.ts
git commit -m "test: cover feedback reports with a large realistic puzzleSpec"
```

---

### Task 6: Update documentation

**Files:**
- Modify: `docs/architecture.md`

- [x] **Step 1: Document the new `feedbackSubmit.ts` module**

In `docs/architecture.md`, in the "Bug reporting" paragraph (currently around line 301), replace:

```markdown
**Bug reporting:** `reportBug(e, context)` (in `main.ts`) stores the exception for the next feedback modal open. When the user submits feedback via the Feedback button, the exception string is included in the worker payload and appears in the generated GitHub issue.
```

with:

```markdown
**Bug reporting:** `reportBug(e, context)` (in `main.ts`) stores the exception for the next feedback modal open. When the user submits feedback via the Feedback button, `handleFeedbackSubmit` reads the form fields and calls `buildFeedbackPayload()` (`session/feedbackSubmit.ts`) to construct a `FeedbackReport` — including `reportType: 'feedback'`, the exception string (if any), and (for `new-rule` suggestions with an active fixture) `fixtureName`/`unsolvedCells`/`totalCandidates`. `submitFeedback()` POSTs the payload to the training worker, which opens a GitHub issue via `FeedbackReport.githubAction()`.
```

- [x] **Step 2: Add `feedbackSubmit.ts` to the key files table**

In `docs/architecture.md`, in the key files table (around line 217), add a row after the `trainingUpload.ts` row:

```markdown
| `web/src/session/feedbackSubmit.ts` | `buildFeedbackPayload`, `submitFeedback` — feedback payload construction and POST |
```

- [x] **Step 3: Note the Miniflare-based worker test setup**

In `docs/architecture.md`, after the "Infrastructure" table (around line 264), add:

```markdown
**Worker tests:** `worker/src/index.test.ts` exercises the real worker `fetch`
handler against a `miniflare`-backed `R2Bucket` (in-memory, fresh per test —
no persistence/cleanup needed) rather than a hand-rolled mock, so R2 `put`/
`get`/`list` behaviour is real. `globalThis.fetch` (the GitHub API call)
remains mocked — tests never create real GitHub issues or comments.
```

- [x] **Step 4: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: document feedbackSubmit module and Miniflare-based worker tests"
```

---

### Task 7: Final verification and branch completion

**Files:** none (verification only)

- [x] **Step 1: Run the bronze gate**

Run: `bash scripts/run-bronze-gate.sh`
Expected: PASS (`tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, `npm test` all succeed). This creates `.bronze-gate-ok`.

- [x] **Step 2: Run the worker test suite directly (not covered by the web bronze gate)**

Run: `cd worker && npm test`
Expected: PASS — all worker tests green, including the new Miniflare-backed and feedback-route tests.

- [x] **Step 3: Manually verify the fix in the browser**

With the dev server running (`cd web && npm run dev -- --port 5175`), open the feedback modal, submit feedback for each of the three `feedbackType` options (bug, enhancement, new-rule), and confirm the status message reads "Feedback logged to console (no worker URL configured)." in each case (no `VITE_TRAINING_WORKER_URL` is set in dev) — and confirm via the browser console that each logged payload includes `"reportType": "feedback"`.

- [x] **Step 4: Finish the branch**

Announce: "I'm using the finishing-a-development-branch skill to complete this work."
**REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch — verify tests, then merge to `master` per the user's standing "it's always 1" instruction (Option 1: merge locally).

Before merging, confirm doc hygiene: this plan file
(`docs/superpowers/plans/2026-06-13-feedback-submission-testing.md`) must have
every step checked off, then deleted; the spec file
(`docs/superpowers/specs/2026-06-13-feedback-submission-testing-design.md`) has
already been incorporated into `docs/architecture.md` via Task 6 and must be
deleted too.
