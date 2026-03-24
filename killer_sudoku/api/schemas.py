"""Pydantic models for the COACH API request/response contracts.

All API endpoints use these models exclusively — no raw dicts or Any types.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


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
    """

    label: str
    total: int
    cells: list[CellPosition]
    subdivisions: list[SubCageState] = []


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
        spec_data:          Serialized PuzzleSpec arrays (for canvas rendering).
        original_image_b64: Base64-encoded JPEG of the uploaded photo.
    """

    session_id: str
    newspaper: Literal["guardian", "observer"]
    cages: list[CageState]
    spec_data: PuzzleSpecData
    original_image_b64: str


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
