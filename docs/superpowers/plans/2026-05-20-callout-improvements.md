# Callout Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the infinite-loop bug in the callout tutorial system, add sliding pointer arrows to callouts, ensure callouts stay within the viewport on narrow mobile screens, and add a callout for the feedback button.

**Architecture:** Extract a pure `calcCalloutPosition()` function from `tutorial.ts` for testable geometry logic; keep `positionCallout()` as the DOM-writing wrapper. Arrow direction is controlled by CSS classes (`callout-above` / `callout-below` / `callout-no-arrow`) and the arrow horizontal position by a `--arrow-offset` CSS custom property.

**Tech Stack:** TypeScript, Vitest (jsdom), CSS custom properties + `::before` pseudo-element.

---

## File Map

| File | Change |
|---|---|
| `web/src/tutorial.ts` | Add `_resetForTest` export; fix `advanceCallout` (iterative); add `CalloutPosition` interface and `calcCalloutPosition`; rewrite `positionCallout` |
| `web/src/tutorial.test.ts` | Create — unit tests for `advanceCallout` skipping and `calcCalloutPosition` geometry |
| `web/public/styles.css` | Add `::before` arrow rules for `.callout-above`, `.callout-below`, `.callout-no-arrow` |
| `web/src/main.ts` | Add `feedback-btn` callout step after `help-btn` in `playingCallouts` |

---

## Task 0: Create feature branch

- [ ] **Step 1: Create and switch to feature branch**

  ```
  git checkout -b feature/callout-improvements
  ```

---

## Task 1: Test scaffolding + failing tests for `advanceCallout` iteration

**Files:**
- Modify: `web/src/tutorial.ts`
- Create: `web/src/tutorial.test.ts`

- [ ] **Step 1: Add `_resetForTest` export to `tutorial.ts`**

  Append after the `appendCallouts` function (before `advanceCallout`):

  ```ts
  /** Reset module state for unit tests. Sets tutorialActive and calloutStarted true. */
  export function _resetForTest(): void {
    calloutQueue = [];
    calloutRunning = false;
    calloutStarted = true;
    tutorialActive = true;
  }
  ```

- [ ] **Step 2: Create `web/src/tutorial.test.ts` with failing tests**

  The `makeDOM` helper builds the required DOM elements using safe DOM APIs (no innerHTML):

  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { appendCallouts, _resetForTest } from './tutorial.js';

  function makeDOM(): void {
    document.body.replaceChildren();

    const callout = document.createElement('div');
    callout.id = 'callout';
    callout.hidden = true;

    const textEl = document.createElement('p');
    textEl.id = 'callout-text';

    const gotItBtn = document.createElement('button');
    gotItBtn.id = 'callout-got-it';

    callout.append(textEl, gotItBtn);

    const realBtn = document.createElement('button');
    realBtn.id = 'real-btn';
    realBtn.textContent = 'Real';

    document.body.append(callout, realBtn);
  }

  describe('advanceCallout — iterative', () => {
    beforeEach(() => {
      makeDOM();
      _resetForTest();
    });

    it('skips all-missing elements without throwing', () => {
      expect(() =>
        appendCallouts([
          { id: 'missing-1', text: 'A' },
          { id: 'missing-2', text: 'B' },
          { id: 'missing-3', text: 'C' },
        ])
      ).not.toThrow();
    });

    it('leaves callout hidden when every queued element is missing', () => {
      appendCallouts([{ id: 'missing-1', text: 'A' }]);
      expect((document.getElementById('callout') as HTMLElement).hidden).toBe(true);
    });

    it('shows the first element that exists in the DOM', () => {
      appendCallouts([
        { id: 'missing-1', text: 'Skipped' },
        { id: 'real-btn',  text: 'Use this button' },
      ]);
      expect((document.getElementById('callout') as HTMLElement).hidden).toBe(false);
      expect(document.getElementById('callout-text')!.textContent).toBe('Use this button');
    });
  });
  ```

- [ ] **Step 3: Run tests — expect FAIL**

  ```
  cd web && npm test -- tutorial.test
  ```

  Expected: import error — `_resetForTest` not yet exported. Confirms the test is wired up.

---

## Task 2: Fix `advanceCallout` — iterative loop

**Files:**
- Modify: `web/src/tutorial.ts` (the `advanceCallout` function)

- [ ] **Step 1: Replace `advanceCallout` with the iterative version**

  Replace the existing function body:

  ```ts
  function advanceCallout(): void {
    let item: CalloutItem | undefined;
    let target: HTMLElement | null = null;
    while ((item = calloutQueue.shift()) !== undefined) {
      target = document.getElementById(item.id);
      if (target !== null) break;
      target = null;
    }
    if (item === undefined || target === null) {
      calloutRunning = false;
      return;
    }
    calloutRunning = true;
    showCallout(item, target);
  }
  ```

- [ ] **Step 2: Run tutorial tests — expect PASS**

  ```
  cd web && npm test -- tutorial.test
  ```

  Expected: 3 tests pass.

- [ ] **Step 3: Commit**

  ```
  git add web/src/tutorial.ts web/src/tutorial.test.ts
  git commit -m "fix: iterative advanceCallout — no recursion on missing elements (#75)"
  ```

---

## Task 3: Failing tests for `calcCalloutPosition`

**Files:**
- Modify: `web/src/tutorial.test.ts`

- [ ] **Step 1: Add `calcCalloutPosition` to the import and append tests**

  Update the import line:
  ```ts
  import { appendCallouts, calcCalloutPosition, _resetForTest } from './tutorial.js';
  ```

  Append this describe block at the end of `tutorial.test.ts`:

  ```ts
  describe('calcCalloutPosition', () => {
    const CW = 260; // callout width
    const CH = 80;  // callout height

    it('centres callout on the button when viewport is wide', () => {
      // buttonCenterX=230, preferredLeft=100, clamped=100
      const r = calcCalloutPosition(CW, CH, { left: 200, top: 400, right: 260, bottom: 440, width: 60 }, 800, 600);
      expect(r.left).toBe(100);
    });

    it('clamps callout to left edge (min 8px)', () => {
      const r = calcCalloutPosition(CW, CH, { left: 4, top: 400, right: 44, bottom: 440, width: 40 }, 800, 600);
      expect(r.left).toBe(8);
    });

    it('clamps callout to right edge (max vpWidth - calloutWidth - 8)', () => {
      const r = calcCalloutPosition(CW, CH, { left: 760, top: 400, right: 800, bottom: 440, width: 40 }, 800, 600);
      expect(r.left).toBe(532); // 800 - 260 - 8
    });

    it('arrow offset equals distance from clamped left to button centre', () => {
      // left=100, buttonCenterX=230 → offset=130
      const r = calcCalloutPosition(CW, CH, { left: 200, top: 400, right: 260, bottom: 440, width: 60 }, 800, 600);
      expect(r.arrowOffset).toBe(130);
    });

    it('arrow offset is clamped to minimum 16px', () => {
      // button at far left: clampedLeft=8, buttonCenterX=24 → raw offset=16=ARROW_MIN
      const r = calcCalloutPosition(CW, CH, { left: 4, top: 400, right: 44, bottom: 440, width: 40 }, 800, 600);
      expect(r.arrowOffset).toBeGreaterThanOrEqual(16);
    });

    it('arrow offset is clamped to max (calloutWidth - 16)', () => {
      const r = calcCalloutPosition(CW, CH, { left: 760, top: 400, right: 800, bottom: 440, width: 40 }, 800, 600);
      expect(r.arrowOffset).toBeLessThanOrEqual(CW - 16);
    });

    it('places callout above when there is enough space above', () => {
      // spaceAbove=400 >= CH+GAP=92 → above
      const r = calcCalloutPosition(CW, CH, { left: 200, top: 400, right: 260, bottom: 440, width: 60 }, 800, 600);
      expect(r.direction).toBe('above');
      expect(r.top).toBeLessThan(400);
    });

    it('places callout below when insufficient space above but space below', () => {
      // target near top; spaceAbove=20 < 92; spaceBelow=540 >= 92
      const r = calcCalloutPosition(CW, CH, { left: 200, top: 20, right: 260, bottom: 60, width: 60 }, 800, 600);
      expect(r.direction).toBe('below');
      expect(r.top).toBeGreaterThan(60);
    });

    it('returns direction "none" when neither above nor below fits', () => {
      // 400px-tall callout in 450px viewport: neither 200px above nor 210px below >= 412
      const r = calcCalloutPosition(CW, 400, { left: 200, top: 200, right: 260, bottom: 240, width: 60 }, 800, 450);
      expect(r.direction).toBe('none');
    });
  });
  ```

- [ ] **Step 2: Run tests — expect FAIL**

  ```
  cd web && npm test -- tutorial.test
  ```

  Expected: `calcCalloutPosition` is not exported — import fails.

---

## Task 4: Implement `calcCalloutPosition` + rewrite `positionCallout`

**Files:**
- Modify: `web/src/tutorial.ts`

- [ ] **Step 1: Add `CalloutPosition` interface and `calcCalloutPosition` after the `CalloutItem` interface**

  Insert immediately after the closing `}` of `export interface CalloutItem`:

  ```ts
  export interface CalloutPosition {
    top: number;
    left: number;
    arrowOffset: number;
    direction: 'above' | 'below' | 'none';
  }

  const _GAP = 12;       // px gap between callout edge and target
  const _EDGE = 8;       // min distance from viewport edge
  const _ARROW_MIN = 16; // min/max arrow offset from callout edge (keeps arrow tip inside box)

  export function calcCalloutPosition(
    calloutWidth: number,
    calloutHeight: number,
    targetRect: { left: number; top: number; right: number; bottom: number; width: number },
    vpWidth: number,
    vpHeight: number,
  ): CalloutPosition {
    const buttonCenterX = targetRect.left + targetRect.width / 2;
    const left = Math.max(_EDGE, Math.min(buttonCenterX - calloutWidth / 2, vpWidth - calloutWidth - _EDGE));
    const arrowOffset = Math.max(_ARROW_MIN, Math.min(buttonCenterX - left, calloutWidth - _ARROW_MIN));

    if (targetRect.top >= calloutHeight + _GAP) {
      return { top: targetRect.top - _GAP - calloutHeight, left, arrowOffset, direction: 'above' };
    }
    if (vpHeight - targetRect.bottom >= calloutHeight + _GAP) {
      return { top: targetRect.bottom + _GAP, left, arrowOffset, direction: 'below' };
    }
    return { top: Math.max(_EDGE, (vpHeight - calloutHeight) / 2), left, arrowOffset, direction: 'none' };
  }
  ```

- [ ] **Step 2: Replace the `positionCallout` function**

  Replace the existing `positionCallout` implementation:

  ```ts
  function positionCallout(callout: HTMLElement, target: HTMLElement): void {
    const rect = target.getBoundingClientRect();
    const pos = calcCalloutPosition(
      callout.offsetWidth || 260,
      callout.offsetHeight || 80,
      rect,
      window.innerWidth,
      window.innerHeight,
    );
    callout.style.top = `${pos.top}px`;
    callout.style.left = `${pos.left}px`;
    callout.style.transform = '';
    callout.style.setProperty('--arrow-offset', `${pos.arrowOffset}px`);
    callout.classList.remove('callout-above', 'callout-below', 'callout-no-arrow');
    callout.classList.add(
      pos.direction === 'above' ? 'callout-above' :
      pos.direction === 'below' ? 'callout-below' : 'callout-no-arrow',
    );
  }
  ```

- [ ] **Step 3: Run tutorial tests — expect all 12 pass**

  ```
  cd web && npm test -- tutorial.test
  ```

  Expected: 12 tests pass (3 from Task 1 + 9 new).

- [ ] **Step 4: Run full test suite**

  ```
  cd web && npm test
  ```

  Expected: all existing tests pass.

- [ ] **Step 5: Commit**

  ```
  git add web/src/tutorial.ts web/src/tutorial.test.ts
  git commit -m "feat: calcCalloutPosition — viewport clamping and arrow offset geometry (#74, #75)"
  ```

---

## Task 5: Add CSS arrow styles

**Files:**
- Modify: `web/public/styles.css`

- [ ] **Step 1: Append arrow rules after the `#callout-got-it` block**

  Locate the line `#callout-got-it { ... }` block (currently the last callout CSS rule at ~line 1080) and append after its closing `}`:

  ```css
  /* Sliding arrow pointer — tracks the target button's centre via --arrow-offset */
  #callout::before {
    content: '';
    position: absolute;
    left: var(--arrow-offset, 50%);
    transform: translateX(-50%);
    width: 0;
    height: 0;
  }

  #callout.callout-above::before {
    bottom: -8px;
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    border-top: 8px solid var(--accent);
  }

  #callout.callout-below::before {
    top: -8px;
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    border-bottom: 8px solid var(--accent);
  }

  #callout.callout-no-arrow::before { display: none; }
  ```

- [ ] **Step 2: Type-check (no logic changed)**

  ```
  cd web && tsc --noEmit
  ```

  Expected: no errors.

- [ ] **Step 3: Commit**

  ```
  git add web/public/styles.css
  git commit -m "feat: callout arrow — CSS pointer slides to track target button (#74, #75)"
  ```

---

## Task 6: Add `feedback-btn` callout

**Files:**
- Modify: `web/src/main.ts` (~line 528, the `playingCallouts` array in `renderPlayingMode`)

- [ ] **Step 1: Insert `feedback-btn` entry after `help-btn`**

  Locate:
  ```ts
    { id: 'help-btn',      text: 'Re-open this guide at any time.' },
    { id: 'config-btn',    text: 'Configure which logical rules run automatically.' },
  ```

  Replace with:
  ```ts
    { id: 'help-btn',      text: 'Re-open this guide at any time.' },
    { id: 'feedback-btn',  text: 'Found a bug or have a suggestion? Tap the envelope to send feedback.' },
    { id: 'config-btn',    text: 'Configure which logical rules run automatically.' },
  ```

- [ ] **Step 2: Run full bronze gate**

  ```
  cd web && tsc --noEmit && tsc -p tsconfig.node.json --noEmit && npm test
  ```

  Expected: type check clean, all tests pass.

- [ ] **Step 3: Commit**

  ```
  git add web/src/main.ts
  git commit -m "feat: add feedback-btn tutorial callout (#74)"
  ```

---

## Task 7: Push + PR

- [ ] **Step 1: Push branch and open PR targeting master**

  ```
  git push -u origin feature/callout-improvements
  gh pr create \
    --title "feat: callout improvements — pointer arrows, viewport clamping, loop fix" \
    --body "Fixes #75 (infinite loop on missing elements), closes #74 (feedback-btn callout). Adds sliding CSS arrow pointer and mobile viewport clamping to all callouts."
  ```

- [ ] **Step 2: Merge PR and delete branch once CI is green**
