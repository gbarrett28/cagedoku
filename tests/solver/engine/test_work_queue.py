"""Tests for SolverQueue and WorkItem."""

from killer_sudoku.solver.engine.types import Trigger, UnitKind
from killer_sudoku.solver.engine.work_queue import SolverQueue, WorkItem


class _FakeRule:
    name = "fake"
    priority = 5
    triggers: frozenset[Trigger] = frozenset({Trigger.COUNT_DECREASED})
    unit_kinds: frozenset[UnitKind] = frozenset()

    def apply(self, ctx: object) -> list[object]:  # type: ignore[override]
        return []


def test_queue_dedup_unit_scoped_keeps_lower_priority() -> None:
    q = SolverQueue()
    rule = _FakeRule()
    q.enqueue_unit(
        3,
        rule,
        unit_id=5,
        unit_version=1,
        trigger=Trigger.COUNT_DECREASED,
        hint_digit=4,
    )
    q.enqueue_unit(
        1,
        rule,
        unit_id=5,
        unit_version=2,
        trigger=Trigger.COUNT_DECREASED,
        hint_digit=7,
    )
    item = q.pop()
    assert item.priority == 1
    assert q.empty()


def test_queue_dedup_cell_scoped_ignores_second() -> None:
    q = SolverQueue()
    rule = _FakeRule()
    q.enqueue_cell(0, rule, cell=(1, 2), trigger=Trigger.CELL_DETERMINED, hint_digit=5)
    q.enqueue_cell(0, rule, cell=(1, 2), trigger=Trigger.CELL_DETERMINED, hint_digit=5)
    q.pop()
    assert q.empty()


def test_queue_priority_ordering() -> None:
    q = SolverQueue()
    rule = _FakeRule()
    q.enqueue_unit(
        5,
        rule,
        unit_id=1,
        unit_version=0,
        trigger=Trigger.COUNT_DECREASED,
        hint_digit=1,
    )
    rule2 = _FakeRule()
    rule2.name = "fake2"
    q.enqueue_unit(
        2,
        rule2,
        unit_id=2,
        unit_version=0,
        trigger=Trigger.COUNT_DECREASED,
        hint_digit=2,
    )
    item = q.pop()
    assert item.priority == 2


def test_version_unchanged_detects_stale() -> None:
    rule = _FakeRule()
    item = WorkItem(
        priority=3,
        rule=rule,
        unit_id=4,
        unit_version=1,
        cell=None,
        trigger=Trigger.COUNT_DECREASED,
        hint_digit=3,
    )
    unit_versions = [0] * 10
    unit_versions[4] = 1  # unchanged since enqueue
    assert item.is_stale(unit_versions)
    unit_versions[4] = 2  # changed since enqueue
    assert not item.is_stale(unit_versions)


def test_cell_determined_item_never_stale() -> None:
    rule = _FakeRule()
    item = WorkItem(
        priority=0,
        rule=rule,
        unit_id=None,
        unit_version=None,
        cell=(2, 3),
        trigger=Trigger.CELL_DETERMINED,
        hint_digit=5,
    )
    assert not item.is_stale([0] * 10)


def test_global_item_never_stale() -> None:
    rule = _FakeRule()
    item = WorkItem(
        priority=11,
        rule=rule,
        unit_id=None,
        unit_version=None,
        cell=None,
        trigger=Trigger.GLOBAL,
        hint_digit=None,
    )
    assert not item.is_stale([0] * 10)


def test_enqueue_global_dedup() -> None:
    q = SolverQueue()
    rule = _FakeRule()
    q.enqueue_global(11, rule)
    q.enqueue_global(11, rule)
    q.pop()
    assert q.empty()
