# UI Specification — COACH

> Read this before working on the frontend (`static/`) or any behaviour
> visible to the user. For the coaching API and session lifecycle see
> `docs/architecture.md`. For rule internals see `docs/rules.md`.

---

## Application Flow

```
Upload Screen
    │  image processed successfully
    ▼
OCR Review Screen
    │  layout confirmed (POST /confirm)
    ▼
Playing Screen ──► Solution Screen (puzzle complete)
```

The upload panel collapses once an image has been processed successfully.
Navigating back to "New puzzle" reloads the page.

---

## Upload Screen

**Components**

| Element | Description |
|---|---|
| Newspaper select | `guardian` or `observer` — determines OCR model |
| File input | Accepts any image format (`image/*`) |
| Process button | Submits image to `POST /api/puzzle` |
| Status message | Shows progress, warnings, and errors inline |

**Behaviour**

- On success: upload panel hides; OCR Review Screen appears.
- On warning (OCR validation failed but partial result available): review screen
  shows with a warning banner; warped grid and detected layout are both visible
  so the user can inspect what went wrong.
- On error (grid not locatable): status shows the error; upload panel remains
  visible for retry.
- **Unimplemented:** If the application is launched with a puzzle path as an
  argument, the upload panel is not shown at all; the app opens directly at the
  OCR Review Screen.

---

## OCR Review Screen

**Layout**

Three columns:

| Column | Always visible? | Description |
|---|---|---|
| Detected Layout | Always | Canvas showing OCR result — borders and cage totals |
| Original Photo | Always | Uploaded image for comparison |
| Warped Grid | Only on warning | Perspective-corrected image when validation failed |

Below the columns:

- **Action bar**: "Looks correct — solve!" and "Edit cage totals".
- **Cage totals editor** (hidden until "Edit cage totals" pressed): a table of
  `Cage | Cells | Total` rows with editable totals, plus a "Solve puzzle"
  button.

**Clicking a cage boundary** (in Detected Layout canvas) toggles the boundary
between cage boundary and internal cell boundary.

**Clicking a cage total** (or a cell with no total) opens an inline editor for
that cage's total.

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

### Hints Dropdown

Lists all currently applicable hints sorted by impact. Each hint shows:
- Rule display name
- Brief explanation
- Elimination count (or placement action)

Clicking a hint opens the **Hint Modal**.

### Hint Modal

Shows the hint's title, full explanation, and summary. Two actions:

- **Apply automatically** — posts to `/api/puzzle/{id}/hints/apply` and refreshes.
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
- User-eliminated solutions (struck through, restorable)

Clicking a solution row toggles its elimination status.

### Virtual Cage Panel

Activated by "Virtual cage". The user clicks cells on the grid to select them
(indigo underlay), enters a total, and presses "Add". Cancel clears the selection.

**Bug (known):** When the total input field is focused, digit keys also place
digits into the last selected cage cell. Fix: suppress the grid keydown handler
while the total input has focus. See Known Issues #2.

---

## Config Modal

Opened via "Config" in the header.

**Rule list**: one row per hintable rule.
- Checkbox: toggles the rule between always-apply and hint-only.
- Rule display name.
- **(i) button**: opens an **Rule Info Modal** (see below) explaining the rule.

**Essential highlight toggle**: enables or disables the salmon highlight that
marks essential digits. Disabled state leaves essential digits grey, identical
to inessential.

Save / Cancel. Changes to `always_apply_rules` take effect immediately on the
next candidates refresh.

### Rule Info Modal

A small modal (or popover) triggered by the (i) button next to each rule. Shows:

- Rule display name
- A plain-English description of what the rule detects and why it helps.
- Whether the rule is always-apply, hint-only, or (if applicable) always-apply
  by default.

The description is sourced from the rule's `description` class attribute
(added as part of implementing this feature). `GET /api/settings` returns
descriptions alongside names so no additional endpoint is required.

---

## Help Facilities

### Existing

| Trigger | Content |
|---|---|
| **?** button (playing screen) | Candidates help modal — explains the candidate grid, essential digits, auto/manual mode, cycling states, solved cell behaviour |

### Proposed

**1. Rule info modals** (in config — described above).  
One modal per rule, triggered by the (i) button. Self-contained; no new endpoint
needed once `description` is added to `RuleInfo`.

**2. General app help** (header "?" or "Help" button).  
A single modal covering:
- What COACH does (image → candidates → hints → solution)
- How to work through each phase (upload, review, playing)
- What always-apply rules are and when to change them
- What virtual cages are and when to use them
- Keyboard shortcuts table

This modal is static HTML (no API call). It is the single onboarding reference
for new users and replaces having no general help at all.

---

## Known UI Issues

1. **Candidate cycling allows toggling essential state** (COACH.md #2). The
   cycle should be possible ↔ impossible only. Essential is auto-computed and
   must not be user-overridable.

2. **Virtual cage total input conflicts with digit entry** (architecture.md).
   Digit keys fire the grid keydown handler while the total input has focus,
   placing digits in the last selected cell.

3. **Undo has no visible effect** (COACH.md #4). The `/undo` endpoint correctly
   reverts server state but the frontend does not re-render after the response.

4. **Arrow navigation not yet implemented.** Keyboard arrow keys do not move
   cell selection.

5. **Upload panel does not collapse after successful processing.**

6. **No essential highlight toggle in config.**

7. **No rule info (i) modals in config.**
