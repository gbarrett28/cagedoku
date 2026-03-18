"""Tests for core engine value types."""

from killer_sudoku.solver.engine.types import (
    BoardEvent,
    Cell,
    Elimination,
    Trigger,
    Unit,
    UnitKind,
)


def test_trigger_ordering() -> None:
    assert Trigger.CELL_DETERMINED.value == 0
    assert Trigger.GLOBAL.value == 5


def test_elimination_is_value_object() -> None:
    e1 = Elimination(cell=(2, 3), digit=7)
    e2 = Elimination(cell=(2, 3), digit=7)
    assert e1 == e2


def test_board_event_cell_determined() -> None:
    ev = BoardEvent(trigger=Trigger.CELL_DETERMINED, payload=(1, 2), hint_digit=5)
    assert ev.trigger == Trigger.CELL_DETERMINED
    assert ev.payload == (1, 2)
    assert ev.hint_digit == 5


def test_unit_cells() -> None:
    cells: frozenset[Cell] = frozenset({(0, 0), (0, 1)})
    u = Unit(unit_id=0, kind=UnitKind.ROW, cells=cells)
    assert u.cells == cells
    assert u.kind == UnitKind.ROW
