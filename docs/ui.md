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
| Adjust corners | Opens the corner picker on the Original Photo (see below) |
| Type dropdown | `Killer` / `Classic` — changeable if OCR misdetected |

**Corner picker**

The **Adjust corners** button appears in the review action bar whenever corner data is
available (i.e. after a successful grid detection). Clicking it overlays an interactive
canvas directly on top of the Original Photo with four coloured drag handles — one for
each corner of the detected grid boundary.

- Drag any handle to move that corner.
- Press **Apply** to re-run the full OCR pipeline (Stages 2–6) using the adjusted
  corners, skipping grid detection (Stage 1). The review screen refreshes with the
  new result.
- Press **Cancel** to dismiss the overlay without re-parsing.

The re-parse uses the same `parsePuzzleImage` function with `providedCorners` (original-
image pixel space) so all subsequent pipeline stages (perspective warp, border clustering,
digit recognition, validation) run exactly as for a normal upload.

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

The action bar is **part of the page header** (`<div class="sticky-bars">` →
`<header>` → `.header-inner`). It is visible only in playing mode; on desktop
all buttons fit on one row; on mobile (`≤ 620 px`) the action group wraps to a
second row within the same `<header>` element.

All buttons are **icon-only** (`btn-icon` class, `2.25 rem × 2.25 rem`) with a
`data-tooltip` attribute that shows a hover label via a CSS `::after`
pseudo-element. Tooltips are suppressed on touch-sized viewports.

| Button | Symbol | Condition | Description |
|---|---|---|---|
| `#undo-btn` | ↩ | Always (disabled until a move exists) | Revert the last digit entry |
| `#hints-btn` | 💡 | Always (disabled until confirmed) | Open hints dropdown |
| `#mode-toggle` | N\|C pill | Visible when `showCandidates = true` | Toggle between Normal entry and Candidates editing mode. Active side is highlighted. |
| `#inspect-cage-btn` | 🔍 | **Killer** playing mode only | Enter cage inspection mode. Gets `.active` class while active; tooltip changes to "Done inspecting". |
| `#virtual-cage-btn` | ➕ | **Killer** playing mode only | Enter virtual cage drawing mode. Gets `.active` class while active; tooltip changes to "Cancel virtual cage". |
| `#reveal-btn` | 👁 | Only while a cell is selected | Reveal the solution digit for the selected cell after a confirmation popup |
| `#new-puzzle-btn` | 🏠 | Review or Playing screen | Return to the upload screen |
| `#help-btn` | ? | Always | Open general help modal |
| `#config-btn` | ⚙ | Always | Open config modal |
| `#feedback-btn` | ✉ | Always | Open feedback modal |

**`#detected-layout-heading`** is hidden in playing mode via a `:has()` CSS
selector; it remains visible in review mode.

**COACH subtitle** (`.header-sub`) and `#load-time` are hidden in playing mode
via a `:has()` selector; they remain visible on upload and review screens.

### Candidate Visibility

Candidates are shown by default when playing mode starts. `showCandidates` is
initialised from the `showCandidatesByDefault` field of `CoachSettings`
(default: `true`). The Config modal contains a "Show candidates by default"
checkbox to change this preference. There is no mid-session toggle.

### `(N|C)` Mode Toggle Pill

`#mode-toggle` is a single `<button>` containing three `<span>` elements:
`N`, `|`, `C`. Clicking anywhere on the pill toggles `candidateEditMode`. When
`candidateEditMode = false` the `N` span is highlighted (no `.active` class on
button); when `candidateEditMode = true` the `C` span is highlighted (`.active`
on button).

### Digit Pad

Rendered below the grid canvas inside `#playing-actions`. Uses a 5-column CSS
grid producing a fixed 2-row layout:

```
[ 1 ][ 2 ][ 3 ][ 4 ][ 5 ]
[ 6 ][ 7 ][ 8 ][ 9 ][ X ]
```

The "Puzzle solved — well done!" completion message appears below the digit pad
when `isGridSolved()` returns true.

### Playing-Mode Space Recovery

The following CSS `:has(#action-group:not([hidden]))` overrides apply in playing
mode to maximise grid size:

- `.header-sub`, `#load-time`, `#detected-layout-heading` — hidden
- `main` top/bottom margin reduced to `0.5rem`
- `#review-panel` padding reduced to `0.5rem`; background and border set to transparent

### Responsive Layout (Portrait / Landscape)

The playing-mode layout adapts to viewport orientation via
`@media (orientation: landscape)` + `body:has(#playing-actions:not([hidden]))`.

**Portrait:** sticky header at top, grid fills card width (bounded by available
height via `max-width: min(100%, calc(100dvh - var(--header-h) - var(--digit-pad-h) - var(--chrome-v)))`),
`#side-panel` below the canvas.

**Landscape:** `<body>` becomes a CSS grid (`auto 1fr`). `.sticky-bars` is the
full-height left sidebar; `.header-inner` uses `flex-direction: column` with
`justify-content: space-between` (K at top, action group centre, permanent buttons
at bottom). `#canvas-col` is `flex-direction: row`: the canvas fills remaining
width via `flex: 1 1 0px; max-height: 100%; aspect-ratio: 1` (largest square
fitting the available height). `#side-panel` is the right strip.

**CSS custom properties** (`:root`):
- `--header-h: 124px` — portrait header height (2-row wrapped layout at narrow viewports, measured 121px)
- `--digit-pad-h: 116px` — `#side-panel` height in portrait playing mode (measured 113.59px)
- `--chrome-v: 2rem` — main margins + card padding in playing mode

**K badge** (`.logo-k`): replaces `<h1>COACH</h1>`. Blue rounded-rect badge matching
the favicon. `.header-sub` ("Killer Sudoku Coaching App") is still present but
hidden in playing mode via `:has(#action-group:not([hidden]))`.

**`#side-panel`:** unified switchable zone inside `#canvas-col`, after `#canvas-wrapper`.
Contains three mutually exclusive panels — exactly one visible at a time:
- `#playing-actions` — digit pad (default in playing mode)
- `#inspector-col` — cage solutions inspector (shown when 🔍 active)
- `#virtual-cage-col` — virtual cage form (shown when ➕ active)

In review mode, inspector and virtual-cage panels appear below the detected-layout
canvas (same `#side-panel` wrapper) rather than as separate columns in `#images-row`.

**N|C pill in landscape:** `transform: rotate(90deg)` applied so the pill reads
vertically within the sidebar.

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

**Essential highlight toggle**: enables or disables the salmon highlight that
marks essential digits. Disabled state leaves essential digits grey, identical
to inessential.

**Auto-apply step delay** slider (0 – 2 000 ms, step 50 ms):
- **0 (Off)**: default — all auto-placements are applied instantly after each
  user placement, exactly as before.
- **> 0**: after the user places a digit, each auto-deduced placement is
  applied one-at-a-time with the configured delay between steps and the grid
  redrawn after each one. This creates a step-through "teaching" effect.
  The delay applies between the user's placement and the first
  auto-placement, and between each subsequent auto-placement.

**Rule list**: one row per hintable rule.
- Dropdown: toggles the rule between `Auto-apply` and `Hint-only`.
- Rule display name.
- **(i) button**: opens a **Rule Info Modal** (see below) explaining the rule.

Save / Cancel. Changes to `alwaysApplyRules` and `autoPlacementDelay` take
effect from the next user placement.

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
| Adjust corners | `#adjust-corners-btn` | When corner data is available (grid detection succeeded) |
| Corner picker canvas | `#corner-picker-canvas` | While corner picker is active |
| Corner picker actions | `#corner-picker-actions` (`#corner-apply-btn`, `#corner-cancel-btn`) | While corner picker is active |
| Type dropdown | `#puzzle-type-select` | Always; values `killer` / `classic` |
| Review status | `#review-status-msg` | Shows validation errors inline |
| **Digit pad** | `#digit-1` … `#digit-0` | **Classic review only** — `#playing-actions` is shown but `#action-bar` is hidden so only the digit pad is reachable |

### Playing Screen (`#review-panel` visible, `#playing-actions` visible, `#action-group` visible)

| Element | ID | Visible when |
|---|---|---|
| Undo | `#undo-btn` | Always (disabled until a user turn exists) |
| Hints | `#hints-btn` | Always (disabled before confirm) |
| Hints dropdown | `#hints-dropdown` | While `#hints-btn` is toggled on |
| Mode toggle pill | `#mode-toggle` | When `showCandidates = true` |
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

