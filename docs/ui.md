# UI Specification — COACH

> Read this before working on the frontend (`web/src/`) or any behaviour
> visible to the user. For the coaching API and session lifecycle see
> `docs/architecture.md`. For rule internals see `docs/architecture.md` § *Rule Contract*.

---

## Application Flow

```
Upload Screen
    │  image processed
    ▼
Auto-confirm attempt
    │ clean OCR + valid layout + solver complete        │ any check fails
    ▼                                                    ▼
Playing Screen ──► Solution Screen (puzzle complete)    OCR Review Screen (always has error message)
                                                             │  "Confirm & Solve" pressed, layout valid
                                                             ▼
                                                        Playing Screen ──► Solution Screen
```

After processing, the app attempts to auto-confirm the OCR result:
if the cage layout is structurally valid, totals sum to 405, and the solver
finds a complete assignment for all 81 cells, the review screen is skipped
entirely and the user lands directly in Playing mode.

The OCR Review Screen only appears when auto-confirm fails (OCR pipeline
warning, invalid cage layout, incorrect total sum, or solver stall).
**Invariant:** the status bar always contains a non-empty error or warning
message when the review screen is shown.

The upload panel collapses once processing completes. Navigating back via
"New puzzle" returns to the upload screen.

### Auto-Confirm Logic (implementation)

Auto-confirm applies to **Killer puzzles only**. Classic puzzles always proceed to
the OCR Review Screen so the user can verify the detected given digits.

`handleProcess()` runs these checks in order on the raw OCR output
(no draft edits applied):

| # | Check | Failure → status message |
|---|---|---|
| 1 | **OCR warning** — `uploadPuzzle()` returned a non-null `warning` | `Warning: <text>` — go straight to review |
| 2 | **Layout validation** — `applyDraftLayout()` returns no `errorCells` | *"Each cage needs exactly one total in its valid range — highlighted in red"* + amber highlights |
| 3 | **Sum** — cage totals sum to exactly 405 (returned as `warnings` by `applyDraftLayout()`) | *"Cage totals sum to N (expected 405) — please correct the totals before confirming"* |
| 4 | **Solver completion** — `solveCurrentSpec()` returns a board where every cell has exactly one candidate | *"Solver could not determine all cells — please check the cage layout and totals"* |

`solveCurrentSpec()` (`web/src/session/actions.ts`) runs `solve()` without
mutating state and returns a `BoardState`. `solve()` uses constraint-propagation
rules first and falls back to MRV backtracking if stalled. The completeness
check (all 81 cells with a single candidate) is done inline in `handleProcess()`.
This is not a uniqueness proof — it finds one complete assignment. For OCR'd
newspaper puzzles (always uniquely solvable) this is the appropriate proxy: a
complete assignment signals a plausible layout.

`confirmPuzzle(board: BoardState)` takes the board as a mandatory parameter —
it does not call the solver internally. On the auto-confirm path only one solver
pass occurs total (in `solveCurrentSpec()`); on the manual "Confirm & Solve"
path `handleConfirm()` calls `confirmPuzzle(solveCurrentSpec())` — also one pass.

No training data is uploaded on auto-confirm (`draftEdited` is `false`),
consistent with the existing behaviour when the user clicks "Confirm & Solve"
without making manual corrections.

---

## Upload Screen

**Components**

| Element | Description |
|---|---|
| File input | Accepts any image file (`image/*`). PDF support planned (see below). |
| Process button | Runs the image pipeline locally (no server required). |
| Status message | Shows progress and warnings inline. Never blocks on error — see Behaviour. |

**Behaviour**

- After processing, an auto-confirm attempt is made (see Application Flow).
  If it succeeds the user lands directly in Playing mode; the review screen
  is never shown. Auto-confirm only applies to Killer puzzles — Classic
  puzzles always proceed to the review screen.
- If auto-confirm fails (or the puzzle is Classic), the upload panel hides and
  the OCR Review Screen appears with a non-empty status message. On total OCR
  failure a blank canvas is shown (no borders, no cage totals) so the user can
  build the layout from scratch.
- The only exception to reaching the review screen is an unrecognised file
  format: if the browser cannot decode the selected file as an image, an error
  is shown on the upload screen and the user is asked to choose a different
  file.  All other failures (grid not found, pipeline errors, etc.) return a
  blank-grid placeholder and proceed to the review screen.

**PDF support (planned, not yet implemented)**

Accept `application/pdf` in the file input. Extract the first page as an image
using pdf.js, then pass it through the existing image pipeline. No other changes
required.

---

## OCR Review Screen

The review screen is only shown when auto-confirm fails; it always has a
non-empty error or warning message in the status bar when it appears.

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

Click a cell to select it (blue highlight), then tap a digit button (the digit
pad is shown below the review action bar for Classic puzzles) or type a digit
(1–9) to correct an OCR misread. Tap the ✕ button or Backspace to clear the
cell. Duplicate digits in the same row, column, or box are highlighted in red.

**Action bar**

| Control | Description |
|---|---|
| Confirm & Solve | Validates the layout and transitions to Playing mode |
| Type dropdown | `Killer` / `Classic` — changeable if OCR misdetected |

**Killer** — Confirm runs the following checks in order:

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

**Classic** — no cage validation. Confirm immediately runs the solver on the
detected (and optionally corrected) given digits and transitions to Playing mode.

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
| Inspect cage | Visible in **Killer** playing mode (always) | Enter cage inspection mode |
| Virtual cage | Visible in **Killer** playing mode (always) | Enter virtual cage drawing mode |
| Reveal | Visible when a cell is selected | Reveal the solution digit for the selected cell after a confirmation popup |

### Reveal

Pressing **Reveal** with a cell selected opens a small confirmation popup:
"Reveal solution for r{R}c{C}?" with OK and Cancel. On OK, the correct digit is
read from `goldenSolution` (cached at confirm time) and placed via the normal
`enterCell` path so that undo works as expected.

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

Activated by "Edit candidates". Pressing a digit key **or tapping a digit on the
digit pad** toggles it between two states:

| State | Appearance | Meaning |
|---|---|---|
| Possible | grey (or salmon if essential) | Still a valid candidate |
| Removed | hidden | Ruled out by the user |

The essential highlight (salmon) is **auto-computed only** — it cannot be set or
cleared by the user.

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

---

## Button / Control Inventory

Complete reference mapping every interactive element to the screen and state where it is visible.
The element IDs match the HTML (`index.html`).

### Header (always visible once a puzzle is loaded)

| Element | ID | Visible when |
|---|---|---|
| New puzzle button | `#new-puzzle-btn` | Review or Playing screen (hidden on Upload) |
| Help button | `#help-btn` | Always |
| Config button | `#config-btn` | Always |

### Upload Screen

| Element | ID | Notes |
|---|---|---|
| File input | `#file-input` | `accept="image/*"` |
| Process button | `#process-btn` | Triggers OCR pipeline |
| Status message | `#status-msg` | Shows progress / error |
| Pipeline progress | `#cv-loading-row` | Visible while OpenCV is loading |

### OCR Review Screen (`#review-panel` visible, `#review-actions` visible)

| Element | ID | Visible when |
|---|---|---|
| Grid canvas | `#grid-canvas` | Always |
| Warped image | `#warped-img` (`#warped-col`) | Always |
| Original image | `#original-img` (`#original-col`) | Always |
| Cage total editor | `#cage-total-edit` | Overlays a cell while a Killer total is being edited |
| Classic edit hint | `#classic-edit-hint` | Classic review only (`puzzleType === 'classic'`, before confirm) |
| Confirm & Solve | `#confirm-btn` | Always |
| Type dropdown | `#puzzle-type-select` | Always; values `killer` / `classic` |
| Review status | `#review-status-msg` | Shows validation errors inline |
| **Digit pad** | `#digit-1` … `#digit-0` | **Classic review only** — `#playing-actions` is shown but `#action-group` is hidden so only the digit pad is reachable |

### Playing Screen (`#review-panel` visible, `#playing-actions` visible, `#action-group` visible)

| Element | ID | Visible when |
|---|---|---|
| Undo | `#undo-btn` | Always (disabled until a user turn exists) |
| Hints | `#hints-btn` | Always (disabled before confirm) |
| Hints dropdown | `#hints-dropdown` | While `#hints-btn` is toggled on |
| Show / Hide candidates | `#candidates-btn` | Always (disabled before confirm) |
| Edit candidates | `#edit-candidates-btn` | Only while candidates are shown |
| Candidates help (?) | `#help-candidates-btn` | Only while candidates are shown |
| Inspect cage | `#inspect-cage-btn` | **Killer only** — visible from the start of playing mode |
| Virtual cage | `#virtual-cage-btn` | **Killer only** — visible from the start of playing mode |
| Reveal | `#reveal-btn` | Only while a cell is selected |
| Digit pad | `#digit-1` … `#digit-0` | Always |

### Modals

| Modal | ID | Trigger |
|---|---|---|
| General help | `#general-help-modal` | `#help-btn` |
| Config | `#config-modal` | `#config-btn` |
| Hint detail | `#hint-modal` | Clicking a hint in `#hints-dropdown` |
| Rule info | `#rule-info-modal` | ⓘ button in `#config-modal` |
| Candidates help | `#help-candidates-modal` | `#help-candidates-btn` |
| Training consent | `#training-consent-modal` | After first upload that produces training data |

---

## Known UI Issues

1. **Arrow navigation not implemented.** Keyboard arrow keys do not move cell
   selection.

2. **Cage-total edit overlay mis-positioned on narrow viewports.** The canvas
   is CSS-scaled to fit mobile screens (the click handler already accounts for
   the scale ratio via `getBoundingClientRect()`), but the `#cage-total-edit`
   overlay is positioned and sized in unscaled canvas pixels. On viewports
   narrower than ~460 px the overlay drifts and may be oversized relative to
   the visible cell. Only affects Killer OCR review mode on mobile.
