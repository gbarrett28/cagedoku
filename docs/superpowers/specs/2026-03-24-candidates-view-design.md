# Candidates View Design

**Date:** 2026-03-24
**Feature:** Per-cell candidate grid with essential-digit highlighting, auto/manual modes, and help modal

---

## Overview

Extend the COACH playing mode with a candidates view. For each unsolved cell the app displays a 3×3 sub-grid showing which digits are still possible and — in auto mode — which are essential to the cage (present in every remaining valid solution). The user can toggle the view on and off, switch between solution-entry and candidate-editing interaction modes, and choose between auto-computed and fully manual candidate management.

---

## Scope

### In scope

- `CandidateCell`, `CandidateGrid`, `CandidateCycleRequest`, `CandidateModeRequest` Pydantic schemas
- `PuzzleState` extended with `candidate_grid`
- Candidate computation: `auto_candidates` from solver `sq_poss`; `auto_essential` from cage solution sets
- Three new API endpoints: `POST /candidates/mode`, `PATCH /candidates/cell`; existing `/confirm`, `/cell`, `/undo` extended
- Frontend: Show Candidates toggle, Edit Candidates toggle, Auto/Manual toggle, help modal button
- Canvas layer 8: 3×3 candidate sub-grid per unsolved cell (grey / salmon)
- Keyboard cycling (1–9, Delete) and mousedown sub-cell cycling
- Help modal with full explanatory text
- Backend unit tests (`TestConfirmInitializesCandidates`, `TestCandidateCycle`, `TestCandidateMode`, `TestCandidateWithCellEntry`, `TestRuleA`)
- Playwright e2e tests with mock OCR via `CoachConfig.mock_ocr`

### Explicitly out of scope

- Pencil-mark import/export
- Candidate view persistence across browser sessions (beyond what the server session already stores)
- Visual canvas tests (pixel/screenshot comparisons)
- Hints rule suggestions (separate sprint)

---

## Data Model

### New schema: `CandidateCell`

```python
class CandidateCell(BaseModel):
    """Candidate state for one cell.

    auto_candidates and auto_essential are computed by the solver and updated
    after every cell entry. user_essential and user_removed store the user's
    overrides and are preserved even when the cell is solved (so they survive
    undo). Rule A: if a digit drops out of auto_candidates for an unsolved
    cell, it is silently removed from user_essential.
    """

    auto_candidates: list[int]  # digits solver considers possible (1–9)
    auto_essential:  list[int]  # digits present in ALL remaining cage solutions
    user_essential:  list[int]  # user-marked essential (overrides auto inessential)
    user_removed:    list[int]  # user-removed digits (overrides auto present)
```

**Displayed state for digit `n`** (priority order):

| Condition | Display |
|-----------|---------|
| Auto mode: `n` not in `auto_candidates` | not shown |
| `n` in `user_removed` | not shown |
| `n` in `user_essential` OR `auto_essential` | essential — salmon `#ffb5a7` |
| otherwise | inessential — grey `#9ca3af` |

In **manual mode** the `auto_candidates` check is skipped; the base set is all nine digits minus digits already placed in the same row, column, or box by `user_grid`.

### New schema: `CandidateGrid`

```python
class CandidateGrid(BaseModel):
    """Full 9×9 grid of per-cell candidate state plus the current mode."""

    cells: list[list[CandidateCell]]  # 9 rows × 9 cols, 0-based
    mode: Literal["auto", "manual"] = "auto"
```

### New schema: `CandidateCycleRequest`

```python
class CandidateCycleRequest(BaseModel):
    """Cycle one digit in one cell, or reset the whole cell (digit=0)."""

    row:   int                      # 1-based (1–9)
    col:   int                      # 1-based (1–9)
    digit: int                      # 1–9 to cycle; 0 to reset cell
    mode:  Literal["auto", "manual"]
```

### New schema: `CandidateModeRequest`

```python
class CandidateModeRequest(BaseModel):
    mode: Literal["auto", "manual"]
```

### `PuzzleState` addition

```python
    candidate_grid: CandidateGrid | None = None
    # None  → pre-confirm
    # Set at /confirm; updated after every /cell, /undo, /candidates/cell,
    # and /candidates/mode
```

---

## Server-Side Candidate Computation

### When computation runs

| Event | What happens |
|-------|-------------|
| `POST /confirm` | Build initial `CandidateGrid` (auto mode, all overrides empty) |
| `PATCH /cell` | After updating `user_grid`, recompute candidates for unsolved cells |
| `POST /undo` | Same recomputation after restoring previous digit |
| `POST /candidates/mode` (→ auto) | Recompute auto state; apply min-merge with existing overrides |
| `POST /candidates/mode` (→ manual) | Update `mode` field only; no state change |
| `PATCH /candidates/cell` | Update overrides for one cell; no solver recomputation |

### Recomputation procedure

1. Create a fresh `Grid`, call `set_up(spec)`.
2. For each solved cell (`user_grid[r][c] != 0`), place that digit and propagate via `discard_n`.
3. `sq_poss[r][c]` after propagation is `auto_candidates` for unsolved cell `(r, c)`.
4. For each cage, inspect remaining valid solutions (`cge.alts` after propagation) to derive per-cell `auto_essential`: digits that appear in **every** remaining cage solution at that cell's position.

> **Implementation note:** The exact API for `cge.alts` after partial placement must be confirmed during implementation. If `cge.alts` is not updated by `discard_n` alone, an additional propagation step may be required.

### Solved-cell rule

**Recomputation only runs for unsolved cells** (`user_grid[r][c] == 0`). Solved cells' `CandidateCell` — including both auto state and user overrides — is frozen until the cell becomes unsolved again. This ensures that undoing a digit entry restores the exact candidate state the user had before placing it.

### Rule A — auto impossible overrides user essential

After recomputing `auto_candidates` for an unsolved cell, any digit in `user_essential` that is no longer in `auto_candidates` is silently removed from `user_essential`. `user_removed` entries are preserved even if auto also considers the digit impossible (they are harmless and may become relevant again if the user undoes moves).

### Manual mode base set

In manual mode the displayed candidates for an unsolved cell are all nine digits minus any digit already placed in the same row, column, or box in `user_grid`. The solver's `auto_candidates` and `auto_essential` are still computed and stored but are not consulted for display.

---

## API Endpoints

All new endpoints live under the existing `/api/puzzle` router prefix.

### `POST /api/puzzle/{session_id}/candidates/mode`

Switch between auto and manual modes.

**Request body:** `CandidateModeRequest`

**Behaviour:**
1. Load session; return 404 if not found.
2. Return 409 if `candidate_grid` is None (session not yet confirmed).
3. If `mode == "manual"`: update `candidate_grid.mode`; no other changes.
4. If `mode == "auto"`: recompute auto state; apply min-merge (see below); update `candidate_grid.mode`.
5. Save and return updated `PuzzleState`.

**Min-merge (manual → auto):** For each digit `n` in each unsolved cell, compute the displayed state in manual and auto independently, using the ordering `impossible=0 < essential=1 < inessential=2`. The result is the minimum. Concretely:
- If auto says impossible: remove `n` from `user_essential` (auto wins).
- If manual has `n` in `user_removed` and auto says possible: keep `n` in `user_removed`.
- If manual has `n` in `user_essential` and auto says inessential: keep `n` in `user_essential`.

**Response:** `PuzzleState`

---

### `PATCH /api/puzzle/{session_id}/candidates/cell`

Cycle one digit in one cell, or reset a cell's overrides.

**Request body:** `CandidateCycleRequest`

**Behaviour:**
1. Load session; return 404 if not found.
2. Return 409 if `candidate_grid` is None.
3. Validate row/col 1–9; return 422 otherwise.
4. If `digit == 0`: clear `user_essential` and `user_removed` for `(row, col)`; save and return.
5. Otherwise determine current displayed state for `digit` in `(row, col)`:
   - In auto mode: if `digit` not in `auto_candidates` and not in `user_removed` → no-op (return 200 unchanged).
   - Apply cycle rules (see table below).
6. Save and return updated `PuzzleState`.

**Cycle rules — auto mode:**

| Current state | Condition | Next state | Override change |
|---|---|---|---|
| inessential | digit in `auto_candidates`, not user-marked | essential | add to `user_essential` |
| essential (user) | digit in `user_essential` | impossible | remove from `user_essential`; add to `user_removed` |
| essential (auto only) | digit in `auto_essential`, not `user_essential` | impossible | add to `user_removed` |
| impossible (user) | digit in `user_removed` | inessential/essential | remove from `user_removed` (auto_essential determines display) |
| impossible (auto) | digit not in `auto_candidates`, not `user_removed` | no-op | — |

Note: an auto-essential digit cycles essential → impossible → essential (inessential is unreachable because removing from `user_removed` restores auto_essential).

**Cycle rules — manual mode:**

| Current state | Next state | Override change |
|---|---|---|
| inessential | essential | add to `user_essential` |
| essential | impossible | remove from `user_essential`; add to `user_removed` |
| impossible | inessential | remove from `user_removed` |

**Response:** `PuzzleState`

---

### Modified: `POST /confirm`, `PATCH /cell`, `POST /undo`

Each of these must now also compute and return an updated `candidate_grid` in the response. The existing `patch_cage` and `subdivide_cage` endpoints pass `candidate_grid` through unchanged via `model_copy` (already implemented).

---

## Frontend Changes

### New module state

```typescript
let showCandidates: boolean = false;
let candidateEditMode: boolean = false;
```

### New buttons in `#playing-actions`

```html
<button id="candidates-btn"      class="btn-secondary" disabled>Show candidates</button>
<button id="edit-candidates-btn" class="btn-secondary" hidden>Edit candidates</button>
<button id="candidates-mode-btn" class="btn-secondary" hidden>Auto</button>
<button id="help-candidates-btn" class="btn-secondary" hidden>?</button>
```

| Button | Visible | Enabled | Label |
|---|---|---|---|
| `candidates-btn` | Playing mode | Always | "Show candidates" / "Hide candidates" |
| `edit-candidates-btn` | `showCandidates` | Always | "Edit candidates" / "Done editing" |
| `candidates-mode-btn` | `showCandidates` | Always | Current mode: "Auto" / "Manual" |
| `help-candidates-btn` | `showCandidates` | Always | "?" |

### Keyboard routing

```
showCandidates && candidateEditMode && selectedCell !== null:
  digit 1–9       → PATCH /candidates/cell  {row, col, digit, mode}
  Delete/Backspace → PATCH /candidates/cell  {row, col, digit: 0, mode}

else (solution entry mode) && selectedCell !== null:
  digit 1–9       → PATCH /cell  {row, col, digit}
  Delete/Backspace → PATCH /cell  {row, col, digit: 0}
```

### `drawGrid` signature extension

```typescript
function drawGrid(
  canvas: HTMLCanvasElement,
  state: PuzzleState,
  selected: { row: number; col: number } | null = null,
  showCandidates: boolean = false
): void
```

### Canvas layer 8 — candidates

Rendered after user digits, only when `showCandidates && state.candidate_grid !== null`.

For each unsolved cell (`user_grid[r][c] === 0`):

```typescript
const SUB = CELL / 3;  // ≈ 16.7 px
// digit n (1–9):
const subRow = Math.floor((n - 1) / 3);
const subCol = (n - 1) % 3;
const cx = MARGIN + c * CELL + (subCol + 0.5) * SUB;
const cy = MARGIN + r * CELL + (subRow + 0.5) * SUB;
```

Font: `bold 10px sans-serif`, `textAlign: "center"`, `textBaseline: "middle"`.

Colour logic (from `candidate_grid.cells[r][c]` and `candidate_grid.mode`):

| Condition | Colour |
|---|---|
| Auto mode: `n` not in `auto_candidates` | not drawn |
| `n` in `user_removed` | not drawn |
| `n` in `user_essential` or `auto_essential` | `#ffb5a7` (salmon) |
| otherwise | `#9ca3af` (grey) |

(In manual mode the `auto_candidates` check is skipped.)

### Mousedown sub-cell detection (candidate editing mode only)

```typescript
const subCol = Math.floor((x - MARGIN - (col - 1) * CELL) / (CELL / 3));
const subRow = Math.floor((y - MARGIN - (row - 1) * CELL) / (CELL / 3));
const digit  = subRow * 3 + subCol + 1;  // 1–9
// if digit in 1..9: call PATCH /candidates/cell directly
```

### `selectedCell` storage convention

`selectedCell` storage convention is unchanged (1-based row/col). In candidate editing mode a mousedown on a sub-cell skips the separate cell-selection step and calls `/candidates/cell` directly.

### Help modal

A `<dialog id="help-candidates-modal">` element is added to the HTML. The `?` button opens it; a Close button inside dismisses it. Content is the text in the Help Modal section below.

---

## Help Modal Text

---

### Candidates

The candidates view shows, for each unsolved cell, which digits are still possible — and highlights which digits appear in every valid solution for that cage.

---

**Turning it on**

Press **Show candidates** to reveal the candidate grid. Each unsolved cell displays up to nine small digits arranged in a 3×3 layout matching their position on a keypad:

```
1  2  3
4  5  6
7  8  9
```

A digit that does not appear has been ruled out. A digit shown in **grey** is possible but not yet certain. A digit shown in **salmon** is essential to that cage.

---

**Essential digits**

A digit is *essential* for a cell if it appears in every remaining valid solution for that cell's cage. If you must place one of a cage's essential digits somewhere, at least one cell in the cage must take it — no solution avoids it. Essential digits are worth paying close attention to when you are stuck.

---

**Auto mode and manual mode**

The **Auto / Manual** toggle controls how the candidate grid is maintained.

*Auto mode* (default): the app computes candidates for you. When you place a digit in any cell, candidates in related cells — same row, column, box, or cage — are immediately updated. Essential digits are recalculated from the cage's remaining solutions. You can still adjust the auto-computed state: press a digit key (or tap its position) to cycle it forward through its states, or press **Delete** to reset a cell back to its auto-computed state.

*Manual mode*: you manage candidates yourself. Every unsolved cell starts with all nine digits marked inessential. The app does not eliminate or promote anything — you decide what to keep, what to mark essential, and what to remove.

**Switching from manual to auto** merges your work with the solver's knowledge: for each digit in each cell, the more restrictive of the two assessments wins. If you removed a digit the solver thinks is still possible, it stays removed. If you marked a digit essential that the solver considers inessential, it stays essential. If the solver has ruled something out entirely, that takes precedence.

**Switching from auto to manual** leaves everything exactly as it is.

---

**Cycling a digit's state**

Press **Edit candidates** to enter candidate editing mode. Each digit cycles through its states each time you interact with it:

| State | Appearance | Meaning |
|---|---|---|
| Inessential | grey | Possible, but not in every cage solution |
| Essential | salmon | Marked as present in every cage solution |
| Impossible | hidden | Ruled out — not shown |

To cycle: press the digit key (1–9) while a cell is selected, or tap the digit's position directly within the cell. Each press advances to the next state.

In **auto mode**, a digit that the solver has ruled out cannot be cycled back in (the solver's impossible overrides your marks). A digit you removed yourself can be restored by cycling past impossible back to inessential. An auto-essential digit — one the solver has determined appears in every cage solution — cycles between essential and impossible only; cycling it removes it from play, and restoring it brings it straight back to essential.

In **manual mode**, all nine digits can be cycled freely in any cell.

Press **Delete** (or **Backspace**) in candidate editing mode to reset the selected cell: all your adjustments to that cell are cleared, restoring it to its auto-computed state (in auto mode) or all-inessential (in manual mode).

---

**Solved cells**

When you enter a digit into a cell, its candidates are hidden but not lost. If you undo or clear the digit, the candidates reappear exactly as you left them.

---

## Testing

### Backend unit tests (`tests/api/test_endpoints.py`)

**`TestConfirmInitializesCandidates`**
- `/confirm` returns `candidate_grid` non-None with `mode == "auto"`
- All `user_essential` and `user_removed` empty for every cell
- For the trivial single-cell-cage fixture, each cell's `auto_candidates` contains exactly the solution digit

**`TestCandidateCycle`**
- Cycling an inessential digit → digit added to `user_essential`
- Cycling a user-essential digit → removed from `user_essential`, added to `user_removed`
- Cycling a user-removed digit → removed from `user_removed`
- Auto mode: cycling an auto-essential digit: essential → impossible → essential (inessential never reached)
- Auto mode: cycling an auto-impossible digit (not user-removed) → no-op, 200 returned unchanged
- Manual mode: all nine digits cycle through the full three states
- `digit=0` (reset): clears `user_essential` and `user_removed` for cell entirely

**`TestCandidateMode`**
- Switching auto → manual: `candidate_grid.cells` unchanged, `mode` becomes `"manual"`
- Switching manual → auto, min-merge:
  - User-removed digit auto says possible → stays in `user_removed`
  - User-essential digit auto says inessential → stays in `user_essential`
  - Digit auto says impossible → cleared from `user_essential` (auto wins)

**`TestCandidateWithCellEntry`**
- After placing digit `d` in cell `(r,c)`, peers no longer have `d` in `auto_candidates`
- Solved cell's `user_essential` and `user_removed` are unchanged after a peer cell changes
- After `/undo`, cell's candidate state is visible again and unchanged

**`TestRuleA`**
- When a cell entry causes a digit to drop from `auto_candidates` in a peer, that digit is cleared from `user_essential` in the peer
- `user_removed` entries are preserved even when auto also considers the digit impossible

### Playwright e2e tests

**Mock OCR setup:**

`CoachConfig` gains a `mock_ocr: bool = False` field. When `True`, the upload endpoint bypasses `InpImage` entirely and returns a fixture `PuzzleSpec` designed for candidate testing (multiple genuinely ambiguous cages with interesting essential-digit patterns). A dedicated fixture, distinct from `minimal_puzzle.py`, is created during implementation.

The Playwright test server is started with `mock_ocr=True`. Tests upload a minimal valid JPEG (e.g. a 1×1 pixel image); the server returns the fixture puzzle.

**Test cases:**

- Upload → confirm flow completes; canvas renders without errors
- **Show/hide toggle:** `candidates-btn` click shows candidate digits; second click hides them
- **Edit mode toggle:** `edit-candidates-btn` appears only when candidates visible; activating it changes keyboard routing
- **Keyboard routing — solution entry:** digit key calls `/cell`, not `/candidates/cell`
- **Keyboard routing — candidate editing:** digit key calls `/candidates/cell`, not `/cell`
- **Delete in solution entry mode:** calls `/cell` with `digit: 0`
- **Delete in candidate editing mode:** calls `/candidates/cell` with `digit: 0`
- **Auto/manual toggle:** `candidates-mode-btn` calls `/candidates/mode`; label updates
- **Help modal:** `?` button opens dialog; Close button dismisses it

Canvas pixel/colour assertions are explicitly excluded — too brittle for maintenance.

---

## Open Questions

1. **`cge.alts` API after partial placement** — confirm whether cage alternative sets are updated by `discard_n` propagation alone, or whether an additional step is required to filter them. To be resolved during implementation.
2. **Playwright fixture design** — the exact cage layout for the mock-OCR fixture (chosen to produce interesting essential-digit patterns) is deferred to implementation.
