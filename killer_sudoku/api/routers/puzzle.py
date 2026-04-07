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

import cv2
import numpy as np
import numpy.typing as npt
from fastapi import APIRouter, HTTPException, UploadFile

from killer_sudoku.api.config import CoachConfig
from killer_sudoku.api.schemas import (
    AddVirtualCageRequest,
    ApplyHintRequest,
    BoardSnapshot,
    CageInfo,
    CagePatchRequest,
    CageSolutionsResponse,
    CageState,
    CandidateCycleRequest,
    CandidatesResponse,
    CellEntryRequest,
    CellInfo,
    CellPosition,
    EliminateSolutionRequest,
    EliminationItem,
    HintItem,
    HintsResponse,
    MoveRecord,
    PuzzleSpecData,
    PuzzleState,
    RewindRequest,
    SolveResponse,
    SubdivideRequest,
    Turn,
    UploadResponse,
    UserAction,
    VirtualCage,
    VirtualCageInfo,
    VirtualCageSuggestion,
)
from killer_sudoku.api.session import SessionStore
from killer_sudoku.api.settings import SettingsStore
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.solver.engine import BoardState, SolverEngine, default_rules
from killer_sudoku.solver.engine.board_state import NoSolnError
from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.types import Elimination, Placement
from killer_sudoku.solver.equation import sol_sums
from killer_sudoku.solver.grid import Grid  # used in solve endpoint
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


def _build_diagnostic_spec(
    cage_totals: npt.NDArray[np.intp],
    border_x: npt.NDArray[np.bool_],
    border_y: npt.NDArray[np.bool_],
) -> PuzzleSpec:
    """Build an unvalidated PuzzleSpec for diagnostic display.

    Uses the same union-find connected-components logic as validate_cage_layout
    but skips all cage-validity checks.  The result may contain invalid cages
    (wrong totals, multiple heads, headless regions) but is safe to render and
    interact with in the confirmation UI.

    Args:
        cage_totals: (9,9) int array; non-zero at cage-head cells.
        border_x: (9,8) horizontal cage-wall flags.
        border_y: (8,9) vertical cage-wall flags.

    Returns:
        PuzzleSpec with connected-component regions; cage_totals unchanged.
    """
    rmap: dict[tuple[int, int], tuple[int, int]] = {
        (c, r): (c, r) for c in range(9) for r in range(9)
    }
    members: dict[tuple[int, int], set[tuple[int, int]]] = {
        (c, r): {(c, r)} for c in range(9) for r in range(9)
    }

    def union(a: tuple[int, int], b: tuple[int, int]) -> None:
        ra, rb = sorted((rmap[a], rmap[b]))
        if ra == rb:
            return
        for p in members[rb]:
            rmap[p] = ra
        members[ra] |= members[rb]
        del members[rb]

    for col in range(9):
        for row in range(8):
            if not border_x[col, row]:
                union((col, row), (col, row + 1))

    for col in range(8):
        for row in range(9):
            if not border_y[col, row]:
                union((col, row), (col + 1, row))

    rep_to_id: dict[tuple[int, int], int] = {}
    regions: npt.NDArray[np.intp] = np.zeros((9, 9), dtype=np.intp)
    for col in range(9):
        for row in range(9):
            rep = rmap[(col, row)]
            if rep not in rep_to_id:
                rep_to_id[rep] = len(rep_to_id) + 1
            regions[col, row] = rep_to_id[rep]

    return PuzzleSpec(
        regions=regions,
        cage_totals=cage_totals,
        border_x=border_x,
        border_y=border_y,
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


def _user_virtual_cages(state: PuzzleState) -> list[VirtualCage]:
    """Extract VirtualCage entries from Turn history.

    Processes add_virtual_cage and eliminate_virtual_cage_soln actions in
    order so that per-key eliminated solutions are populated correctly.
    """
    result: list[VirtualCage] = []
    eliminated: dict[str, list[list[int]]] = {}
    for turn in state.history:
        a = turn.user_action
        if (
            a.type == "add_virtual_cage"
            and a.virtual_cage_key is not None
            and a.virtual_cage_cells is not None
            and a.virtual_cage_total is not None
        ):
            result.append(
                VirtualCage(
                    key=a.virtual_cage_key,
                    cells=a.virtual_cage_cells,
                    total=a.virtual_cage_total,
                    eliminated_solns=eliminated.get(a.virtual_cage_key, []),
                )
            )
        elif (
            a.type == "eliminate_virtual_cage_soln"
            and a.virtual_cage_key is not None
            and a.solution is not None
        ):
            eliminated.setdefault(a.virtual_cage_key, []).append(a.solution)
    return result


def _user_removed(state: PuzzleState) -> list[tuple[int, int, int]]:
    """Extract (row, col, digit) removals from Turn history.

    Processes remove_candidate, restore_candidate, reset_cell_candidates, and
    apply_hint (hint_eliminations) actions in order to compute the final set
    of user-removed candidates.  All indices are 0-based.
    """
    result: list[tuple[int, int, int]] = []
    for turn in state.history:
        a = turn.user_action
        if (
            a.type == "remove_candidate"
            and a.row is not None
            and a.col is not None
            and a.digit is not None
        ):
            result.append((a.row, a.col, a.digit))
        elif (
            a.type == "restore_candidate"
            and a.row is not None
            and a.col is not None
            and a.digit is not None
        ):
            result = [
                (r, c, d)
                for r, c, d in result
                if not (r == a.row and c == a.col and d == a.digit)
            ]
        elif (
            a.type == "reset_cell_candidates"
            and a.row is not None
            and a.col is not None
        ):
            result = [(r, c, d) for r, c, d in result if (r, c) != (a.row, a.col)]
        elif a.type == "apply_hint" and a.hint_eliminations:
            result.extend(a.hint_eliminations)
    return result


def _build_engine(
    state: PuzzleState,
    always_apply: frozenset[str],
) -> tuple[BoardState, SolverEngine]:
    """Build a fresh BoardState and run it to convergence from user decisions.

    Replaces _compute_candidate_grid and _make_board_and_engine.
    BoardState is always reconstructed from spec + Turn history — never
    stored as serialised solver state.

    Hint-only rules (those not in always_apply) buffer HintResults into
    engine.pending_hints rather than draining eliminations.

    Raises HTTPException 422 if the board is in a contradictory state.
    """
    spec = _data_to_spec(state.spec_data)
    board = BoardState(spec, include_virtual_cages=False)

    for vc in _user_virtual_cages(state):
        board.add_virtual_cage(
            frozenset((int(c[0]), int(c[1])) for c in vc.cells),
            vc.total,
            [frozenset(s) for s in vc.eliminated_solns],
        )

    hint_rule_names = frozenset(
        r.name for r in default_rules() if r.name not in always_apply
    )
    engine = SolverEngine(
        board,
        rules=list(default_rules()),
        linear_system_active=False,
        hint_rules=hint_rule_names,
    )

    if state.user_grid is not None:
        engine.apply_eliminations(_user_eliminations(board, state.user_grid))

    for r, c, d in _user_removed(state):
        if d in board.candidates[r][c] and len(board.candidates[r][c]) > 1:
            engine.apply_eliminations([Elimination(cell=(r, c), digit=d)])

    # Apply user-eliminated real cage solutions (legacy CageState storage)
    for cage_idx, cage in enumerate(state.cages):
        for soln in cage.user_eliminated_solns:
            fs = frozenset(soln)
            if fs in board.cage_solns[cage_idx]:
                board.cage_solns[cage_idx].remove(fs)

    try:
        engine.solve()
    except NoSolnError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Board is in a contradictory state: {exc}",
        ) from exc

    return board, engine


def _record_turn(
    state: PuzzleState,
    user_action: UserAction,
    engine: SolverEngine,
    board: BoardState,
) -> PuzzleState:
    """Append a Turn (user action + auto mutations + snapshot) to history."""
    snapshot = BoardSnapshot(
        candidates=[
            [sorted(board.candidates[r][c]) for c in range(9)] for r in range(9)
        ],
        cage_solns=[
            [sorted(s) for s in board.cage_solns[i]]
            for i in range(len(board.cage_solns))
        ],
    )
    turn = Turn(
        user_action=user_action,
        auto_mutations=engine.applied_mutations,
        snapshot=snapshot,
    )
    return state.model_copy(update={"history": [*state.history, turn]})


def _apply_auto_placements(state: PuzzleState, engine: SolverEngine) -> PuzzleState:
    """Promote NakedSingle (and other placement-rule) results into user_grid.

    After _build_engine runs, engine.applied_placements holds any cells that
    the engine's always-apply placement rules determined.  This function folds
    those placements into user_grid so the stored state reflects them.  Only
    cells that are still empty (0) are updated — explicit user entries win.
    """
    if not engine.applied_placements or state.user_grid is None:
        return state
    grid = [row[:] for row in state.user_grid]
    p: Placement
    for p in engine.applied_placements:
        r, c = p.cell
        if grid[r][c] == 0:
            grid[r][c] = p.digit
    return state.model_copy(update={"user_grid": grid})


def _rebuild_user_grid(state: PuzzleState) -> PuzzleState:
    """Recompute user_grid and move_history from place_digit/remove_digit in history."""
    grid = [[0] * 9 for _ in range(9)]
    new_move_history: list[MoveRecord] = []
    for turn in state.history:
        a = turn.user_action
        if (
            a.type == "place_digit"
            and a.row is not None
            and a.col is not None
            and a.digit is not None
        ):
            prev = grid[a.row][a.col]
            grid[a.row][a.col] = a.digit
            new_move_history.append(
                MoveRecord(row=a.row + 1, col=a.col + 1, digit=a.digit, prev_digit=prev)
            )
        elif a.type == "remove_digit" and a.row is not None and a.col is not None:
            prev = grid[a.row][a.col]
            grid[a.row][a.col] = 0
            new_move_history.append(
                MoveRecord(row=a.row + 1, col=a.col + 1, digit=0, prev_digit=prev)
            )
    return state.model_copy(
        update={"user_grid": grid, "move_history": new_move_history}
    )


def _virtual_cage_key(cells: list[tuple[int, int]], total: int) -> str:
    """Canonical key for a virtual cage: sorted cells joined by ':' then total.

    Example: cells [(0,3),(0,0),(1,2)], total=17 → "0,0:0,3:1,2:17".
    """
    return ":".join(f"{r},{c}" for r, c in sorted(cells)) + f":{total}"


def _find_last_consistent_turn_idx(state: PuzzleState) -> int | None:
    """Return the history slice index that makes the state consistent, or None.

    Walks history forward, maintaining a running user_grid and user_removed set.
    Checks consistency with golden_solution after every turn.  Returns the index
    N such that history[:N] is the longest consistent prefix — i.e. the caller
    should rewind to N.

    Returns None when the full history is consistent (no rewind needed).

    Cells where golden_solution[r][c] == 0 (solver could not determine the value)
    are excluded from the check.
    """
    golden = state.golden_solution
    if golden is None:
        return None

    grid: list[list[int]] = [[0] * 9 for _ in range(9)]
    removed: set[tuple[int, int, int]] = set()
    last_consistent = 0

    for i, turn in enumerate(state.history):
        a = turn.user_action
        # Update running grid
        if (
            a.type == "place_digit"
            and a.row is not None
            and a.col is not None
            and a.digit is not None
        ):
            grid[a.row][a.col] = a.digit
        elif a.type == "remove_digit" and a.row is not None and a.col is not None:
            grid[a.row][a.col] = 0
        # Update running user_removed
        if (
            a.type == "remove_candidate"
            and a.row is not None
            and a.col is not None
            and a.digit is not None
        ):
            removed.add((a.row, a.col, a.digit))
        elif (
            a.type == "restore_candidate"
            and a.row is not None
            and a.col is not None
            and a.digit is not None
        ):
            removed.discard((a.row, a.col, a.digit))
        elif (
            a.type == "reset_cell_candidates"
            and a.row is not None
            and a.col is not None
        ):
            removed = {(r, c, d) for r, c, d in removed if (r, c) != (a.row, a.col)}
        elif a.type == "apply_hint" and a.hint_eliminations:
            for r, c, d in a.hint_eliminations:
                removed.add((r, c, d))

        # Check consistency after this turn
        consistent = True
        for r in range(9):
            for c in range(9):
                g = golden[r][c]
                if g == 0:
                    continue  # solver could not determine this cell — skip
                if grid[r][c] != 0 and grid[r][c] != g:
                    consistent = False
                    break
                if (r, c, g) in removed:
                    consistent = False
                    break
            if not consistent:
                break

        if consistent:
            last_consistent = i + 1

    return None if last_consistent == len(state.history) else last_consistent


def _describe_first_error(
    state: PuzzleState,
    rewind_idx: int,
) -> tuple[str, list[tuple[int, int]]]:
    """Return (explanation, highlight_cells) for the first post-rewind error.

    Describes the turn at history[rewind_idx] — the first turn that made the
    state inconsistent with golden_solution.  All coordinates in the returned
    highlight_cells are 0-based (row, col).
    """
    golden = state.golden_solution
    assert golden is not None
    a = state.history[rewind_idx].user_action

    if (
        a.type == "place_digit"
        and a.row is not None
        and a.col is not None
        and a.digit is not None
    ):
        g = golden[a.row][a.col]
        if g != 0 and a.digit != g:
            return (
                f"Digit {a.digit} at r{a.row + 1}c{a.col + 1} conflicts with the "
                f"solution (correct digit is {g}).",
                [(a.row, a.col)],
            )

    if (
        a.type == "remove_candidate"
        and a.row is not None
        and a.col is not None
        and a.digit is not None
        and golden[a.row][a.col] == a.digit
    ):
        return (
            f"Digit {a.digit} was removed from r{a.row + 1}c{a.col + 1}, but it "
            f"is the solution for that cell.",
            [(a.row, a.col)],
        )

    if a.type == "apply_hint" and a.hint_eliminations:
        for r, c, d in a.hint_eliminations:
            if golden[r][c] == d:
                return (
                    f"A hint removed digit {d} from r{r + 1}c{c + 1}, which is "
                    f"the solution for that cell.  The hint was generated from an "
                    f"already-incorrect board state.",
                    [(r, c)],
                )

    return (
        "The board contains a move that conflicts with the solution.",
        [],
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

            img_config = ImagePipelineConfig(
                puzzle_dir=config.puzzle_dir,
                rework=True,
            )
            border_detector = InpImage.make_border_detector(img_config)
            num_recogniser = InpImage.make_num_recogniser(img_config)

            try:
                inp = InpImage(tmp_path, img_config, border_detector, num_recogniser)
            except AssertionError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

            warped_b64: str | None = _encode_image(_resize_for_display(inp.warped_img))

            if inp.spec_error is not None:
                try:
                    spec = _build_diagnostic_spec(
                        inp.info.cage_totals,
                        inp.info.border_x,
                        inp.info.border_y,
                    )
                except Exception as exc:
                    raise HTTPException(status_code=422, detail=str(exc)) from exc
                warning: str | None = inp.spec_error
            else:
                assert inp.spec is not None
                spec = inp.spec
                warning = None

            cages = _spec_to_cage_states(spec)
            spec_data = _spec_to_data(spec)
            original_b64 = _encode_image(_resize_for_display(inp.img))

            session_id = str(uuid.uuid4())
            state = PuzzleState(
                session_id=session_id,
                cages=cages,
                spec_data=spec_data,
                original_image_b64=original_b64,
                puzzle_type=inp.puzzle_type,
                given_digits=(
                    inp.given_digits.tolist() if inp.given_digits is not None else None
                ),
            )
            store.save(state)
            return UploadResponse(
                session_id=session_id,
                state=state,
                warning=warning,
                warped_image_b64=warped_b64,
            )

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
            given = (
                np.array(state.given_digits, dtype=np.intp)
                if state.given_digits is not None
                else None
            )
            grd.set_up(spec, given_digits=given)
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

        # For classic puzzles, pre-fill user_grid with given digits and record them
        # in history so _rebuild_user_grid can reconstruct them after undo.
        user_grid: list[list[int]] = [[0] * 9 for _ in range(9)]
        given_turns: list[Turn] = []
        if state.given_digits is not None:
            for r in range(9):
                for c in range(9):
                    d = state.given_digits[r][c]
                    if d > 0:
                        user_grid[r][c] = d
                        given_turns.append(
                            Turn(
                                user_action=UserAction(
                                    type="place_digit",
                                    row=r,
                                    col=c,
                                    digit=d,
                                    source="given",
                                ),
                                auto_mutations=[],
                            )
                        )

        updated = state.model_copy(
            update={
                "golden_solution": golden,
                "user_grid": user_grid,
                "history": given_turns,
            }
        )
        always_apply = frozenset(settings_store.load().always_apply_rules)
        _board, _engine = _build_engine(updated, always_apply)
        store.save(updated)
        return updated

    @router.get("/{session_id}/candidates", response_model=CandidatesResponse)
    async def get_candidates(session_id: str) -> CandidatesResponse:
        """Return current candidate state for all 81 cells plus cage info.

        Rebuilds board from Turn history via _build_engine and computes:
          - cells: per-cell solver candidates (including user_removed for
            strikethrough rendering) and the user_removed set.
          - cages: remaining solutions and must_contain per cage (for
            essential-digit highlighting).
          - virtual_cages: user-acknowledged derived sum constraints.
        Returns 404 if session unknown; 409 if not yet confirmed.
        """
        try:
            state = store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

        if state.user_grid is None:
            raise HTTPException(status_code=409, detail="Session not yet confirmed")

        always_apply = frozenset(settings_store.load().always_apply_rules)
        board, _engine = _build_engine(state, always_apply)

        removed_by_cell: dict[tuple[int, int], set[int]] = {}
        for r, c, d in _user_removed(state):
            removed_by_cell.setdefault((r, c), set()).add(d)

        # 9×9 per-cell info
        cells: list[list[CellInfo]] = []
        for r in range(9):
            row: list[CellInfo] = []
            for c in range(9):
                cage_idx = int(board.regions[r, c])
                remaining = board.cage_solns[cage_idx]
                cage_possible: set[int] = (
                    set().union(*remaining) if remaining else set()
                )
                removed_here = removed_by_cell.get((r, c), set())
                # Active candidates: engine's view filtered by remaining cage
                # solutions.  User-removed digits are unioned in afterwards so
                # they always appear for strikethrough rendering, even after
                # SolutionMapFilter prunes cage_solns (which would otherwise
                # silently drop the hint's promised strikethroughs).
                solver_cands = (board.candidates[r][c] & cage_possible) | removed_here
                row.append(
                    CellInfo(
                        candidates=sorted(solver_cands),
                        user_removed=sorted(removed_here),
                    )
                )
            cells.append(row)

        # Real cage info (must_contain drives essential-digit highlighting)
        n_real_cages = int(board.regions.max()) + 1
        cages: list[CageInfo] = []
        for cage_idx in range(n_real_cages):
            unit = board.units[27 + cage_idx]
            solns = board.cage_solns[cage_idx]
            must = sorted(set.intersection(*[set(s) for s in solns])) if solns else []
            total = 0
            for r, c in unit.cells:
                v = int(board.spec.cage_totals[r, c])
                if v:
                    total = v
                    break
            cages.append(
                CageInfo(
                    cage_idx=cage_idx,
                    cells=sorted(unit.cells),
                    total=total,
                    solutions=[sorted(s) for s in solns],
                    must_contain=must,
                )
            )

        # Virtual cage info — use _user_virtual_cages (same source as _build_engine)
        virtual_cages: list[VirtualCageInfo] = []
        for vc_idx, vc in enumerate(_user_virtual_cages(state)):
            vc_solns = board.cage_solns[n_real_cages + vc_idx]
            vc_must = (
                sorted(set.intersection(*[set(s) for s in vc_solns]))
                if vc_solns
                else []
            )
            virtual_cages.append(
                VirtualCageInfo(
                    key=vc.key,
                    cells=[(int(cell[0]), int(cell[1])) for cell in vc.cells],
                    total=vc.total,
                    solutions=[sorted(s) for s in vc_solns],
                    must_contain=vc_must,
                )
            )

        return CandidatesResponse(cells=cells, cages=cages, virtual_cages=virtual_cages)

    @router.patch("/{session_id}/cell", response_model=PuzzleState)
    async def enter_cell(
        session_id: str,
        req: CellEntryRequest,
    ) -> PuzzleState:
        """Place or clear a digit in the user's playing grid.

        Records every change as a Turn in history and a MoveRecord for
        backward compatibility.
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

        new_move_history = list(state.move_history) + [
            MoveRecord(
                row=req.row,
                col=req.col,
                digit=req.digit,
                prev_digit=prev_digit,
            )
        ]

        user_action = UserAction(
            type="place_digit" if req.digit != 0 else "remove_digit",
            row=r,
            col=c,
            digit=req.digit if req.digit != 0 else None,
            source="user:manual",
        )

        updated = state.model_copy(
            update={"user_grid": new_grid, "move_history": new_move_history}
        )
        always_apply = frozenset(settings_store.load().always_apply_rules)
        board, engine = _build_engine(updated, always_apply)
        updated = _apply_auto_placements(updated, engine)
        updated = _record_turn(updated, user_action, engine, board)
        store.save(updated)
        return updated

    @router.post("/{session_id}/undo", response_model=PuzzleState)
    async def undo_move(session_id: str) -> PuzzleState:
        """Reverse the most recent user action and all its auto-apply cascades.

        Pops the last Turn from history, rebuilds user_grid and move_history
        from the remaining Turns, then re-runs the solver to validate.
        Returns 409 if there is nothing to undo.
        """
        try:
            state = store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

        if not state.history:
            raise HTTPException(status_code=409, detail="Nothing to undo")

        if state.history[-1].user_action.source == "given":
            raise HTTPException(status_code=409, detail="Nothing to undo")

        trimmed = state.model_copy(update={"history": state.history[:-1]})
        updated = _rebuild_user_grid(trimmed)
        always_apply = frozenset(settings_store.load().always_apply_rules)
        _board, engine = _build_engine(updated, always_apply)
        updated = _apply_auto_placements(updated, engine)
        store.save(updated)
        return updated

    @router.post("/{session_id}/rewind", response_model=PuzzleState)
    async def rewind(session_id: str, req: RewindRequest) -> PuzzleState:
        """Rewind history to a specific turn index, discarding all later turns.

        Designed for use with the Rewind hint: history[:req.turn_idx] is kept,
        everything after is discarded (including cascaded auto-mutations), then
        user_grid is rebuilt from the trimmed history and the engine re-runs.

        Returns 409 if no session history exists.
        Returns 422 if turn_idx is out of range.
        """
        try:
            state = store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

        if state.user_grid is None:
            raise HTTPException(status_code=409, detail="Session not yet confirmed")

        if not (0 <= req.turn_idx <= len(state.history)):
            raise HTTPException(
                status_code=422,
                detail=f"turn_idx {req.turn_idx} out of range "
                f"[0, {len(state.history)}]",
            )

        trimmed = state.model_copy(update={"history": state.history[: req.turn_idx]})
        updated = _rebuild_user_grid(trimmed)
        always_apply = frozenset(settings_store.load().always_apply_rules)
        _board, engine = _build_engine(updated, always_apply)
        updated = _apply_auto_placements(updated, engine)
        store.save(updated)
        return updated

    @router.post("/{session_id}/virtual-cages", response_model=PuzzleState)
    async def add_virtual_cage_endpoint(
        session_id: str, req: AddVirtualCageRequest
    ) -> PuzzleState:
        """Add a user-derived sum constraint as a virtual cage.

        Records an add_virtual_cage Turn in history.  The virtual cage is
        picked up by _build_engine and _user_virtual_cages on all subsequent
        requests; GET /candidates includes it in virtual_cages.

        Returns 404 if session unknown, 409 if not confirmed or duplicate key,
        422 if cells are invalid or total is impossible for distinct digits.
        """
        try:
            state = store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

        if state.user_grid is None:
            raise HTTPException(status_code=409, detail="Session not yet confirmed")

        cells = [(int(r), int(c)) for r, c in req.cells]

        if len(cells) < 2:
            raise HTTPException(
                status_code=422, detail="Virtual cage requires at least 2 cells"
            )
        if len(set(cells)) != len(cells):
            raise HTTPException(
                status_code=422, detail="Duplicate cells in virtual cage"
            )
        for r, c in cells:
            if not (0 <= r <= 8 and 0 <= c <= 8):
                raise HTTPException(
                    status_code=422,
                    detail=f"Cell ({r},{c}) is out of range — must be 0–8",
                )

        n = len(cells)
        min_total = n * (n + 1) // 2  # 1+2+...+n
        max_total = n * (19 - n) // 2  # (10-n)+...+9
        if not (min_total <= req.total <= max_total):
            raise HTTPException(
                status_code=422,
                detail=f"Total {req.total} is impossible for {n} distinct digits "
                f"(valid range: {min_total}–{max_total})",
            )

        key = _virtual_cage_key(cells, req.total)
        existing_keys = {vc.key for vc in _user_virtual_cages(state)}
        if key in existing_keys:
            raise HTTPException(
                status_code=409,
                detail=f"Virtual cage already exists: {key!r}",
            )

        user_action = UserAction(
            type="add_virtual_cage",
            virtual_cage_key=key,
            virtual_cage_cells=cells,
            virtual_cage_total=req.total,
            source="user:manual",
        )
        always_apply = frozenset(settings_store.load().always_apply_rules)
        board, engine = _build_engine(state, always_apply)
        state = _apply_auto_placements(state, engine)
        updated = _record_turn(state, user_action, engine, board)
        store.save(updated)
        return updated

    @router.patch("/{session_id}/candidates/cell", response_model=PuzzleState)
    async def cycle_candidate(
        session_id: str,
        req: CandidateCycleRequest,
    ) -> PuzzleState:
        """Cycle one digit's state in a cell, or reset all overrides (digit=0).

        Records the change as a Turn in history. Cycle is a 2-state toggle:
        normal ↔ user_removed. digit=0 clears all user_removed for the cell.
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
        always_apply = frozenset(settings_store.load().always_apply_rules)
        board, engine = _build_engine(state, always_apply)
        state = _apply_auto_placements(state, engine)

        if req.digit == 0:
            user_action: UserAction = UserAction(
                type="reset_cell_candidates", row=r, col=c, source="user:manual"
            )
        else:
            cell_removed = {
                d for (rr, cc, d) in _user_removed(state) if rr == r and cc == c
            }
            if req.digit in cell_removed:
                user_action = UserAction(
                    type="restore_candidate",
                    row=r,
                    col=c,
                    digit=req.digit,
                    source="user:manual",
                )
            elif req.digit in board.candidates[r][c]:
                user_action = UserAction(
                    type="remove_candidate",
                    row=r,
                    col=c,
                    digit=req.digit,
                    source="user:manual",
                )
            else:
                # Auto-impossible and not user-removed: no-op
                return state

        updated = _record_turn(state, user_action, engine, board)
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
        auto_impossible: solutions absent from board.cage_solns after engine
            eliminations — consistent with GET /candidates.
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
        board, _engine = _build_engine(state, always_apply)

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
        Records the change in CageState.user_eliminated_solns (legacy path —
        not a Turn action) then validates board consistency via _build_engine.
        Returns the full updated PuzzleState.
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
        always_apply = frozenset(settings_store.load().always_apply_rules)
        _board, engine = _build_engine(updated, always_apply)
        updated = _apply_auto_placements(updated, engine)
        store.save(updated)
        return updated

    @router.get("/{session_id}/hints", response_model=HintsResponse)
    async def get_hints(session_id: str) -> HintsResponse:
        """Return all currently applicable hints, stratified by tier.

        Rebuilds the board from Turn history via _build_engine, which replays
        all user actions (placements, candidate removals, accepted hints) and
        runs always-apply rules. Hint-only rules buffer HintResults into
        engine.pending_hints instead of draining eliminations.

        Linear hints are stratified: T1 (cell placements) > T2 (delta/sum pairs)
        > T3 (virtual cage suggestions).  Only the smallest non-empty linear tier
        is returned, preventing T3 suggestions when T2 deductions remain.
        Non-linear hints (MustContainOutie, CageConfinement, etc.) are always
        returned alongside the chosen linear tier.

        Returns an empty list before /confirm or if no rules currently fire.
        """
        try:
            state = store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

        if state.user_grid is None:
            return HintsResponse(hints=[])

        # Inconsistency check: if any move conflicts with the golden solution,
        # suppress all normal hints and return only a Rewind hint.  This prevents
        # the coach from offering deductions derived from a corrupt board state.
        rewind_idx = _find_last_consistent_turn_idx(state)
        if rewind_idx is not None:
            explanation, highlight = _describe_first_error(state, rewind_idx)
            return HintsResponse(
                hints=[
                    HintItem(
                        rule_name="Rewind",
                        display_name="Rewind to last consistent state",
                        explanation=explanation,
                        highlight_cells=highlight,
                        eliminations=[],
                        elimination_count=0,
                        rewind_to_turn_idx=rewind_idx,
                    )
                ]
            )

        always_apply = frozenset(settings_store.load().always_apply_rules)
        _board, engine = _build_engine(state, always_apply)

        raw_hints = [
            h
            for h in engine.pending_hints
            if h.placement is None
            or state.user_grid[h.placement[0]][h.placement[1]] == 0
        ]

        # Stratify linear hints: T1 > T2 > T3.
        # T1: LinearElimination placement hints
        # T2: DeltaConstraint or SumPairConstraint elimination hints
        # T3: LinearElimination virtual cage suggestion hints
        linear_rule_names = frozenset(
            {"LinearElimination", "DeltaConstraint", "SumPairConstraint"}
        )
        t1 = [
            h
            for h in raw_hints
            if h.rule_name == "LinearElimination" and h.placement is not None
        ]
        t2 = [
            h
            for h in raw_hints
            if h.rule_name in {"DeltaConstraint", "SumPairConstraint"}
        ]
        t3 = [
            h
            for h in raw_hints
            if h.rule_name == "LinearElimination"
            and h.virtual_cage_suggestion is not None
        ]
        non_linear = [h for h in raw_hints if h.rule_name not in linear_rule_names]

        if t1:
            linear_hints = t1
        elif t2:
            linear_hints = t2
        elif t3:
            linear_hints = t3
        else:
            linear_hints = []

        selected = sorted(
            non_linear + linear_hints,
            key=lambda h: h.elimination_count,
            reverse=True,
        )

        def _map_hint(h: HintResult) -> HintItem:
            vc_sug = None
            if h.virtual_cage_suggestion is not None:
                vcells, vtotal = h.virtual_cage_suggestion
                vc_sug = VirtualCageSuggestion(
                    cells=sorted(vcells),
                    total=vtotal,
                )
            return HintItem(
                rule_name=h.rule_name,
                display_name=h.display_name,
                explanation=h.explanation,
                highlight_cells=sorted(h.highlight_cells),
                eliminations=[
                    EliminationItem(cell=e.cell, digit=e.digit) for e in h.eliminations
                ],
                elimination_count=h.elimination_count,
                placement=h.placement,
                virtual_cage_suggestion=vc_sug,
            )

        return HintsResponse(hints=[_map_hint(h) for h in selected])

    @router.post("/{session_id}/hints/apply", response_model=PuzzleState)
    async def apply_hint(session_id: str, req: ApplyHintRequest) -> PuzzleState:
        """Apply a hint's eliminations by marking each digit as user_removed.

        Records the player's acceptance of the deduction as an apply_hint Turn
        in history, so subsequent rebuilds replay the eliminations.
        """
        try:
            state = store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

        if state.user_grid is None:
            raise HTTPException(
                status_code=400, detail="No candidate grid — confirm puzzle first"
            )

        always_apply = frozenset(settings_store.load().always_apply_rules)
        board, engine = _build_engine(state, always_apply)
        state = _apply_auto_placements(state, engine)

        hint_elims = [(e.cell[0], e.cell[1], e.digit) for e in req.eliminations]
        user_action = UserAction(
            type="apply_hint",
            hint_eliminations=hint_elims,
            source="user:hint",
        )
        updated = _record_turn(state, user_action, engine, board)
        store.save(updated)
        return updated

    @router.post("/{session_id}/refresh", response_model=PuzzleState)
    async def refresh(session_id: str) -> PuzzleState:
        """Re-validate the board with current always-apply settings; return state.

        Called by the frontend after saving settings. Validates the board is
        consistent with the new settings; raises 422 if contradictory.
        """
        try:
            state = store.load(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Session not found") from exc

        if state.user_grid is None:
            raise HTTPException(status_code=409, detail="Session not yet confirmed")

        always_apply = frozenset(settings_store.load().always_apply_rules)
        _board, engine = _build_engine(state, always_apply)
        state = _apply_auto_placements(state, engine)
        store.save(state)
        return state

    return router
