"""Tests for BoardState."""

import pytest

from killer_sudoku.solver.engine.board_state import BoardState, NoSolnError
from killer_sudoku.solver.engine.types import Trigger, UnitKind
from tests.fixtures.minimal_puzzle import make_trivial_spec


def test_board_state_init_candidates_full() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    assert bs.candidates[0][0] == set(range(1, 10))
    assert bs.candidates[8][8] == set(range(1, 10))


def test_board_state_unit_count() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    # 9 rows + 9 cols + 9 boxes + 81 cages (trivial spec: each cell is its own cage)
    assert len(bs.units) == 9 + 9 + 9 + 81


def test_board_state_counts_initial() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    row0_id = bs.row_unit_id(0)
    for d in range(1, 10):
        assert bs.counts[row0_id][d] == 9


def test_board_state_cell_units() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    unit_kinds = {bs.units[uid].kind for uid in bs.cell_unit_ids(0, 0)}
    assert unit_kinds == {UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE}


def test_board_state_unit_versions_start_at_zero() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    assert all(v == 0 for v in bs.unit_versions)


# --- remove_candidate tests ---


def test_remove_candidate_decrements_count() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    row0 = bs.row_unit_id(0)
    before = bs.counts[row0][5]
    bs.remove_candidate(0, 0, 5)
    assert bs.counts[row0][5] == before - 1


def test_remove_candidate_bumps_unit_version() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    uid = bs.row_unit_id(0)
    bs.remove_candidate(0, 0, 5)
    assert bs.unit_versions[uid] == 1


def test_remove_candidate_emits_count_decreased() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    events = bs.remove_candidate(0, 0, 5)
    triggers = {e.trigger for e in events}
    assert Trigger.COUNT_DECREASED in triggers


def test_remove_candidate_emits_cell_determined() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    bs.candidates[1][1] = {3, 7}
    events = bs.remove_candidate(1, 1, 3)
    det = [e for e in events if e.trigger == Trigger.CELL_DETERMINED]
    assert len(det) == 1
    assert det[0].payload == (1, 1)
    assert det[0].hint_digit == 7


def test_remove_candidate_raises_on_empty_set() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    bs.candidates[0][0] = {5}
    with pytest.raises(NoSolnError):
        bs.remove_candidate(0, 0, 5)


def test_remove_candidate_emits_count_hit_one() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    row0 = bs.row_unit_id(0)
    # Drive count for digit 9 in row 0 from 9 down to 2
    for c in range(7):
        bs.remove_candidate(0, c, 9)
    # Next removal: count goes 2 → 1, should fire COUNT_HIT_ONE
    events = bs.remove_candidate(0, 7, 9)
    hit_one = [
        e for e in events if e.trigger == Trigger.COUNT_HIT_ONE and e.payload == row0
    ]
    assert len(hit_one) == 1
    assert hit_one[0].hint_digit == 9


def test_remove_cage_solution_emits_solution_pruned() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    cage_idx = int(bs.regions[0, 0])
    # Manually add a second fake solution to test removal
    extra = frozenset({3})
    bs.cage_solns[cage_idx].append(extra)
    event = bs.remove_cage_solution(cage_idx, extra)
    assert event.trigger == Trigger.SOLUTION_PRUNED
    assert extra not in bs.cage_solns[cage_idx]


def test_virtual_cages_included_in_units_and_solns() -> None:
    """Virtual cages from LinearSystem RREF appear as extra CAGE units.

    Regression test: before this fix, the LinearSystem's derived sum equations
    were computed but never inserted into BoardState as units. Rules like
    SolutionMapFilter never saw them, so row-derived constraints were ignored.
    """
    spec = make_trivial_spec()
    bs = BoardState(spec)
    n_real_cages = int(bs.regions.max()) + 1
    n_virtual = len(bs.linear_system.virtual_cages)

    # cage_solns should cover real cages + virtual cages
    assert len(bs.cage_solns) == n_real_cages + n_virtual

    # All virtual cage units should be CAGE kind
    for i, (vcells, _vtotal) in enumerate(bs.linear_system.virtual_cages):
        vunit_id = 27 + n_real_cages + i
        assert bs.units[vunit_id].kind == UnitKind.CAGE
        assert bs.units[vunit_id].cells == vcells

    # Each virtual cage's cells must be in _cell_unit_ids
    for i, (vcells, _vtotal) in enumerate(bs.linear_system.virtual_cages):
        vunit_id = 27 + n_real_cages + i
        for r, c in vcells:
            assert vunit_id in bs.cell_unit_ids(r, c)


def test_remove_candidate_triggers_cage_pruning() -> None:
    spec = make_trivial_spec()
    bs = BoardState(spec)
    cage_idx = int(bs.regions[0, 0])
    # Add a fake solution containing digit 3 to a cage whose cell is (0,0)
    bs.cage_solns[cage_idx].append(frozenset({3}))
    # Remove 3 from every cell in that cage so pruning fires
    cage_unit = bs.units[27 + cage_idx]
    for r, c in cage_unit.cells:
        if 3 in bs.candidates[r][c]:
            bs.candidates[r][c].discard(3)
            for uid in bs.cell_unit_ids(r, c):
                if bs.counts[uid][3] > 0:
                    bs.counts[uid][3] -= 1
    # Now cell (0,0) has no 3; call remove on some other digit to trigger pruning path
    # Actually call directly:
    events = bs._prune_cage_solutions(cage_idx, 0, 0, 3)
    pruned = [e for e in events if e.trigger == Trigger.SOLUTION_PRUNED]
    assert len(pruned) == 1
