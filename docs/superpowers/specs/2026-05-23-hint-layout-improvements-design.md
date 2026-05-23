# Hint Layout Improvements — Design Spec (Issue #116)

## Context

Two layout problems in the playing-mode header:

1. **Fast-forward button** (`#fast-forward-btn`) uses `.btn-secondary` with the text
   "⏩ Fast Forward", making it wider than the icon-only buttons around it. When the
   animation lock activates it, the extra width pushes the grid to the right.

2. **Hints dropdown** (`#hints-dropdown`) is an absolutely-positioned `<div>` with
   `max-width: 380px` and no `max-height`. On puzzles with many hints, or on small
   viewports, the list overflows.

---

## Design

### 1 — Fast-forward button overlay

**Goal:** Fast-forward appears during animation with no layout shift.

**Approach:** The hints button is disabled during animation (part of `lockable` in
`setAutoApplyLock`), so its space is always available. Move `#fast-forward-btn`
inside `#action-group` immediately after `#hints-btn` and position it absolutely
over the same cell.

**HTML change** (`web/index.html`):
- Remove the text label; keep only the emoji: `⏩`
- Add class `btn-icon` (removes it from `.btn-secondary` only — both classes can
  coexist, but `btn-icon` enforces the fixed 2.25 rem × 2.25 rem size)
- Move the element to immediately after `#hints-btn` inside `#action-group`

**CSS change** (`web/public/styles.css`):
```css
#fast-forward-btn {
  position: absolute;
  inset: 0;
}
```

`#action-group` already carries `.hints-anchor` which sets `position: relative`.
With `inset: 0` the fast-forward button fills exactly the same bounding box as the
hints button. `hidden` toggling in `autoApplyLock.ts` requires no changes.

**No JS changes required.**

---

### 2 — Hints list modal

**Goal:** Replace the overflow-prone dropdown with a `<dialog>` that is always
fully visible and keyboard-accessible.

**HTML change** (`web/index.html`):
- Remove `<div id="hints-dropdown" class="hints-dropdown" hidden></div>`
- Add a new `<dialog id="hints-list-modal">` in the `<main>` dialogs section:

```html
<dialog id="hints-list-modal">
  <h2>Available Hints</h2>
  <div id="hints-list-content"></div>
  <div class="form-actions">
    <button id="hints-list-close-btn" class="btn-secondary">Close</button>
  </div>
</dialog>
```

**CSS changes** (`web/public/styles.css`):
- Remove `.hints-dropdown` rule (no longer needed)
- Keep `.hints-anchor` rule (`position: relative`) — still required so the fast-forward
  button can be positioned absolutely within `#action-group`
- Keep `.hint-item` and `.hints-empty` — reused by the modal's list content
- Add sizing for the new modal:

```css
#hints-list-modal {
  max-width: 520px;
  width: 90vw;
}

#hints-list-content {
  max-height: 60vh;
  overflow-y: auto;
}
```

**JS changes** (`web/src/main.ts`):
- Remove the document-level click-outside listener that closed `#hints-dropdown`
- Rewrite the `#hints-btn` click handler:
  - Build hint buttons into `#hints-list-content` (same logic as before)
  - Open with `hintsListModal.showModal()` instead of `dropdown.hidden = false`
  - Each hint button's click: `hintsListModal.close(); showHintModal(hint)`
- Add `#hints-list-close-btn` click handler: `hintsListModal.close()`
- Add backdrop-click-to-dismiss on the dialog:
  ```ts
  hintsListModal.addEventListener('click', e => {
    if (e.target === hintsListModal) hintsListModal.close();
  });
  ```

**Flow:** 💡 click → hints list modal opens → user clicks a hint → list modal
closes → existing hint-detail modal opens (no changes to detail modal or its
apply/close/minimise handlers).

---

## Files to Change

| File | Change |
|---|---|
| `web/index.html` | Move + shrink `#fast-forward-btn`; remove `#hints-dropdown`; add `#hints-list-modal` dialog |
| `web/public/styles.css` | Add `#fast-forward-btn` absolute positioning; remove `.hints-dropdown`; add `#hints-list-modal` + `#hints-list-content` sizing |
| `web/src/main.ts` | Rewrite `#hints-btn` handler; add `#hints-list-close-btn` + backdrop-click handlers; remove click-outside listener |

---

## Out of Scope

- No changes to the hint-detail modal (`#hint-modal`) or its handlers
- No changes to `autoApplyLock.ts` or `setAutoApplyLock`
- No aesthetic changes (colours, typography)
