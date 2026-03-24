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
    CagePatchRequest,
    CageState,
    CandidateCell,
    CandidateCycleRequest,
    CandidateGrid,
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
from killer_sudoku.api.session import SessionStore
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.solver.engine import BoardState, SolverEngine, default_rules
from killer_sudoku.solver.engine.types import Elimination
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
                cage_solns: list[frozenset[int]] = board.cage_solns[cage_idx]
                cage_must: set[int] = set(range(1, 10)) if cage_solns else set()
                for soln in cage_solns:
                    cage_must &= soln

                auto_ess = sorted(auto_cands_set & cage_must)
                auto_cands = sorted(auto_cands_set)

                # Preserve overrides; apply Rule A to user_essential in auto mode only.
                # In manual mode user_essential is user-owned and not filtered here
                # — Rule A fires only on manual→auto transition via _min_merge_to_auto.
                if existing_grid is not None:
                    prev = existing_grid.cells[r][c]
                    if existing_grid.mode == "auto":
                        user_essential = [
                            d for d in prev.user_essential if d in auto_cands_set
                        ]
                    else:
                        user_essential = list(prev.user_essential)
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


# ---------------------------------------------------------------------------
# Router factory
# ---------------------------------------------------------------------------


def make_router(config: CoachConfig, store: SessionStore) -> APIRouter:
    """Create the puzzle API router bound to the given config and session store.

    Uses a factory pattern so that config and store are injected once at
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
        candidate_grid = _compute_candidate_grid(initial_state_for_cg, None)
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
        new_cg = _compute_candidate_grid(updated, updated.candidate_grid)
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
        new_cg = _compute_candidate_grid(updated, updated.candidate_grid)
        updated = updated.model_copy(update={"candidate_grid": new_cg})
        store.save(updated)
        return updated

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

        new_rows = [
            [
                new_cell
                if (row == r and col == c)
                else state.candidate_grid.cells[row][col]
                for col in range(9)
            ]
            for row in range(9)
        ]
        new_cg = CandidateGrid(cells=new_rows, mode=mode)
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

    return router
