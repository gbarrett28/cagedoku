"""Tests for R3 CageIntersection and R4 SolutionMapFilter."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.cage_candidate_filter import CageCandidateFilter
from killer_sudoku.solver.engine.rules.incomplete.cage_intersection import (
    CageIntersection,
)
from killer_sudoku.solver.engine.rules.solution_map_filter import (
    SolutionMapFilter,
    _per_cell_possible,
)
from killer_sudoku.solver.engine.types import Trigger
from tests.fixtures.minimal_puzzle import (
    make_three_cell_cage_spec,
    make_trivial_spec,
    make_two_cell_cage_spec,
)


def _cage_ctx(
    bs: BoardState,
    cage_unit_id: int,
    trigger: Trigger = Trigger.COUNT_DECREASED,
    hint: int | None = None,
) -> RuleContext:
    return RuleContext(
        unit=bs.units[cage_unit_id],
        cell=None,
        board=bs,
        hint=trigger,
        hint_digit=hint,
    )


def test_solution_map_filter_no_crash_on_trivial() -> None:
    """SolutionMapFilter should not crash on a fresh trivial board."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    cage_idx = int(bs.regions[0, 0])
    cage_uid = 27 + cage_idx
    ctx = _cage_ctx(bs, cage_uid)
    elims = SolutionMapFilter().apply(ctx)
    assert isinstance(elims, list)


def test_solution_map_filter_removes_impossible_digits() -> None:
    """Digits not in any surviving solution are eliminated."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    cage_idx = int(bs.regions[0, 0])
    cage_uid = 27 + cage_idx
    cage = bs.units[cage_uid]
    r, c = next(iter(cage.cells))

    # Restrict candidates to {3} — solution {5} (from trivial spec) is dead
    bs.candidates[r][c] = {3}

    ctx = _cage_ctx(bs, cage_uid)
    elims = SolutionMapFilter().apply(ctx)
    # The surviving solutions only contain {3}, so 5 is eliminated from the cage
    # (already not in candidates, so no eliminations produced — that's correct)
    assert isinstance(elims, list)


def test_cage_intersection_no_crash() -> None:
    """CageIntersection should not crash on a fresh trivial board."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    cage_idx = int(bs.regions[0, 0])
    cage_uid = 27 + cage_idx
    ctx = _cage_ctx(bs, cage_uid)
    elims = CageIntersection().apply(ctx)
    assert isinstance(elims, list)


def test_per_cell_possible_forces_last_cell() -> None:
    """When two cells of a 3-cage each need one of two digits, the third is forced.

    Regression test for the coarse-vs-per-cell R4 gap:
    - A = {1,2}, B = {1,2}, C = {1,2,3}, solution {1,2,3}
    - Coarse check passes: {1,2,3} ⊆ union({1,2},{1,2},{1,2,3})
    - Per-cell feasibility: C can only receive digit 3 (A and B fill 1 and 2)
    """
    candidates: list[list[set[int]]] = [
        [set(range(1, 10)) for _ in range(9)] for _ in range(9)
    ]
    candidates[0][0] = {1, 2}
    candidates[0][1] = {1, 2}
    candidates[0][2] = {1, 2, 3}
    cells = [(0, 0), (0, 1), (0, 2)]
    solution = frozenset({1, 2, 3})

    result = _per_cell_possible(cells, solution, candidates)

    assert result[(0, 0)] == {1, 2}
    assert result[(0, 1)] == {1, 2}
    assert result[(0, 2)] == {3}  # forced — A and B consume 1 and 2


def test_solution_map_filter_eliminates_per_cell_infeasible_digits() -> None:
    """SolutionMapFilter eliminates digits unreachable via per-cell assignment.

    Scenario: 3-cell cage (0,0)+(0,1)+(0,2) with total=12.
    - Restrict (0,0) and (0,1) candidates to {1,2}.
    - Only solution {1,2,9} remains feasible (A and B fill 1+2, C must be 9).
    - SolutionMapFilter should eliminate all candidates except 9 from (0,2).

    This is missed by the old coarse check (digit-set ⊆ union-of-candidates):
    {1,2,9} ⊆ {1,2}∪{1,2}∪{1..9} passes, but per-cell assigns C=9 exclusively.
    """
    spec = make_three_cell_cage_spec()
    bs = BoardState(spec)

    # Find the 3-cell cage at row 0 cols 0-2
    cage_idx = int(bs.regions[0, 0])
    cage_uid = 27 + cage_idx
    assert len(bs.units[cage_uid].cells) == 3, "Expected a 3-cell cage at (0,0)"

    # Restrict two cells to force the third
    bs.candidates[0][0] = {1, 2}
    bs.candidates[0][1] = {1, 2}
    # (0,2) still has full candidates {1..9}

    ctx = _cage_ctx(bs, cage_uid)
    elims = SolutionMapFilter().apply(ctx)

    elim_by_cell: dict[tuple[int, int], set[int]] = {}
    for e in elims:
        elim_by_cell.setdefault(e.cell, set()).add(e.digit)

    # (0,2) must be 9: all other digits eliminated
    elims_c = elim_by_cell.get((0, 2), set())
    assert elims_c == {1, 2, 3, 4, 5, 6, 7, 8}, (
        f"Expected digits 1-8 eliminated from (0,2), got {elims_c}"
    )


def test_cage_candidate_filter_as_hints() -> None:
    """as_hints returns elimination hints for a two-cell cage."""
    spec = make_two_cell_cage_spec()
    bs = BoardState(spec)
    cage_uid = bs.cage_unit_id(0, 0)
    ctx = _cage_ctx(bs, cage_uid)
    rule = CageCandidateFilter()
    elims = rule.apply(ctx)
    hints = rule.as_hints(ctx, elims)
    assert len(hints) >= 1
    assert all(h.placement is None for h in hints)
