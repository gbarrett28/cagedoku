"""API router for puzzle upload, cage editing, and solving.

All endpoints share a session store and coach configuration injected via the
make_router() factory, avoiding module-level globals while keeping the
FastAPI route definitions clean.
"""

from __future__ import annotations

import base64
import tempfile
import uuid
from pathlib import Path
from typing import Literal

import cv2
import numpy as np
import numpy.typing as npt
from fastapi import APIRouter, HTTPException, UploadFile

from killer_sudoku.api.config import CoachConfig
from killer_sudoku.api.schemas import (
    ApplyHintRequest,
    CagePatchRequest,
    CageSolutionsResponse,
    CageState,
    CandidateCell,
    CandidateCycleRequest,
    CandidateGrid,
    CellEntryRequest,
    CellPosition,
    EliminateSolutionRequest,
    EliminationItem,
    HintItem,
    HintsResponse,
    MoveRecord,
    PuzzleSpecData,
    PuzzleState,
    SolveResponse,
    SubdivideRequest,
    UploadResponse,
)
from killer_sudoku.api.session import SessionStore
from killer_sudoku.api.settings import SettingsStore
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.solver.engine import BoardState, SolverEngine, default_rules
from killer_sudoku.solver.engine.hint import HintableRule, collect_hints
from killer_sudoku.solver.engine.types import Elimination
from killer_sudoku.solver.equation import sol_sums
from killer_sudoku.solver.grid import (  # Grid used in solve endpoint
    Grid,
    ProcessingError,
)
from killer_sudoku.solver.puzzle_spec import PuzzleSpec

# ---------------------------------------------------------------------------
# Pure conversion helpers (no I/O, easily unit-tested)
# ---------------------------------------------------------------------------


def _cage_label(i: int) -> str:
    """Generate an Excel-column-style label: A…Z, AA…AZ, BA…

    Uses 0-based index i. Supports any number of cages without overflow.
    """
    label = ""
    n = i + 1
    while n > 0:
        n, remainder = divmod(n - 1, 26)
        label = chr(ord("A") + remainder) + label
    return label


def _spec_to_cage_states(spec: PuzzleSpec) -> list[CageState]:
    """Convert a PuzzleSpec into a list of CageState Pydantic models.

    Groups cells by cage index from spec.regions, assigns sequential
    uppercase labels (A, B, C …), and reads the total from spec.cage_totals
    (stored at the head cell of each cage; all other cells are 0).
    """
    cage_cells: dict[int, list[CellPosition]] = {}
    cage_totals_map: dict[int, int] = {}

    for row in range(9):
        for col in range(9):
            idx = int(spec.regions[row, col])
            if idx == 0:
                continue  # 0 = unassigned; skip
            if idx not in cage_cells:
                cage_cells[idx] = []
            cage_cells[idx].append(CellPosition(row=row + 1, col=col + 1))
            total = int(spec.cage_totals[row, col])
            if total > 0:
                cage_totals_map[idx] = total

    return [
        CageState(
            label=_cage_label(i),
            total=cage_totals_map.get(idx, 0),
            cells=cage_cells[idx],
        )
        for i, idx in enumerate(sorted(cage_cells))
    ]


def _spec_to_data(spec: PuzzleSpec) -> PuzzleSpecData:
    """Serialize a PuzzleSpec's numpy arrays to nested Python lists for JSON storage."""
    return PuzzleSpecData(
        regions=spec.regions.tolist(),
        cage_totals=spec.cage_totals.tolist(),
        border_x=spec.border_x.tolist(),
        border_y=spec.border_y.tolist(),
    )


def _data_to_spec(data: PuzzleSpecData) -> PuzzleSpec:
    """Reconstruct a PuzzleSpec from serialized session data."""
    return PuzzleSpec(
        regions=np.array(data.regions, dtype=np.intp),
        cage_totals=np.array(data.cage_totals, dtype=np.intp),
        border_x=np.array(data.border_x, dtype=bool),
        border_y=np.array(data.border_y, dtype=bool),
    )


def _cage_states_to_spec(cages: list[CageState], data: PuzzleSpecData) -> PuzzleSpec:
    """Rebuild a PuzzleSpec from (possibly edited) cage states and stored border data.

    Re-derives regions and cage_totals from the current cage list so that
    user corrections to cage totals are reflected. The original border_x /
    border_y arrays from the OCR run are reused for rendering.
    """
    regions = np.zeros((9, 9), dtype=np.intp)
    cage_totals = np.zeros((9, 9), dtype=np.intp)

    for cage_idx, cage in enumerate(cages, start=1):
        head: tuple[int, int] | None = None
        for cell in cage.cells:
            r, c = cell.row - 1, cell.col - 1
            regions[r, c] = cage_idx
            if head is None:
                head = (r, c)
        if head is not None:
            cage_totals[head[0], head[1]] = cage.total

    return PuzzleSpec(
        regions=regions,
        cage_totals=cage_totals,
        border_x=np.array(data.border_x, dtype=bool),
        border_y=np.array(data.border_y, dtype=bool),
    )


def _encode_image(img: npt.NDArray[np.uint8], fmt: str = ".jpg") -> str:
    """Encode a numpy BGR image as a base64 string.

    Args:
        img: BGR image array.
        fmt: File extension controlling the codec, e.g. ".jpg" or ".png".
    """
    success, buf = cv2.imencode(fmt, img)
    if not success:
        raise RuntimeError(f"cv2.imencode({fmt!r}) failed")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _resize_for_display(
    img: npt.NDArray[np.uint8], max_px: int = 504
) -> npt.NDArray[np.uint8]:
    """Downscale img so its largest dimension is at most max_px.

    Returns the original array unchanged if it already fits.
    """
    h, w = img.shape[:2]
    largest = max(h, w)
    if largest <= max_px:
        return img
    scale = max_px / largest
    new_w, new_h = int(w * scale), int(h * scale)
    return np.asarray(
        cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA),
        dtype=np.uint8,
    )


# ---------------------------------------------------------------------------
# Candidate grid helpers
# ---------------------------------------------------------------------------


def _user_eliminations(
    board: BoardState,
    user_grid: list[list[int]],
) -> list[Elimination]:
    """Build eliminations that reflect the user's placed digits.

    For each placed digit d at (r, c):
    - Removes all non-d digits from that cell (pins the cell to d).
    - Removes d from every peer: same row, same column, and same 3×3 box.

    Only emits eliminations for digits still present in board.candidates to
    avoid redundant work.
    """
    elim_set: set[tuple[tuple[int, int], int]] = set()
    for r in range(9):
        for c in range(9):
            placed = user_grid[r][c]
            if placed == 0:
                continue
            for d in range(1, 10):
                if d != placed:
                    elim_set.add(((r, c), d))
            box_r, box_c = (r // 3) * 3, (c // 3) * 3
            for cc in range(9):
                if cc != c:
                    elim_set.add(((r, cc), placed))
            for rr in range(9):
                if rr != r:
                    elim_set.add(((rr, c), placed))
            for rr in range(box_r, box_r + 3):
                for cc in range(box_c, box_c + 3):
                    if (rr, cc) != (r, c):
                        elim_set.add(((rr, cc), placed))
    return [
        Elimination(cell=cell, digit=d)
        for cell, d in elim_set
        if d in board.candidates[cell[0]][cell[1]]
    ]


def _compute_candidate_grid(
    state: PuzzleState,
    existing_grid: CandidateGrid | None,
    always_apply: frozenset[str],
) -> CandidateGrid:
    """Compute candidates for all unsolved cells using always-apply solver rules.

    Builds a fresh BoardState, applies structural constraints (linear system),
    user placements, and user-eliminated cage solutions, then runs the solver
    engine with only the always-apply rules to convergence.

    auto_candidates reflects what the always-apply rules consider still possible.
    auto_essential is the intersection of all remaining cage solutions for a cell's
    cage — digits that must appear in the cage regardless of which combination is
    chosen.

    Solved cells (user_grid[r][c] != 0) have their CandidateCell copied unchanged
    from existing_grid (freeze rule). If existing_grid is None (initial call at
    /confirm), all user_essential and user_removed start empty.

    Rule A: digits no longer in auto_candidates are silently removed from
    user_essential on every recomputation.
    """
    assert state.user_grid is not None
    spec = _data_to_spec(state.spec_data)
    linear_active = "LinearElimination" in always_apply
    board = BoardState(spec, include_virtual_cages=linear_active)
    engine: SolverEngine = SolverEngine(
        board,
        rules=[r for r in default_rules() if r.name in always_apply],
        linear_system_active=linear_active,
    )

    # Step 1: pin user placements — eliminate other digits from each solved cell
    # and eliminate the placed digit from all peers (same row, col, 3×3 box).
    engine.apply_eliminations(_user_eliminations(board, state.user_grid))

    # Step 2: run always-apply rules to convergence.
    # User-eliminated cage solutions are NOT fed into the solver here — they are
    # applied as a display-time filter in Step 4.  This prevents an impossible
    # board state when the solver's row/col/box constraints already narrow a cell
    # to exactly the digits the user chose to eliminate.
    engine.solve()

    # Step 3: build per-cell CandidateCell from the post-solve board state.
    # auto_candidates = solver candidates ∩ cage_possible (user-filtered solns)
    # auto_essential  = auto_candidates ∩ must-contain set (user-filtered solns)
    cells: list[list[CandidateCell]] = []
    for r in range(9):
        row_cells: list[CandidateCell] = []
        for c in range(9):
            placed = state.user_grid[r][c]
            if placed != 0:
                # Solved cell: freeze existing state unchanged.
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
                cage_idx = int(board.regions[r, c])
                user_elim = {
                    frozenset(s) for s in state.cages[cage_idx].user_eliminated_solns
                }
                remaining = [
                    s for s in board.cage_solns[cage_idx] if s not in user_elim
                ]
                cage_possible: set[int] = (
                    set().union(*remaining) if remaining else set()
                )
                cage_must: set[int] = set(remaining[0]) if remaining else set()
                for s in remaining[1:]:
                    cage_must &= s

                auto_cands_set = board.candidates[r][c] & cage_possible
                auto_cands = sorted(auto_cands_set)
                auto_ess = sorted(auto_cands_set & cage_must)

                if existing_grid is not None:
                    prev = existing_grid.cells[r][c]
                    # Rule A: auto-impossible digits are cleared from user_essential.
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

    return CandidateGrid(cells=cells)


def _cycle_candidate(
    cell: CandidateCell,
    digit: int,
) -> CandidateCell:
    """Advance digit one step through its state cycle.

    Cycle order (auto-impossible and not user-removed → no-op):
      impossible (user-removed) → restore
      essential (user) → impossible
      essential (auto only) → impossible
      inessential → promote to user-essential
    """
    auto_set = set(cell.auto_candidates)
    auto_ess = set(cell.auto_essential)
    user_ess = set(cell.user_essential)
    user_rem = set(cell.user_removed)

    if digit not in auto_set and digit not in user_rem:
        return cell  # auto-impossible, not user-removed: no-op
    if digit in user_rem:
        user_rem.discard(digit)
    elif digit in user_ess:
        user_ess.discard(digit)
        user_rem.add(digit)
    elif digit in auto_ess:
        user_rem.add(digit)
    else:
        user_ess.add(digit)

    return CandidateCell(
        auto_candidates=cell.auto_candidates,
        auto_essential=cell.auto_essential,
        user_essential=sorted(user_ess),
        user_removed=sorted(user_rem),
    )


# ---------------------------------------------------------------------------
# Router factory
# ---------------------------------------------------------------------------


def make_router(
    config: CoachConfig, store: SessionStore, settings_store: SettingsStore
) -> APIRouter:
    """Create the puzzle API router bound to the given config, session store,
    and settings store.

    Uses a factory pattern so that config and stores are injected once at
    startup (in app.py) rather than read from module-level globals, making
    the router straightforwardly testable.
    """
    router = APIRouter(prefix="/api/puzzle", tags=["puzzle"])

    @router.post("", response_model=UploadResponse)
    async def upload_puzzle(
        file: UploadFile,
        newspaper: Literal["guardian", "observer"] = "guardian",
    ) -> UploadResponse:
        """Accept a puzzle image, run the OCR pipeline, and create a session.

        The uploaded image is written to a temp file for InpImage processing
        (InpImage requires a Path, not bytes). rework=True ensures no stale
        .jpk cache files are left alongside the temp file.

        Raises 422 if the OCR pipeline cannot parse the image.
        """
        if config.mock_spec is not None:
            spec = config.mock_spec
            cages = _spec_to_cage_states(spec)
            spec_data = _spec_to_data(spec)
            placeholder = np.zeros((1, 1, 3), dtype=np.uint8) + 255
            original_b64 = _encode_image(np.asarray(placeholder, dtype=np.uint8))
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

        contents = await file.read()
        suffix = Path(file.filename or "upload.jpg").suffix or ".jpg"

        tmp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(contents)
                tmp_path = Path(tmp.name)

            puzzle_dir = config.puzzle_dir(newspaper)
            img_config = ImagePipelineConfig(
                puzzle_dir=puzzle_dir,
                newspaper=newspaper,
                rework=True,
            )
            border_detector = InpImage.make_border_detector(img_config)
            num_recogniser = InpImage.make_num_recogniser(img_config)

            try:
                inp = InpImage(tmp_path, img_config, border_detector, num_recogniser)
            except (AssertionError, ValueError, ProcessingError) as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

            spec = inp.spec
            cages = _spec_to_cage_states(spec)
            spec_data = _spec_to_data(spec)
            original_b64 = _encode_image(_resize_for_display(inp.img))

            session_id = str(uuid.uuid4())
            state = PuzzleState(
                session_id=session_id,
                newspaper=newspaper,
                cages=cages,
                spec_data=spec_data,
                original_image_b64=original_b64,
            )
            store.save(state)
            return UploadResponse(session_id=session_id, state=state)

        finally:
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)

    @router.get("/{session_id}", response_model=PuzzleState)
    async def get_puzzle(session_id: str) -> PuzzleState:
        """Retrieve the current state of a puzzle session."""
        try:
            return store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

    @router.patch("/{session_id}/cage/{label}", response_model=PuzzleState)
    async def patch_cage(
        session_id: str,
        label: str,
        req: CagePatchRequest,
    ) -> PuzzleState:
        """Correct the OCR-detected total for a named cage.

        Re-renders the overlay image with the updated total so the frontend
        can display the correction immediately.
        """
        try:
            state = store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

        upper = label.upper()
        if not any(c.label == upper for c in state.cages):
            raise HTTPException(status_code=404, detail=f"Cage {label!r} not found")

        updated_cages = [
            CageState(
                label=c.label,
                total=req.total if c.label == upper else c.total,
                cells=c.cells,
                subdivisions=c.subdivisions,
            )
            for c in state.cages
        ]

        updated = state.model_copy(update={"cages": updated_cages})
        store.save(updated)
        return updated

    @router.post("/{session_id}/cage/{label}/subdivide", response_model=PuzzleState)
    async def subdivide_cage(
        session_id: str,
        label: str,
        req: SubdivideRequest,
    ) -> PuzzleState:
        """Split a cage into user-defined sub-cages.

        Stores the subdivision in the session for Phase 2 use. The parent
        cage total and cells are unchanged; solving still uses the parent cage.
        """
        try:
            state = store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

        upper = label.upper()
        if not any(c.label == upper for c in state.cages):
            raise HTTPException(status_code=404, detail=f"Cage {label!r} not found")

        updated_cages = [
            CageState(
                label=c.label,
                total=c.total,
                cells=c.cells,
                subdivisions=req.sub_cages if c.label == upper else c.subdivisions,
            )
            for c in state.cages
        ]

        updated = state.model_copy(update={"cages": updated_cages})
        store.save(updated)
        return updated

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
        try:
            grd.set_up(spec)
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
        initial_state_for_cg = state.model_copy(
            update={
                "golden_solution": golden,
                "user_grid": [[0] * 9 for _ in range(9)],
            }
        )
        always_apply = frozenset(settings_store.load().always_apply_rules)
        candidate_grid = _compute_candidate_grid(
            initial_state_for_cg, None, always_apply
        )
        updated = initial_state_for_cg.model_copy(
            update={"candidate_grid": candidate_grid}
        )
        store.save(updated)
        return updated

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
            raise HTTPException(
                status_code=422, detail="row/col must be 1–9; digit 0–9"
            )

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

        updated = state.model_copy(
            update={"user_grid": new_grid, "move_history": new_history}
        )
        # Recompute candidates after the cell entry
        always_apply = frozenset(settings_store.load().always_apply_rules)
        new_cg = _compute_candidate_grid(updated, updated.candidate_grid, always_apply)
        updated = updated.model_copy(update={"candidate_grid": new_cg})
        store.save(updated)
        return updated

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

        updated = state.model_copy(
            update={"user_grid": new_grid, "move_history": new_history}
        )
        # Recompute candidates after restoring the cell
        always_apply = frozenset(settings_store.load().always_apply_rules)
        new_cg = _compute_candidate_grid(updated, updated.candidate_grid, always_apply)
        updated = updated.model_copy(update={"candidate_grid": new_cg})
        store.save(updated)
        return updated

    @router.patch("/{session_id}/candidates/cell", response_model=PuzzleState)
    async def cycle_candidate(
        session_id: str,
        req: CandidateCycleRequest,
    ) -> PuzzleState:
        """Cycle one digit's state in a cell, or reset all overrides (digit=0).

        Does not run solver recomputation — only updates user_essential and
        user_removed overrides.
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
            new_cell = _cycle_candidate(old_cell, req.digit)

        new_rows = [
            [
                new_cell
                if (row == r and col == c)
                else state.candidate_grid.cells[row][col]
                for col in range(9)
            ]
            for row in range(9)
        ]
        new_cg = CandidateGrid(cells=new_rows)
        updated = state.model_copy(update={"candidate_grid": new_cg})
        store.save(updated)
        return updated

    @router.post("/{session_id}/solve", response_model=SolveResponse)
    async def solve_puzzle(session_id: str) -> SolveResponse:
        """Solve the puzzle using the constraint engine, with CSP fallback.

        Reconstructs a PuzzleSpec from the current (possibly edited) cage
        states, runs engine_solve(), and falls back to cheat_solve() if the
        constraint engine cannot reach a full solution.

        Returns a 9×9 grid of digits (0 = unsolved) and a solved flag.
        """
        try:
            state = store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

        spec = _cage_states_to_spec(state.cages, state.spec_data)
        grd = Grid()
        grd.set_up(spec)

        try:
            alts_sum, _ = grd.engine_solve()
        except (AssertionError, ValueError) as exc:
            empty: list[list[int]] = [[0] * 9 for _ in range(9)]
            return SolveResponse(solved=False, grid=empty, error=str(exc))

        if alts_sum != 81:
            grd.cheat_solve()

        solution = [
            [int(next(iter(grd.sq_poss[r][c]))) for c in range(9)] for r in range(9)
        ]
        solved = all(
            len(set(grd.sq_poss[r][c])) == 1 for r in range(9) for c in range(9)
        )
        return SolveResponse(solved=solved, grid=solution)

    @router.get(
        "/{session_id}/cage/{label}/solutions",
        response_model=CageSolutionsResponse,
    )
    async def get_cage_solutions(
        session_id: str,
        label: str,
    ) -> CageSolutionsResponse:
        """Return all valid digit combinations for a cage, split by status.

        all_solutions: complete set from sol_sums, each as a sorted digit list.
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

        always_apply = frozenset(settings_store.load().always_apply_rules)
        spec = _data_to_spec(state.spec_data)
        linear_active = "LinearElimination" in always_apply
        board = BoardState(spec, include_virtual_cages=linear_active)
        engine: SolverEngine = SolverEngine(
            board,
            rules=[r for r in default_rules() if r.name in always_apply],
            linear_system_active=linear_active,
        )
        engine.apply_eliminations(_user_eliminations(board, state.user_grid))
        engine.solve()

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
            cage = next(c for c in state.cages if c.label == upper)
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
        always_apply = frozenset(settings_store.load().always_apply_rules)
        new_cg = _compute_candidate_grid(updated, updated.candidate_grid, always_apply)
        updated = updated.model_copy(update={"candidate_grid": new_cg})
        store.save(updated)
        return updated

    @router.get("/{session_id}/hints", response_model=HintsResponse)
    async def get_hints(session_id: str) -> HintsResponse:
        """Return all currently applicable hints, ordered by impact.

        Sets up the board in the same state as candidate computation, then
        runs each hintable rule to collect HintResult objects.  Results are
        sorted descending by elimination_count so the most impactful hint
        appears first.  Returns an empty list before /confirm or if no rules
        currently fire.
        """
        try:
            state = store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

        if state.user_grid is None:
            return HintsResponse(hints=[])

        always_apply = frozenset(settings_store.load().always_apply_rules)
        spec = _data_to_spec(state.spec_data)
        linear_active = "LinearElimination" in always_apply
        board = BoardState(spec, include_virtual_cages=linear_active)
        # Run the solver with always-apply rules only, so hint-only rules
        # (e.g. MustContainOutie) are not pre-applied and can still fire.
        engine: SolverEngine = SolverEngine(
            board,
            rules=[r for r in default_rules() if r.name in always_apply],
            linear_system_active=linear_active,
        )
        engine.apply_eliminations(_user_eliminations(board, state.user_grid))
        # Apply user-eliminated cage solutions so the solver sees the user's
        # pruning decisions.
        for cage_idx, cage in enumerate(state.cages):
            if not cage.user_eliminated_solns:
                continue
            eliminated_sets = [frozenset(s) for s in cage.user_eliminated_solns]
            board.cage_solns[cage_idx] = [
                s for s in board.cage_solns[cage_idx] if s not in eliminated_sets
            ]
        engine.solve()

        # Re-apply cage candidate narrowing after user solution eliminations.
        # User-eliminated cage solutions are applied directly to board.cage_solns
        # above, bypassing the engine event system, so CageCandidateFilter did
        # not see them.  This pass ensures board.candidates reflects the
        # user-filtered solution sets before hint detection runs.
        cage_narrow: list[Elimination] = []
        for cage_idx in range(len(state.cages)):
            solns = board.cage_solns[cage_idx]
            if not solns:
                continue
            cage_possible: set[int] = set().union(*solns)
            for cr, cc in board.units[27 + cage_idx].cells:
                for d in list(board.candidates[cr][cc]):
                    if d not in cage_possible:
                        cage_narrow.append(Elimination(cell=(cr, cc), digit=d))
        if cage_narrow:
            engine.apply_eliminations(cage_narrow)
            engine.solve()

        hint_rules: list[HintableRule] = [
            r for r in default_rules() if isinstance(r, HintableRule)
        ]
        raw_hints = collect_hints(hint_rules, board, skip_names=set(always_apply))
        raw_hints.sort(key=lambda h: h.elimination_count, reverse=True)

        return HintsResponse(
            hints=[
                HintItem(
                    rule_name=h.rule_name,
                    display_name=h.display_name,
                    explanation=h.explanation,
                    highlight_cells=sorted(h.highlight_cells),
                    eliminations=[
                        EliminationItem(cell=e.cell, digit=e.digit)
                        for e in h.eliminations
                    ],
                    elimination_count=h.elimination_count,
                )
                for h in raw_hints
            ]
        )

    @router.post("/{session_id}/hints/apply", response_model=PuzzleState)
    async def apply_hint(session_id: str, req: ApplyHintRequest) -> PuzzleState:
        """Apply a hint's eliminations by marking each digit as user_removed.

        Records the player's acceptance of the deduction.  Candidate grids
        are recomputed so the display reflects the updated user_removed sets.
        """
        try:
            state = store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

        if state.candidate_grid is None:
            raise HTTPException(
                status_code=400, detail="No candidate grid — confirm puzzle first"
            )

        cells = [list(row) for row in state.candidate_grid.cells]
        for elim in req.eliminations:
            r, c = elim.cell
            d = elim.digit
            cell = cells[r][c]
            if d in cell.auto_candidates and d not in cell.user_removed:
                cells[r][c] = CandidateCell(
                    auto_candidates=cell.auto_candidates,
                    auto_essential=cell.auto_essential,
                    user_essential=cell.user_essential,
                    user_removed=sorted(set(cell.user_removed) | {d}),
                )

        updated = state.model_copy(
            update={"candidate_grid": CandidateGrid(cells=cells)}
        )
        store.save(updated)
        return updated

    return router
