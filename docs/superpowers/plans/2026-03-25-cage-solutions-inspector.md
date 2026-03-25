# Cage Solutions Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cage solutions inspector panel that lets users select a cage, view all valid digit combinations, and eliminate combinations — with eliminations persisted and feeding back into the candidate grid.

**Architecture:** Three layers of change: (1) Pydantic schemas gain `user_eliminated_solns` on `CageState` plus two new schemas; (2) two new API endpoints and one modified helper; (3) TypeScript frontend gains an inspect-mode button, a panel in the right column (replacing the original photo after confirm), and the associated fetch/render logic.

**Tech stack:** FastAPI + Pydantic v2, TypeScript, HTML Canvas, pytest, Playwright.

---

## File Map

| File | Change |
|------|--------|
| `killer_sudoku/api/schemas.py` | Add `user_eliminated_solns` to `CageState`; add `EliminateSolutionRequest`, `CageSolutionsResponse` |
| `killer_sudoku/api/routers/puzzle.py` | Modify `_compute_candidate_grid`; add `get_cage_solutions`, `eliminate_cage_solution` endpoints |
| `killer_sudoku/static/index.html` | Add `#inspect-cage-btn`; replace right photo column with `#inspector-col` |
| `killer_sudoku/static/styles.css` | Add `.soln-item` variants and `#cage-inspector` styles |
| `killer_sudoku/static/main.ts` | Add inspect mode state, button handlers, mousedown update, `fetchCageSolutions`, `renderCageInspector`, `eliminateSolution` |
| `tests/fixtures/minimal_puzzle.py` | Add `make_two_cell_cage_spec()` fixture |
| `tests/api/test_endpoints.py` | Add `TestCageSolutions` and `TestEliminateSolution` test classes |
| `tests/e2e/test_candidates.py` | Add two e2e tests for inspect button and panel appearance |

---

## Key Context for Implementers

### `_spec_to_cage_states` ordering
Cages are built by iterating `sorted(cage_cells)` where `cage_cells` is keyed by the
`spec.regions` index (1-based, non-zero). The 0-based position in `state.cages` (i.e.
`enumerate(state.cages)`) equals the position in the sorted regions-index list, which
equals `board.cage_solns`'s 0-based index. So:

```python
cage_idx = next(i for i, c in enumerate(state.cages) if c.label == upper)
# cage_idx is the same index used in _compute_candidate_grid via int(board.regions[r,c])
```

### `make_two_cell_cage_spec` fixture needed
The test for narrowing candidates needs a 2-cell cage. Create it in
`tests/fixtures/minimal_puzzle.py` mirroring `make_three_cell_cage_spec`.

Cells (0,0) and (0,1) — KNOWN_SOLUTION values 5 and 3 → total = 8.
`sol_sums(2, 0, 8)` = `[{1,7},{2,6},{3,5}]`. After confirm + eliminations, all three
should be possible (no linear-system conflicts for this cage).
Eliminating `[3, 5]` leaves `[{1,7},{2,6}]` → auto_candidates = {1,2,6,7} only.

Remove wall: `border_x[0, 0] = False` (one wall between (0,0) and (0,1)).
Totals: `totals[0,0] = 8`, `totals[0,1] = 0`.

### Bronze gate command (run before every commit)
```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff check --unsafe-fixes --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

---

## Task 1: Schema additions

**Files:**
- Modify: `killer_sudoku/api/schemas.py`

- [ ] **Step 1: Add `user_eliminated_solns` to `CageState`**

In `killer_sudoku/api/schemas.py`, add one field to the end of `CageState`:

```python
user_eliminated_solns: list[list[int]] = []
```

Full updated class:

```python
class CageState(BaseModel):
    """The mutable state of a single detected cage.

    Attributes:
        label: Single uppercase letter assigned sequentially by cage index.
        total: OCR-detected (or user-corrected) cage sum.
        cells: All cells belonging to this cage, 1-based row/col.
        subdivisions: Non-empty only after the user manually splits this cage.
        user_eliminated_solns: Sorted digit lists the user has eliminated, e.g.
            [[1, 5], [2, 4]]. Persisted server-side; feeds back into candidate
            computation (eliminated combinations are excluded from cage_solns).
    """

    label: str
    total: int
    cells: list[CellPosition]
    subdivisions: list[SubCageState] = []
    user_eliminated_solns: list[list[int]] = []
```

- [ ] **Step 2: Add `EliminateSolutionRequest` and `CageSolutionsResponse` after the last class**

Append to `killer_sudoku/api/schemas.py`:

```python
class EliminateSolutionRequest(BaseModel):
    """Request body for toggling a cage solution as user-eliminated.

    solution: Sorted list of digits identifying the combination, e.g. [1, 5].
    The endpoint toggles: if already eliminated it is restored, otherwise added.
    """

    solution: list[int]


class CageSolutionsResponse(BaseModel):
    """All solution data for one cage, split by status.

    all_solutions: Complete set from sol_sums, each as a sorted digit list.
    auto_impossible: Subset of all_solutions absent from board.cage_solns after
        linear-system eliminations — consistent with _compute_candidate_grid.
    user_eliminated: Combinations the user has explicitly struck out.
    active = all_solutions - auto_impossible - user_eliminated (frontend computes).
    """

    label: str
    all_solutions: list[list[int]]
    auto_impossible: list[list[int]]
    user_eliminated: list[list[int]]
```

- [ ] **Step 3: Add the two new schemas to the router import**

In `killer_sudoku/api/routers/puzzle.py`, add `CageSolutionsResponse` and
`EliminateSolutionRequest` to the existing `from killer_sudoku.api.schemas import`
line.

- [ ] **Step 4: Run bronze gate — expect pass (no logic changed yet)**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 5: Commit**

```bash
git add killer_sudoku/api/schemas.py killer_sudoku/api/routers/puzzle.py
git commit -m "feat: add user_eliminated_solns to CageState and cage solutions schemas"
```

---

## Task 2: Fixture — two-cell cage

**Files:**
- Modify: `tests/fixtures/minimal_puzzle.py`

- [ ] **Step 1: Add constants and `make_two_cell_cage_spec`**

Add after `make_three_cell_cage_spec` at the bottom of `tests/fixtures/minimal_puzzle.py`:

```python
# Cells (0,0) and (0,1) from KNOWN_SOLUTION: 5 + 3 = 8
TWO_CELL_CAGE_CELLS = ((0, 0), (0, 1))
TWO_CELL_CAGE_TOTAL = KNOWN_SOLUTION[0][0] + KNOWN_SOLUTION[0][1]  # = 8


def make_two_cell_cage_spec() -> PuzzleSpec:
    """Return a PuzzleSpec where BoardState cells (0,0) and (0,1) form one cage.

    All other cells remain as single-cell cages.
    Cage total = 8 (KNOWN_SOLUTION[0][0] + KNOWN_SOLUTION[0][1] = 5 + 3).
    sol_sums(2, 0, 8) = [{1,7}, {2,6}, {3,5}] — three valid combinations.

    Border removal: border_x[col=0, row=0] controls the wall between
    validation (0,0) and (0,1), i.e. BoardState cells (0,0) and (0,1).
    """
    totals = make_trivial_cage_totals().copy()
    totals[0, 0] = TWO_CELL_CAGE_TOTAL
    totals[0, 1] = 0

    border_x = make_trivial_border_x().copy()
    border_x[0, 0] = False  # remove wall between (0,0) and (0,1)

    return validate_cage_layout(totals, border_x, make_trivial_border_y())
```

- [ ] **Step 2: Run tests — expect pass**

```bash
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/minimal_puzzle.py
git commit -m "test: add make_two_cell_cage_spec fixture"
```

---

## Task 3: Modify `_compute_candidate_grid` to respect user eliminations

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py`

- [ ] **Step 1: Locate and modify the `cage_solns` assignment**

In `_compute_candidate_grid`, find:

```python
cage_idx = int(board.regions[r, c])  # 0-based
cage_solns: list[frozenset[int]] = board.cage_solns[cage_idx]
cage_possible: set[int] = set()
```

Replace the `cage_solns` line:

```python
cage_idx = int(board.regions[r, c])  # 0-based
# Filter out user-eliminated combinations before computing possible/essential.
_eliminated = {
    frozenset(s) for s in state.cages[cage_idx].user_eliminated_solns
}
cage_solns: list[frozenset[int]] = [
    s for s in board.cage_solns[cage_idx] if s not in _eliminated
]
cage_possible: set[int] = set()
```

- [ ] **Step 2: Run bronze gate — expect pass**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 3: Commit**

```bash
git add killer_sudoku/api/routers/puzzle.py
git commit -m "feat: filter user-eliminated cage solutions from candidate computation"
```

---

## Task 4: GET /api/puzzle/{sid}/cage/{label}/solutions

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py`
- Test: `tests/api/test_endpoints.py`

- [ ] **Step 1: Add fixture and import to test file**

Add near the top of `tests/api/test_endpoints.py` (with the existing imports):

```python
from killer_sudoku.api.routers.puzzle import _compute_candidate_grid
from tests.fixtures.minimal_puzzle import (
    TWO_CELL_CAGE_TOTAL,
    make_two_cell_cage_spec,
)
```

Add this fixture inside the test file (after `trivial_state`):

```python
@pytest.fixture
def two_cell_state(store: SessionStore) -> PuzzleState:
    """Confirmed PuzzleState with a 2-cell cage (cells (0,0)+(0,1), total=8)."""
    spec = make_two_cell_cage_spec()
    cages = _spec_to_cage_states(spec)
    state = PuzzleState(
        session_id="two-cell-001",
        newspaper="guardian",
        cages=cages,
        spec_data=_spec_to_data(spec),
        original_image_b64="dGVzdA==",
        golden_solution=KNOWN_SOLUTION,
        user_grid=[[0] * 9 for _ in range(9)],
    )
    state = state.model_copy(
        update={"candidate_grid": _compute_candidate_grid(state, None)}
    )
    store.save(state)
    return state
```

Also add `KNOWN_SOLUTION` to the fixture import:

```python
from tests.fixtures.minimal_puzzle import KNOWN_SOLUTION, make_trivial_spec
```

(merge with the existing import line)

- [ ] **Step 2: Write failing GET tests**

Add a new class:

```python
class TestCageSolutions:
    def test_returns_all_solutions_for_fresh_cage(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        """2-cell total-8 cage: sol_sums gives [{1,7},{2,6},{3,5}]."""
        sid = two_cell_state.session_id
        label = two_cell_state.cages[0].label
        res = client.get(f"/api/puzzle/{sid}/cage/{label}/solutions")
        assert res.status_code == 200
        body = res.json()
        assert sorted(body["all_solutions"]) == [[1, 7], [2, 6], [3, 5]]
        assert body["user_eliminated"] == []
        for s in body["auto_impossible"]:
            assert s in body["all_solutions"]

    def test_returns_404_for_unknown_session(self, client: TestClient) -> None:
        res = client.get("/api/puzzle/no-such-session/cage/A/solutions")
        assert res.status_code == 404

    def test_returns_404_for_unknown_label(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        res = client.get(
            f"/api/puzzle/{two_cell_state.session_id}/cage/ZZZ/solutions"
        )
        assert res.status_code == 404

    def test_returns_409_before_confirm(
        self,
        client: TestClient,
        store: SessionStore,
        trivial_state: PuzzleState,
    ) -> None:
        store.save(trivial_state)
        label = trivial_state.cages[0].label
        res = client.get(
            f"/api/puzzle/{trivial_state.session_id}/cage/{label}/solutions"
        )
        assert res.status_code == 409
```

- [ ] **Step 3: Run — expect FAIL (endpoint missing)**

```bash
python -m pytest tests/api/test_endpoints.py::TestCageSolutions -v
```

- [ ] **Step 4: Check existing imports in puzzle.py**

Verify that `sol_sums` is already imported at the top of `puzzle.py`. If not, add:

```python
from killer_sudoku.solver.equation import sol_sums
```

Verify `BoardState`, `SolverEngine`, `default_rules`, `Elimination` are already imported
(they are used in `_compute_candidate_grid`).

- [ ] **Step 5: Implement `get_cage_solutions`**

Add inside `make_router` in `puzzle.py`, after `solve_puzzle` (before `return router`):

```python
@router.get(
    "/{session_id}/cage/{label}/solutions",
    response_model=CageSolutionsResponse,
)
async def get_cage_solutions(
    session_id: str,
    label: str,
) -> CageSolutionsResponse:
    """Return all valid digit combinations for a cage, split by status.

    all_solutions: complete set from sol_sums.
    auto_impossible: solutions absent from board.cage_solns after linear-system
        eliminations — consistent with _compute_candidate_grid.
    user_eliminated: stored from CageState.user_eliminated_solns.
    Returns 404 if session/label unknown; 409 if not yet confirmed;
    400 if cage has subdivisions.
    """
    try:
        state = store.load(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Session not found") from exc

    upper = label.upper()
    try:
        cage_idx, cage = next(
            (i, c) for i, c in enumerate(state.cages) if c.label == upper
        )
    except StopIteration as exc:
        raise HTTPException(
            status_code=404, detail=f"Cage {label!r} not found"
        ) from exc

    if state.user_grid is None:
        raise HTTPException(status_code=409, detail="Session not yet confirmed")

    if cage.subdivisions:
        raise HTTPException(
            status_code=400, detail="Subdivided cages are not supported"
        )

    spec = _data_to_spec(state.spec_data)
    board = BoardState(spec)
    engine: SolverEngine = SolverEngine(board, rules=default_rules())
    engine.apply_eliminations(
        [
            e
            for e in board.linear_system.initial_eliminations
            if e.digit in board.candidates[e.cell[0]][e.cell[1]]
        ]
    )
    user_elims: list[Elimination] = [
        Elimination(cell=(r, c), digit=d)
        for r in range(9)
        for c in range(9)
        for d in range(1, 10)
        if state.user_grid[r][c] != 0 and d != state.user_grid[r][c]
    ]
    engine.apply_eliminations(user_elims)

    all_solutions = sorted(
        sorted(s) for s in sol_sums(len(cage.cells), 0, cage.total)
    )
    possible = {frozenset(s) for s in board.cage_solns[cage_idx]}
    auto_impossible = [s for s in all_solutions if frozenset(s) not in possible]

    return CageSolutionsResponse(
        label=upper,
        all_solutions=all_solutions,
        auto_impossible=auto_impossible,
        user_eliminated=cage.user_eliminated_solns,
    )
```

- [ ] **Step 6: Run GET tests — expect pass**

```bash
python -m pytest tests/api/test_endpoints.py::TestCageSolutions -v
```

- [ ] **Step 7: Run full test suite**

```bash
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 8: Commit**

```bash
git add killer_sudoku/api/routers/puzzle.py tests/api/test_endpoints.py
git commit -m "feat: add GET /cage/{label}/solutions endpoint"
```

---

## Task 5: POST /api/puzzle/{sid}/cage/{label}/solutions/eliminate

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py`
- Test: `tests/api/test_endpoints.py`

- [ ] **Step 1: Write failing tests**

Add to `tests/api/test_endpoints.py`:

```python
class TestEliminateSolution:
    def test_eliminate_adds_to_user_eliminated(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        sid = two_cell_state.session_id
        label = two_cell_state.cages[0].label
        res = client.post(
            f"/api/puzzle/{sid}/cage/{label}/solutions/eliminate",
            json={"solution": [3, 5]},
        )
        assert res.status_code == 200
        cage = next(c for c in res.json()["cages"] if c["label"] == label)
        assert [3, 5] in cage["user_eliminated_solns"]

    def test_eliminate_twice_restores(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        sid = two_cell_state.session_id
        label = two_cell_state.cages[0].label
        url = f"/api/puzzle/{sid}/cage/{label}/solutions/eliminate"
        client.post(url, json={"solution": [3, 5]})
        res = client.post(url, json={"solution": [3, 5]})
        assert res.status_code == 200
        cage = next(c for c in res.json()["cages"] if c["label"] == label)
        assert [3, 5] not in cage["user_eliminated_solns"]

    def test_eliminate_narrows_candidates(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        """Eliminating [3,5] from 2-cell total-8 removes 3 and 5 from candidates."""
        sid = two_cell_state.session_id
        label = two_cell_state.cages[0].label
        res = client.post(
            f"/api/puzzle/{sid}/cage/{label}/solutions/eliminate",
            json={"solution": [3, 5]},
        )
        assert res.status_code == 200
        cg = res.json()["candidate_grid"]
        assert 3 not in cg["cells"][0][0]["auto_candidates"]
        assert 5 not in cg["cells"][0][0]["auto_candidates"]

    def test_returns_404_unknown_session(self, client: TestClient) -> None:
        res = client.post(
            "/api/puzzle/bad/cage/A/solutions/eliminate",
            json={"solution": [1, 7]},
        )
        assert res.status_code == 404

    def test_returns_404_unknown_label(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        res = client.post(
            f"/api/puzzle/{two_cell_state.session_id}/cage/ZZZ/solutions/eliminate",
            json={"solution": [1, 7]},
        )
        assert res.status_code == 404

    def test_returns_409_before_confirm(
        self,
        client: TestClient,
        store: SessionStore,
        trivial_state: PuzzleState,
    ) -> None:
        store.save(trivial_state)
        label = trivial_state.cages[0].label
        res = client.post(
            f"/api/puzzle/{trivial_state.session_id}/cage/{label}/solutions/eliminate",
            json={"solution": [1]},
        )
        assert res.status_code == 409

    def test_returns_422_invalid_digits(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        sid = two_cell_state.session_id
        label = two_cell_state.cages[0].label
        res = client.post(
            f"/api/puzzle/{sid}/cage/{label}/solutions/eliminate",
            json={"solution": [0, 10]},
        )
        assert res.status_code == 422
```

- [ ] **Step 2: Run — expect FAIL**

```bash
python -m pytest tests/api/test_endpoints.py::TestEliminateSolution -v
```

- [ ] **Step 3: Implement `eliminate_cage_solution`**

Add inside `make_router`, after `get_cage_solutions`:

```python
@router.post(
    "/{session_id}/cage/{label}/solutions/eliminate",
    response_model=PuzzleState,
)
async def eliminate_cage_solution(
    session_id: str,
    label: str,
    req: EliminateSolutionRequest,
) -> PuzzleState:
    """Toggle a cage combination as user-eliminated (or restore it).

    Validates digits are in 1-9, distinct, and count matches cage size.
    Returns the full updated PuzzleState with recomputed candidate_grid.
    """
    try:
        state = store.load(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Session not found") from exc

    upper = label.upper()
    try:
        cage_idx, cage = next(
            (i, c) for i, c in enumerate(state.cages) if c.label == upper
        )
    except StopIteration as exc:
        raise HTTPException(
            status_code=404, detail=f"Cage {label!r} not found"
        ) from exc

    if state.user_grid is None:
        raise HTTPException(status_code=409, detail="Session not yet confirmed")

    if cage.subdivisions:
        raise HTTPException(
            status_code=400, detail="Subdivided cages are not supported"
        )

    solution = sorted(req.solution)
    if (
        len(solution) != len(cage.cells)
        or any(d < 1 or d > 9 for d in solution)
        or len(set(solution)) != len(solution)
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                "solution must contain distinct digits 1-9,"
                f" one per cage cell ({len(cage.cells)} cells)"
            ),
        )

    current = [sorted(s) for s in cage.user_eliminated_solns]
    if solution in current:
        current.remove(solution)
    else:
        current.append(solution)

    updated_cages = [
        c.model_copy(update={"user_eliminated_solns": current})
        if c.label == upper
        else c
        for c in state.cages
    ]
    updated = state.model_copy(update={"cages": updated_cages})
    assert updated.user_grid is not None
    new_cg = _compute_candidate_grid(updated, updated.candidate_grid)
    updated = updated.model_copy(update={"candidate_grid": new_cg})
    store.save(updated)
    return updated
```

Note: `cage_idx` is extracted but not used in the endpoint body — this is intentional
(it's used only in the GET endpoint). Remove it to satisfy mypy:

```python
    try:
        cage = next(c for c in state.cages if c.label == upper)
    except StopIteration as exc:
        raise HTTPException(
            status_code=404, detail=f"Cage {label!r} not found"
        ) from exc
```

(The GET endpoint needs `cage_idx` for `board.cage_solns[cage_idx]`; the POST does not.)

- [ ] **Step 4: Run tests — expect pass**

```bash
python -m pytest tests/api/test_endpoints.py::TestEliminateSolution -v
```

- [ ] **Step 5: Run full suite**

```bash
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 6: Bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff check --unsafe-fixes --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 7: Commit**

```bash
git add killer_sudoku/api/routers/puzzle.py tests/api/test_endpoints.py
git commit -m "feat: add POST /cage/{label}/solutions/eliminate endpoint"
```

---

## Task 6: HTML — inspector column and button

**Files:**
- Modify: `killer_sudoku/static/index.html`

- [ ] **Step 1: Replace the original-photo column**

Find:

```html
      <div class="image-col">
        <h2>Original Photo</h2>
        <img id="original-img" alt="Uploaded puzzle photo">
      </div>
```

Replace with:

```html
      <div class="image-col" id="inspector-col" hidden>
        <h2 id="inspector-heading"></h2>
        <div id="cage-inspector"></div>
      </div>
```

- [ ] **Step 2: Add `#inspect-cage-btn`**

After `#help-candidates-btn`:

```html
        <button id="inspect-cage-btn" class="btn-secondary" hidden>Inspect cage</button>
```

- [ ] **Step 3: Commit**

```bash
git add killer_sudoku/static/index.html
git commit -m "feat: add inspector column and inspect-cage button to HTML"
```

---

## Task 7: CSS — inspector styles

**Files:**
- Modify: `killer_sudoku/static/styles.css`

- [ ] **Step 1: Append at end of `styles.css`**

```css
/* ── Cage solutions inspector ── */

#cage-inspector {
  font-family: ui-monospace, monospace;
  font-size: 0.9rem;
  padding: 0.5rem 0;
}

.soln-item {
  display: block;
  padding: 0.2rem 0;
  line-height: 1.6;
}

.soln-item.active {
  color: var(--text);
  cursor: pointer;
}

.soln-item.active:hover {
  color: var(--accent);
}

.soln-item.user-eliminated {
  text-decoration: line-through;
  color: var(--text-muted);
  cursor: pointer;
}

.soln-item.user-eliminated:hover {
  color: var(--text);
}

.soln-item.auto-impossible {
  opacity: 0.35;
  cursor: default;
}
```

- [ ] **Step 2: Commit**

```bash
git add killer_sudoku/static/styles.css
git commit -m "feat: add cage inspector CSS styles"
```

---

## Task 8: TypeScript — inspect mode, fetch, render

**Files:**
- Modify: `killer_sudoku/static/main.ts`

Read the current `main.ts` before editing. Key existing items:
- `currentState`, `currentSessionId`, `showCandidates`, `candidateEditMode`, `selectedCell`
- `renderPlayingMode(state)`, `drawGrid(canvas, state, selectedCell, showCandidates)`
- `el<T>(id)` helper
- Mousedown handler on `#grid-canvas`
- `#candidates-btn` click handler (shows/hides sub-buttons)

- [ ] **Step 1: Add `CageSolutionsResponse` interface and update `CageState`**

In the interface section of `main.ts`, add:

```typescript
interface CageSolutionsResponse {
  label: string;
  all_solutions: number[][];
  auto_impossible: number[][];
  user_eliminated: number[][];
}
```

Add `user_eliminated_solns: number[][]` to the existing `CageState` interface.

- [ ] **Step 2: Add inspect mode state variables**

Near `showCandidates` and `candidateEditMode`:

```typescript
let inspectCageMode = false;
let inspectedCageLabel: string | null = null;
```

- [ ] **Step 3: Add `renderCageInspector`, `fetchCageSolutions`, `eliminateSolution`**

Add these three functions before `renderPlayingMode`. Use `replaceChildren()` to clear
the inspector (never `innerHTML`):

```typescript
function renderCageInspector(
  data: CageSolutionsResponse,
  cage: CageState
): void {
  const inspector = el<HTMLElement>("cage-inspector");
  const heading = el<HTMLElement>("inspector-heading");

  const topLeft = cage.cells[0];
  heading.textContent = `c${topLeft.row},${topLeft.col} \u2014 total ${cage.total} \u2014 ${cage.cells.length} cells`;

  const impossibleSet = new Set(data.auto_impossible.map((s) => s.join(",")));
  const eliminatedSet = new Set(data.user_eliminated.map((s) => s.join(",")));
  const active = data.all_solutions.filter(
    (s) => !impossibleSet.has(s.join(",")) && !eliminatedSet.has(s.join(","))
  );
  const userElim = data.user_eliminated.filter(
    (s) => !impossibleSet.has(s.join(","))
  );

  inspector.replaceChildren();

  for (const soln of active) {
    const div = document.createElement("div");
    div.className = "soln-item active";
    div.textContent = `{${soln.join(",")}}`;
    div.addEventListener("click", () => {
      void eliminateSolution(data.label, soln);
    });
    inspector.appendChild(div);
  }

  for (const soln of userElim) {
    const div = document.createElement("div");
    div.className = "soln-item user-eliminated";
    div.textContent = `{${soln.join(",")}}`;
    div.addEventListener("click", () => {
      void eliminateSolution(data.label, soln);
    });
    inspector.appendChild(div);
  }

  for (const soln of data.auto_impossible) {
    const div = document.createElement("div");
    div.className = "soln-item auto-impossible";
    div.textContent = `{${soln.join(",")}}`;
    inspector.appendChild(div);
  }
}

async function fetchCageSolutions(label: string): Promise<void> {
  if (!currentSessionId || !currentState) return;
  const cage = currentState.cages.find((c) => c.label === label);
  if (!cage) return;
  try {
    const res = await fetch(
      `/api/puzzle/${currentSessionId}/cage/${label}/solutions`
    );
    if (!res.ok) return;
    const data = (await res.json()) as CageSolutionsResponse;
    renderCageInspector(data, cage);
  } catch {
    // best effort — inspector is non-critical
  }
}

async function eliminateSolution(
  label: string,
  solution: number[]
): Promise<void> {
  if (!currentSessionId) return;
  try {
    const res = await fetch(
      `/api/puzzle/${currentSessionId}/cage/${label}/solutions/eliminate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ solution }),
      }
    );
    if (!res.ok) return;
    const state = (await res.json()) as PuzzleState;
    renderPlayingMode(state);  // updates canvas, undo button, currentState
    void fetchCageSolutions(label);
  } catch {
    // best effort
  }
}
```

- [ ] **Step 4: Add `#inspect-cage-btn` click handler**

After the handler for `#help-candidates-btn`:

```typescript
el<HTMLButtonElement>("inspect-cage-btn").addEventListener("click", () => {
  inspectCageMode = !inspectCageMode;
  const btn = el<HTMLButtonElement>("inspect-cage-btn");
  btn.textContent = inspectCageMode ? "Stop inspecting" : "Inspect cage";
  if (!inspectCageMode) {
    el<HTMLElement>("inspector-col").hidden = true;
    inspectedCageLabel = null;
  }
});
```

- [ ] **Step 5: Show `#inspect-cage-btn` when candidates shown; hide when hidden**

In the `#candidates-btn` click handler, when `showCandidates` becomes `true`, add:

```typescript
el<HTMLElement>("inspect-cage-btn").hidden = false;
```

When `showCandidates` becomes `false`, add:

```typescript
el<HTMLElement>("inspect-cage-btn").hidden = true;
inspectCageMode = false;
el<HTMLButtonElement>("inspect-cage-btn").textContent = "Inspect cage";
el<HTMLElement>("inspector-col").hidden = true;
inspectedCageLabel = null;
```

- [ ] **Step 6: Update mousedown handler**

In the canvas mousedown handler, after existing click handling, add at the end of the
handler body (still inside the `if (row >= 1 && row <= 9 && col >= 1 && col <= 9)`
guard):

```typescript
    if (inspectCageMode && currentState) {
      const clickedCage = currentState.cages.find((cage) =>
        cage.cells.some((cp) => cp.row === row && cp.col === col)
      );
      if (clickedCage) {
        inspectedCageLabel = clickedCage.label;
        el<HTMLElement>("inspector-col").hidden = false;
        void fetchCageSolutions(clickedCage.label);
      }
    }
```

- [ ] **Step 7: Compile TypeScript (type-check only)**

```bash
cd killer_sudoku/static && npx tsc --noEmit
```

Fix any type errors.

- [ ] **Step 8: Compile to JS**

```bash
cd killer_sudoku/static && npx tsc
```

- [ ] **Step 9: Bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 10: Commit**

```bash
git add killer_sudoku/static/main.ts killer_sudoku/static/main.js
git commit -m "feat: add cage solutions inspector UI (inspect mode, panel, fetch/render)"
```

---

## Task 9: E2E tests

**Files:**
- Modify: `tests/e2e/test_candidates.py`

- [ ] **Step 1: Add `TestCageInspector` class**

```python
class TestCageInspector:
    def test_inspect_cage_btn_appears_when_candidates_shown(
        self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
    ) -> None:
        _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
        page.click("#candidates-btn")
        expect(page.locator("#inspect-cage-btn")).to_be_visible()

    def test_cage_inspector_appears_on_cage_click(
        self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
    ) -> None:
        _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
        page.click("#candidates-btn")
        page.click("#inspect-cage-btn")
        canvas = page.locator("#grid-canvas")
        canvas.click(position={"x": 30, "y": 30})
        page.wait_for_timeout(500)
        expect(page.locator("#inspector-col")).to_be_visible()
```

- [ ] **Step 2: Run e2e tests**

```bash
python -m pytest tests/e2e/test_candidates.py -v --timeout=120
```

- [ ] **Step 3: Full bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff check --unsafe-fixes --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/test_candidates.py
git commit -m "test: add e2e tests for cage inspector button and panel"
```

---

## Task 10: Final verification and push

- [ ] **Step 1: Silver gate**

```bash
python -m ruff check killer_sudoku/
python -m mypy --strict killer_sudoku/
```

Fix any violations. If complexity warnings appear, refactor rather than using `# noqa`.

- [ ] **Step 2: Full test suite**

```bash
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

All tests must pass.

- [ ] **Step 3: Push**

```bash
git push
```
