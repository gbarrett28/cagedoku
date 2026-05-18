# Responsive Playing Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the playing-mode grid as large as possible in both portrait and landscape by reorienting the header bar to a left sidebar and digit pad to a right sidebar in landscape, while filling full available width in portrait.

**Architecture:** Pure CSS layout switching via `@media (orientation: landscape)` + `body:has()` selectors — no JS changes. A new `<div id="side-panel">` inside `#canvas-col` unifies digit pad, cage inspector, and virtual cage form as a single switchable zone. Portrait sizes the canvas using a `min(100%, height-calc)` max-width; landscape uses `flex: 1 + max-height: 100%` on the canvas wrapper inside a flex-row `#canvas-col`.

**Tech Stack:** CSS (flexbox, `:has()`, `@media (orientation: landscape)`, CSS custom properties), HTML restructure, no new JS.

---

### Task 1: Feature branch

**Files:** none

- [ ] **Create branch**

```bash
git checkout -b feature/responsive-playing-layout
```

---

### Task 2: HTML — K badge and side-panel restructure

**Files:**
- Modify: `web/index.html`

- [ ] **Replace `<h1>COACH</h1>` with K badge**

Find in `web/index.html`:
```html
<h1>COACH</h1>
```
Replace with:
```html
<div id="logo-k" class="logo-k">K</div>
```

- [ ] **Introduce `#side-panel` and move inspector/virtual-cage panels inside `#canvas-col`**

The current HTML inside `#images-row` has `#canvas-col` followed by `#inspector-col`
and `#virtual-cage-col` as siblings. The goal is to move the two panel divs inside
`#canvas-col`, wrapped in a new `#side-panel` div alongside `#playing-actions`.

Find in `web/index.html` (inside `#canvas-col`):
```html
          <!-- Playing mode actions: digit pad in Classic review; full action bar in playing mode -->
          <div id="playing-actions" hidden>
```
Replace with:
```html
          <div id="side-panel">
          <!-- Playing mode actions: digit pad in Classic review; full action bar in playing mode -->
          <div id="playing-actions" hidden>
```

Find the closing `</div>` that ends `#playing-actions` followed by `</div>` ending `#canvas-col`:
```html
        </div>
      </div>
      <div class="image-col" id="inspector-col" hidden>
        <h2 id="inspector-heading"></h2>
        <div id="cage-inspector"></div>
      </div>
      <div class="image-col" id="virtual-cage-col" hidden>
```
Replace with (close playing-actions, then side-panel absorbs inspector+vc, close side-panel, close canvas-col):
```html
        </div>
        <div id="inspector-col" hidden>
          <h2 id="inspector-heading"></h2>
          <div id="cage-inspector"></div>
        </div>
        <div id="virtual-cage-col" hidden>
```

Then find where `#virtual-cage-col` closes and `#canvas-col` closes — add `</div>` to close `#side-panel` before the `</div>` that closes `#canvas-col`:
```html
        </div>
      </div>
      </div>
```
becomes:
```html
        </div>
        </div><!-- #side-panel -->
      </div><!-- #canvas-col -->
```

**After the change, `#canvas-col` should have this structure:**
```html
<div class="image-col" id="canvas-col">
  <h2 id="detected-layout-heading">Detected Layout</h2>
  <div id="canvas-wrapper">
    <canvas id="grid-canvas"></canvas>
    <input id="cage-total-edit" type="number" min="1" max="45">
  </div>
  <div id="side-panel">
    <div id="playing-actions" hidden>
      <div class="digit-pad">…</div>
      <p id="completion-msg" …>…</p>
    </div>
    <div id="inspector-col" hidden>
      <h2 id="inspector-heading"></h2>
      <div id="cage-inspector"></div>
    </div>
    <div id="virtual-cage-col" hidden>
      <h2>Virtual Cages</h2>
      …
    </div>
  </div>
</div>
```

`#inspector-col` and `#virtual-cage-col` are no longer siblings of `#canvas-col` in
`#images-row`. Their `hidden` toggling in JS is unchanged (IDs are the same).

- [ ] **Verify JS show/hide logic is unaffected**

```bash
cd web && grep -n "inspector-col\|virtual-cage-col" src/main.ts
```

Confirm every reference uses `el('inspector-col')` / `el('virtual-cage-col')` by ID.
No changes needed — ID-based lookup works regardless of DOM position.

- [ ] **Bronze gate — TypeScript only**

```bash
cd web && tsc --noEmit && tsc -p tsconfig.node.json --noEmit
```

Expected: no errors (HTML change has no TypeScript impact).

---

### Task 3: CSS — K badge styles and CSS custom properties

**Files:**
- Modify: `web/public/styles.css`

- [ ] **Add CSS custom properties to `:root`**

Find the existing `:root` block and add three new properties:

```css
:root {
  /* …existing properties… */
  --header-h: 52px;    /* sticky header height — verify in DevTools during Task 5 */
  --digit-pad-h: 124px; /* #side-panel height in portrait playing mode — verify in Task 5 */
  --chrome-v: 2rem;    /* main margins (0.5rem×2) + card padding (0.5rem×2) in playing mode */
}
```

- [ ] **Add `.logo-k` badge style**

Add immediately after the `.sticky-bars` block:

```css
.logo-k {
  background: var(--accent);
  color: #fff;
  font-weight: bold;
  border-radius: 4px;
  width: 1.75rem;
  height: 1.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  flex-shrink: 0;
  user-select: none;
}
```

- [ ] **Bronze gate**

```bash
cd web && tsc --noEmit && npm test
```

Expected: all tests pass.

---

### Task 4: CSS — Portrait playing-mode canvas sizing

**Files:**
- Modify: `web/public/styles.css`

The canvas should fill the full card width in portrait but not overflow vertically.
Replace the existing `max-width: clamp(...)` approach with a CSS `min()` that uses
custom properties so the 458px hard cap is gone.

- [ ] **Replace portrait playing-mode `#canvas-col` max-width rule**

Find:
```css
body:has(#playing-actions:not([hidden])) #canvas-col {
  max-width: clamp(200px, calc(100vh - 204px), 458px);
}
```

Replace with:
```css
body:has(#playing-actions:not([hidden])) #canvas-col {
  max-width: min(100%, calc(100dvh - var(--header-h) - var(--digit-pad-h) - var(--chrome-v)));
}
```

This allows the canvas to fill the full card width on wide devices while preventing
vertical overflow on short viewports. The 458px cap is removed.

- [ ] **Add `#side-panel` base style (portrait: natural flow below canvas)**

After the `#playing-actions` block, add:

```css
#side-panel {
  width: 100%;
}
```

This ensures the side panel fills the canvas column width in portrait so the digit pad
is centred correctly.

- [ ] **Bronze gate**

```bash
cd web && tsc --noEmit && npm test
```

---

### Task 5: Measure and verify portrait layout

**Files:** none (CSS variable values from Task 3 may need updating)

- [ ] **Start dev server**

```bash
cd web && npm run dev
```

Load a puzzle and enter playing mode.

- [ ] **Measure `--header-h`**

In DevTools, inspect `.sticky-bars`. Note the computed height. Update `--header-h`
in `:root` if it differs from 52px.

- [ ] **Measure `--digit-pad-h`**

In DevTools, inspect `#side-panel`. Note the computed height in portrait playing mode.
Update `--digit-pad-h` in `:root` if it differs from 124px.

- [ ] **Verify canvas is square and fills width**

In DevTools, select `#grid-canvas`. Confirm `offsetWidth === offsetHeight`.
On a typical phone viewport (≤390px wide), the canvas should fill the available
content width. On a short viewport, it should not overflow below the digit pad.

---

### Task 6: CSS — Landscape playing-mode sidebar layout

**Files:**
- Modify: `web/public/styles.css`

- [ ] **Remove the existing landscape playing-mode max-width override**

Inside the existing `@media (orientation: landscape)` block, find and remove:
```css
  /* Playing mode in landscape: only one grid visible, use full viewport height. */
  body:has(#playing-actions:not([hidden])) #canvas-col {
    max-width: clamp(200px, calc(100vh - 204px), 458px);
  }
```

- [ ] **Add the landscape playing-mode layout block**

Add a new `@media (orientation: landscape)` block after the existing one (or append
inside it, keeping the new rules at the end):

```css
/* ── Landscape playing mode: full-height sidebar layout ── */

@media (orientation: landscape) {

  /* Body becomes a two-column grid: [left sidebar] [right content] */
  body:has(#playing-actions:not([hidden])) {
    display: grid;
    grid-template-columns: auto 1fr;
    height: 100dvh;
    overflow: hidden;
  }

  /* .sticky-bars becomes the full-height left sidebar */
  body:has(#playing-actions:not([hidden])) .sticky-bars {
    height: 100dvh;
    overflow-y: auto;
  }

  body:has(#playing-actions:not([hidden])) header {
    height: 100%;
  }

  /* Header inner becomes a vertical flex column:
     K logo at top, action buttons in middle, permanent buttons at bottom */
  body:has(#playing-actions:not([hidden])) .header-inner {
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0;
    height: 100%;
    gap: 0;
  }

  /* Action group stacks vertically */
  body:has(#playing-actions:not([hidden])) #action-group {
    flex-direction: column;
    margin-left: 0;
  }

  /* N|C pill rotates to read vertically in the sidebar */
  body:has(#playing-actions:not([hidden])) #mode-toggle {
    transform: rotate(90deg);
  }

  /* Reset new-puzzle-btn margin — space-between handles positioning */
  body:has(#playing-actions:not([hidden])) #new-puzzle-btn {
    margin-left: 0;
  }

  /* main fills the right grid column */
  body:has(#playing-actions:not([hidden])) main {
    height: 100dvh;
    overflow: hidden;
    margin: 0;
  }

  /* review-panel fills main */
  body:has(#playing-actions:not([hidden])) #review-panel {
    height: 100%;
    padding: 0;
    overflow: hidden;
  }

  /* images-row fills review-panel */
  body:has(#playing-actions:not([hidden])) #images-row {
    height: 100%;
    margin-bottom: 0;
  }

  /* canvas-col: full-height flex row — canvas left, side-panel right */
  body:has(#playing-actions:not([hidden])) #canvas-col {
    max-width: none;     /* remove portrait height-based constraint */
    height: 100dvh;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  /* canvas-wrapper: fill remaining width, bounded by viewport height to stay square */
  body:has(#playing-actions:not([hidden])) #canvas-wrapper {
    flex: 1 1 0px;
    min-width: 0;
    aspect-ratio: 1;
    max-height: 100%;   /* if remaining width > 100dvh, height clamps to 100dvh and
                           aspect-ratio transfers the constraint back to width */
    width: auto;        /* override base width: 100% */
  }

  /* side-panel: right strip, vertically centred */
  body:has(#playing-actions:not([hidden])) #side-panel {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0.5rem;
    align-self: stretch;
    overflow-y: auto;
    width: auto;
  }

  /* Digit pad reflows to two vertical columns:
     grid-auto-flow: column fills column-first:
     [1][6] / [2][7] / [3][8] / [4][9] / [5][X] */
  body:has(#playing-actions:not([hidden])) .digit-pad {
    grid-template-columns: repeat(2, 3rem);
    grid-template-rows: repeat(5, auto);
    grid-auto-flow: column;
    margin-top: 0;
  }

  /* Completion message: below digit pad in the right strip */
  body:has(#playing-actions:not([hidden])) #completion-msg {
    text-align: center;
  }
}
```

- [ ] **Bronze gate**

```bash
cd web && tsc --noEmit && tsc -p tsconfig.node.json --noEmit && npm test
```

Expected: all tests pass.

---

### Task 7: Visual verification

**Files:** none

- [ ] **Portrait playing mode**

In the browser (or DevTools responsive mode, portrait phone ~390×844):
1. Enter playing mode. Confirm K badge visible in header, COACH title gone.
2. Canvas is square and fills available width. Digit pad visible below.
3. Open cage inspector (🔍): digit pad hides, inspector appears in the same bottom zone.
4. Close inspector: digit pad returns.
5. Open virtual cage panel (➕): digit pad hides, form appears below canvas.
6. Resize to a short viewport (~390×550): canvas shrinks to fit vertically without overlapping digit pad.

- [ ] **Landscape playing mode**

In DevTools, switch to landscape (e.g., iPhone SE landscape: 667×375):
1. Left sidebar visible: K at top, action buttons stacked, 🏠?⚙✉ at bottom.
2. N|C pill is rotated 90°.
3. Canvas fills available height, is square.
4. Right strip shows digit pad in `[1][6]/[2][7]/[3][8]/[4][9]/[5][X]` layout.
5. Open cage inspector (🔍): digit pad hides, inspector fills right strip.
6. Open virtual cage panel (➕): virtual cage form fills right strip.
7. Toggle orientation back to portrait: layout switches correctly.

- [ ] **Review mode (regression check)**

In review phase (before confirming puzzle):
1. Inspect a cage: inspector panel appears below detected layout canvas (not as a separate column — this is the intentional review-mode side-effect from the DOM restructure).
2. Virtual cage panel appears below canvas similarly.
3. Original photo and warped grid columns are unaffected.

---

### Task 8: Update live docs, delete spec, commit

**Files:**
- Modify: `docs/ui.md`
- Delete: `docs/superpowers/specs/2026-05-18-responsive-playing-layout-design.md`

- [ ] **Update `docs/ui.md`**

Add a **Responsive Layout** subsection under the Playing Mode section. Cover:

- Portrait: sticky header at top, canvas fills card width (bounded by viewport height),
  `#side-panel` below canvas (digit pad default, inspector or virtual-cage when active)
- Landscape: `.sticky-bars` becomes left sidebar via body CSS grid; `header-inner` is
  `flex-direction: column`; `#canvas-col` is `flex-direction: row`; `#side-panel` is
  the right strip
- K badge (`.logo-k`) replaces `<h1>COACH</h1>`; COACH title removed from HTML
- `#side-panel` is the unified switchable zone: exactly one of `#playing-actions`,
  `#inspector-col`, `#virtual-cage-col` is visible at a time
- CSS custom properties: `--header-h`, `--digit-pad-h`, `--chrome-v` in `:root`
- N|C pill gets `transform: rotate(90deg)` in landscape playing mode

- [ ] **Delete spec file**

```bash
git rm docs/superpowers/specs/2026-05-18-responsive-playing-layout-design.md
```

- [ ] **Bronze gate**

```bash
cd web && tsc --noEmit && tsc -p tsconfig.node.json --noEmit && npm test
```

- [ ] **Commit**

```bash
git add web/index.html web/public/styles.css docs/ui.md
git commit -m "$(cat <<'EOF'
feat: responsive playing layout — landscape sidebar, portrait full-width

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Silver gate and merge

**Files:** none

- [ ] **Full silver gate**

```bash
cd web && tsc --noEmit && npm test -- --reporter=verbose && npx playwright test && npx playwright test --config playwright.dev.config.ts
```

If any Playwright test fails due to the DOM restructure (e.g., `#inspector-col` now
inside `#canvas-col`), update the selector and document the change with a comment.

- [ ] **Merge to master and push**

```bash
git checkout master && git merge feature/responsive-playing-layout && git push
```

- [ ] **Delete feature branch**

```bash
git branch -d feature/responsive-playing-layout
```
