"""Pydantic models for the COACH API request/response contracts.

All API endpoints use these models exclusively — no raw dicts or Any types.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

# Cold-start default: only the basic cage candidate constraint is always-apply.
# Further rules (SolvedCellElimination, CageIntersection, etc.) are enabled
# progressively as their hints are designed and tested.
DEFAULT_ALWAYS_APPLY_RULES: list[str] = [
    "CageCandidateFilter",
]


class CellPosition(BaseModel):
    """A grid cell position, 1-based (row 1–9, col 1–9)."""

    row: int
    col: int


class SubCageState(BaseModel):
    """A sub-cage produced by manually subdividing a larger cage.

    When a user splits cage "A" into two parts, the parts become "A1" and "A2".
    The total of the last sub-cage may be None, meaning the system should
    auto-compute it from the golden solution once solving is complete.
    """

    label: str
    total: int | None = None
    cells: list[CellPosition]


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


class MoveRecord(BaseModel):
    """One step in the user's play history.

    Stores both the new digit and the previous digit so any move can be
    reversed without needing to replay the full history.
    """

    row: int  # 1-based (1–9)
    col: int  # 1-based (1–9)
    digit: int  # digit placed (1–9); 0 = cell was cleared
    prev_digit: int  # digit that was there before (0 = was empty)


class CellEntryRequest(BaseModel):
    """Request to place or clear a digit in the user's grid."""

    row: int  # 1-based (1–9)
    col: int  # 1-based (1–9)
    digit: int  # 1–9 to place; 0 to clear


class PuzzleSpecData(BaseModel):
    """Serialized form of PuzzleSpec numpy arrays for JSON session storage.

    Stores the four arrays from PuzzleSpec as nested Python lists so they
    can be round-tripped through JSON without losing the border geometry
    needed for re-rendering the overlay after cage edits.

    Attributes:
        regions:     (9×9) 1-based cage index per cell; 0 = unassigned.
        cage_totals: (9×9) declared cage sum at each cage's head cell, 0 elsewhere.
        border_x:    (9×8) horizontal cage-wall flags.
        border_y:    (8×9) vertical cage-wall flags.
    """

    regions: list[list[int]]
    cage_totals: list[list[int]]
    border_x: list[list[bool]]
    border_y: list[list[bool]]


class PuzzleState(BaseModel):
    """Complete mutable state of a puzzle coaching session.

    Attributes:
        session_id:          UUID identifying this session.
        newspaper:           Source newspaper (determines which OCR models to use).
        cages:               Current cage layout, editable by the user.
        spec_data:           Serialized PuzzleSpec arrays (for canvas rendering).
        original_image_b64:  Base64-encoded JPEG of the uploaded photo.
        golden_solution:     None before /confirm; 9×9 solver solution after.
        user_grid:           None before /confirm; 9×9 user-entered digits after.
        move_history:        Chronological record of every cell entry or clear.
        candidate_grid:      None before /confirm; CandidateGrid after.
    """

    session_id: str
    newspaper: Literal["guardian", "observer"]
    cages: list[CageState]
    spec_data: PuzzleSpecData
    original_image_b64: str

    golden_solution: list[list[int]] | None = None
    # None  → pre-confirm (OCR review phase)
    # 9×9   → computed by /confirm; 0 means solver could not determine cell

    user_grid: list[list[int]] | None = None
    # None  → pre-confirm
    # 9×9   → playing mode; 0 = cell not yet filled by user

    move_history: list[MoveRecord] = []
    # Ordered record of every digit entry or clear, newest last.

    candidate_grid: CandidateGrid | None = None
    # None → pre-confirm. Set at /confirm; updated after /cell, /undo,
    # and /candidates/cell.


class UploadResponse(BaseModel):
    """Response to a successful puzzle image upload."""

    session_id: str
    state: PuzzleState


class CagePatchRequest(BaseModel):
    """Request to correct a cage's OCR-detected total."""

    total: int


class SubdivideRequest(BaseModel):
    """Request to split a cage into multiple user-defined sub-cages."""

    sub_cages: list[SubCageState]


class SolveResponse(BaseModel):
    """Response from the solve endpoint.

    Attributes:
        solved: True if all 81 cells were assigned a unique digit.
        grid:   9×9 solution grid; 0 means the cell could not be determined.
        error:  Non-None only when the solver raised an exception.
    """

    solved: bool
    grid: list[list[int]]
    error: str | None = None


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
    """Full 9×9 grid of per-cell candidate state."""

    cells: list[list[CandidateCell]]  # 9 rows × 9 cols, 0-based


class CandidateCycleRequest(BaseModel):
    """Cycle one digit in one cell, or reset the whole cell (digit=0).

    row and col are 1-based (1–9). digit is 1–9 to cycle, or 0 to reset.
    """

    row: int
    col: int
    digit: int


class CoachSettings(BaseModel):
    """Persistent user preferences for the coaching app.

    always_apply_rules: names of solver rules applied automatically on every
        state change.  Rules not in this list are hint-only — they appear in
        the hints dropdown when they fire but are never applied automatically.
        Defaults to a conservative set covering core cage-sum constraints
        and naked singles without revealing advanced deductions.
    """

    always_apply_rules: list[str] = DEFAULT_ALWAYS_APPLY_RULES


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


class EliminationItem(BaseModel):
    """A single candidate elimination: remove digit from cell."""

    cell: tuple[int, int]  # (row, col), 0-based
    digit: int


class HintItem(BaseModel):
    """One applicable solver rule, with context for the coaching UI.

    Attributes:
        rule_name:       Internal identifier (e.g. "MustContainOutie").
        display_name:    Short label shown in the hints dropdown.
        explanation:     Plain-English explanation of why the rule fires.
        highlight_cells: Cells to highlight on the canvas, 0-based (row, col).
        eliminations:    Candidate removals the rule would make.
        elimination_count: Convenience copy of len(eliminations).
    """

    rule_name: str
    display_name: str
    explanation: str
    highlight_cells: list[tuple[int, int]]
    eliminations: list[EliminationItem]
    elimination_count: int


class HintsResponse(BaseModel):
    """All applicable hints for the current board state, ordered by impact."""

    hints: list[HintItem]
