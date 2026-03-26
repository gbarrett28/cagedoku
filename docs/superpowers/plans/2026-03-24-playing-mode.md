# Playing Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cell-by-cell puzzle playing mode with golden solution storage, undo history, and placeholder hint/undo buttons.

**Architecture:** Three new API endpoints (`confirm`, `cell`, `undo`) extend `PuzzleState` with `golden_solution`, `user_grid`, and `move_history`. The canvas gains click-to-select and keyboard-digit-entry in playing mode; `user_grid is null` means review mode, non-null means playing mode.

**Tech Stack:** Python/FastAPI/Pydantic (backend), TypeScript/HTML5 Canvas (frontend), pytest/starlette TestClient (tests).

**Spec:** `docs/superpowers/specs/2026-03-24-playing-mode-design.md`

---

## File Map

| File | Change |
|------|--------|
| `killer_sudoku/api/schemas.py` | Add `MoveRecord`, `CellEntryRequest`; extend `PuzzleState` |
| `killer_sudoku/api/routers/puzzle.py` | Fix `patch_cage`/`subdivide_cage` propagation; add `confirm`, `cell`, `undo` endpoints |
| `killer_sudoku/static/index.html` | Add `playing-actions` div with `undo-btn`, `hints-btn` |
| `killer_sudoku/static/styles.css` | Style playing-mode action area |
| `killer_sudoku/static/main.ts` | New interfaces, module state, `drawGrid` layers, handlers, wiring |
| `tests/api/test_endpoints.py` | Add `TestConfirm`, `TestCellEntry`, `TestUndo` classes |

---

## Task 1 — Schema additions

**Files:**
- Modify: `killer_sudoku/api/schemas.py`

- [ ] **Add `MoveRecord` and `CellEntryRequest` to schemas.py, and extend `PuzzleState`**

  In `killer_sudoku/api/schemas.py`, add these two new models **before** `PuzzleState`:

  ```python
  class MoveRecord(BaseModel):
      """One step in the user's play history.

      Stores both the new digit and the previous digit so any move can be
      reversed without needing to replay the full history.
      """

      row: int         # 1-based (1–9)
      col: int         # 1-based (1–9)
      digit: int       # digit placed (1–9); 0 = cell was cleared
      prev_digit: int  # digit that was there before (0 = was empty)


  class CellEntryRequest(BaseModel):
      """Request to place or clear a digit in the user's grid."""

      row: int    # 1-based (1–9)
      col: int    # 1-based (1–9)
      digit: int  # 1–9 to place; 0 to clear
  ```

  Then add three fields to `PuzzleState` (after `original_image_b64`):

  ```python
      golden_solution: list[list[int]] | None = None
      # None  → pre-confirm (OCR review phase)
      # 9×9   → computed by /confirm; 0 means solver could not determine cell

      user_grid: list[list[int]] | None = None
      # None  → pre-confirm
      # 9×9   → playing mode; 0 = cell not yet filled by user

      move_history: list[MoveRecord] = []
      # Ordered record of every digit entry or clear, newest last.
  ```

- [ ] **Run bronze gate on schemas.py only**

  ```
  python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/api/schemas.py
  python -m mypy --strict killer_sudoku/api/schemas.py
  ```
  Expected: no errors.

- [ ] **Verify session round-trip preserves new fields**

  Run the existing session tests — new fields have defaults so they must round-trip cleanly:

  ```
  python -m pytest tests/api/test_session.py -v
  ```
  Expected: all pass.

- [ ] **Commit**

  ```
  git add killer_sudoku/api/schemas.py
  git commit -m "feat: add MoveRecord, CellEntryRequest; extend PuzzleState with playing-mode fields"
  ```

---

## Task 2 — Fix PuzzleState propagation in `patch_cage` and `subdivide_cage`

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py` (two `PuzzleState(...)` construction sites)

Both `patch_cage` and `subdivide_cage` rebuild `PuzzleState` by listing fields
explicitly. After Task 1's additions they will silently drop `golden_solution`,
`user_grid`, and `move_history`. Fix both with `model_copy`.

- [ ] **Write the failing test**

  Add to `tests/api/test_endpoints.py` (inside class `TestPatchCage`):

  ```python
  def test_playing_mode_fields_survive_cage_edit(
      self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
  ) -> None:
      """Editing a cage total must not wipe out playing-mode fields."""
      # Manually inject playing-mode fields into a saved state
      playing = trivial_state.model_copy(update={
          "user_grid": [[0] * 9 for _ in range(9)],
          "golden_solution": [[1] * 9 for _ in range(9)],
          "move_history": [],
      })
      store.save(playing)
      first_label = playing.cages[0].label
      res = client.patch(
          f"/api/puzzle/{playing.session_id}/cage/{first_label}",
          json={"total": 7},
      )
      assert res.status_code == 200
      body = res.json()
      assert body["user_grid"] is not None
      assert body["golden_solution"] is not None
  ```

- [ ] **Run to verify it fails**

  ```
  python -m pytest tests/api/test_endpoints.py::TestPatchCage::test_playing_mode_fields_survive_cage_edit -v
  ```
  Expected: FAIL (user_grid is None in response).

- [ ] **Fix `patch_cage` in `killer_sudoku/api/routers/puzzle.py`**

  Replace the `updated = PuzzleState(...)` block in `patch_cage` with:

  ```python
  updated = state.model_copy(update={"cages": updated_cages})
  ```

- [ ] **Fix `subdivide_cage` in `killer_sudoku/api/routers/puzzle.py`**

  Replace the `updated = PuzzleState(...)` block in `subdivide_cage` with:

  ```python
  updated = state.model_copy(update={"cages": updated_cages})
  ```

- [ ] **Run the new test and full endpoint suite**

  ```
  python -m pytest tests/api/test_endpoints.py -v
  ```
  Expected: all pass including the new test.

- [ ] **Commit**

  ```
  git add killer_sudoku/api/routers/puzzle.py tests/api/test_endpoints.py
  git commit -m "fix: propagate playing-mode fields through patch_cage and subdivide_cage"
  ```

---

## Task 3 — `confirm` endpoint

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py`
- Modify: `tests/api/test_endpoints.py`

- [ ] **Write failing tests**

  Add a new `TestConfirm` class to `tests/api/test_endpoints.py`.

  `KNOWN_SOLUTION` is already defined in `tests/fixtures/minimal_puzzle.py` —
  add it to the existing import from that module at the top of the test file:

  ```python
  from tests.fixtures.minimal_puzzle import (
      KNOWN_SOLUTION,
      make_trivial_spec,
  )
  ```

  Then add the class:

  ```python
  class TestConfirm:
      def test_returns_200_with_user_grid_all_zeros(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          assert res.status_code == 200
          body = res.json()
          assert body["user_grid"] is not None
          assert len(body["user_grid"]) == 9
          assert all(len(row) == 9 for row in body["user_grid"])
          assert all(cell == 0 for row in body["user_grid"] for cell in row)

      def test_golden_solution_matches_known_solution(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          body = res.json()
          assert body["golden_solution"] == KNOWN_SOLUTION

      def test_returns_409_on_already_confirmed_session(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          assert res.status_code == 409

      def test_returns_404_for_unknown_session(
          self, client: TestClient
      ) -> None:
          res = client.post("/api/puzzle/no-such-session/confirm")
          assert res.status_code == 404

      def test_returns_422_for_invalid_cage_layout(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """Solver raises on an invalid layout — endpoint must return 422."""
          # Corrupt the cage totals to make the puzzle unsolvable/invalid.
          # The easiest way: set every cage total to 0, which the solver rejects.
          corrupted_cages = [
              cage.model_copy(update={"total": 0})
              for cage in trivial_state.cages
          ]
          bad_state = trivial_state.model_copy(update={"cages": corrupted_cages})
          store.save(bad_state)
          res = client.post(f"/api/puzzle/{bad_state.session_id}/confirm")
          assert res.status_code == 422
  ```

- [ ] **Run to verify they fail**

  ```
  python -m pytest tests/api/test_endpoints.py::TestConfirm -v
  ```
  Expected: all FAIL (404 — endpoint does not exist yet).

- [ ] **Implement `confirm` endpoint in `killer_sudoku/api/routers/puzzle.py`**

  Add the following imports at the top of the `make_router` function's enclosing
  scope (if not already present — `Grid` and `ProcessingError` are already imported
  by the existing `solve_puzzle` endpoint):

  Add this endpoint **before** `solve_puzzle` inside `make_router`:

  ```python
  @router.post("/{session_id}/confirm", response_model=PuzzleState)
  async def confirm_puzzle(session_id: str) -> PuzzleState:
      """Solve the puzzle and transition the session to playing mode.

      Runs engine_solve() with cheat_solve() fallback. Stores the golden
      solution (0 for cells the solver cannot determine) and initialises
      user_grid to all zeros. Returns 409 if already confirmed.
      """
      try:
          state = store.load(session_id)
      except KeyError as exc:
          raise HTTPException(status_code=404, detail="Session not found") from exc

      if state.user_grid is not None:
          raise HTTPException(status_code=409, detail="Session already confirmed")

      spec = _cage_states_to_spec(state.cages, state.spec_data)
      grd = Grid()
      grd.set_up(spec)

      try:
          alts_sum, _ = grd.engine_solve()
      except (AssertionError, ValueError) as exc:
          raise HTTPException(status_code=422, detail=str(exc)) from exc

      if alts_sum != 81:
          grd.cheat_solve()

      golden: list[list[int]] = [
          [
              int(next(iter(grd.sq_poss[r][c]))) if len(grd.sq_poss[r][c]) == 1 else 0
              for c in range(9)
          ]
          for r in range(9)
      ]
      updated = state.model_copy(update={
          "golden_solution": golden,
          "user_grid": [[0] * 9 for _ in range(9)],
      })
      store.save(updated)
      return updated
  ```

- [ ] **Run tests to verify they pass**

  ```
  python -m pytest tests/api/test_endpoints.py::TestConfirm -v
  ```
  Expected: all pass.

- [ ] **Run full endpoint suite**

  ```
  python -m pytest tests/api/test_endpoints.py -v
  ```
  Expected: all pass.

- [ ] **Commit**

  ```
  git add killer_sudoku/api/routers/puzzle.py tests/api/test_endpoints.py
  git commit -m "feat: add POST /confirm endpoint — solves puzzle and enters playing mode"
  ```

---

## Task 4 — `cell` entry endpoint

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py`
- Modify: `tests/api/test_endpoints.py`

- [ ] **Write failing tests**

  Add a new `TestCellEntry` class to `tests/api/test_endpoints.py`:

  ```python
  class TestCellEntry:
      def _confirm(self, client: TestClient, session_id: str) -> None:
          client.post(f"/api/puzzle/{session_id}/confirm")

      def test_digit_stored_in_user_grid(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          self._confirm(client, trivial_state.session_id)
          res = client.patch(
              f"/api/puzzle/{trivial_state.session_id}/cell",
              json={"row": 1, "col": 1, "digit": 5},
          )
          assert res.status_code == 200
          assert res.json()["user_grid"][0][0] == 5

      def test_move_record_appended_with_prev_digit(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          self._confirm(client, trivial_state.session_id)
          res = client.patch(
              f"/api/puzzle/{trivial_state.session_id}/cell",
              json={"row": 2, "col": 3, "digit": 7},
          )
          history = res.json()["move_history"]
          assert len(history) == 1
          assert history[0] == {"row": 2, "col": 3, "digit": 7, "prev_digit": 0}

      def test_prev_digit_recorded_on_overwrite(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          self._confirm(client, trivial_state.session_id)
          client.patch(
              f"/api/puzzle/{trivial_state.session_id}/cell",
              json={"row": 1, "col": 1, "digit": 5},
          )
          res = client.patch(
              f"/api/puzzle/{trivial_state.session_id}/cell",
              json={"row": 1, "col": 1, "digit": 3},
          )
          history = res.json()["move_history"]
          assert history[-1]["prev_digit"] == 5

      def test_clear_sets_cell_to_zero_and_records_prev(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          self._confirm(client, trivial_state.session_id)
          client.patch(
              f"/api/puzzle/{trivial_state.session_id}/cell",
              json={"row": 1, "col": 1, "digit": 5},
          )
          res = client.patch(
              f"/api/puzzle/{trivial_state.session_id}/cell",
              json={"row": 1, "col": 1, "digit": 0},
          )
          body = res.json()
          assert body["user_grid"][0][0] == 0
          assert body["move_history"][-1]["digit"] == 0
          assert body["move_history"][-1]["prev_digit"] == 5

      def test_returns_409_on_unconfirmed_session(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          res = client.patch(
              f"/api/puzzle/{trivial_state.session_id}/cell",
              json={"row": 1, "col": 1, "digit": 5},
          )
          assert res.status_code == 409

      def test_returns_422_on_invalid_row(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          self._confirm(client, trivial_state.session_id)
          res = client.patch(
              f"/api/puzzle/{trivial_state.session_id}/cell",
              json={"row": 10, "col": 1, "digit": 5},
          )
          assert res.status_code == 422
  ```

- [ ] **Run to verify they fail**

  ```
  python -m pytest tests/api/test_endpoints.py::TestCellEntry -v
  ```
  Expected: all FAIL.

- [ ] **Implement `cell` endpoint**

  Add the import for `CellEntryRequest` to the imports block in `puzzle.py`
  (it comes from `killer_sudoku.api.schemas`). Then add this endpoint
  inside `make_router`, after `confirm_puzzle`:

  ```python
  @router.patch("/{session_id}/cell", response_model=PuzzleState)
  async def enter_cell(
      session_id: str,
      req: CellEntryRequest,
  ) -> PuzzleState:
      """Place or clear a digit in the user's playing grid.

      Records every change as a MoveRecord (including clears) so the full
      history can be reversed by repeated calls to /undo.
      """
      try:
          state = store.load(session_id)
      except KeyError as exc:
          raise HTTPException(status_code=404, detail="Session not found") from exc

      if state.user_grid is None:
          raise HTTPException(status_code=409, detail="Session not yet confirmed")

      if not (1 <= req.row <= 9 and 1 <= req.col <= 9 and 0 <= req.digit <= 9):
          raise HTTPException(status_code=422, detail="row/col must be 1–9; digit 0–9")

      r, c = req.row - 1, req.col - 1
      prev_digit = state.user_grid[r][c]

      new_grid = [row[:] for row in state.user_grid]
      new_grid[r][c] = req.digit

      new_history = list(state.move_history) + [
          MoveRecord(
              row=req.row,
              col=req.col,
              digit=req.digit,
              prev_digit=prev_digit,
          )
      ]

      updated = state.model_copy(update={
          "user_grid": new_grid,
          "move_history": new_history,
      })
      store.save(updated)
      return updated
  ```

  Also add `MoveRecord` to the import from `killer_sudoku.api.schemas` at the
  top of `puzzle.py`.

- [ ] **Run tests**

  ```
  python -m pytest tests/api/test_endpoints.py::TestCellEntry -v
  ```
  Expected: all pass.

- [ ] **Commit**

  ```
  git add killer_sudoku/api/routers/puzzle.py tests/api/test_endpoints.py
  git commit -m "feat: add PATCH /cell endpoint — enter or clear a digit in playing grid"
  ```

---

## Task 5 — `undo` endpoint

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py`
- Modify: `tests/api/test_endpoints.py`

- [ ] **Write failing tests**

  Add a new `TestUndo` class to `tests/api/test_endpoints.py`:

  ```python
  class TestUndo:
      def _setup_with_move(
          self,
          client: TestClient,
          store: SessionStore,
          trivial_state: PuzzleState,
          row: int = 1,
          col: int = 1,
          digit: int = 5,
      ) -> None:
          store.save(trivial_state)
          client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          client.patch(
              f"/api/puzzle/{trivial_state.session_id}/cell",
              json={"row": row, "col": col, "digit": digit},
          )

      def test_undo_restores_prev_digit(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          self._setup_with_move(client, store, trivial_state)
          res = client.post(f"/api/puzzle/{trivial_state.session_id}/undo")
          assert res.status_code == 200
          assert res.json()["user_grid"][0][0] == 0

      def test_undo_removes_move_from_history(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          self._setup_with_move(client, store, trivial_state)
          res = client.post(f"/api/puzzle/{trivial_state.session_id}/undo")
          assert res.json()["move_history"] == []

      def test_undo_of_overwrite_restores_previous_digit(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          client.patch(
              f"/api/puzzle/{trivial_state.session_id}/cell",
              json={"row": 1, "col": 1, "digit": 5},
          )
          client.patch(
              f"/api/puzzle/{trivial_state.session_id}/cell",
              json={"row": 1, "col": 1, "digit": 9},
          )
          res = client.post(f"/api/puzzle/{trivial_state.session_id}/undo")
          assert res.json()["user_grid"][0][0] == 5

      def test_returns_409_on_empty_history(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          res = client.post(f"/api/puzzle/{trivial_state.session_id}/undo")
          assert res.status_code == 409

      def test_returns_404_for_unknown_session(
          self, client: TestClient
      ) -> None:
          res = client.post("/api/puzzle/no-such-session/undo")
          assert res.status_code == 404
  ```

- [ ] **Run to verify they fail**

  ```
  python -m pytest tests/api/test_endpoints.py::TestUndo -v
  ```
  Expected: all FAIL.

- [ ] **Implement `undo` endpoint**

  Add this endpoint inside `make_router`, after `enter_cell`:

  ```python
  @router.post("/{session_id}/undo", response_model=PuzzleState)
  async def undo_move(session_id: str) -> PuzzleState:
      """Reverse the most recent cell entry or clear.

      Pops the last MoveRecord and restores the previous digit in user_grid.
      Returns 409 if there is nothing to undo.
      """
      try:
          state = store.load(session_id)
      except KeyError as exc:
          raise HTTPException(status_code=404, detail="Session not found") from exc

      if not state.move_history:
          raise HTTPException(status_code=409, detail="Nothing to undo")

      # user_grid is guaranteed non-None here: move_history is only non-empty
      # after /confirm, which sets user_grid at the same time.
      assert state.user_grid is not None

      last = state.move_history[-1]
      new_history = list(state.move_history[:-1])

      new_grid = [row[:] for row in state.user_grid]
      new_grid[last.row - 1][last.col - 1] = last.prev_digit

      updated = state.model_copy(update={
          "user_grid": new_grid,
          "move_history": new_history,
      })
      store.save(updated)
      return updated
  ```

- [ ] **Run tests**

  ```
  python -m pytest tests/api/test_endpoints.py::TestUndo -v
  ```
  Expected: all pass.

- [ ] **Run full suite + bronze gate**

  ```
  python -m pytest tests/api/ -v
  python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
  python -m mypy --strict killer_sudoku/
  ```
  Expected: all pass, no type errors.

- [ ] **Commit**

  ```
  git add killer_sudoku/api/routers/puzzle.py tests/api/test_endpoints.py
  git commit -m "feat: add POST /undo endpoint — reverse last cell entry"
  ```

---

## Task 6 — HTML and CSS

**Files:**
- Modify: `killer_sudoku/static/index.html`
- Modify: `killer_sudoku/static/styles.css`

- [ ] **Add playing-mode actions div to `index.html`**

  Inside `#review-panel`, after the `#editor-section` closing `</div>`, add:

  ```html
  <!-- Playing mode actions — hidden until user confirms layout -->
  <div id="playing-actions" hidden>
    <div class="form-actions">
      <button id="undo-btn" class="btn-secondary" disabled>Undo</button>
      <button id="hints-btn" class="btn-secondary" disabled>Hints</button>
    </div>
  </div>
  ```

- [ ] **Add playing-mode CSS to `styles.css`**

  Append to `styles.css`:

  ```css
  /* ── Playing mode ── */

  #playing-actions {
    border-top: 1px solid var(--border);
    padding-top: 1.25rem;
    margin-top: 0.25rem;
  }
  ```

- [ ] **Visually verify the HTML structure is sane**

  Open `killer_sudoku/static/index.html` in a browser (or inspect the DOM after
  starting `coach`) — `#playing-actions` should be present but hidden.

- [ ] **Commit**

  ```
  git add killer_sudoku/static/index.html killer_sudoku/static/styles.css
  git commit -m "feat: add playing-mode action buttons (undo, hints) to review panel"
  ```

---

## Task 7 — TypeScript: interfaces, module state, `drawGrid` playing-mode layers

**Files:**
- Modify: `killer_sudoku/static/main.ts`

- [ ] **Add `MoveRecord` interface and extend `PuzzleState` (top of `main.ts`, API types section)**

  After the existing `CageState` interface, add:

  ```typescript
  interface MoveRecord {
    row: number;        // 1-based
    col: number;        // 1-based
    digit: number;      // 0–9 (0 = clear)
    prev_digit: number; // 0–9
  }
  ```

  Add four fields to the existing `PuzzleState` interface:

  ```typescript
    golden_solution: number[][] | null;
    user_grid: number[][] | null;
    move_history: MoveRecord[];
  ```

- [ ] **Add module-level state variables (after existing `let currentSessionId`)**

  These are **new** variables — they do not exist in the current `main.ts`:

  ```typescript
  let currentState: PuzzleState | null = null;
  let selectedCell: { row: number; col: number } | null = null;
  // row and col are 1-based (1–9), matching the API convention
  ```

- [ ] **Update `drawGrid` to accept `selected` parameter and draw playing-mode layers**

  Change the function signature:

  ```typescript
  function drawGrid(
    canvas: HTMLCanvasElement,
    state: PuzzleState,
    selected: { row: number; col: number } | null = null
  ): void {
  ```

  After the white-fill block (step 1) and **before** the cage underlay (step 2),
  insert the selected-cell highlight:

  ```typescript
    // 1b. Selected-cell highlight (before cage underlay so red lines render on top)
    if (selected !== null) {
      ctx.fillStyle = "#dbeafe";
      ctx.fillRect(
        MARGIN + (selected.col - 1) * CELL,
        MARGIN + (selected.row - 1) * CELL,
        CELL,
        CELL
      );
    }
  ```

  At the very end of `drawGrid`, after the cage-totals block, add:

  ```typescript
    // 7. User-entered digits (playing mode)
    if (state.user_grid !== null) {
      ctx.fillStyle = "#2563eb";
      ctx.font = "bold 28px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const digit = state.user_grid[r]?.[c] ?? 0;
          if (digit > 0) {
            ctx.fillText(
              String(digit),
              MARGIN + c * CELL + CELL / 2,
              MARGIN + r * CELL + CELL / 2
            );
          }
        }
      }
    }
  ```

- [ ] **Compile and check for type errors**

  ```
  tsc
  ```
  Expected: no output (clean compile).

- [ ] **Commit**

  ```
  git add killer_sudoku/static/main.ts
  git commit -m "feat: extend TypeScript PuzzleState interface; add playing-mode drawGrid layers"
  ```

---

## Task 8 — TypeScript: confirm handler, playing mode, cell entry, undo

**Files:**
- Modify: `killer_sudoku/static/main.ts`

- [ ] **Add `renderPlayingMode` helper (after existing `renderSolution`)**

  ```typescript
  function renderPlayingMode(state: PuzzleState): void {
    currentState = state;
    drawGrid(el<HTMLCanvasElement>("grid-canvas"), state, selectedCell);
    el<HTMLElement>("review-actions").hidden = true;
    el<HTMLElement>("editor-section").hidden = true;
    el<HTMLElement>("playing-actions").hidden = false;
    el<HTMLElement>("solution-panel").hidden = true;
    updateUndoButton(state);
  }

  function updateUndoButton(state: PuzzleState): void {
    el<HTMLButtonElement>("undo-btn").disabled = state.move_history.length === 0;
  }
  ```

- [ ] **Add `handleConfirm` (after existing `handleProcess`)**

  ```typescript
  async function handleConfirm(): Promise<void> {
    if (!currentSessionId) {
      setStatus("No active session — process an image first.", true);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/puzzle/${currentSessionId}/confirm`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = (await res.json()) as { detail: string };
        setStatus(`Confirm failed: ${err.detail}`, true);
        return;
      }
      const state = (await res.json()) as PuzzleState;
      renderPlayingMode(state);
      setStatus("");
    } catch (e) {
      setStatus(`Network error: ${String(e)}`, true);
    } finally {
      setLoading(false);
    }
  }
  ```

- [ ] **Add `handleCellEntry` and `handleUndo` (after `handleConfirm`)**

  ```typescript
  async function handleCellEntry(digit: number): Promise<void> {
    if (!currentSessionId || selectedCell === null) return;
    try {
      const res = await fetch(`/api/puzzle/${currentSessionId}/cell`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          row: selectedCell.row,
          col: selectedCell.col,
          digit,
        }),
      });
      if (!res.ok) return;
      const state = (await res.json()) as PuzzleState;
      currentState = state;
      drawGrid(el<HTMLCanvasElement>("grid-canvas"), state, selectedCell);
      updateUndoButton(state);
    } catch {
      // Cell entry is best-effort; network errors are silently ignored
    }
  }

  async function handleUndo(): Promise<void> {
    if (!currentSessionId) return;
    try {
      const res = await fetch(`/api/puzzle/${currentSessionId}/undo`, {
        method: "POST",
      });
      if (!res.ok) return;
      const state = (await res.json()) as PuzzleState;
      currentState = state;
      drawGrid(el<HTMLCanvasElement>("grid-canvas"), state, selectedCell);
      updateUndoButton(state);
    } catch {
      // Undo is best-effort; network errors are silently ignored
    }
  }
  ```

- [ ] **Add canvas `mousedown` handler for cell selection (in the wire-up section)**

  ```typescript
  el<HTMLCanvasElement>("grid-canvas").addEventListener("mousedown", (e) => {
    if (currentState?.user_grid === null || currentState?.user_grid === undefined) return;
    const rect = el<HTMLCanvasElement>("grid-canvas").getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const col = Math.floor((x - MARGIN) / CELL) + 1;
    const row = Math.floor((y - MARGIN) / CELL) + 1;
    if (col >= 1 && col <= 9 && row >= 1 && row <= 9) {
      selectedCell = { row, col };
      drawGrid(el<HTMLCanvasElement>("grid-canvas"), currentState, selectedCell);
    }
  });
  ```

- [ ] **Add `keydown` handler for digit entry (in the wire-up section)**

  ```typescript
  document.addEventListener("keydown", (e) => {
    if (currentState?.user_grid === null || currentState?.user_grid === undefined) return;
    if (selectedCell === null) return;
    if (e.key >= "1" && e.key <= "9") {
      void handleCellEntry(Number(e.key));
    } else if (e.key === "Backspace" || e.key === "Delete") {
      void handleCellEntry(0);
    }
  });
  ```

- [ ] **Rewire `confirm-btn` and wire `undo-btn` (update existing wire-up section)**

  Change the existing `confirm-btn` listener from calling `handleSolve` to calling
  `handleConfirm`:

  ```typescript
  // Before (remove this):
  el<HTMLButtonElement>("confirm-btn").addEventListener("click", () => {
    void handleSolve();
  });

  // After (replace with):
  el<HTMLButtonElement>("confirm-btn").addEventListener("click", () => {
    void handleConfirm();
  });
  ```

  Add the undo button listener:

  ```typescript
  el<HTMLButtonElement>("undo-btn").addEventListener("click", () => {
    void handleUndo();
  });
  ```

- [ ] **Compile**

  ```
  tsc
  ```
  Expected: clean compile, no errors.

- [ ] **Commit**

  ```
  git add killer_sudoku/static/main.ts
  git commit -m "feat: add confirm/cell/undo handlers and playing-mode canvas interaction"
  ```

---

## Task 9 — Full bronze + silver gate, push

- [ ] **Run full bronze gate**

  ```
  python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
  python -m ruff check --unsafe-fixes --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
  python -m ruff format killer_sudoku/ tests/
  python -m mypy --strict killer_sudoku/
  python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
  ```
  Expected: all 161+ tests pass, no ruff or mypy errors.

- [ ] **Run silver gate**

  ```
  python -m ruff check killer_sudoku/ tests/
  python -m mypy --strict killer_sudoku/
  ```
  Expected: clean pass.

- [ ] **Manual smoke test**

  Start the server (`coach`), upload a puzzle image, confirm, click a cell,
  type a digit — verify it appears blue and centred in the cell. Press
  Backspace — verify digit clears. Click Undo — verify it restores. Verify
  Hints button is visible but disabled.

- [ ] **Final commit and push on feature branch**

  If there are any remaining unstaged changes (e.g., formatted files):

  ```
  git add killer_sudoku/ tests/ docs/
  git commit -m "chore: playing mode — bronze/silver gate pass"
  git push
  ```
