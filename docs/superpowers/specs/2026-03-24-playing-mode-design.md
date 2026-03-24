# Playing Mode Design

**Date:** 2026-03-24
**Feature:** Cell-by-cell puzzle solving with mistake detection, undo history, and hint scaffolding

---

## Overview

Extend the COACH web app so the user can play through a puzzle themselves after
confirming the cage layout. The app silently checks each entered digit against the
golden solution and checkpoints the first mistake, enabling a future "rewind to
first mistake" hint. A full undo history supports step-by-step reversal of moves.

---

## Scope

### In scope
- `PuzzleState` extended with playing-mode fields (golden solution, user grid,
  move history, first-mistake index)
- New schemas: `MoveRecord`, `CellEntryRequest`
- TypeScript `PuzzleState` interface updated to include the four new fields
- Three new API endpoints: `confirm`, `cell` (PATCH), `undo`
- Canvas: click-to-select cell, keyboard digit entry, user-digit rendering,
  selected-cell highlight
- Undo button (enabled/disabled by history length)
- Hints button (visible, permanently disabled — placeholder for future work)

### Explicitly out of scope
- Candidate/pencil-mark view (DEL-in-cell behaviour deferred)
- Hints implementation (rule suggestions, reveal-cell, reveal-grid)
- Rewind-to-checkpoint UI (achievable as repeated undo once hints land)
- Multiple-solution re-solve: if `golden_solution` has a 0 for a cell (solver
  could not determine it), no mistake check is performed for that cell. The
  re-solve-with-user-digit strategy is deferred.

---

## Data Model

### New schema: `MoveRecord`

```python
class MoveRecord(BaseModel):
    row: int        # 1-based (1–9)
    col: int        # 1-based (1–9)
    digit: int      # digit placed (1–9); 0 = cell was cleared
    prev_digit: int # digit that was there before (0 = was empty)
```

`MoveRecord` is included in full in every `PuzzleState` response. Payload growth
after many moves is acceptable for the current scope; truncation or pagination can
be added later if needed.

### New schema: `CellEntryRequest`

```python
class CellEntryRequest(BaseModel):
    row: int    # 1-based (1–9)
    col: int    # 1-based (1–9)
    digit: int  # 1–9 to place; 0 to clear
```

### `PuzzleState` additions

```python
class PuzzleState(BaseModel):
    # ... existing fields unchanged ...

    golden_solution: list[list[int]] | None = None
    # None  → pre-confirm (OCR review phase)
    # 9×9   → computed by /confirm; 0 means solver could not determine the cell

    user_grid: list[list[int]] | None = None
    # None  → pre-confirm
    # 9×9   → playing mode; 0 = cell not yet filled by user

    move_history: list[MoveRecord] = []
    # Ordered record of every digit entry or clear, newest last.
    # Sufficient to replay or reverse the full game history.

    first_mistake_index: int | None = None
    # Index into move_history of the first move that disagreed with
    # golden_solution (for a cell golden_solution can determine, i.e. != 0).
    #
    # INVARIANT: first_mistake_index is immutable once set. It is cleared only
    # by /undo when the undone move was the move at that index. It reflects
    # history, not the current grid state — the cell may subsequently have been
    # overwritten with the correct digit without clearing the flag.
    # None = no confirmed mistake in history yet.
```

**Lifecycle:**

| Phase | `golden_solution` | `user_grid` |
|-------|-------------------|-------------|
| OCR review (pre-confirm) | `None` | `None` |
| Playing mode | `list[list[int]]` | `list[list[int]]` |

The transition is atomic: `/confirm` populates both fields in a single session write.

---

## API Endpoints

All new endpoints live under the existing `/api/puzzle` router prefix.

### `POST /api/puzzle/{session_id}/confirm`

Runs the solver on the current cage layout and transitions the session to playing
mode. Replaces the role of the "Looks correct — solve!" button in the UI flow.

**Request:** no body

**Behaviour:**
1. Load session; return 404 if not found.
2. Return 409 if `user_grid` is already set (session already confirmed).
3. Reconstruct `PuzzleSpec` from current cage states via `_cage_states_to_spec`.
4. Run solver:
   ```python
   grd = Grid()
   grd.set_up(spec)
   try:
       alts_sum, _ = grd.engine_solve()
   except (AssertionError, ValueError) as exc:
       raise HTTPException(status_code=422, detail=str(exc))
   if alts_sum != 81:       # engine did not fully solve; alts_sum == 81 means
       grd.cheat_solve()    # each cell has exactly one candidate remaining
   ```
   A partial result (cells still 0 after `cheat_solve`) is acceptable — those
   cells will never be flagged as mistakes.
5. Extract golden solution — cells with more than one candidate remaining are stored
   as 0:
   ```python
   golden = [
       [
           int(next(iter(grd.sq_poss[r][c]))) if len(grd.sq_poss[r][c]) == 1 else 0
           for c in range(9)
       ]
       for r in range(9)
   ]
   ```
6. Store `golden_solution` and `user_grid = [[0]*9 for _ in range(9)]` atomically.
7. Return updated `PuzzleState`.

**Response:** `PuzzleState`

**Note on existing endpoints:** `patch_cage` and `subdivide_cage` reconstruct
`PuzzleState` by name when saving updates. Both must be updated to pass through
the new fields (`golden_solution`, `user_grid`, `move_history`,
`first_mistake_index`) so that confirming a session and then editing a cage does
not silently revert the playing-mode fields to their defaults.

**Edge cases:**
- Solver raises (invalid cage layout) → 422.
- Solver returns partial grid (some zeros) → playing mode activates; those cells
  are simply never checked.

### `PATCH /api/puzzle/{session_id}/cell`

Enter or clear a digit in the user's grid.

**Request body:** `CellEntryRequest`

**Behaviour:**
1. Load session; return 404 if not found.
2. Return 409 if `user_grid` is None (not yet confirmed).
3. Validate: row/col in 1–9, digit in 0–9; return 422 otherwise.
4. Record `prev_digit = user_grid[row-1][col-1]`.
5. Update `user_grid[row-1][col-1] = digit`.
6. Append `MoveRecord(row=row, col=col, digit=digit, prev_digit=prev_digit)` to
   `move_history`. Clear moves (`digit=0`) are recorded identically to digit
   placements — undo must be able to reverse them.
7. **Mistake detection** (only when `digit != 0`):
   - `golden = golden_solution[row-1][col-1]`
   - If `golden != 0` and `digit != golden` and `first_mistake_index is None`:
     - `first_mistake_index = len(move_history) - 1`
   - If `golden == 0` (solver could not determine cell): no check performed.
8. Save session; return updated `PuzzleState`.

**Response:** `PuzzleState`

### `POST /api/puzzle/{session_id}/undo`

Reverse the most recent move.

**Request:** no body

**Behaviour:**
1. Load session; return 404 if not found.
2. Return 409 if `move_history` is empty.
3. Pop the last `MoveRecord` from `move_history`.
4. Restore `user_grid[row-1][col-1] = prev_digit`.
5. If `first_mistake_index == len(move_history)` (the popped move was the
   first-mistake move), clear `first_mistake_index` to `None`.
6. Save session; return updated `PuzzleState`.

**Response:** `PuzzleState`

---

## Frontend Changes

### State machine

```
upload → [review mode] → confirm → [playing mode]
```

The frontend derives mode from `state.user_grid`:
- `null` → review mode (existing behaviour, no changes)
- non-null → playing mode (new behaviour below)

### TypeScript interface additions

```typescript
interface MoveRecord {
  row: number;        // 1-based
  col: number;        // 1-based
  digit: number;      // 0–9 (0 = clear)
  prev_digit: number; // 0–9
}

// PuzzleState gains four new fields (added to the existing interface):
// golden_solution: number[][] | null;
// user_grid:       number[][] | null;
// move_history:    MoveRecord[];
// first_mistake_index: number | null;
```

### `selectedCell` storage convention

`selectedCell` is stored **1-based** in module state:

```typescript
let selectedCell: { row: number; col: number } | null = null;
// row and col are 1-based (1–9), matching the API convention
```

Canvas drawing converts to pixels as:
```typescript
const x = MARGIN + (selectedCell.col - 1) * CELL;
const y = MARGIN + (selectedCell.row - 1) * CELL;
```

The hit-test on `mousedown` computes 0-based indices then adds 1 before storing:
```typescript
const col = Math.floor((mouseX - MARGIN) / CELL) + 1;  // 1-based
const row = Math.floor((mouseY - MARGIN) / CELL) + 1;  // 1-based
```

### Canvas changes (playing mode only)

Drawing layers (back → front, extending existing `drawGrid`):

0. **Selected-cell highlight** — light blue (`#dbeafe`) fill for `selectedCell`
   (before cage underlay, so red cage lines render on top)
1. Cage underlay (red, 7.5 px) — unchanged
2. Dashed cell dividers — unchanged
3. Box dividers — unchanged
4. Outer border — unchanged
5. Cage total labels — unchanged
6. **User digits** — centred in each non-zero `user_grid` cell;
   `bold 28px sans-serif`; colour `#2563eb` (blue)

### Button changes

The existing button with `id="confirm-btn"` and text "Looks correct — solve!" is
**rewired** (same element, same ID) to call `handleConfirm()` instead of
`handleSolve()`. No new HTML element is needed.

| Button | Review mode | Playing mode |
|--------|-------------|--------------|
| "Looks correct — solve!" (`confirm-btn`) | Active → triggers `/confirm` | Hidden |
| "Edit cage totals" (`edit-btn`) | Active | Hidden |
| Undo (`undo-btn`) | Hidden | Active when `move_history.length > 0` |
| Hints (`hints-btn`) | Hidden | Visible, always disabled |
| Quit server (`quit-btn`) | Visible | Visible |

`undo-btn` and `hints-btn` are new `<button>` elements added to the HTML.

### Digit entry

- `keydown` listener on `document` (active only in playing mode, i.e. when
  `state.user_grid !== null` and `selectedCell !== null`)
- Keys `1`–`9` → `PATCH /cell` with `{row, col, digit}`
- `Backspace` or `Delete` → `PATCH /cell` with `digit: 0` (clear)
  - Behaviour when candidate view is active: deferred (open question)
- Arrow keys → move selection (low priority, deferred)

### Solution panel

The `#solution-panel` is not shown after confirm. The user grid is rendered
progressively on the canvas as cells are filled in.

The existing `POST /solve` endpoint and cage-editor "Solve puzzle" button remain
unchanged — useful for testing and direct solution display.

---

## Testing

### New unit tests (`tests/api/test_endpoints.py`)

**`TestConfirm`:**
- Returns 200 with `user_grid` (all zeros) and `golden_solution` populated
- Returns 409 on already-confirmed session
- Returns 404 on missing session
- Returns 422 when cage layout is invalid (solver raises)

**`TestCellEntry`:**
- Digit stored in `user_grid` at correct 0-based index
- `MoveRecord` appended with correct `prev_digit`
- Wrong digit (vs non-zero golden) sets `first_mistake_index`
- Correct digit leaves `first_mistake_index` as `None`
- Clear (`digit=0`) appended to history; no mistake check performed
- Returns 409 on unconfirmed session

**`TestUndo`:**
- `prev_digit` restored in `user_grid`
- `MoveRecord` removed from `move_history`
- Undoing first-mistake move clears `first_mistake_index`
- Undoing a non-mistake move does not touch `first_mistake_index`
- Returns 409 on empty history

---

## Open Questions

1. **DEL in candidate/pencil-mark view** — when the candidate view is implemented,
   what should deleting a user digit do to the pencil marks for that cell? Deferred.
2. **Multiple-solution re-solve** — deferred to a future sprint. Cells the solver
   cannot determine (`golden_solution[r][c] == 0`) are never checked for mistakes.
