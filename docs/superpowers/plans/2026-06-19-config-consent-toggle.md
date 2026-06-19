# Config-Modal Consent Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any user view and change their training-data consent directly from the config modal, instead of only via the "Always send" button in the training-consent popup.

**Architecture:** Add a `revokeConsent()` function next to the existing `grantConsent()` in `trainingUpload.ts` (clears the `training_consent` cookie). Add a checkbox to `#config-modal` that reflects `hasConsent()` on open and calls `grantConsent()`/`revokeConsent()` immediately on toggle — independent of the modal's Save/Cancel buttons.

**Tech Stack:** TypeScript, Vite, Vitest (`@vitest-environment jsdom`), Playwright (dev config, `flow.spec.ts`).

## Global Constraints

- Branch: `feature/config-consent-toggle` (already created and pushed).
- No "denied" tri-state — absence of the cookie already means "not granted" everywhere; revoking returns to that state.
- No confirmation dialog on revoke.
- Consent stays out of `CoachSettings`/`saveSettingsData` — it is cookie-based and applies immediately, not on Save.
- Bronze gate (`bash scripts/run-bronze-gate.sh` from repo root) must pass before each commit on this branch.

---

### Task 1: `revokeConsent()` in trainingUpload.ts

**Files:**
- Modify: `web/src/image/trainingUpload.ts:27-29` (after `grantConsent`)
- Test: `web/src/image/trainingUpload.test.ts:32-41` (after the `grantConsent` describe block)

**Interfaces:**
- Produces: `export function revokeConsent(): void` — clears the `training_consent` cookie so a subsequent `hasConsent()` call returns `false`.

- [ ] **Step 1: Write the failing test**

In `web/src/image/trainingUpload.test.ts`, change the import on line 3 to add `revokeConsent`:

```ts
import { hasConsent, grantConsent, revokeConsent, uploadTrainingData, initiateUpload, submitStallReport, submitRuleBugReport, submitTriggerMissReport } from './trainingUpload.js';
```

Then add this new `describe` block immediately after the existing `describe('grantConsent', ...)` block (after line 41, before the `minimalExport` declaration on line 43):

```ts
describe('revokeConsent', () => {
  beforeEach(clearCookies);
  afterEach(clearCookies);

  it('clears the consent cookie so hasConsent() returns false', () => {
    grantConsent();
    expect(hasConsent()).toBe(true);
    revokeConsent();
    expect(hasConsent()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/image/trainingUpload.test.ts`
Expected: FAIL — `revokeConsent is not a function` (or a TypeScript error: `Module '"./trainingUpload.js"' has no exported member 'revokeConsent'`).

- [ ] **Step 3: Write minimal implementation**

In `web/src/image/trainingUpload.ts`, add this function immediately after `grantConsent` (after line 29):

```ts
export function revokeConsent(): void {
  document.cookie = `${CONSENT_COOKIE}=; max-age=0`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/image/trainingUpload.test.ts`
Expected: PASS, all tests in the file green (including the new `revokeConsent` describe block).

- [ ] **Step 5: Run full bronze gate and commit**

```bash
cd /home/user/cagedoku
bash scripts/run-bronze-gate.sh
git add web/src/image/trainingUpload.ts web/src/image/trainingUpload.test.ts
git commit -m "feat: add revokeConsent() to clear training-consent cookie"
```

---

### Task 2: Config-modal checkbox + wiring + e2e test

**Files:**
- Modify: `web/index.html:211-216` (inside `#config-modal`)
- Modify: `web/src/main.ts:17` (import), `web/src/main.ts:1069-1070` (`openConfigModal`), `web/src/main.ts:2324` (event wiring)
- Test: `web/e2e/flow.spec.ts` (after the `'config button opens config-modal'` test, line 359-365)

**Interfaces:**
- Consumes: `hasConsent(): boolean`, `grantConsent(): void`, `revokeConsent(): void` from `web/src/image/trainingUpload.js` (the last is new in Task 1; the first two are already imported in `main.ts:17`).

- [ ] **Step 1: Add the checkbox to the config modal HTML**

In `web/index.html`, inside `<dialog id="config-modal">`, insert a new `<h3>Privacy</h3>` heading and row directly after `<h2>Solver Rules</h2>` (line 212) and before the existing `candidates-default-toggle` row:

```html
<dialog id="config-modal">
  <h2>Solver Rules</h2>
  <h3>Privacy</h3>
  <div class="form-row">
    <label class="field-label" for="consent-toggle">Send anonymised training &amp; bug-fixing data</label>
    <input type="checkbox" id="consent-toggle">
  </div>
  <div class="form-row">
    <label class="field-label" for="candidates-default-toggle">Show candidates by default</label>
    <input type="checkbox" id="candidates-default-toggle" checked>
  </div>
```

(The remaining rows below — `essential-toggle`, `telemetry-failures-toggle`, the delay slider — are unchanged.)

- [ ] **Step 2: Wire `openConfigModal()` to read the current consent state**

In `web/src/main.ts`, update the import on line 17 to add `revokeConsent`:

```ts
import { initiateUpload, grantConsent, revokeConsent, uploadTrainingData, submitStallReport, hasConsent } from './image/trainingUpload.js';
```

Then in `openConfigModal()` (around line 1070), add a line setting the new checkbox's state right after the `telemetry-failures-toggle` line:

```ts
  el<HTMLInputElement>('candidates-default-toggle').checked = data.showCandidatesByDefault;
  el<HTMLInputElement>('telemetry-failures-toggle').checked = data.devSurfaceTelemetryFailures;
  el<HTMLInputElement>('consent-toggle').checked = hasConsent();
```

- [ ] **Step 3: Wire the checkbox's `change` listener**

In `web/src/main.ts`, in the startup wiring section, add this immediately before the existing `config-btn` listener (around line 2324):

```ts
  el<HTMLInputElement>('consent-toggle').addEventListener('change', (e) => {
    if ((e.target as HTMLInputElement).checked) grantConsent();
    else revokeConsent();
  });
  el<HTMLButtonElement>('config-btn').addEventListener('click', () => { openConfigModal(); });
```

- [ ] **Step 4: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manually verify in the dev server**

```bash
cd web && npm run dev -- --port 5175
```

Open `http://localhost:5175`, open dev tools → Application → Cookies, confirm no `training_consent` cookie. Click the config button (⚙), confirm the "Privacy" section shows an unchecked "Send anonymised training & bug-fixing data" box. Check it — confirm `training_consent=granted` appears in cookies immediately (no need to click Save). Uncheck it — confirm the cookie disappears immediately. Click Cancel — confirm the cookie state from your last toggle persists (Cancel does not revert it).

- [ ] **Step 6: Write the e2e test**

In `web/e2e/flow.spec.ts`, add this test immediately after the `'config button opens config-modal'` test (after line 365):

```ts
test('config modal consent checkbox grants and revokes training_consent cookie immediately', async ({ page }) => {
  await loadAndConfirm(page);
  await page.locator('#config-btn').click();
  await expect(page.locator('#config-modal')).toBeVisible();

  const checkbox = page.locator('#consent-toggle');
  await expect(checkbox).not.toBeChecked();

  await checkbox.check();
  let cookies = await page.context().cookies();
  expect(cookies.find(c => c.name === 'training_consent')?.value).toBe('granted');

  await checkbox.uncheck();
  cookies = await page.context().cookies();
  expect(cookies.find(c => c.name === 'training_consent')).toBeUndefined();
});
```

- [ ] **Step 7: Run the e2e test to verify it passes**

Run: `cd web && npx playwright test --config playwright.dev.config.ts -g "consent checkbox"`
Expected: PASS.

- [ ] **Step 8: Run full bronze gate and commit**

```bash
cd /home/user/cagedoku
bash scripts/run-bronze-gate.sh
git add web/index.html web/src/main.ts web/e2e/flow.spec.ts
git commit -m "feat: add training-consent toggle to config modal"
```

---

## After both tasks: doc hygiene

This plan's spec lives at `docs/superpowers/specs/2026-06-19-config-consent-toggle-design.md`. Per `CLAUDE.md`'s Silver Gate doc-hygiene check, once both tasks above are complete and the live docs accurately describe the feature, incorporate the design into `docs/architecture.md` (a short note alongside the existing "Telemetry-failure surfacing (dev diagnostic)" subsection, since this directly addresses the loop described there) and delete the spec file. Delete this plan file once every step above is checked off. Then proceed to merge per `CLAUDE.md`'s branch workflow (Silver Gate, merge to `master`, push, delete the feature branch).
