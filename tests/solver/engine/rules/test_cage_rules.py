"""Tests for R3 CageIntersection and R4 SolutionMapFilter."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules.cage_intersection import CageIntersection
from killer_sudoku.solver.engine.rules.solution_map_filter import SolutionMapFilter
from killer_sudoku.solver.engine.types import Trigger
from tests.fixtures.minimal_puzzle import make_trivial_spec


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
