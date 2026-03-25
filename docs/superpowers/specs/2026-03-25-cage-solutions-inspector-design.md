# Cage Solutions Inspector — Design Spec

**Goal:** Let the user select a cage, inspect all valid digit combinations for it, and
eliminate combinations they know are wrong — with eliminations persisted server-side and
feeding back into the candidate grid.

**Architecture:** New "Inspect cage" toggle button enables inspect mode. Clicking a cage
in that mode fetches its solutions from a new GET endpoint and renders them in a panel
that replaces the original-photo column (the photo is no longer needed once the grid is
confirmed). A toggle POST endpoint eliminates or restores individual solutions.
Eliminated solutions feed back into candidate computation in auto mode.

**Tech stack:** FastAPI + Pydantic (backend), TypeScript + Canvas (frontend), existing
JSON session store.

**Note:** Cage totals cannot be edited after confirm, so `user_eliminated_solns` never
needs to be invalidated by a total change.

---

## Data Model

### `CageState` (modified — `killer_sudoku/api/schemas.py`)

Add one field:

```python
user_eliminated_solns: list[list[int]] = []
```

Each entry is a sorted list of digits identifying one eliminated combination — e.g.
`[[1, 5], [2, 4]]` means those two combinations have been user-eliminated.

### New schemas — `killer_sudoku/api/schemas.py`

```python
class EliminateSolutionRequest(BaseModel):
    solution: list[int]  # sorted digit list identifying the combination to toggle
```

```python
class CageSolutionsResponse(BaseModel):
    label: str                        # letter label, used in API URLs
    all_solutions: list[list[int]]    # complete set from sol_sums, as sorted lists
    auto_impossible: list[list[int]]  # solver says unreachable
    user_eliminated: list[list[int]]  # user has struck these out
    # active = all_solutions − auto_impossible − user_eliminated (computed by frontend)
```

`all_solutions` is produced by converting each `frozenset` from `sol_sums` to a sorted
list, then sorting the resulting list of lists:

```python
all_solutions = sorted(sorted(s) for s in sol_sums(len(cage.cells), 0, cage.total))
```

`auto_impossible` definition: a solution is auto-impossible if it is absent from
`board.cage_solns[cage_idx]` after linear-system eliminations are applied. This is
exactly the filtered list that `_compute_candidate_grid` already uses, so the inspector
and the candidate grid are perfectly consistent with each other:

```python
possible = {frozenset(s) for s in board.cage_solns[cage_idx]}
auto_impossible = [s for s in all_solutions if frozenset(s) not in possible]
```

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

Returns 404 if session or label not found; 409 if session has not yet been confirmed
(`state.user_grid is None`); 400 if the cage has non-empty `subdivisions` (out of scope).

Steps:
1. Load session (404 if not found).
2. Find the 0-based cage index: `cage_idx = next(i for i, c in enumerate(state.cages) if c.label == upper)` (404 if not found).
3. Guard: if `state.user_grid is None`, raise 409. If `cage.subdivisions`, raise 400.
4. Build `BoardState`; apply `linear_system.initial_eliminations` and user placements (same as `_compute_candidate_grid`).
5. `all_solutions` = `sorted(sorted(s) for s in sol_sums(len(cage.cells), 0, cage.total))`.
6. `possible` = `{frozenset(s) for s in board.cage_solns[cage_idx]}` (already filtered by linear system). `board` is always built from `state.cages` in order, so the 0-based index from step 2 is identical to the `int(board.regions[r, c])` index used in `_compute_candidate_grid`.
7. `auto_impossible` = `[s for s in all_solutions if frozenset(s) not in possible]`.
8. `user_eliminated` = `cage.user_eliminated_solns`.

### New endpoint: `POST /api/puzzle/{sid}/cage/{label}/solutions/eliminate`

Body: `EliminateSolutionRequest`. Returns `PuzzleState`. Returns 404 if session or
label not found; 409 if not yet confirmed; 400 for subdivided cage; 422 if the
`solution` digits are out of range 1–9, contain duplicates, or have wrong length for
the cage. Eliminating an already-`auto_impossible` solution is allowed (it is stored in
`user_eliminated_solns` but has no additional effect on candidates — the display shows
it faded regardless).

Steps:
1. Load session; find cage (404 guards as above).
2. Guard 409 (not confirmed), 400 (subdivided), 422 (invalid digits).
3. Normalise request `solution` to a sorted list.
4. Toggle: if the sorted solution is already in `user_eliminated_solns` (compare as
   sorted lists), remove it; otherwise append it.
5. Save updated session.
6. Recompute candidate grid (`_compute_candidate_grid`) — user eliminations filter
   `cage_solns`, automatically narrowing candidates in auto mode.
7. Return full updated `PuzzleState`.

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
shows/hides `#cage-inspector`. Independent of `candidateEditMode` — both can be active
simultaneously.

### Layout change on confirm

After the user confirms the grid, `#original-img` and its containing `.image-col` are
hidden. `#cage-inspector` takes their place in the right column of `#images-row`.
The `#cage-inspector` div is a sibling of the left `.image-col` (which contains
`#grid-canvas`), and is initially hidden until the user opens it via `#inspect-cage-btn`.

### Mousedown handler (modified)

When `inspectCageMode` is true, after resolving `(row, col)` from click coordinates,
find the cage label by searching `currentState.cages` for the cage whose `cells`
contains `{row, col}`. Call `fetchCageSolutions(label)` and set `inspectedCageLabel`.
This runs in addition to existing click behaviour: if `candidateEditMode` is also active,
a click fires both the candidate cycle and the cage inspector fetch.

### `fetchCageSolutions(label: string): Promise<void>`

```
GET /api/puzzle/{sid}/cage/{label}/solutions
→ CageSolutionsResponse
→ renderCageInspector(response)
```

### `renderCageInspector(data: CageSolutionsResponse): void`

Populates `#cage-inspector`. The cage header uses the coordinate of the top-left cell
(i.e. `cage.cells[0]` from `currentState.cages`, which is where the total is displayed
on the grid), formatted as `c<row>,<col>` with 1-based indices. Example: a cage whose
total appears in cell (row 2, col 3) has header "c2,3 — total 15 — 3 cells".

Each solution is displayed as a set literal: `{1,5}`, `{2,4}`, etc.

- **Active solutions** (`all_solutions` minus `auto_impossible` minus `user_eliminated`,
  auto-impossible takes precedence if a solution appears in both): normal text, cursor
  pointer. Click calls `eliminateSolution(label, solution)`.
- **User-eliminated solutions** (in `user_eliminated` and NOT in `auto_impossible`):
  strikethrough text, cursor pointer. Click restores (same `eliminateSolution` toggle).
- **Auto-impossible solutions**: faded text, at bottom, not interactive, regardless of
  whether they also appear in `user_eliminated`.

Example panel for a 2-cell cage total 6 where `{2,4}` has been user-eliminated:

```
c3,1 — total 6 — 2 cells
{1,5}
~~{2,4}~~
```

### `eliminateSolution(label: string, solution: number[]): Promise<void>`

```
POST /api/puzzle/{sid}/cage/{label}/solutions/eliminate
body: { solution }
→ PuzzleState
→ currentState = response
→ renderPlayingMode()        // updates candidate canvas
→ fetchCageSolutions(label)  // refreshes inspector panel
```

### Dismissal

`#cage-inspector` is hidden when:
- `#inspect-cage-btn` is toggled off, or
- Candidates are hidden (`showCandidates` becomes false).

---

## HTML changes (`killer_sudoku/static/index.html`)

```html
<button id="inspect-cage-btn" class="btn-secondary" hidden>Inspect cage</button>
```

Added to `#playing-actions` alongside the other candidates sub-buttons.

The right `.image-col` (which currently contains `<h2>Original Photo</h2>` and
`#original-img`) is repurposed: on confirm, its contents are replaced with
`#cage-inspector`:

```html
<div class="image-col" id="inspector-col" hidden>
  <h2 id="inspector-heading"></h2>
  <div id="cage-inspector">
    <!-- populated by renderCageInspector() -->
  </div>
</div>
```

`#inspector-col` is shown when `#inspect-cage-btn` is toggled on, hidden when toggled
off or when candidates are hidden.

---

## CSS additions (`killer_sudoku/static/styles.css`)

- `.soln-item`: block element, one solution per line, `cursor: pointer`.
- `.soln-item.active`: default text colour.
- `.soln-item.user-eliminated`: `text-decoration: line-through`, muted colour.
- `.soln-item.auto-impossible`: `opacity: 0.4`, `cursor: default`.
- `#cage-inspector`: padding, `font-family: monospace`.

---

## Test additions

### `tests/api/test_endpoints.py`

- `test_cage_solutions_returns_all_for_fresh_cage`: GET solutions for a confirmed puzzle;
  assert `all_solutions` matches expected combinations for the cage total; assert
  `user_eliminated` is empty; assert `auto_impossible ⊆ all_solutions`.
- `test_cage_solutions_404_unknown_session`: GET with unknown sid → 404.
- `test_cage_solutions_404_unknown_label`: GET with unknown label → 404.
- `test_cage_solutions_409_before_confirm`: GET before `/confirm` → 409.
- `test_eliminate_solution_toggles`: POST eliminate, assert solution appears in returned
  `PuzzleState.cages[i].user_eliminated_solns`; POST again, assert it is absent.
- `test_eliminate_narrows_candidates`: POST eliminate on a 2-cell cage; eliminating one
  combination reduces possible digits; assert returned `candidate_grid` reflects narrowing.
- `test_eliminate_422_invalid_digits`: POST with out-of-range digits → 422.

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
- Auto-impossible is derived from `board.cage_solns` (already filtered by the linear
  system) — no additional bipartite matching needed.
- No undo support for solution eliminations in this sprint.
- Subdivided cages (non-empty `subdivisions`): not supported in this sprint. Both new
  endpoints return 400 for subdivided cages.
