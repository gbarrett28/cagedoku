# Candidates View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-cell candidate sub-grid to the COACH playing canvas, with essential-digit highlighting, auto/manual modes, cycle-to-edit interaction, and Playwright e2e tests.

**Architecture:** New Pydantic schemas (`CandidateCell`, `CandidateGrid`) stored in `PuzzleState.candidate_grid`. A `_compute_candidate_grid` helper uses `BoardState`/`SolverEngine` directly (not `Grid.engine_solve`) to incorporate user placements. Two new endpoints handle mode switching and per-cell cycling. The frontend adds canvas layer 8 and four new buttons.

**Tech Stack:** FastAPI/Pydantic (backend), TypeScript/Canvas2D (frontend), pytest (unit tests), pytest-playwright (e2e tests), tsc (TypeScript compiler)

**Spec:** `docs/superpowers/specs/2026-03-24-candidates-view-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `killer_sudoku/api/schemas.py` | Modify | Add `CandidateCell`, `CandidateGrid`, `CandidateCycleRequest`, `CandidateModeRequest`; extend `PuzzleState` |
| `killer_sudoku/api/config.py` | Modify | Add `mock_spec: PuzzleSpec \| None = None` |
| `killer_sudoku/api/routers/puzzle.py` | Modify | Add `_compute_candidate_grid`, `_cycle_candidate`, `_min_merge_to_auto`; extend `/confirm`, `/cell`, `/undo`; add `/candidates/mode`, `/candidates/cell` |
| `killer_sudoku/static/index.html` | Modify | Add 4 buttons in `#playing-actions`, add `<dialog>` help modal |
| `killer_sudoku/static/main.ts` | Modify | Add TS interfaces, module state, drawGrid layer 8, handlers, keyboard routing |
| `tests/fixtures/candidates_puzzle.py` | Create | `make_candidates_spec()` factory (wraps `make_trivial_spec`) |
| `tests/api/test_endpoints.py` | Modify | Add 5 test classes for candidates |
| `tests/e2e/__init__.py` | Create | Empty package marker |
| `tests/e2e/conftest.py` | Create | `live_server_url` fixture (uvicorn thread) |
| `tests/e2e/test_candidates.py` | Create | Playwright e2e tests |
| `pyproject.toml` | Modify | Add `playwright>=1.40` and `pytest-playwright>=0.4` to dev deps |

---

## Task 1 — Pydantic schemas + CoachConfig mock_spec

**Files:**
- Modify: `killer_sudoku/api/schemas.py`
- Modify: `killer_sudoku/api/config.py`

- [ ] **Step 1: Add `CandidateCell`, `CandidateGrid`, `CandidateCycleRequest`, `CandidateModeRequest` to schemas.py**

  Open `killer_sudoku/api/schemas.py`. Add the `Literal` import if not present (check the existing imports — it may already be imported via `typing`). Insert these four classes after `SolveResponse`:

  ```python
  class CandidateCell(BaseModel):
      """Candidate state for one cell.

      auto_candidates: digits solver considers possible, from BoardState.candidates.
      auto_essential: auto_candidates ∩ cage must-set (cage-level property stored
          per-cell for frontend convenience).
      user_essential: user-promoted digits (overrides auto inessential).
      user_removed: user-eliminated digits (overrides auto present).
      Rule A: digits dropped from auto_candidates are silently removed from
          user_essential on recomputation.
      """

      auto_candidates: list[int]
      auto_essential: list[int]
      user_essential: list[int]
      user_removed: list[int]


  class CandidateGrid(BaseModel):
      """Full 9×9 grid of per-cell candidate state plus the current mode."""

      cells: list[list[CandidateCell]]  # 9 rows × 9 cols, 0-based
      mode: Literal["auto", "manual"] = "auto"


  class CandidateCycleRequest(BaseModel):
      """Cycle one digit in one cell, or reset the whole cell (digit=0).

      Mode is read from candidate_grid.mode in the session — not sent by client.
      row and col are 1-based (1–9). digit is 1–9 to cycle, or 0 to reset.
      """

      row: int
      col: int
      digit: int


  class CandidateModeRequest(BaseModel):
      """Switch candidate grid between auto and manual modes."""

      mode: Literal["auto", "manual"]
  ```

- [ ] **Step 2: Add `candidate_grid` to `PuzzleState`**

  In `PuzzleState`, after the `move_history` field, add:

  ```python
      candidate_grid: CandidateGrid | None = None
      # None → pre-confirm. Set at /confirm; updated after /cell, /undo,
      # /candidates/cell, and /candidates/mode.
  ```

  Also update the docstring `Attributes` block to add:
  ```
      candidate_grid: None before /confirm; CandidateGrid after.
  ```

- [ ] **Step 3: Add `mock_spec` to `CoachConfig`**

  Open `killer_sudoku/api/config.py`. Add these imports at the top (after existing imports):

  ```python
  from killer_sudoku.solver.puzzle_spec import PuzzleSpec
  ```

  Add this field to `CoachConfig` (after the `port` field):

  ```python
      mock_spec: PuzzleSpec | None = None
      # When set, the upload endpoint bypasses InpImage and returns this spec
      # directly. Used by Playwright e2e tests via CoachConfig(mock_spec=...).
  ```

  Since this field holds a mutable object, add `eq=False` to the dataclass or accept that equality comparison on CoachConfig instances may be affected. Actually, frozen dataclasses with mutable fields work but are not hashable. That is fine — CoachConfig is never used as a dict key. No change needed to the `@dataclasses.dataclass(frozen=True)` decorator.

- [ ] **Step 4: Run mypy + ruff to verify schemas**

  ```bash
  python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/api/
  python -m mypy --strict killer_sudoku/api/schemas.py killer_sudoku/api/config.py
  ```

  Expected: no errors. If mypy complains about `PuzzleSpec` field in frozen dataclass, add a `# type: ignore[misc]` comment only on that field (document why: frozen dataclass with mutable field is intentional for test injection). This is NOT a legitimate `# noqa` — it's a `# type: ignore` on a specific known-safe pattern.

- [ ] **Step 5: Commit**

  ```bash
  git add killer_sudoku/api/schemas.py killer_sudoku/api/config.py
  git commit -m "feat: add CandidateCell/CandidateGrid schemas and CoachConfig.mock_spec"
  ```

---

## Task 2 — Candidate computation helpers

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py`

- [ ] **Step 1: Add engine imports to puzzle.py**

  Open `killer_sudoku/api/routers/puzzle.py`. Add these imports alongside the existing solver imports:

  ```python
  from killer_sudoku.solver.engine import BoardState, SolverEngine, default_rules
  from killer_sudoku.solver.engine.types import Elimination
  ```

  Also add `CandidateCell`, `CandidateGrid`, `CandidateCycleRequest`, `CandidateModeRequest` to the `schemas` import block:

  ```python
  from killer_sudoku.api.schemas import (
      CagePatchRequest,
      CageState,
      CandidateCell,
      CandidateGrid,
      CandidateCycleRequest,
      CandidateModeRequest,
      CellEntryRequest,
      CellPosition,
      MoveRecord,
      PuzzleSpecData,
      PuzzleState,
      SolveResponse,
      SubdivideRequest,
      UploadResponse,
  )
  ```

  Also add `cast` to the `typing` import (or add a new import line):
  ```python
  from typing import Literal, cast
  ```

- [ ] **Step 2: Write `_compute_candidate_grid`**

  Add this function after `_encode_image` / `_resize_for_display` and before `make_router`:

  ```python
  def _compute_candidate_grid(
      state: PuzzleState,
      existing_grid: CandidateGrid | None,
  ) -> CandidateGrid:
      """Recompute auto_candidates and auto_essential for all unsolved cells.

      Uses BoardState/SolverEngine directly so that user placements can be
      injected as Elimination events before the engine runs. This ensures
      cage_solns and candidates reflect placed digits correctly.

      Solved cells (user_grid[r][c] != 0) have their CandidateCell copied
      unchanged from existing_grid (freeze rule). If existing_grid is None
      (initial call at /confirm), all user_essential and user_removed start empty.

      Rule A is applied for unsolved cells: digits no longer in auto_candidates
      are removed from user_essential.
      """
      assert state.user_grid is not None
      spec = _data_to_spec(state.spec_data)
      board = BoardState(spec)
      engine: SolverEngine = SolverEngine(board, rules=default_rules())

      # Step 1: apply linear system initial eliminations (same as normal solve)
      engine.apply_eliminations(
          [
              e
              for e in board.linear_system.initial_eliminations
              if e.digit in board.candidates[e.cell[0]][e.cell[1]]
          ]
      )

      # Step 2: pin user placements so the engine propagates them
      user_elims: list[Elimination] = [
          Elimination(cell=(r, c), digit=d)
          for r in range(9)
          for c in range(9)
          for d in range(1, 10)
          if state.user_grid[r][c] != 0 and d != state.user_grid[r][c]
      ]
      engine.apply_eliminations(user_elims)

      # Step 3: propagate — best-effort (partial results still useful)
      try:
          engine.solve()
      except (AssertionError, ValueError):
          pass

      # Step 4: build per-cell CandidateCell
      cells: list[list[CandidateCell]] = []
      for r in range(9):
          row_cells: list[CandidateCell] = []
          for c in range(9):
              placed = state.user_grid[r][c]
              if placed != 0:
                  # Solved cell: freeze existing state unchanged
                  if existing_grid is not None:
                      row_cells.append(existing_grid.cells[r][c])
                  else:
                      row_cells.append(
                          CandidateCell(
                              auto_candidates=[],
                              auto_essential=[],
                              user_essential=[],
                              user_removed=[],
                          )
                      )
              else:
                  # Unsolved cell: derive auto state from engine output
                  auto_cands_set = board.candidates[r][c]
                  cage_idx = int(board.regions[r, c])  # 0-based
                  cage_solns = board.cage_solns[cage_idx]
                  cage_must: set[int] = (
                      set(range(1, 10)) if cage_solns else set()
                  )
                  for soln in cage_solns:
                      cage_must &= soln

                  auto_ess = sorted(auto_cands_set & cage_must)
                  auto_cands = sorted(auto_cands_set)

                  # Preserve overrides; apply Rule A to user_essential
                  if existing_grid is not None:
                      prev = existing_grid.cells[r][c]
                      user_essential = [
                          d for d in prev.user_essential if d in auto_cands_set
                      ]
                      user_removed = list(prev.user_removed)
                  else:
                      user_essential = []
                      user_removed = []

                  row_cells.append(
                      CandidateCell(
                          auto_candidates=auto_cands,
                          auto_essential=auto_ess,
                          user_essential=user_essential,
                          user_removed=user_removed,
                      )
                  )
          cells.append(row_cells)

      mode = existing_grid.mode if existing_grid is not None else "auto"
      return CandidateGrid(cells=cells, mode=mode)
  ```

- [ ] **Step 3: Write `_cycle_candidate`**

  Add this function immediately after `_compute_candidate_grid`:

  ```python
  def _cycle_candidate(
      cell: CandidateCell,
      digit: int,
      mode: Literal["auto", "manual"],
  ) -> CandidateCell:
      """Advance digit one step through its state cycle in the given mode.

      Auto mode cycle (pre-check: if auto-impossible and not user-removed → no-op):
        inessential → essential (user)
        essential (user) → impossible
        essential (auto only) → impossible
        impossible (user) → restore (auto_essential determines displayed state)

      Manual mode cycle (all digits cycle freely):
        inessential → essential → impossible → inessential
      """
      auto_set = set(cell.auto_candidates)
      auto_ess = set(cell.auto_essential)
      user_ess = set(cell.user_essential)
      user_rem = set(cell.user_removed)

      if mode == "auto":
          if digit not in auto_set and digit not in user_rem:
              return cell  # auto-impossible, not user-removed: no-op
          if digit in user_rem:
              user_rem.discard(digit)
          elif digit in user_ess:
              user_ess.discard(digit)
              user_rem.add(digit)
          elif digit in auto_ess:
              # auto-essential only (not user_essential): essential → impossible
              user_rem.add(digit)
          else:
              # inessential: promote to essential
              user_ess.add(digit)
      else:
          # manual: full three-state cycle
          if digit in user_rem:
              user_rem.discard(digit)
          elif digit in user_ess:
              user_ess.discard(digit)
              user_rem.add(digit)
          else:
              user_ess.add(digit)

      return CandidateCell(
          auto_candidates=cell.auto_candidates,
          auto_essential=cell.auto_essential,
          user_essential=sorted(user_ess),
          user_removed=sorted(user_rem),
      )
  ```

- [ ] **Step 4: Write `_min_merge_to_auto`**

  Add immediately after `_cycle_candidate`:

  ```python
  def _min_merge_to_auto(
      existing: CandidateGrid,
      new_auto: CandidateGrid,
      user_grid: list[list[int]],
  ) -> CandidateGrid:
      """Merge manual→auto: for each digit, the more restrictive state wins.

      Uses ordering: impossible=0 < essential=1 < inessential=2.
      - Auto says impossible → clears from user_essential (Rule A).
      - User removed + auto says possible → stays in user_removed.
      - User essential + auto says inessential → stays in user_essential.
      Solved cells are frozen unchanged.
      """
      cells: list[list[CandidateCell]] = []
      for r in range(9):
          row_cells: list[CandidateCell] = []
          for c in range(9):
              if user_grid[r][c] != 0:
                  row_cells.append(existing.cells[r][c])
              else:
                  auto_cell = new_auto.cells[r][c]
                  manual_cell = existing.cells[r][c]
                  auto_set = set(auto_cell.auto_candidates)
                  # Rule A: auto-impossible beats user_essential
                  merged_ess = [d for d in manual_cell.user_essential if d in auto_set]
                  # User-removed stays removed (manual restriction persists)
                  merged_rem = list(manual_cell.user_removed)
                  row_cells.append(
                      CandidateCell(
                          auto_candidates=auto_cell.auto_candidates,
                          auto_essential=auto_cell.auto_essential,
                          user_essential=merged_ess,
                          user_removed=merged_rem,
                      )
                  )
          cells.append(row_cells)
      return CandidateGrid(cells=cells, mode="auto")
  ```

- [ ] **Step 5: Run mypy on puzzle.py**

  ```bash
  python -m mypy --strict killer_sudoku/api/routers/puzzle.py
  ```

  Expected: no errors. Common issues to fix:
  - `board.candidates[r][c]` is `set[int]` but mypy may type it as `object` — add `cast(set[int], board.candidates[r][c])` if needed
  - `board.regions` is `NDArray[np.intp]` — `int(board.regions[r, c])` is fine
  - `board.cage_solns[cage_idx]` is `list[frozenset[int]]` — iteration and `&` operator should type-check

- [ ] **Step 6: Commit helpers**

  ```bash
  git add killer_sudoku/api/routers/puzzle.py
  git commit -m "feat: add _compute_candidate_grid, _cycle_candidate, _min_merge_to_auto helpers"
  ```

---

## Task 3 — Extend /confirm; TestConfirmInitializesCandidates

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py` (confirm endpoint)
- Modify: `tests/api/test_endpoints.py`

- [ ] **Step 1: Write failing tests**

  Open `tests/api/test_endpoints.py`. Add this class after the existing `TestConfirm` class:

  ```python
  class TestConfirmInitializesCandidates:
      def test_candidate_grid_is_not_none(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          assert res.status_code == 200
          data = res.json()
          assert data["candidate_grid"] is not None

      def test_mode_is_auto(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          cg = res.json()["candidate_grid"]
          assert cg["mode"] == "auto"

      def test_all_overrides_empty(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          cg = res.json()["candidate_grid"]
          for r in range(9):
              for c in range(9):
                  cell = cg["cells"][r][c]
                  assert cell["user_essential"] == [], f"cell ({r},{c}) user_essential not empty"
                  assert cell["user_removed"] == [], f"cell ({r},{c}) user_removed not empty"

      def test_auto_candidates_match_solution(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """Trivial spec: every cell is a single-cell cage. After engine_solve,
          each cell's auto_candidates equals its solution digit."""
          store.save(trivial_state)
          res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          cg = res.json()["candidate_grid"]
          for r in range(9):
              for c in range(9):
                  cell = cg["cells"][r][c]
                  expected = KNOWN_SOLUTION[r][c]
                  assert cell["auto_candidates"] == [expected], (
                      f"cell ({r},{c}): expected [{expected}], got {cell['auto_candidates']}"
                  )
                  assert cell["auto_essential"] == [expected], (
                      f"cell ({r},{c}): expected essential [{expected}], got {cell['auto_essential']}"
                  )
  ```

- [ ] **Step 2: Run failing tests**

  ```bash
  python -m pytest tests/api/test_endpoints.py::TestConfirmInitializesCandidates -v
  ```

  Expected: FAIL — `candidate_grid` in response is `null` (not yet computed).

- [ ] **Step 3: Update /confirm to compute candidate_grid**

  In `puzzle.py`, in the `confirm_puzzle` endpoint, after the `golden` and `user_grid` are computed, add candidate grid computation before `state.model_copy`:

  ```python
  initial_state_for_cg = state.model_copy(
      update={
          "golden_solution": golden,
          "user_grid": [[0] * 9 for _ in range(9)],
      }
  )
  candidate_grid = _compute_candidate_grid(initial_state_for_cg, None)
  updated = state.model_copy(
      update={
          "golden_solution": golden,
          "user_grid": [[0] * 9 for _ in range(9)],
          "candidate_grid": candidate_grid,
      }
  )
  ```

  Remove the old `updated = state.model_copy(...)` that doesn't include `candidate_grid`.

- [ ] **Step 4: Run tests — expect pass**

  ```bash
  python -m pytest tests/api/test_endpoints.py::TestConfirmInitializesCandidates -v
  ```

  Expected: all 4 PASS.

- [ ] **Step 5: Also extend /confirm to bypass OCR when mock_spec set**

  In the `upload_puzzle` endpoint, after the existing `config` access, add a bypass at the start of the endpoint body (before the `try` block that writes the temp file):

  ```python
  if config.mock_spec is not None:
      spec = config.mock_spec
      cages = _spec_to_cage_states(spec)
      spec_data = _spec_to_data(spec)
      # Create a 1×1 white JPEG as placeholder original image
      import numpy as np as _np  # top-level import — move to file top instead
      placeholder = np.zeros((1, 1, 3), dtype=np.uint8) + 255
      original_b64 = _encode_image(placeholder)
      session_id = str(uuid.uuid4())
      mock_state = PuzzleState(
          session_id=session_id,
          newspaper=newspaper,
          cages=cages,
          spec_data=spec_data,
          original_image_b64=original_b64,
      )
      store.save(mock_state)
      return UploadResponse(session_id=session_id, state=mock_state)
  ```

  **IMPORTANT**: Do NOT use inline imports. The `import numpy as np` above is wrong per CLAUDE.md. `numpy` is already imported at the top of puzzle.py as `import numpy as np`. Use the existing `np` name. Just use `np.zeros(...)` directly.

- [ ] **Step 6: Run full test suite**

  ```bash
  python -m pytest tests/api/test_endpoints.py -v
  ```

  Expected: all existing tests still pass plus new 4.

- [ ] **Step 7: Commit**

  ```bash
  git add killer_sudoku/api/routers/puzzle.py tests/api/test_endpoints.py
  git commit -m "feat: /confirm computes candidate_grid; add TestConfirmInitializesCandidates"
  ```

---

## Task 4 — Extend /cell and /undo; TestCandidateWithCellEntry + TestRuleA

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py`
- Modify: `tests/api/test_endpoints.py`

- [ ] **Step 1: Write failing tests**

  Add these two classes to `tests/api/test_endpoints.py`:

  ```python
  class TestCandidateWithCellEntry:
      """candidate_grid is updated after /cell and restored after /undo.

      Freeze rule: solved cell's CandidateCell is unchanged during recomputation.
      """

      def _confirmed_session(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> str:
          """Confirm trivial session and return session_id."""
          store.save(trivial_state)
          res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          assert res.status_code == 200
          return trivial_state.session_id

      def test_candidate_grid_updated_after_cell_entry(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          sid = self._confirmed_session(client, store, trivial_state)
          # Place KNOWN_SOLUTION[0][0] = 5 in cell (1,1)
          res = client.patch(
              f"/api/puzzle/{sid}/cell",
              json={"row": 1, "col": 1, "digit": 5},
          )
          assert res.status_code == 200
          cg = res.json()["candidate_grid"]
          assert cg is not None

      def test_solved_cell_candidates_frozen(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """After placing a digit, that cell's CandidateCell is frozen unchanged."""
          sid = self._confirmed_session(client, store, trivial_state)
          # Get initial candidate state for cell (0,0)
          state_before = store.load(sid)
          assert state_before.candidate_grid is not None
          cell_before = state_before.candidate_grid.cells[0][0]

          # Place digit 5 (KNOWN_SOLUTION[0][0]) in cell (0,0)
          res = client.patch(
              f"/api/puzzle/{sid}/cell",
              json={"row": 1, "col": 1, "digit": KNOWN_SOLUTION[0][0]},
          )
          assert res.status_code == 200
          cg_after = res.json()["candidate_grid"]
          cell_after = cg_after["cells"][0][0]
          # Solved cell: CandidateCell is frozen — same as before
          assert cell_after["auto_candidates"] == cell_before.auto_candidates
          assert cell_after["auto_essential"] == cell_before.auto_essential

      def test_undo_restores_candidate_state(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """After undo, candidate_grid is non-None and cell (0,0) is unsolved again."""
          sid = self._confirmed_session(client, store, trivial_state)
          # Place then undo
          client.patch(
              f"/api/puzzle/{sid}/cell",
              json={"row": 1, "col": 1, "digit": KNOWN_SOLUTION[0][0]},
          )
          res = client.post(f"/api/puzzle/{sid}/undo")
          assert res.status_code == 200
          state = res.json()
          assert state["user_grid"][0][0] == 0
          assert state["candidate_grid"] is not None
          # Cell (0,0) should have its auto_candidates back
          cell = state["candidate_grid"]["cells"][0][0]
          assert KNOWN_SOLUTION[0][0] in cell["auto_candidates"]

      def test_freeze_scope(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """Place in cell A; cycle peer cell B; undo A; assert B's override preserved."""
          from killer_sudoku.api.schemas import CandidateGrid, CandidateCell

          sid = self._confirmed_session(client, store, trivial_state)
          # Switch to manual so we can cycle any digit in peer cell B = (0,1)
          client.post(
              f"/api/puzzle/{sid}/candidates/mode",
              json={"mode": "manual"},
          )
          # Cycle digit 7 in cell B (0,1) [row=1, col=2]: inessential → essential
          client.patch(
              f"/api/puzzle/{sid}/candidates/cell",
              json={"row": 1, "col": 2, "digit": 7},
          )
          # Place digit in cell A = (0,0)
          client.patch(
              f"/api/puzzle/{sid}/cell",
              json={"row": 1, "col": 1, "digit": KNOWN_SOLUTION[0][0]},
          )
          # Undo
          res = client.post(f"/api/puzzle/{sid}/undo")
          data = res.json()
          # Cell B's override (7 in user_essential) should be preserved
          cell_b = data["candidate_grid"]["cells"][0][1]
          assert 7 in cell_b["user_essential"], (
              "Cell B's user_essential should still have 7 after undoing cell A"
          )


  class TestRuleA:
      """Rule A: digits dropped from auto_candidates are removed from user_essential."""

      def test_rule_a_removes_from_user_essential(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """After confirming, manually promote a digit in cell (0,1).
          Then place a digit that (via solver propagation) might eliminate a
          candidate. In trivial spec all cells are already determined, so we
          verify Rule A via direct state manipulation."""
          from killer_sudoku.api.schemas import CandidateGrid, CandidateCell

          store.save(trivial_state)
          # Confirm
          client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          sid = trivial_state.session_id
          # Switch to manual
          client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
          # Add digit 3 to user_essential in cell (0,1) [row=1,col=2]
          client.patch(
              f"/api/puzzle/{sid}/candidates/cell",
              json={"row": 1, "col": 2, "digit": 3},
          )
          # Now switch back to auto — the recomputation applies Rule A.
          # In trivial spec, cell (0,1)'s auto_candidates = [KNOWN_SOLUTION[0][1]] = [3].
          # Since 3 IS in auto_candidates, Rule A does NOT remove it here.
          # Instead verify: adding digit that's NOT auto_candidate triggers removal.
          # Manually seed user_essential with a digit not in auto_candidates:
          # cell (0,0) has auto_candidates=[5]; cycle digit 3 in manual mode.
          client.patch(
              f"/api/puzzle/{sid}/candidates/cell",
              json={"row": 1, "col": 1, "digit": 3},
          )
          # Switch to auto: digit 3 is not in auto_candidates for (0,0) → Rule A removes it
          res = client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "auto"})
          data = res.json()
          cell_00 = data["candidate_grid"]["cells"][0][0]
          assert 3 not in cell_00["user_essential"], (
              "Rule A: digit 3 should be removed from user_essential since auto says impossible"
          )

      def test_user_removed_preserved_when_auto_also_impossible(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """user_removed entries are preserved even when auto also considers digit impossible."""
          store.save(trivial_state)
          client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          sid = trivial_state.session_id
          # In auto mode: cycle digit 5 in cell (0,0) [row=1,col=1]
          # Digit 5 is auto-essential → first cycle sends it to impossible (user_removed)
          res = client.patch(
              f"/api/puzzle/{sid}/candidates/cell",
              json={"row": 1, "col": 1, "digit": 5},
          )
          # Verify 5 is now in user_removed
          cell = res.json()["candidate_grid"]["cells"][0][0]
          assert 5 in cell["user_removed"]
          # Now place a digit in the same row that would make 5 impossible in peers
          # (In trivial spec everything is already determined — just verify user_removed survives /cell)
          res2 = client.patch(
              f"/api/puzzle/{sid}/cell",
              json={"row": 1, "col": 2, "digit": KNOWN_SOLUTION[0][1]},
          )
          cell_after = res2.json()["candidate_grid"]["cells"][0][0]
          # user_removed should still contain 5
          assert 5 in cell_after["user_removed"], (
              "user_removed should be preserved after cell entry"
          )
  ```

- [ ] **Step 2: Run failing tests**

  ```bash
  python -m pytest tests/api/test_endpoints.py::TestCandidateWithCellEntry tests/api/test_endpoints.py::TestRuleA -v
  ```

  Expected: FAIL — `/cell` and `/undo` don't update `candidate_grid` yet.

- [ ] **Step 3: Update /cell endpoint**

  In `puzzle.py`, in the `enter_cell` endpoint, after `store.save(updated)` and before `return updated`, add:

  ```python
  # Recompute candidates after the cell entry
  new_cg = _compute_candidate_grid(updated, updated.candidate_grid)
  updated = updated.model_copy(update={"candidate_grid": new_cg})
  store.save(updated)
  return updated
  ```

  This replaces the existing `return updated` — ensure you only have one return.

- [ ] **Step 4: Update /undo endpoint**

  Same pattern: after `store.save(updated)`, recompute and re-save:

  ```python
  new_cg = _compute_candidate_grid(updated, updated.candidate_grid)
  updated = updated.model_copy(update={"candidate_grid": new_cg})
  store.save(updated)
  return updated
  ```

- [ ] **Step 5: Run tests — expect pass**

  ```bash
  python -m pytest tests/api/test_endpoints.py::TestCandidateWithCellEntry tests/api/test_endpoints.py::TestRuleA -v
  ```

  Expected: PASS. If `test_freeze_scope` fails because `/candidates/mode` and `/candidates/cell` don't exist yet, skip that test by adding `@pytest.mark.skip(reason="depends on Task 5+6")` temporarily — restore it after Task 6.

- [ ] **Step 6: Run full test suite**

  ```bash
  python -m pytest tests/api/test_endpoints.py -v
  ```

  Expected: all existing + new tests pass.

- [ ] **Step 7: Commit**

  ```bash
  git add killer_sudoku/api/routers/puzzle.py tests/api/test_endpoints.py
  git commit -m "feat: /cell and /undo recompute candidate_grid; add TestCandidateWithCellEntry, TestRuleA"
  ```

---

## Task 5 — /candidates/mode endpoint; TestCandidateMode

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py`
- Modify: `tests/api/test_endpoints.py`

- [ ] **Step 1: Write failing tests**

  Add this class to `tests/api/test_endpoints.py`:

  ```python
  class TestCandidateMode:
      def _confirmed_sid(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> str:
          store.save(trivial_state)
          client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          return trivial_state.session_id

      def test_auto_to_manual_preserves_cells(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          sid = self._confirmed_sid(client, store, trivial_state)
          before = store.load(sid)
          assert before.candidate_grid is not None
          res = client.post(
              f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"}
          )
          assert res.status_code == 200
          data = res.json()
          assert data["candidate_grid"]["mode"] == "manual"
          # cells unchanged
          assert data["candidate_grid"]["cells"] == [
              [
                  {
                      "auto_candidates": before.candidate_grid.cells[r][c].auto_candidates,
                      "auto_essential": before.candidate_grid.cells[r][c].auto_essential,
                      "user_essential": before.candidate_grid.cells[r][c].user_essential,
                      "user_removed": before.candidate_grid.cells[r][c].user_removed,
                  }
                  for c in range(9)
              ]
              for r in range(9)
          ]

      def test_manual_to_auto_user_removed_stays(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """User-removed digit that auto says possible stays in user_removed."""
          sid = self._confirmed_sid(client, store, trivial_state)
          client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
          # In manual mode, cycle digit 5 in cell (0,0): inessential→essential→impossible
          client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 5})
          client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 5})
          # Now cell (0,0) has digit 5 in user_removed
          res = client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "auto"})
          assert res.status_code == 200
          cell = res.json()["candidate_grid"]["cells"][0][0]
          # In trivial spec auto_candidates for (0,0) = [5], so auto says possible
          # user_removed [5] should stay (more restrictive wins)
          assert 5 in cell["user_removed"]

      def test_manual_to_auto_rule_a_clears_user_essential(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """Digit auto says impossible is cleared from user_essential on merge."""
          sid = self._confirmed_sid(client, store, trivial_state)
          client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
          # In manual mode, cycle digit 3 in cell (0,0): inessential→essential
          # (digit 3 is NOT in auto_candidates for (0,0), which has auto_candidates=[5])
          client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 3})
          # Switch to auto: digit 3 not in auto_candidates → cleared from user_essential
          res = client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "auto"})
          assert res.status_code == 200
          cell = res.json()["candidate_grid"]["cells"][0][0]
          assert 3 not in cell["user_essential"]

      def test_409_if_not_confirmed(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          res = client.post(
              f"/api/puzzle/{trivial_state.session_id}/candidates/mode",
              json={"mode": "manual"},
          )
          assert res.status_code == 409
  ```

- [ ] **Step 2: Run failing tests**

  ```bash
  python -m pytest tests/api/test_endpoints.py::TestCandidateMode -v
  ```

  Expected: FAIL — endpoint doesn't exist.

- [ ] **Step 3: Add /candidates/mode endpoint**

  In `puzzle.py`, inside `make_router`, add after the `/undo` endpoint:

  ```python
  @router.post("/{session_id}/candidates/mode", response_model=PuzzleState)
  async def set_candidates_mode(
      session_id: str,
      req: CandidateModeRequest,
  ) -> PuzzleState:
      """Switch between auto and manual candidate modes.

      auto→manual: update mode field only; no state change.
      manual→auto: recompute auto state; apply min-merge (more restrictive wins).
      """
      try:
          state = store.load(session_id)
      except KeyError as exc:
          raise HTTPException(status_code=404, detail="Session not found") from exc

      if state.candidate_grid is None:
          raise HTTPException(status_code=409, detail="Session not yet confirmed")

      if req.mode == "manual":
          new_cg = state.candidate_grid.model_copy(update={"mode": "manual"})
      else:
          # manual → auto: recompute then min-merge
          assert state.user_grid is not None
          new_auto = _compute_candidate_grid(state, None)
          new_cg = _min_merge_to_auto(state.candidate_grid, new_auto, state.user_grid)

      updated = state.model_copy(update={"candidate_grid": new_cg})
      store.save(updated)
      return updated
  ```

- [ ] **Step 4: Run tests — expect pass**

  ```bash
  python -m pytest tests/api/test_endpoints.py::TestCandidateMode -v
  ```

- [ ] **Step 5: Remove any `@pytest.mark.skip` added in Task 4**

  If `test_freeze_scope` was skipped, remove the decorator. Run:

  ```bash
  python -m pytest tests/api/test_endpoints.py -v
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add killer_sudoku/api/routers/puzzle.py tests/api/test_endpoints.py
  git commit -m "feat: add /candidates/mode endpoint; add TestCandidateMode"
  ```

---

## Task 6 — /candidates/cell endpoint; TestCandidateCycle

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py`
- Modify: `tests/api/test_endpoints.py`

- [ ] **Step 1: Write failing tests**

  Add this class to `tests/api/test_endpoints.py`:

  ```python
  class TestCandidateCycle:
      """Tests for PATCH /candidates/cell cycle behavior."""

      def _confirmed_sid(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> str:
          store.save(trivial_state)
          client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
          return trivial_state.session_id

      def test_manual_inessential_to_essential(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          sid = self._confirmed_sid(client, store, trivial_state)
          client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
          res = client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 3})
          assert res.status_code == 200
          cell = res.json()["candidate_grid"]["cells"][0][0]
          assert 3 in cell["user_essential"]
          assert 3 not in cell["user_removed"]

      def test_manual_essential_to_impossible(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          sid = self._confirmed_sid(client, store, trivial_state)
          client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
          # First cycle: inessential → essential
          client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 3})
          # Second cycle: essential → impossible
          res = client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 3})
          assert res.status_code == 200
          cell = res.json()["candidate_grid"]["cells"][0][0]
          assert 3 not in cell["user_essential"]
          assert 3 in cell["user_removed"]

      def test_manual_impossible_to_inessential(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          sid = self._confirmed_sid(client, store, trivial_state)
          client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
          client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 3})
          client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 3})
          # Third cycle: impossible → inessential
          res = client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 3})
          cell = res.json()["candidate_grid"]["cells"][0][0]
          assert 3 not in cell["user_essential"]
          assert 3 not in cell["user_removed"]

      def test_auto_essential_to_impossible(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """Auto-essential digit: cycles essential → impossible (user_removed)."""
          # In trivial spec: cell (0,0) has auto_essential=[5] (KNOWN_SOLUTION[0][0])
          sid = self._confirmed_sid(client, store, trivial_state)
          res = client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 5})
          assert res.status_code == 200
          cell = res.json()["candidate_grid"]["cells"][0][0]
          assert 5 in cell["user_removed"]
          assert 5 not in cell["user_essential"]

      def test_auto_impossible_to_essential(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """After making auto-essential impossible, next cycle restores it."""
          sid = self._confirmed_sid(client, store, trivial_state)
          client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 5})
          # Second cycle: impossible → restore (auto_essential still has 5)
          res = client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 5})
          cell = res.json()["candidate_grid"]["cells"][0][0]
          assert 5 not in cell["user_removed"]
          assert 5 not in cell["user_essential"]  # auto-essential, not user-essential

      def test_auto_impossible_no_op(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """Cycling a digit that auto says impossible (and not user-removed) is a no-op."""
          # In trivial spec: cell (0,0) has auto_candidates=[5]; digit 3 is auto-impossible
          sid = self._confirmed_sid(client, store, trivial_state)
          before = store.load(sid)
          assert before.candidate_grid is not None
          res = client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 3})
          assert res.status_code == 200
          after = res.json()["candidate_grid"]["cells"][0][0]
          assert after["user_essential"] == []
          assert after["user_removed"] == []

      def test_reset_clears_overrides(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          """digit=0 clears user_essential and user_removed for the cell."""
          sid = self._confirmed_sid(client, store, trivial_state)
          # Add something to user_essential via manual mode
          client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
          client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 3})
          # Reset
          res = client.patch(f"/api/puzzle/{sid}/candidates/cell", json={"row": 1, "col": 1, "digit": 0})
          assert res.status_code == 200
          cell = res.json()["candidate_grid"]["cells"][0][0]
          assert cell["user_essential"] == []
          assert cell["user_removed"] == []

      def test_409_if_not_confirmed(
          self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
      ) -> None:
          store.save(trivial_state)
          res = client.patch(
              f"/api/puzzle/{trivial_state.session_id}/candidates/cell",
              json={"row": 1, "col": 1, "digit": 5},
          )
          assert res.status_code == 409
  ```

- [ ] **Step 2: Run failing tests**

  ```bash
  python -m pytest tests/api/test_endpoints.py::TestCandidateCycle -v
  ```

  Expected: FAIL — endpoint doesn't exist.

- [ ] **Step 3: Add /candidates/cell endpoint**

  In `puzzle.py`, inside `make_router`, add after `/candidates/mode`:

  ```python
  @router.patch("/{session_id}/candidates/cell", response_model=PuzzleState)
  async def cycle_candidate(
      session_id: str,
      req: CandidateCycleRequest,
  ) -> PuzzleState:
      """Cycle one digit's state in a cell, or reset all overrides (digit=0).

      Reads current mode from candidate_grid.mode. Does not run solver
      recomputation — only updates user_essential and user_removed overrides.
      """
      try:
          state = store.load(session_id)
      except KeyError as exc:
          raise HTTPException(status_code=404, detail="Session not found") from exc

      if state.candidate_grid is None:
          raise HTTPException(status_code=409, detail="Session not yet confirmed")

      if not (1 <= req.row <= 9 and 1 <= req.col <= 9 and 0 <= req.digit <= 9):
          raise HTTPException(
              status_code=422, detail="row/col must be 1–9; digit 0–9"
          )

      r, c = req.row - 1, req.col - 1
      mode = state.candidate_grid.mode
      old_cell = state.candidate_grid.cells[r][c]

      if req.digit == 0:
          # Reset: clear all overrides for this cell
          new_cell = CandidateCell(
              auto_candidates=old_cell.auto_candidates,
              auto_essential=old_cell.auto_essential,
              user_essential=[],
              user_removed=[],
          )
      else:
          new_cell = _cycle_candidate(old_cell, req.digit, mode)

      # Rebuild grid with the updated cell
      new_rows = [
          [
              new_cell if (row == r and col == c) else state.candidate_grid.cells[row][col]
              for col in range(9)
          ]
          for row in range(9)
      ]
      new_cg = CandidateGrid(cells=new_rows, mode=mode)
      updated = state.model_copy(update={"candidate_grid": new_cg})
      store.save(updated)
      return updated
  ```

- [ ] **Step 4: Run tests — expect pass**

  ```bash
  python -m pytest tests/api/test_endpoints.py::TestCandidateCycle -v
  ```

- [ ] **Step 5: Run full test suite**

  ```bash
  python -m pytest tests/api/test_endpoints.py -v
  ```

  Expected: all tests pass.

- [ ] **Step 6: Commit**

  ```bash
  git add killer_sudoku/api/routers/puzzle.py tests/api/test_endpoints.py
  git commit -m "feat: add /candidates/cell endpoint; add TestCandidateCycle"
  ```

---

## Task 7 — Playwright setup + fixture + e2e tests

**Files:**
- Modify: `pyproject.toml`
- Create: `tests/fixtures/candidates_puzzle.py`
- Create: `tests/e2e/__init__.py`
- Create: `tests/e2e/conftest.py`
- Create: `tests/e2e/test_candidates.py`

- [ ] **Step 1: Add playwright to dev deps**

  In `pyproject.toml`, update the `dev` optional dependency list:

  ```toml
  [project.optional-dependencies]
  dev = ["ruff", "mypy", "pytest", "pytest-cov", "playwright>=1.40", "pytest-playwright>=0.4"]
  ```

- [ ] **Step 2: Install playwright and browsers**

  ```bash
  pip install "playwright>=1.40" "pytest-playwright>=0.4"
  python -m playwright install chromium
  ```

- [ ] **Step 3: Create candidates fixture**

  Create `tests/fixtures/candidates_puzzle.py`:

  ```python
  """Fixture puzzle for Playwright e2e candidate view tests.

  Uses the trivial single-cell-cage spec (make_trivial_spec) as a simple,
  valid puzzle that the server can confirm and display. A more complex fixture
  with genuinely ambiguous cages can be added later if visual essential-digit
  testing is needed.
  """

  from killer_sudoku.solver.puzzle_spec import PuzzleSpec
  from tests.fixtures.minimal_puzzle import make_trivial_spec


  def make_candidates_spec() -> PuzzleSpec:
      """Return a valid PuzzleSpec suitable for Playwright candidate view tests."""
      return make_trivial_spec()
  ```

- [ ] **Step 4: Create `tests/e2e/__init__.py`**

  Create an empty file:
  ```python
  ```

- [ ] **Step 5: Create `tests/e2e/conftest.py`**

  Create `tests/e2e/conftest.py`:

  ```python
  """Playwright e2e test fixtures.

  Starts the COACH server in a background thread using the trivial puzzle
  fixture (mock_ocr via CoachConfig.mock_spec). The server runs on localhost
  at a fixed port for the duration of the test session.
  """

  from __future__ import annotations

  import threading
  import time
  from pathlib import Path

  import httpx
  import pytest
  import uvicorn

  from killer_sudoku.api.app import create_app
  from killer_sudoku.api.config import CoachConfig
  from tests.fixtures.candidates_puzzle import make_candidates_spec

  _E2E_PORT = 9877
  _E2E_HOST = "127.0.0.1"


  @pytest.fixture(scope="session")
  def live_server_url(tmp_path_factory: pytest.TempPathFactory) -> str:
      """Start COACH server with mock_spec; return its base URL."""
      sessions_dir = tmp_path_factory.mktemp("e2e_sessions")
      config = CoachConfig(
          guardian_dir=Path("."),
          observer_dir=Path("."),
          sessions_dir=sessions_dir,
          host=_E2E_HOST,
          port=_E2E_PORT,
          mock_spec=make_candidates_spec(),
      )
      app = create_app(config)
      server = uvicorn.Server(
          uvicorn.Config(app, host=_E2E_HOST, port=_E2E_PORT, log_level="warning")
      )
      thread = threading.Thread(target=server.run, daemon=True)
      thread.start()

      # Poll until server accepts connections
      deadline = time.monotonic() + 10.0
      while time.monotonic() < deadline:
          try:
              httpx.get(f"http://{_E2E_HOST}:{_E2E_PORT}/")
              break
          except httpx.ConnectError:
              time.sleep(0.05)
      else:
          raise RuntimeError("COACH e2e server did not start within 10 seconds")

      return f"http://{_E2E_HOST}:{_E2E_PORT}"
  ```

  Note: `httpx` must be available — add `"httpx"` to dev dependencies if not already present (check with `python -c "import httpx"`; if missing, add to pyproject.toml dev list).

- [ ] **Step 6: Create minimal test JPEG helper**

  In `tests/e2e/conftest.py`, add a helper for the upload JPEG (used in multiple tests):

  ```python
  import base64

  # 1×1 white JPEG in base64 — used as the upload payload for mock-OCR tests.
  # Generated with: cv2.imencode(".jpg", np.zeros((1,1,3), np.uint8)+255)[1]
  _TINY_JPEG_B64 = (
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkS"
      "Ew8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJ"
      "CQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy"
      "MjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/"
      "EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAA"
      "AAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJQA/9k="
  )


  @pytest.fixture(scope="session")
  def tiny_jpeg_bytes() -> bytes:
      """Return a minimal valid JPEG as bytes (1×1 white pixel)."""
      return base64.b64decode(_TINY_JPEG_B64)
  ```

  **Note on the JPEG**: The constant above may not decode to a valid JPEG. During implementation, generate the correct bytes with:
  ```python
  import cv2, numpy as np, base64
  _, buf = cv2.imencode(".jpg", np.zeros((1,1,3), np.uint8)+255)
  print(base64.b64encode(buf.tobytes()).decode())
  ```
  And replace the `_TINY_JPEG_B64` constant with the actual output.

- [ ] **Step 7: Create `tests/e2e/test_candidates.py`**

  Create `tests/e2e/test_candidates.py`:

  ```python
  """Playwright e2e tests for the candidates view.

  Tests upload → confirm flow and UI interaction (button visibility, toggles,
  keyboard routing, help modal). Canvas pixel/colour assertions are excluded.

  All tests share a session via module-scoped page state where possible.
  Network request interception is used to verify which API endpoints are called.
  """

  from __future__ import annotations

  import pytest
  from playwright.sync_api import Page, expect


  def _upload_and_confirm(page: Page, live_server_url: str, tiny_jpeg_bytes: bytes) -> None:
      """Upload the mock puzzle and click confirm — shared setup helper."""
      page.goto(live_server_url)

      # Upload file
      with page.expect_file_chooser() as fc_info:
          page.click("#file-input")
      fc = fc_info.value
      fc.set_files(
          files=[{"name": "test.jpg", "mimeType": "image/jpeg", "buffer": tiny_jpeg_bytes}]
      )

      # Process
      with page.expect_response("**/api/puzzle") as resp_info:
          page.click("#process-btn")
      resp_info.value.finished()

      # Confirm
      with page.expect_response("**/confirm") as resp_info:
          page.click("#confirm-btn")
      resp_info.value.finished()


  class TestUploadConfirmFlow:
      def test_canvas_visible_after_confirm(
          self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
      ) -> None:
          _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
          expect(page.locator("#grid-canvas")).to_be_visible()

      def test_candidates_btn_enabled_after_confirm(
          self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
      ) -> None:
          _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
          expect(page.locator("#candidates-btn")).to_be_enabled()


  class TestCandidatesToggle:
      def test_show_hide_toggle(
          self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
      ) -> None:
          _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
          btn = page.locator("#candidates-btn")
          expect(btn).to_have_text("Show candidates")
          btn.click()
          expect(btn).to_have_text("Hide candidates")
          btn.click()
          expect(btn).to_have_text("Show candidates")

      def test_edit_btn_appears_when_candidates_shown(
          self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
      ) -> None:
          _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
          expect(page.locator("#edit-candidates-btn")).to_be_hidden()
          page.click("#candidates-btn")
          expect(page.locator("#edit-candidates-btn")).to_be_visible()

      def test_mode_btn_appears_when_candidates_shown(
          self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
      ) -> None:
          _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
          page.click("#candidates-btn")
          expect(page.locator("#candidates-mode-btn")).to_be_visible()

      def test_help_btn_appears_when_candidates_shown(
          self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
      ) -> None:
          _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
          page.click("#candidates-btn")
          expect(page.locator("#help-candidates-btn")).to_be_visible()


  class TestKeyboardRouting:
      def test_digit_in_solution_entry_mode_calls_cell_endpoint(
          self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
      ) -> None:
          _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
          # Select cell (1,1) by clicking top-left area of canvas
          canvas = page.locator("#grid-canvas")
          canvas.click(position={"x": 30, "y": 30})  # MARGIN + ~0.5*CELL

          requests: list[str] = []
          page.on("request", lambda r: requests.append(r.url))

          page.keyboard.press("5")
          page.wait_for_timeout(300)

          cell_calls = [u for u in requests if "/cell" in u and "/candidates" not in u]
          candidate_calls = [u for u in requests if "/candidates/cell" in u]
          assert len(cell_calls) >= 1, "Expected /cell to be called in solution entry mode"
          assert len(candidate_calls) == 0, "Expected no /candidates/cell call"

      def test_digit_in_candidate_edit_mode_calls_candidates_endpoint(
          self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
      ) -> None:
          _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
          page.click("#candidates-btn")
          page.click("#edit-candidates-btn")

          canvas = page.locator("#grid-canvas")
          canvas.click(position={"x": 30, "y": 30})

          requests: list[str] = []
          page.on("request", lambda r: requests.append(r.url))

          page.keyboard.press("5")
          page.wait_for_timeout(300)

          candidate_calls = [u for u in requests if "/candidates/cell" in u]
          cell_calls = [u for u in requests if u.endswith("/cell")]
          assert len(candidate_calls) >= 1, "Expected /candidates/cell to be called"
          assert len(cell_calls) == 0, "Expected no /cell call in candidate edit mode"


  class TestModeToggle:
      def test_mode_btn_label_changes(
          self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
      ) -> None:
          _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
          page.click("#candidates-btn")
          btn = page.locator("#candidates-mode-btn")
          expect(btn).to_have_text("Auto")
          with page.expect_response("**/candidates/mode"):
              btn.click()
          expect(btn).to_have_text("Manual")


  class TestHelpModal:
      def test_help_modal_opens_and_closes(
          self, page: Page, live_server_url: str, tiny_jpeg_bytes: bytes
      ) -> None:
          _upload_and_confirm(page, live_server_url, tiny_jpeg_bytes)
          page.click("#candidates-btn")
          page.click("#help-candidates-btn")
          expect(page.locator("#help-candidates-modal")).to_be_visible()
          page.click("#close-help-btn")
          expect(page.locator("#help-candidates-modal")).to_be_hidden()
  ```

- [ ] **Step 8: Verify Playwright tests fail (no frontend yet)**

  ```bash
  python -m pytest tests/e2e/ -v --headed
  ```

  Expected: FAIL — buttons don't exist yet. This confirms the test infrastructure is wired correctly.

- [ ] **Step 9: Commit fixture and test scaffolding**

  ```bash
  git add pyproject.toml tests/fixtures/candidates_puzzle.py tests/e2e/
  git commit -m "test: add Playwright e2e test scaffold for candidates view"
  ```

---

## Task 8 — Frontend: HTML + TypeScript schemas + state

**Files:**
- Modify: `killer_sudoku/static/index.html`
- Modify: `killer_sudoku/static/main.ts`

- [ ] **Step 1: Add 4 new buttons to `#playing-actions` in index.html**

  In `index.html`, replace the `#playing-actions` div:

  ```html
  <!-- Playing mode actions — hidden until user confirms layout -->
  <div id="playing-actions" hidden>
    <div class="form-actions">
      <button id="undo-btn" class="btn-secondary" disabled>Undo</button>
      <button id="hints-btn" class="btn-secondary" disabled>Hints</button>
      <button id="candidates-btn" class="btn-secondary" disabled>Show candidates</button>
      <button id="edit-candidates-btn" class="btn-secondary" hidden>Edit candidates</button>
      <button id="candidates-mode-btn" class="btn-secondary" hidden>Auto</button>
      <button id="help-candidates-btn" class="btn-secondary" hidden>?</button>
    </div>
  </div>
  ```

- [ ] **Step 2: Add help modal to index.html**

  After `</main>` and before `<script ...>`, add:

  ```html
  <dialog id="help-candidates-modal">
    <h2>Candidates</h2>
    <p>The candidates view shows, for each unsolved cell, which digits are still possible — and highlights which digits appear in every valid solution for that cage.</p>

    <h3>Turning it on</h3>
    <p>Press <strong>Show candidates</strong> to reveal the candidate grid. Each unsolved cell displays up to nine small digits arranged in a 3&times;3 layout matching their position on a keypad:</p>
    <pre>1  2  3
4  5  6
7  8  9</pre>
    <p>A digit that does not appear has been ruled out. A digit shown in <strong>grey</strong> is possible but not yet certain. A digit shown in <span style="color:#cc5a45">salmon</span> is essential to that cage.</p>

    <h3>Essential digits</h3>
    <p>A digit is <em>essential</em> for a cell if it appears in every remaining valid solution for that cell&#8217;s cage. If you must place one of a cage&#8217;s essential digits somewhere, at least one cell in the cage must take it &#8212; no solution avoids it. Essential digits are worth paying close attention to when you are stuck.</p>

    <h3>Auto mode and manual mode</h3>
    <p>The <strong>Auto / Manual</strong> toggle controls how the candidate grid is maintained.</p>
    <p><em>Auto mode</em> (default): the app computes candidates for you. When you place a digit in any cell, candidates in related cells &#8212; same row, column, box, or cage &#8212; are immediately updated. Essential digits are recalculated from the cage&#8217;s remaining solutions. You can still adjust the auto-computed state: press a digit key (or tap its position) to cycle it forward through its states, or press <strong>Delete</strong> to reset a cell back to its auto-computed state.</p>
    <p><em>Manual mode</em>: you manage candidates yourself. Every unsolved cell starts with all nine digits marked inessential. The app does not eliminate or promote anything &#8212; you decide what to keep, what to mark essential, and what to remove.</p>
    <p><strong>Switching from manual to auto</strong> merges your work with the solver&#8217;s knowledge: for each digit in each cell, the more restrictive of the two assessments wins. If you removed a digit the solver thinks is still possible, it stays removed. If you marked a digit essential that the solver considers inessential, it stays essential. If the solver has ruled something out entirely, that takes precedence.</p>
    <p><strong>Switching from auto to manual</strong> leaves your candidate marks exactly as they are &#8212; the display is unchanged.</p>

    <h3>Cycling a digit&#8217;s state</h3>
    <p>Press <strong>Edit candidates</strong> to enter candidate editing mode. Each digit cycles through its states each time you interact with it:</p>
    <table>
      <tr><th>State</th><th>Appearance</th><th>Meaning</th></tr>
      <tr><td>Inessential</td><td>grey</td><td>Possible, but not in every cage solution</td></tr>
      <tr><td>Essential</td><td>salmon</td><td>Marked as present in every cage solution</td></tr>
      <tr><td>Impossible</td><td>hidden</td><td>Ruled out &#8212; not shown</td></tr>
    </table>
    <p>To cycle: press the digit key (1&#8211;9) while a cell is selected, or tap the digit&#8217;s position directly within the cell. Each press advances to the next state.</p>
    <p>In <strong>auto mode</strong>, a digit that the solver has ruled out cannot be cycled back in (the solver&#8217;s impossible overrides your marks). A digit you removed yourself can be restored by cycling past impossible back to inessential. An auto-essential digit &#8212; one the solver has determined appears in every cage solution &#8212; cycles between essential and impossible only; cycling it removes it from play, and restoring it brings it straight back to essential.</p>
    <p>In <strong>manual mode</strong>, all nine digits can be cycled freely in any cell.</p>
    <p>Press <strong>Delete</strong> (or <strong>Backspace</strong>) in candidate editing mode to reset the selected cell: all your adjustments to that cell are cleared, restoring it to its auto-computed state (in auto mode) or all-inessential (in manual mode).</p>

    <h3>Solved cells</h3>
    <p>When you enter a digit into a cell, its candidates are hidden but not lost. If you undo or clear the digit, the candidates reappear exactly as you left them.</p>

    <button id="close-help-btn">Close</button>
  </dialog>
  ```

- [ ] **Step 3: Add TypeScript interfaces to main.ts**

  In `main.ts`, after the `MoveRecord` interface, add:

  ```typescript
  interface CandidateCell {
    auto_candidates: number[];
    auto_essential:  number[];
    user_essential:  number[];
    user_removed:    number[];
  }

  interface CandidateGrid {
    cells: CandidateCell[][];   // 9 rows × 9 cols, 0-based
    mode:  "auto" | "manual";
  }
  ```

  In the `PuzzleState` interface, add after `move_history`:

  ```typescript
    candidate_grid: CandidateGrid | null;
  ```

- [ ] **Step 4: Add module state variables**

  In `main.ts`, after the `selectedCell` declaration, add:

  ```typescript
  let showCandidates: boolean = false;
  let candidateEditMode: boolean = false;
  ```

- [ ] **Step 5: Compile and check for TS errors**

  ```bash
  tsc
  ```

  Expected: `killer_sudoku/static/main.js` rebuilt without errors. (New buttons referenced in later tasks will cause errors if wired up now — that's fine; only wire them in Task 9.)

- [ ] **Step 6: Commit HTML + TS schema changes**

  ```bash
  git add killer_sudoku/static/index.html killer_sudoku/static/main.ts
  git commit -m "feat: add candidate view HTML buttons, help modal, TS schema additions"
  ```

---

## Task 9 — Frontend: drawGrid layer 8 + handlers + keyboard routing

**Files:**
- Modify: `killer_sudoku/static/main.ts`

- [ ] **Step 1: Extend drawGrid signature to accept showCandidates**

  In `main.ts`, change the `drawGrid` function signature from:

  ```typescript
  function drawGrid(
    canvas: HTMLCanvasElement,
    state: PuzzleState,
    selected: { row: number; col: number } | null = null
  ): void {
  ```

  To:

  ```typescript
  function drawGrid(
    canvas: HTMLCanvasElement,
    state: PuzzleState,
    selected: { row: number; col: number } | null = null,
    showCands: boolean = false
  ): void {
  ```

  (`showCands` is the local parameter name to avoid shadowing the module-level `showCandidates`.)

- [ ] **Step 2: Add layer 8 — candidate sub-grid**

  In `drawGrid`, after the closing `}` of the layer 7 user digits block (after `}` of `if (state.user_grid !== null) { ... }`), add:

  ```typescript
  // 8. Candidate sub-grid (only when showCands && candidate data available)
  if (showCands && state.candidate_grid !== null && state.user_grid !== null) {
    const cg = state.candidate_grid;
    const SUB = CELL / 3;
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if ((state.user_grid[r]?.[c] ?? 0) !== 0) continue;  // skip solved cells
        const cell = cg.cells[r]?.[c];
        if (cell === undefined) continue;
        const autoSet = new Set(cell.auto_candidates);
        const removedSet = new Set(cell.user_removed);
        const essSet = new Set([...cell.user_essential, ...cell.auto_essential]);
        for (let n = 1; n <= 9; n++) {
          if (removedSet.has(n)) continue;
          if (cg.mode === "auto" && !autoSet.has(n)) continue;
          const subRow = Math.floor((n - 1) / 3);
          const subCol = (n - 1) % 3;
          const cx = MARGIN + c * CELL + (subCol + 0.5) * SUB;
          const cy = MARGIN + r * CELL + (subRow + 0.5) * SUB;
          ctx.fillStyle = essSet.has(n) ? "#ffb5a7" : "#9ca3af";
          ctx.fillText(String(n), cx, cy);
        }
      }
    }
  }
  ```

- [ ] **Step 3: Update drawGrid call sites to pass showCandidates**

  Find all calls to `drawGrid(...)` in `main.ts` that are in playing-mode context (after confirm). Update them to pass `showCandidates`:

  - In `renderPlayingMode`: `drawGrid(el<HTMLCanvasElement>("grid-canvas"), state, selectedCell, showCandidates);`
  - In `handleCellEntry`: `drawGrid(el<HTMLCanvasElement>("grid-canvas"), state, selectedCell, showCandidates);`
  - In `handleUndo`: `drawGrid(el<HTMLCanvasElement>("grid-canvas"), state, selectedCell, showCandidates);`
  - In the mousedown handler: `drawGrid(el<HTMLCanvasElement>("grid-canvas"), currentState, selectedCell, showCandidates);`

  Also update `renderPlayingMode` to enable the candidates button:

  ```typescript
  function renderPlayingMode(state: PuzzleState): void {
    currentState = state;
    drawGrid(el<HTMLCanvasElement>("grid-canvas"), state, selectedCell, showCandidates);
    el<HTMLElement>("review-actions").hidden = true;
    el<HTMLElement>("editor-section").hidden = true;
    el<HTMLElement>("playing-actions").hidden = false;
    el<HTMLElement>("solution-panel").hidden = true;
    updateUndoButton(state);
    el<HTMLButtonElement>("candidates-btn").disabled = false;
  }
  ```

- [ ] **Step 4: Add `handleCandidateCycle` and `handleCandidateMode` functions**

  Add these after `handleUndo`:

  ```typescript
  async function handleCandidateCycle(
    row: number,
    col: number,
    digit: number
  ): Promise<void> {
    if (!currentSessionId) return;
    try {
      const res = await fetch(
        `/api/puzzle/${currentSessionId}/candidates/cell`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ row, col, digit }),
        }
      );
      if (!res.ok) return;
      const state = (await res.json()) as PuzzleState;
      currentState = state;
      drawGrid(
        el<HTMLCanvasElement>("grid-canvas"),
        state,
        selectedCell,
        showCandidates
      );
    } catch {
      // Candidate cycle is best-effort; network errors silently ignored
    }
  }

  async function handleCandidateMode(): Promise<void> {
    if (!currentSessionId || currentState?.candidate_grid == null) return;
    const newMode =
      currentState.candidate_grid.mode === "auto" ? "manual" : "auto";
    try {
      const res = await fetch(
        `/api/puzzle/${currentSessionId}/candidates/mode`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: newMode }),
        }
      );
      if (!res.ok) return;
      const state = (await res.json()) as PuzzleState;
      currentState = state;
      el<HTMLButtonElement>("candidates-mode-btn").textContent =
        state.candidate_grid?.mode === "auto" ? "Auto" : "Manual";
      drawGrid(
        el<HTMLCanvasElement>("grid-canvas"),
        state,
        selectedCell,
        showCandidates
      );
    } catch {
      // Best-effort
    }
  }
  ```

- [ ] **Step 5: Update keyboard handler for candidate editing**

  Replace the existing `document.addEventListener("keydown", ...)` with:

  ```typescript
  document.addEventListener("keydown", (e) => {
    if (currentState?.user_grid == null) return;
    if (selectedCell === null) return;
    if (showCandidates && candidateEditMode) {
      if (e.key >= "1" && e.key <= "9") {
        void handleCandidateCycle(
          selectedCell.row,
          selectedCell.col,
          Number(e.key)
        );
      } else if (e.key === "Backspace" || e.key === "Delete") {
        void handleCandidateCycle(selectedCell.row, selectedCell.col, 0);
      }
    } else {
      if (e.key >= "1" && e.key <= "9") {
        void handleCellEntry(Number(e.key));
      } else if (e.key === "Backspace" || e.key === "Delete") {
        void handleCellEntry(0);
      }
    }
  });
  ```

- [ ] **Step 6: Update mousedown handler for sub-cell detection**

  Replace the existing `el<HTMLCanvasElement>("grid-canvas").addEventListener("mousedown", ...)` with:

  ```typescript
  el<HTMLCanvasElement>("grid-canvas").addEventListener("mousedown", (e) => {
    if (currentState?.user_grid == null) return;
    const rect = el<HTMLCanvasElement>("grid-canvas").getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const col = Math.floor((x - MARGIN) / CELL) + 1;
    const row = Math.floor((y - MARGIN) / CELL) + 1;
    if (col < 1 || col > 9 || row < 1 || row > 9) return;

    if (showCandidates && candidateEditMode) {
      const subCol = Math.floor((x - MARGIN - (col - 1) * CELL) / (CELL / 3));
      const subRow = Math.floor((y - MARGIN - (row - 1) * CELL) / (CELL / 3));
      const digit = subRow * 3 + subCol + 1;
      if (digit >= 1 && digit <= 9) {
        selectedCell = { row, col };
        void handleCandidateCycle(row, col, digit);
      }
    } else {
      selectedCell = { row, col };
      drawGrid(
        el<HTMLCanvasElement>("grid-canvas"),
        currentState,
        selectedCell,
        showCandidates
      );
    }
  });
  ```

- [ ] **Step 7: Wire up candidate buttons**

  Add these event listeners in the wire-up section (after the existing `undo-btn` listener):

  ```typescript
  el<HTMLButtonElement>("candidates-btn").addEventListener("click", () => {
    showCandidates = !showCandidates;
    el<HTMLButtonElement>("candidates-btn").textContent = showCandidates
      ? "Hide candidates"
      : "Show candidates";
    el<HTMLElement>("edit-candidates-btn").hidden = !showCandidates;
    el<HTMLElement>("candidates-mode-btn").hidden = !showCandidates;
    el<HTMLElement>("help-candidates-btn").hidden = !showCandidates;
    if (!showCandidates) {
      candidateEditMode = false;
      el<HTMLButtonElement>("edit-candidates-btn").textContent = "Edit candidates";
    }
    if (currentState !== null) {
      drawGrid(
        el<HTMLCanvasElement>("grid-canvas"),
        currentState,
        selectedCell,
        showCandidates
      );
    }
  });

  el<HTMLButtonElement>("edit-candidates-btn").addEventListener("click", () => {
    candidateEditMode = !candidateEditMode;
    el<HTMLButtonElement>("edit-candidates-btn").textContent = candidateEditMode
      ? "Done editing"
      : "Edit candidates";
  });

  el<HTMLButtonElement>("candidates-mode-btn").addEventListener("click", () => {
    void handleCandidateMode();
  });

  el<HTMLButtonElement>("help-candidates-btn").addEventListener("click", () => {
    (el<HTMLDialogElement>("help-candidates-modal")).showModal();
  });

  el<HTMLButtonElement>("close-help-btn").addEventListener("click", () => {
    (el<HTMLDialogElement>("help-candidates-modal")).close();
  });
  ```

- [ ] **Step 8: Compile TypeScript**

  ```bash
  tsc
  ```

  Expected: no errors. Common issues:
  - `HTMLDialogElement` might not exist in older TS lib settings. If so, cast: `(el("help-candidates-modal") as HTMLDialogElement).showModal()`
  - Any undefined variable reference indicates a missed step above

- [ ] **Step 9: Commit frontend changes**

  ```bash
  git add killer_sudoku/static/main.ts
  git commit -m "feat: add candidate canvas layer 8, handlers, keyboard routing"
  ```

---

## Task 10 — Bronze gate + Playwright e2e verification

**Files:**
- Modify: `killer_sudoku/static/main.js` (compiled — not committed)

- [ ] **Step 1: Compile TypeScript (if not already done)**

  ```bash
  tsc
  ```

- [ ] **Step 2: Run bronze gate**

  ```bash
  python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
  python -m ruff check --unsafe-fixes --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
  python -m ruff format killer_sudoku/ tests/
  python -m mypy --strict killer_sudoku/
  python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
  ```

  Fix any issues before proceeding. Common mypy issues:
  - `board.candidates[r][c]` — if typed as `object`, add `cast(set[int], board.candidates[r][c])`
  - `board.cage_solns[cage_idx]` — if typed as `list[Any]`, add explicit type annotation
  - `state.user_grid` — already `list[list[int]] | None`; assert before use is fine

- [ ] **Step 3: Run Playwright e2e tests**

  ```bash
  python -m pytest tests/e2e/ -v
  ```

  Expected: all Playwright tests PASS. If tests fail:
  - Check that the server starts correctly (`live_server_url` fixture)
  - Verify `_TINY_JPEG_B64` decodes to a valid JPEG (regenerate if needed per Step 6 note)
  - Check button IDs match between index.html and tests

- [ ] **Step 4: Full test suite**

  ```bash
  python -m pytest tests/ -v
  ```

  Expected: all tests pass.

- [ ] **Step 5: Final commit**

  ```bash
  git add killer_sudoku/static/main.ts killer_sudoku/api/ tests/
  git commit -m "feat: candidates view — complete implementation"
  ```

---

## Bronze Gate Reference

Run before every commit:

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff check --unsafe-fixes --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

`main.js` is generated by `tsc` — never committed.
