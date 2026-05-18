# Responsive Playing Layout

**Date:** 2026-05-18
**Status:** Approved, pending implementation

## Goal

Make the grid as large as possible in both portrait and landscape orientations by
reorienting the header/action bar and digit pad to match the available axis.

- **Portrait:** header bar at top, digit pad at bottom, grid fills full width
- **Landscape:** header+actions become a left sidebar, digit pad becomes a right sidebar,
  grid fills available height

The grid is always square (aspect-ratio: 1) and always as large as possible.

---

## Layout

### Portrait playing mode

```
┌─────────────────────────────────────┐  ← sticky header
│ K  [↩][💡][N|C][🔍][➕][👁]  🏠?⚙✉ │
└─────────────────────────────────────┘
│                                     │
│      grid  (aspect-ratio: 1,        │
│             fills available width,  │
│             bounded by available    │
│             height)                 │
│                                     │
│    [1][2][3][4][5]                  │
│    [6][7][8][9][X]                  │
└─────────────────────────────────────┘
```

### Landscape playing mode

```
┌──────┬───────────────────────────┬───────┐
│  K   │                           │ 1 │ 6 │
│ ─── │   grid  (aspect-ratio: 1, │ 2 │ 7 │
│  ↩  │   fills available height, │ 3 │ 8 │
│  💡  │   bounded by available    │ 4 │ 9 │
│ N|C │   width)                  │ 5 │ X │
│  🔍  │                           └───────┘
│  ➕  │
│  👁  │
│ ─── │
│  🏠  │
│  ?  │
│  ⚙  │
│  ✉  │
└──────┘
```

---

## HTML changes (`web/index.html`)

- Replace `<h1>COACH</h1>` with `<div id="logo-k" class="logo-k">K</div>`
- Introduce `<div id="side-panel">` inside `#canvas-col`, wrapping the three
  mutually-exclusive panels:

```html
<div id="canvas-col">
  <h2 id="detected-layout-heading">Detected Layout</h2>
  <div id="canvas-wrapper">…</div>
  <div id="side-panel">
    <div id="playing-actions" hidden>…digit pad…</div>
    <div id="inspector-col" hidden>…</div>
    <div id="virtual-cage-col" hidden>…</div>
  </div>
</div>
```

`#inspector-col` and `#virtual-cage-col` are moved from being siblings of `#canvas-col`
in `#images-row` to being children of `#side-panel`. Exactly one child of `#side-panel`
is visible at any time. JS show/hide logic (toggling `hidden`) is unchanged.

**Review-mode side-effect:** inspector and virtual-cage panels now appear below the
detected-layout canvas rather than as a 4th column. The canvas gains more horizontal
space as a result.

---

## CSS changes (`web/public/styles.css`)

### New custom properties (`:root`)

```css
--header-h: 48px;     /* measured sticky header height */
--digit-pad-h: 88px;  /* measured digit pad + margin height */
```

### K logo badge

```css
.logo-k {
  /* Blue rounded rect matching favicon */
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
}
```

### Canvas sizing (container queries)

`#canvas-col` gets `container-type: size`.

`#canvas-wrapper` rule replaces all existing `max-width: clamp(...)` playing-mode rules:

```css
body:has(#playing-actions:not([hidden])) #canvas-wrapper {
  width: min(100cqw, 100cqh);
  aspect-ratio: 1;
}
```

In portrait, `#canvas-col` height is bounded by:
```css
body:has(#playing-actions:not([hidden])) #canvas-col {
  height: calc(100dvh - var(--header-h) - var(--digit-pad-h) - 1.5rem);
}
```
(The `1.5rem` covers card/margin padding; exact value confirmed during implementation.)

### Landscape playing mode

Scoped entirely to:
```css
@media (orientation: landscape) {
  body:has(#playing-actions:not([hidden])) { … }
}
```

**Body becomes a two-column grid:**
```css
display: grid;
grid-template-columns: auto 1fr;
height: 100dvh;
overflow: hidden;
```

**`.sticky-bars` becomes the left sidebar:**
```css
height: 100dvh;
overflow-y: auto;
```

**`header` fills the sidebar height:**
```css
height: 100%;
```

**`.header-inner` stacks vertically:**
```css
flex-direction: column;
align-items: center;
justify-content: space-between;
padding: 0.5rem 0;
height: 100%;
```

**`#action-group` stacks vertically:**
```css
flex-direction: column;
margin-left: 0;
```

**N|C pill rotates 90°:**
```css
#mode-toggle {
  transform: rotate(90deg);
}
```

**`<main>` fills right column:**
```css
height: 100dvh;
overflow: hidden;
```

**`#canvas-col` becomes a flex row (canvas left, side-panel right):**
```css
display: flex;
flex-direction: row;
align-items: center;
height: 100dvh;
```

The `height` override on `#canvas-col` from portrait mode is removed in landscape
(container-query sizing handles both orientations from the same `min(100cqw, 100cqh)` rule).

**`#side-panel` becomes the right strip:**
```css
display: flex;
flex-direction: column;
align-items: center;
justify-content: center;
padding: 0.5rem;
overflow-y: auto;
```

`#playing-actions`, `#inspector-col`, and `#virtual-cage-col` stack inside it;
only one is visible at a time, so no extra layout logic is needed.

**`#playing-actions` strip (portrait margin removal):**
```css
margin-top: 0;
```

**Digit pad reflows to two vertical columns:**
```css
.digit-pad {
  grid-template-columns: repeat(2, 3rem);
  grid-template-rows: repeat(5, auto);
  grid-auto-flow: column;
  margin-top: 0;
}
```

Result: items fill column-first → `[1][6] / [2][7] / [3][8] / [4][9] / [5][X]`.

### Removals

- `max-width: clamp(...)` rules on `#canvas-col` in playing mode (both portrait and
  landscape variants) — replaced by container-query rule above
- `body:has(#action-group:not([hidden])) .header-sub` hide rule — no subtitle in HTML
  after the `<h1>` → K replacement
- `body:has(#action-group:not([hidden])) #new-puzzle-btn { margin-left: auto }` override
  — not needed once `.header-inner` uses `justify-content: space-between` in landscape;
  portrait still needs it, so only the landscape override is removed

---

## JS changes (`web/src/main.ts`)

None required. The canvas `ResizeObserver` already triggers a redraw whenever the
CSS-rendered size changes, covering both portrait↔landscape transitions.

---

## Testing

- Bronze gate: `tsc --noEmit`, `npm test` — must pass before commit
- Silver gate: Playwright tests against production build — no test changes expected
  since button IDs are unchanged
- Manual check: rotate device (or DevTools responsive mode) between portrait and
  landscape in playing mode; verify grid fills available space and remains square
