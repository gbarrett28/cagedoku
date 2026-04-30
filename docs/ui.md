# UI Specification — COACH

> Read this before working on the frontend (`web/src/`) or any behaviour
> visible to the user. For the coaching API and session lifecycle see
> `docs/architecture.md`. For rule internals see `docs/rules.md`.

---

## Application Flow

```
Upload Screen
    │  image processed (success or OCR failure)
    ▼
OCR Review Screen
    │  "Confirm & Solve" pressed, layout valid
    ▼
Playing Screen ──► Solution Screen (puzzle complete)
```

The upload panel collapses once processing completes, whether or not OCR
succeeded. Navigating back via "New puzzle" returns to the upload screen.

---

## Upload Screen

**Components**

| Element | Description |
|---|---|
| File input | Accepts any image file (`image/*`). PDF support planned (see below). |
| Process button | Runs the image pipeline locally (no server required). |
| Status message | Shows progress and warnings inline. Never blocks on error — see Behaviour. |

**Behaviour**

- After processing, the upload panel hides and the OCR Review Screen always
  appears — even if OCR failed to detect cages. On total failure a blank canvas
  is shown (no borders, no cage totals) with a warning message so the user can
  build the layout from scratch.
- If a warning was produced (e.g. cage totals out of range, sum ≠ 405), it
  appears in the status bar below the review columns.
- The upload panel never blocks with a hard error; the user always reaches the
  review screen.

**PDF support (planned, not yet implemented)**

Accept `application/pdf` in the file input. Extract the first page as an image
using pdf.js, then pass it through the existing image pipeline. No other changes
required.

---

## OCR Review Screen

The review screen is always in **edit mode** from the moment it appears.
There is no separate "edit" button or confirmation step before editing.
All changes — border toggles and cage total edits — are **committed when the
user presses "Confirm & Solve"**. Until then, edits are freely reversible.

**Layout**

Three columns, left to right:

| Column | Description |
|---|---|
| Detected Layout | Interactive canvas — borders and cage totals |
| Original Photo | Uploaded image for visual comparison |
| Warped Grid | Perspective-corrected image (always shown) |

The detected puzzle type (Killer / Classic) appears in the dropdown in the
action bar. The user can change it if OCR misdetected the type.

**Editing borders (Killer only)**

Click near a border segment on the canvas to toggle it between cage boundary
and internal cell boundary. There is no explicit save step; the current state
of all borders is committed on Confirm.

**Editing cage totals (Killer only)**

Any cell can hold a cage total. Click any cell on the canvas:

- The `cage-total-edit` input overlays the entire clicked cell, sized to fill
  it, with a large centred font so the value is clearly readable while editing.
- The existing total (or blank if none) is pre-populated.
- **Enter** or clicking elsewhere commits the value to that cell.
- **Escape** cancels and restores the previous value.

**Classic digit correction**

Click a cell, then type a digit (1–9) to correct an OCR misread. Backspace
clears the cell. Duplicate digits in the same row, column, or box are
highlighted in red.

**Action bar**

| Control | Description |
|---|---|
| Confirm & Solve | Validates the layout and transitions to Playing mode |
| Type dropdown | `Killer` / `Classic` — changeable if OCR misdetected |

Confirm runs the following checks in order:

1. **Structural**: each cage (connected component from border toggles) must have
   exactly one non-zero total cell.
2. **Range**: each cage total must be in the achievable range for its size
   `[n(n+1)/2, n(19−n)/2]`. Out-of-range totals are highlighted; user must
   correct before confirming.
3. **Partition validity**: the borders form a valid partition of all 81 cells
   into connected, non-overlapping cage regions. (This is structurally guaranteed
   by the union-find construction; reported if the internal representation is
   inconsistent.)
4. **Sum advisory**: if the total of all cage totals differs significantly from
   405, a warning is shown but does not block confirmation.

If any of checks 1–3 fail, the review screen remains open with an error message
and the problematic cages highlighted in amber on the canvas.

---

## Playing Screen

### Grid Canvas

Renders the 9×9 sudoku grid with the following layers (back → front):

1. White background
2. Virtual cage underlays (teal/violet/pink/orange tints, one per cage)
3. Virtual cage selection underlay (indigo, while drawing a new cage)
4. Selected cell highlight (light blue)
5. Hint highlight cells (yellow)
6. Thin dashed lines for internal cell boundaries
7. Medium solid lines for 3×3 box boundaries
8. Thick outer border
9. Red cage boundary lines
10. Cage total numbers (top-left of first cell in cage)
11. Placed digits (large, centred)
12. Candidate sub-grid (3×3 keypad layout per cell, when candidates shown)
    - Grey: possible but not essential
    - Salmon: essential (must appear in every valid cage solution) — toggleable via config
    - Struck-through: user-removed

### Cell Selection and Navigation

- Click a cell to select it (blue highlight).
- **Arrow keys** move the selection one cell in the pressed direction, wrapping
  at grid edges.
- Digit keys 1–9 place a digit in the selected cell.
- Delete / Backspace clears the selected cell.
- Selection is cleared when leaving playing mode.

### Action Bar

| Button | Condition | Description |
|---|---|---|
| Undo | Always (disabled until a move exists) | Revert the last digit entry |
| Hints | Always (disabled until confirmed) | Open hints dropdown |
| Show candidates | Always (disabled until confirmed) | Toggle candidate sub-grid |
| Edit candidates | Visible when candidates shown | Enter candidate editing mode |
| ? | Visible when candidates shown | Open candidates help modal |
| Inspect cage | Visible when candidates shown | Enter cage inspection mode |
| Virtual cage | Visible when candidates shown | Enter virtual cage drawing mode |
| Reveal | Visible when a cell is selected | Reveal the solution digit for the selected cell after a confirmation popup |

### Reveal

Pressing **Reveal** with a cell selected opens a small confirmation popup:
"Reveal solution for r{R}c{C}?" with OK and Cancel. On OK, the solver computes
the full solution (if not already cached), then places the correct digit in the
selected cell via the normal `enterCell` path so that undo works as expected.

### Hints Dropdown

Lists all currently applicable hints sorted by impact. Each hint shows:
- Rule display name
- Brief explanation
- Elimination count (or placement action)

Clicking a hint opens the **Hint Modal**.

### Hint Modal

Shows the hint's title, full explanation, and summary. Two actions:

- **Apply automatically** — applies the deduction and refreshes.
- **Close & apply by hand** — closes modal; the user acts manually.

### Candidate Editing Mode

Activated by "Edit candidates". Each digit in a cell cycles:

```
Inessential (grey) → Impossible (hidden) → Inessential (grey) → …
```

The essential state is **auto-computed only** — it cannot be set or cleared by
the user. (Note: the current implementation incorrectly allows cycling through
essential; this is a known bug — see Known Issues #1.)

Delete / Backspace in editing mode resets the cell's candidates to their
auto-computed state.

### Cage Inspector

Activated by "Inspect cage" then clicking a cell. Shows:

- Cage label and total
- All valid solutions (digit combinations)
- Auto-impossible solutions (greyed out)
- User-eliminated solutions (struck through, restorable by clicking)

Clicking a non-auto-impossible solution row toggles its user-eliminated status.

### Virtual Cage Panel

Activated by "Virtual cage". The user clicks cells on the grid to select them
(indigo underlay), enters a total, and presses "Add". Cancel clears the selection.

The panel lists **only the virtual cages that contain the currently selected
cell** (not all virtual cages). This keeps the list manageable when many virtual
cages have been added.

User-eliminated solutions in the virtual cage panel appear and behave identically
to user-eliminated solutions in the Cage Inspector (struck through, restorable by
clicking).

---

## Config Modal

Opened via "Config" in the header.

**Rule list**: one row per hintable rule.
- Checkbox: toggles the rule between always-apply and hint-only.
- Rule display name.
- **(i) button**: opens a **Rule Info Modal** (see below) explaining the rule.

**Essential highlight toggle**: enables or disables the salmon highlight that
marks essential digits. Disabled state leaves essential digits grey, identical
to inessential.

Save / Cancel. Changes to `always_apply_rules` take effect immediately on the
next candidates refresh.

### Rule Info Modal

A small modal triggered by the (i) button next to each rule. Shows:

- Rule display name
- A plain-English description of what the rule detects and why it helps.

---

## Help Facilities

| Trigger | Content |
|---|---|
| **?** (header) | General app help modal — phases, candidates, hints, virtual cages, keyboard shortcuts |
| **?** (playing screen, candidates shown) | Candidates-specific help modal |
| **(i)** (config, next to each rule) | Rule info modal |

---

## Known UI Issues

1. **Candidate cycling allows toggling essential state.** The cycle should be
   possible ↔ impossible only. Essential is auto-computed and must not be
   user-overridable.

2. **Undo has no visible effect.** The undo action correctly reverts state but
   the frontend does not re-render after the response.

3. **Arrow navigation not implemented.** Keyboard arrow keys do not move cell
   selection.
