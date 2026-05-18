# Spec: Playing Screen Layout Redesign

## Goal

Move the playing-mode action buttons out of the grid column into a sticky bar
below the page header, and compact the digit pad into a 2-row rectangle below
the grid.

---

## Scope

Affects the **playing mode** layout only. The OCR review screen is unchanged.
Classic review mode (digit pad only, action group hidden) continues to work as
before — the action bar is not shown during review.

---

## HTML Changes (`web/index.html`)

### 1. New sticky wrapper

Wrap the existing `<header>` and a new `<div id="action-bar" hidden>` in a
`<div class="sticky-bars">`:

```html
<div class="sticky-bars">
  <header>…</header>             <!-- unchanged -->
  <div id="action-bar" hidden>   <!-- new -->
    <div id="action-group" class="form-actions hints-anchor">
      <!-- all existing action buttons moved here -->
    </div>
  </div>
</div>
```

### 2. `#action-group` relocates

`#action-group` (and the `#hints-dropdown` inside it) moves from its current
position inside `#playing-actions` / `#canvas-col` into `#action-bar`.
The button IDs, event handlers, and visibility logic are unchanged.

### 3. `#playing-actions` after the move

`#playing-actions` retains only:
- `.digit-pad` — 2-row numeral grid
- `#completion-msg` — shown below the digit pad when the puzzle is solved

The `<p id="completion-msg">` moves to below `.digit-pad` (currently it is
above the digit pad; swap the order).

---

## CSS Changes (`web/public/styles.css`)

### 1. Sticky wrapper

```css
.sticky-bars {
  position: sticky;
  top: 0;
  z-index: 100;
}
```

### 2. Action bar

```css
#action-bar {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0.625rem 2rem;
}
```

The `#action-group` inside uses the existing `.form-actions` class (flex row,
wrapping, gap), so no additional layout CSS is needed for the buttons.

On narrow screens (`max-width: 620px`), reduce padding to match the header:
```css
@media (max-width: 620px) {
  #action-bar { padding: 0.625rem 1rem; }
}
```

### 3. Digit pad — 2-row grid

Replace the current `flex-wrap` layout with a fixed 5-column CSS grid:

```css
.digit-pad {
  display: grid;
  grid-template-columns: repeat(5, 3rem);
  gap: 0.35rem;
  margin-top: 0.75rem;
}
```

This produces exactly:
```
[ 1 ][ 2 ][ 3 ][ 4 ][ 5 ]
[ 6 ][ 7 ][ 8 ][ 9 ][ X ]
```

The mobile override `max-width: none` is removed (no longer needed with grid
layout). The mobile `digit-btn` size increase (`3.25rem`) is kept.

### 4. Canvas height recalculation

The `:has()` selectors that set `max-width` on `#canvas-col` use `100vh - Xpx`
to keep the square grid within the viewport. The sticky bars are now taller
(header ≈ 58 px + action bar ≈ 50 px vs. header alone ≈ 58 px), so the digit
pad area below the grid is now smaller. The net effect on the offset is small;
the value needs empirical tuning at implementation time. Start with
`100vh - 360px` (portrait) and `100vh - 200px` (landscape playing mode) and
adjust visually.

---

## JavaScript Changes (`web/src/main.ts`)

### 1. `renderPlayingMode`

Add one line to show the action bar:
```ts
el<HTMLElement>('action-bar').hidden = false;
```

### 2. State resets

Wherever `#playing-actions` and `#solution-panel` are hidden (new-puzzle reset,
`DOMContentLoaded` initial state), also hide `#action-bar`:
```ts
el<HTMLElement>('action-bar').hidden = true;
```

Affected locations: `DOMContentLoaded` setup block and the new-puzzle button
handler.

### 3. Review mode (Classic)

No change needed. `renderState` and the Classic review path do not touch
`#action-bar`, so it stays hidden. `#playing-actions` (digit pad) is shown as
before for Classic review.

---

## Out of scope

- Any change to button IDs, event handlers, or game logic.
- The `#solution-panel` section (currently always hidden; unrelated).
- Mobile hamburger menu or collapsible action bar.
