# Design: Hint Pill Canvas Tracking

**Date:** 2026-05-24  
**Status:** Approved

---

## Problem

The hint pill (`#hint-pill`) uses `position: fixed; left: 50%; bottom: 5rem; transform: translateX(-50%)` — centering it on the full viewport width. This is incorrect in two ways:

- **Portrait playing mode**: works for a single-column viewport but `bottom: 5rem` is a magic number with no relationship to the canvas or digit pad positions.
- **Landscape playing mode**: the `.sticky-bars` sidebar occupies the left portion of the viewport; the canvas-col occupies the right. `left: 50%` of the viewport falls inside the sidebar, so the pill is misplaced.

The pill appears during hint animation to announce the rule being applied. It must be visually anchored to the canvas it is annotating.

---

## Goal

The pill should appear **below the canvas, above the digit pad** — in the gap between `#canvas-wrapper` and `#side-panel` — in both portrait and landscape playing mode.

---

## Layout Context

### Portrait playing mode

`#canvas-col` is `flex-direction: column`:
```
#canvas-col (flex-col)
  ├── #canvas-wrapper   (flex: 1, square, fills width)
  └── #side-panel       (flex-shrink: 0, contains digit pad)
```

### Landscape playing mode

`#canvas-col` is `flex-direction: row` (full-viewport height):
```
#canvas-col (flex-row, height: 100dvh)
  ├── #canvas-wrapper   (flex: 1, aspect-ratio: 1, fills height)
  └── #side-panel       (flex-shrink: 0, ~7.5rem wide, vertically centred)
```

The side-panel width in landscape ≈ `2 × 3rem (digit cols) + 0.35rem (gap) + 1rem (padding) = 7.35rem`, rounded to `7.5rem`.

---

## Solution: Approach B — In-flow for Portrait, Absolute for Landscape

### 1. HTML change (`web/index.html`)

Move `#hint-pill` from its current position (after `<dialog id="help-candidates-modal">`) into `#canvas-col`, between `#canvas-wrapper` and `#side-panel`:

```html
<div id="canvas-col">
  <div id="canvas-wrapper">
    <canvas id="grid-canvas"></canvas>
    <input id="cage-total-edit" ...>
  </div>

  <div id="hint-pill" hidden role="status" aria-live="polite">
    <span id="hint-pill-label"></span>
  </div>

  <div id="side-panel">
    ...
  </div>
</div>
```

### 2. CSS changes (`web/public/styles.css`)

**Remove** the existing `#hint-pill` rule:
```css
/* REMOVE */
#hint-pill {
  position: fixed;
  bottom: 5rem;
  left: 50%;
  transform: translateX(-50%);
  ...
}
```

**Replace** with a base rule (portrait, in-flow) plus a landscape override:

```css
/* Base styles (no positioning — in-flow flex child in portrait) */
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

/* Landscape playing mode: absolute-position pill at bottom of canvas area */
@media (orientation: landscape) {
  body:has(#playing-actions:not([hidden])) #hint-pill {
    position: absolute;
    bottom: 0.5rem;
    left: 0;
    right: 7.5rem;      /* side-panel width in landscape */
    margin: auto;
    width: max-content;
  }
}
```

This works because:
- **Portrait**: pill is a `flex-direction: column` child with `align-self: center`, sitting between canvas-wrapper and side-panel exactly.
- **Landscape**: `position: absolute` takes pill out of the flex-row flow. `left: 0; right: 7.5rem; margin: auto; width: max-content` distributes auto margins equally within the canvas portion, centering the pill horizontally on the canvas.
  - Requires `#canvas-col` to have `position: relative` (add this to the landscape playing rule).

### 3. `#canvas-col` needs `position: relative` in landscape

Add to the landscape playing-mode rule for `#canvas-col`:
```css
@media (orientation: landscape) {
  body:has(#playing-actions:not([hidden])) #canvas-col {
    position: relative;   /* ← add this */
    ...existing rules...
  }
}
```

---

## Files Changed

| File | Change |
|---|---|
| `web/index.html` | Move `#hint-pill` div into `#canvas-col` between canvas-wrapper and side-panel |
| `web/public/styles.css` | Replace `#hint-pill` fixed positioning with in-flow + landscape absolute rule; add `position: relative` to `#canvas-col` landscape rule |
| `web/src/hintPill.ts` | No changes needed |
| `web/src/main.ts` | No changes needed |

---

## No JS Changes Required

`showHintPill()` and `hideHintPill()` in `hintPill.ts` toggle `hidden` — no positioning logic is involved. The CSS handles all positioning declaratively.

---

## Testing

- Visual: Playwright screenshot in portrait and landscape viewports showing pill below canvas, above digit pad.
- Unit: Existing `hintPill.test.ts` continues to pass unchanged.
