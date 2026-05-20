# Callout Improvements Design

**Date:** 2026-05-20
**Issues:** #74 (feedback-button callout), #75 (infinite loop bug)
**Scope:** `web/src/tutorial.ts`, `web/public/styles.css`, `web/src/main.ts`

---

## Context

The tutorial callout system walks users through the UI one button at a time. Three problems exist:

1. **Bug #75** — `advanceCallout()` recurses when a target element is absent from the DOM. On mobile, several elements in the playing-screen sequence (e.g. `inspect-cage-btn` for classic puzzles) may be absent, causing consecutive misses and unbounded recursion.
2. **Enhancement #74** — The feedback button (`feedback-btn`, envelope icon) has no callout, so users don't know what it does.
3. **UX** — Callouts have no visual pointer connecting them to the button they describe, and the horizontal positioning does not prevent the callout box from overflowing the viewport on narrow screens (e.g. 411 px mobile).

---

## 1. Bug Fix — Iterative `advanceCallout()`

Replace the recursive call-on-missing-element with a `while` loop that drains silently past absent elements:

```ts
function advanceCallout(): void {
  let item: CalloutItem | undefined;
  let target: HTMLElement | null = null;
  while ((item = calloutQueue.shift()) !== undefined) {
    target = document.getElementById(item.id);
    if (target !== null) break;
  }
  if (item === undefined || target === null) {
    calloutRunning = false;
    return;
  }
  calloutRunning = true;
  showCallout(item, target);
}
```

`calloutRunning` is only set `true` when a callout is actually displayed, so subsequent `appendCallouts()` calls are never blocked by a ghost-running state.

---

## 2. Positioning & Arrow

### 2a. Viewport Clamping

`positionCallout()` currently clamps only the left edge (`Math.max(8, rect.left)`). The new logic centres the callout on the button and clamps both edges:

```
buttonCenterX = rect.left + rect.width / 2
preferredLeft = buttonCenterX - callout.offsetWidth / 2
clampedLeft   = clamp(preferredLeft, 8, vw - calloutWidth - 8)
```

Vertical logic (above if `spaceAbove > calloutHeight + 12`, else below) is unchanged, except the gap between callout edge and target is set to a fixed 12 px on the placed side.

Fallback order if neither above nor below fits (very small viewports):
1. Above (preferred)
2. Below
3. Centred vertically in the viewport, no arrow shown (`callout-no-arrow` class)

### 2b. Arrow — Sliding CSS `::before` Triangle

The arrow offset is the horizontal distance from the callout's left edge to the button's centre, clamped to keep the triangle inside the box:

```
arrowOffset = clamp(buttonCenterX - clampedLeft, 16, calloutWidth - 16)
```

This value is set as a CSS custom property: `callout.style.setProperty('--arrow-offset', arrowOffset + 'px')`.

Two mutually exclusive classes control direction:

| Class | Arrow position | Points |
|---|---|---|
| `callout-above` | `::before` at bottom of box | Down toward button |
| `callout-below` | `::before` at top of box | Up toward button |
| `callout-no-arrow` | No `::before` | — |

**CSS:**

```css
#callout::before {
  content: '';
  position: absolute;
  left: var(--arrow-offset, 50%);
  transform: translateX(-50%);
  border: 8px solid transparent;
}

#callout.callout-above::before {
  bottom: -8px;
  border-top-color: var(--accent);
  border-bottom: none;
}

#callout.callout-below::before {
  top: -8px;
  border-bottom-color: var(--accent);
  border-top: none;
}

#callout.callout-no-arrow::before {
  display: none;
}
```

The `#callout` element is `position: fixed`, which establishes the containing block for the `::before` pseudo-element. `overflow` is already `visible` (the CSS default, not overridden), so `bottom: -8px` / `top: -8px` correctly extends the arrow outside the box border.

---

## 3. Feedback-Button Callout

Add `feedback-btn` to the playing-screen callout sequence, immediately after `help-btn`, in both killer and classic sequences. The button is always present in the header regardless of puzzle type.

**Text:** `"Found a bug or have a suggestion? Tap the envelope to send feedback."`

**Updated sequence tail (both puzzle types):**
```
... → reveal-btn → digit-1 → help-btn → feedback-btn → config-btn → new-puzzle-btn
```

---

## Files Changed

| File | Change |
|---|---|
| `web/src/tutorial.ts` | Iterative `advanceCallout()`; rewritten `positionCallout()` |
| `web/public/styles.css` | Arrow `::before` rules; `overflow: visible` on `#callout` if needed |
| `web/src/main.ts` | `feedback-btn` callout step added to both sequences |

---

## Testing

- **Bug #75:** confirm the playing-screen sequence on a classic puzzle completes without hanging (no `inspect-cage-btn` or `virtual-cage-btn` in DOM).
- **Arrow + clamping:** resize viewport to 411 × 748; step through all callouts and verify the arrow always points at the button and the box stays fully on-screen.
- **Feedback callout:** step through to end of playing-screen sequence; verify `feedback-btn` callout appears after `help-btn`.
- **Bronze gate:** `tsc --noEmit` + `npm test` must pass (no logic changes in engine or session layers).
