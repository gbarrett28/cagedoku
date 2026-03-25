# Cage Solutions Inspector — Design Spec

**Goal:** Let the user select a cage, inspect all valid digit combinations for it, and
eliminate combinations they know are wrong — with eliminations persisted server-side and
feeding back into the candidate grid.

**Architecture:** New "Inspect cage" toggle button opens an inline panel below the canvas.
Clicking a cage in inspect mode fetches its solutions from a new GET endpoint and renders
them in the panel. A toggle POST endpoint eliminates or restores individual solutions.
Eliminated solutions feed back into candidate computation in auto mode.

**Tech stack:** FastAPI + Pydantic (backend), TypeScript + Canvas (frontend), existing
JSON session store.

---

## Data Model

### `CageState` (modified — `killer_sudoku/api/schemas.py`)

Add one field:

```python
user_eliminated_solns: list[list[int]] = []
```

Each entry is a sorted list of digits identifying one eliminated combination — e.g.
`[[1, 5], [2, 4]]` means those two combinations have been user-eliminated.

Stored as digit lists (not indices) so they are stable if the cage total is edited:
old lists simply fail to match any new solutions and become inert.

### `CageSolutionsResponse` (new schema — `killer_sudoku/api/schemas.py`)

```python
class EliminateSolutionRequest(BaseModel):
    solution: list[int]   # sorted digit list identifying the combination to toggle

class CageSolutionsResponse(BaseModel):
    label: str
    all_solutions: list[list[int]]    # complete set from sol_sums, sorted
    auto_impossible: list[list[int]]  # solver says unreachable
    user_eliminated: list[list[int]]  # user has struck these out
    # active = all_solutions − auto_impossible − user_eliminated (computed by frontend)
```

`auto_impossible` definition: a solution is auto-impossible if it contains any digit
absent from the union of `board.candidates` over all cage cells, after the linear-system
eliminations have been applied (the same board state used in `_compute_candidate_grid`).
This is a necessary-condition check and a good-enough approximation for the UI.

---

## Backend Changes

### `_compute_candidate_grid` (modified — `killer_sudoku/api/routers/puzzle.py`)

Before computing `cage_possible` and `cage_must`, filter `board.cage_solns[cage_idx]`
by `user_eliminated_solns` from the corresponding `CageState`:

```python
eliminated = {frozenset(s) for s in state.cages[cage_idx].user_eliminated_solns}
cage_solns = [s for s in board.cage_solns[cage_idx] if s not in eliminated]
```

This means eliminating a cage solution immediately narrows the candidate grid in auto
mode — no extra work required.

### New endpoint: `GET /api/puzzle/{sid}/cage/{label}/solutions`

Returns `CageSolutionsResponse`.

Steps:
1. Load session; find `CageState` for `label`.
2. Build `BoardState`; apply `linear_system.initial_eliminations` and user placements.
3. Compute `cage_cands_union` = union of `board.candidates[r][c]` for all cage cells.
4. `all_solutions` = `sorted(sol_sums(len(cage.cells), 0, cage.total))` as sorted lists.
5. `auto_impossible` = solutions where any digit is absent from `cage_cands_union`.
6. `user_eliminated` = `cage.user_eliminated_solns`.

### New endpoint: `POST /api/puzzle/{sid}/cage/{label}/solutions/eliminate`

Body: `EliminateSolutionRequest`. Returns `PuzzleState`.

Steps:
1. Load session; find `CageState` for `label`.
2. Normalise request body to a sorted list.
3. Toggle: if solution is in `user_eliminated_solns`, remove it; otherwise append it.
4. Save updated session.
5. Recompute candidate grid (`_compute_candidate_grid`) — user eliminations now filter
   `cage_solns`, so candidates are automatically narrowed.
6. Return full updated `PuzzleState`.

### `patch_cage` (existing endpoint — modified)

When a cage total is edited, clear `user_eliminated_solns` on that cage: the old
combinations no longer correspond to the new total.

---

## Frontend Changes (`killer_sudoku/static/main.ts`, `killer_sudoku/static/index.html`)

### New state variables

```typescript
let inspectCageMode = false;
let inspectedCageLabel: string | null = null;
```

### New button: `#inspect-cage-btn`

Sits in `#playing-actions` alongside `#edit-candidates-btn` and `#candidates-mode-btn`.
Hidden until candidates are shown. Toggling it sets/clears `inspectCageMode` and
updates `#cage-inspector` visibility. Independent of `candidateEditMode` — both can
be active simultaneously.

### Mousedown handler (modified)

When `inspectCageMode` is true, after resolving `(row, col)` from click coordinates,
find the cage label by searching `currentState.cages` for the cage containing `(row,
col)`. Call `fetchCageSolutions(label)` and render the inspector. This runs alongside
existing click behaviour (cell selection or candidate cycling) without replacing it.

### `fetchCageSolutions(label: string): Promise<void>`

```
GET /api/puzzle/{sid}/cage/{label}/solutions
→ CageSolutionsResponse
→ renderCageInspector(response)
```

### `renderCageInspector(data: CageSolutionsResponse): void`

Populates `#cage-inspector` with:

- Header: "Cage {label} — total {N} — {k} cells"
- **Active solutions** (all_solutions − auto_impossible − user_eliminated): full-colour
  digit chips, one solution per row, clickable. Click calls
  `eliminateSolution(label, solution)`.
- **User-eliminated solutions**: same chip layout but with strikethrough text, clickable
  to restore (same `eliminateSolution` endpoint — it toggles).
- **Auto-impossible solutions**: faded chips, at bottom, not interactive.

Chip layout example for solution [1, 5]:

```
[1] [5]
```

### `eliminateSolution(label: string, solution: number[]): Promise<void>`

```
POST /api/puzzle/{sid}/cage/{label}/solutions/eliminate
body: { solution }
→ PuzzleState
→ currentState = response
→ renderPlayingMode()      // updates candidate canvas
→ fetchCageSolutions(label)  // refreshes inspector panel
```

### Dismissal

`#cage-inspector` is hidden when:
- `#inspect-cage-btn` is toggled off, or
- Candidates are hidden (`showCandidates` becomes false).

---

## HTML additions (`killer_sudoku/static/index.html`)

```html
<button id="inspect-cage-btn" class="btn-secondary" hidden>Inspect cage</button>
```

Added to `#playing-actions` alongside the other candidates sub-buttons.

```html
<div id="cage-inspector" hidden>
  <!-- populated by renderCageInspector() -->
</div>
```

Added below `#grid-canvas` inside `#images-row` or directly below the canvas column.

---

## CSS additions (`killer_sudoku/static/styles.css`)

- `.soln-row`: flex row, gap, margin for each solution.
- `.soln-chip`: small bordered box showing one digit.
- `.soln-row.active`: default colour, `cursor: pointer`.
- `.soln-row.user-eliminated`: `text-decoration: line-through`, muted colour, `cursor: pointer`.
- `.soln-row.auto-impossible`: `opacity: 0.4`, `cursor: default`.
- `#cage-inspector`: padding, border-top, max-height with overflow-y auto (defensive).

---

## Test additions

### `tests/api/test_endpoints.py`

- `test_cage_solutions_returns_all_for_fresh_cage`: GET solutions for a confirmed puzzle,
  assert `all_solutions` matches expected combinations for cage total, `auto_impossible`
  and `user_eliminated` are empty.
- `test_eliminate_solution_toggles`: POST eliminate, assert solution appears in
  `user_eliminated_solns`; POST again, assert it is restored.
- `test_eliminate_narrows_candidates`: POST eliminate on a 2-cell cage where eliminating
  one combination reduces the possible digits; assert returned `PuzzleState.candidate_grid`
  reflects the narrowing.
- `test_patch_cage_clears_eliminated_solns`: PATCH cage total, assert
  `user_eliminated_solns` is cleared.

### `tests/e2e/test_candidates.py`

- `test_inspect_cage_btn_appears_when_candidates_shown`: show candidates, assert
  `#inspect-cage-btn` is visible.
- `test_cage_inspector_appears_on_cage_click`: enter inspect mode, click canvas, assert
  `#cage-inspector` is visible.

---

## Scope boundaries

- No pagination: maximum 12 solutions for any realistic cage.
- No per-cell solution filtering (which cell gets which digit): the inspector shows
  unordered combinations only.
- Auto-impossible uses a necessary-condition check (digit absent from cage candidates
  union), not full bipartite matching.
- No undo support for solution eliminations in this sprint.
