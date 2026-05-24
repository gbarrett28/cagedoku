# Hint Pill Canvas Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `#hint-pill` into `#canvas-col` so it appears below the canvas and above the digit pad in portrait, and is centred on the canvas area in landscape.

**Architecture:** Pure HTML + CSS change — no JavaScript modifications. The pill becomes an in-flow flex child of `#canvas-col` in portrait (appearing naturally between canvas-wrapper and side-panel); in landscape it switches to `position: absolute` pinned to the bottom of the canvas portion via `left: 0; right: 7.5rem; margin: auto`.

**Tech Stack:** HTML, CSS, Playwright (E2E structural test), Vitest (existing unit tests — no changes needed)

---

## Files

| File | Change |
|---|---|
| `web/index.html` | Move `#hint-pill` div into `#canvas-col`, between `#canvas-wrapper` and `#side-panel` |
| `web/public/styles.css` | Replace fixed positioning on `#hint-pill` with in-flow styles; add landscape override; add `position: relative` to landscape `#canvas-col` rule |
| `web/e2e/app.spec.ts` | Add structural test: pill's parent must be `canvas-col` |

---

### Task 1: Write a failing structural test

**Files:**
- Modify: `web/e2e/app.spec.ts`

- [ ] **Step 1: Add the test**

Open `web/e2e/app.spec.ts` and append this test inside the existing `test.describe` block (or at file scope if there is no wrapping describe):

```typescript
test('hint-pill is a direct child of canvas-col', async ({ page }) => {
  await page.goto('/');
  const parentId = await page.evaluate(() => {
    const pill = document.getElementById('hint-pill');
    return pill?.parentElement?.id ?? null;
  });
  expect(parentId).toBe('canvas-col');
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
cd web
npx playwright test e2e/app.spec.ts --grep "hint-pill is a direct child" -p chromium
```

Expected output — test fails with something like:
```
Expected: "canvas-col"
Received: "body"   (or whatever the current parent is)
```

- [ ] **Step 3: Commit the failing test on the feature branch**

```bash
# From repo root
bash scripts/run-bronze-gate.sh
git add web/e2e/app.spec.ts
git commit -m "test: add failing structural test for hint-pill parent"
```

---

### Task 2: Move `#hint-pill` in HTML

**Files:**
- Modify: `web/index.html` lines 344–346 (current pill location) and lines 72–113 (canvas-col block)

- [ ] **Step 1: Remove the pill from its current position**

Find and delete these three lines (they appear just after the `</dialog>` closing tag, before `<div id="callout">`):

```html
<div id="hint-pill" hidden role="status" aria-live="polite">
  <span id="hint-pill-label"></span>
</div>
```

- [ ] **Step 2: Insert the pill inside `#canvas-col`**

Locate the `#canvas-col` block in `index.html`. It looks like:

```html
      <div class="image-col" id="canvas-col">
        <h2 id="detected-layout-heading">Detected Layout</h2>
        <div id="canvas-wrapper">
          <canvas id="grid-canvas"></canvas>
          <input id="cage-total-edit" type="number" min="1" max="45">
        </div>
        <div id="side-panel">
```

Insert the pill **between** `</div><!-- closes canvas-wrapper -->` and `<div id="side-panel">`:

```html
      <div class="image-col" id="canvas-col">
        <h2 id="detected-layout-heading">Detected Layout</h2>
        <div id="canvas-wrapper">
          <canvas id="grid-canvas"></canvas>
          <input id="cage-total-edit" type="number" min="1" max="45">
        </div>

        <div id="hint-pill" hidden role="status" aria-live="polite">
          <span id="hint-pill-label"></span>
        </div>

        <div id="side-panel">
```

- [ ] **Step 3: Verify the HTML is well-formed**

```bash
cd web
npm run build 2>&1 | tail -10
```

Expected: build succeeds with no errors.

---

### Task 3: Update CSS

**Files:**
- Modify: `web/public/styles.css`

#### 3a — Replace the `#hint-pill` base rule

- [ ] **Step 1: Replace the existing `#hint-pill` rule**

Find:
```css
#hint-pill {
  position: fixed;
  bottom: 5rem;
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.4rem 1.1rem;
  cursor: pointer;
  z-index: 50;
  font-size: 0.85rem;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0,0,0,0.18);
  user-select: none;
}
```

Replace with (removes fixed positioning, adds `align-self: center` and a small top margin so the pill sits in the gap between canvas and digit pad):
```css
#hint-pill {
  align-self: center;
  margin-top: 0.35rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.4rem 1.1rem;
  cursor: pointer;
  z-index: 50;
  font-size: 0.85rem;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0,0,0,0.18);
  user-select: none;
}
```

#### 3b — Add `position: relative` to the landscape `#canvas-col` rule

- [ ] **Step 2: Add `position: relative` to the landscape canvas-col rule**

Find the landscape playing-mode `#canvas-col` rule (inside `@media (orientation: landscape)`):
```css
  body:has(#playing-actions:not([hidden])) #canvas-col {
    max-width: none;
    height: 100dvh;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
```

Add `position: relative;` as the first property:
```css
  body:has(#playing-actions:not([hidden])) #canvas-col {
    position: relative;
    max-width: none;
    height: 100dvh;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
```

#### 3c — Add the landscape pill override

- [ ] **Step 3: Add landscape pill override immediately after the rule edited in 3b**

Insert this new rule right after the closing `}` of the canvas-col landscape rule:

```css
  /* Landscape: pill is absolute-positioned at the bottom of the canvas area.
     left: 0; right: 7.5rem subtracts the side-panel width so margin:auto
     centres the pill on the canvas portion, not the full canvas-col. */
  body:has(#playing-actions:not([hidden])) #hint-pill {
    position: absolute;
    bottom: 0.5rem;
    left: 0;
    right: 7.5rem;
    margin: auto;
    width: max-content;
  }
```

---

### Task 4: Run tests and verify

- [ ] **Step 1: Run unit tests**

```bash
cd web
npm test
```

Expected: all tests pass (the `hintPill` unit tests are not affected by this change — they construct pill elements directly without touching the DOM structure).

- [ ] **Step 2: Run the structural Playwright test**

```bash
cd web
npx playwright test e2e/app.spec.ts --grep "hint-pill is a direct child" -p chromium
```

Expected: PASS.

- [ ] **Step 3: Visual spot-check — portrait**

Start the dev server (in a separate terminal):
```bash
cd web && npm run dev -- --port 5175
```

Use the Playwright MCP browser tool (or open `http://localhost:5175/` in a browser) at a portrait viewport (e.g. 390×844). Force the pill visible via the browser console or `page.evaluate`:

```js
// Paste in browser console or use page.evaluate()
const pill = document.getElementById('hint-pill');
const label = document.getElementById('hint-pill-label');
label.textContent = 'Naked Single';
pill.hidden = false;
```

The pill should appear in the gap **below the canvas, above the digit pad**. It must not float over the grid or be centred on the full viewport.

- [ ] **Step 4: Visual spot-check — landscape**

Resize the viewport to landscape (e.g. 844×390) and repeat the JS above. The pill should appear at the **bottom of the canvas area**, horizontally centred on the canvas portion (not shifted into the sidebar). Take a screenshot to confirm.

- [ ] **Step 5: Run the full bronze gate**

```bash
# From repo root
bash scripts/run-bronze-gate.sh
```

Expected: tsc passes, all unit tests pass, bronze gate token created.

---

### Task 5: Commit and update docs

- [ ] **Step 1: Commit the implementation**

```bash
# From repo root
git add web/index.html web/public/styles.css
git commit -m "fix: move hint-pill into canvas-col so it tracks canvas in portrait and landscape

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

- [ ] **Step 2: Delete the spec file (it's been implemented)**

```bash
rm docs/superpowers/specs/2026-05-24-hint-pill-positioning-design.md
```

- [ ] **Step 3: Commit the spec deletion**

```bash
# From repo root
bash scripts/run-bronze-gate.sh
git add docs/superpowers/specs/2026-05-24-hint-pill-positioning-design.md
git commit -m "chore: delete implemented hint-pill positioning spec

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

- [ ] **Step 4: Delete this plan file once all steps above are done**

```bash
rm docs/superpowers/plans/2026-05-24-hint-pill-canvas-tracking.md
```
