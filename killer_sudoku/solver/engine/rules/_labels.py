"""Shared label-formatting helpers for coaching rule hint explanations.

Centralises the four formatting functions that were previously duplicated
in must_contain_outie, cage_confinement, naked_pair, and hidden_single.
"""

from __future__ import annotations

from killer_sudoku.solver.engine.types import Cell, Unit, UnitKind


def unit_label(unit: Unit) -> str:
    """Human-readable label for a unit: 'row 1', 'column 5', 'box 3', 'this cage'."""
    if unit.kind == UnitKind.ROW:
        return f"row {unit.unit_id + 1}"
    if unit.kind == UnitKind.COL:
        return f"column {unit.unit_id - 9 + 1}"
    if unit.kind == UnitKind.BOX:
        return f"box {unit.unit_id - 18 + 1}"
    return "this cage"


def cell_label(cell: Cell) -> str:
    """rNcM notation (1-based) for a cell: e.g. (2, 4) → 'r3c5'."""
    r, c = cell
    return f"r{r + 1}c{c + 1}"


def unit_type_label(kind: UnitKind) -> str:
    """Plural noun for a unit type: 'rows', 'columns', or 'boxes'."""
    if kind == UnitKind.ROW:
        return "rows"
    if kind == UnitKind.COL:
        return "columns"
    return "boxes"


def type_unit_id(kind: UnitKind, r: int, c: int) -> int:
    """Board unit_id of the same-type unit containing cell (r, c).

    ROW  → unit_ids 0–8
    COL  → unit_ids 9–17
    BOX  → unit_ids 18–26
    """
    if kind == UnitKind.ROW:
        return r
    if kind == UnitKind.COL:
        return 9 + c
    return 18 + (r // 3) * 3 + (c // 3)
