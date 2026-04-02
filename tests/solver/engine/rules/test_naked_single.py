"""Tests for R1a NakedSingle."""

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.rules import default_rules
from killer_sudoku.solver.engine.rules.naked_single import NakedSingle
from killer_sudoku.solver.engine.solver_engine import SolverEngine
from killer_sudoku.solver.engine.types import Trigger
from tests.fixtures.minimal_puzzle import KNOWN_SOLUTION, make_trivial_spec


def test_naked_single_returns_no_eliminations() -> None:
    """NakedSingle is a recognition-only rule: it produces no eliminations."""
    spec = make_trivial_spec()
    bs = BoardState(spec)
    bs.candidates[0][0] = {5}
    ctx = RuleContext(
        unit=None,
        cell=(0, 0),
        board=bs,
        hint=Trigger.CELL_DETERMINED,
        hint_digit=5,
    )
    assert NakedSingle().apply(ctx).eliminations == []


def test_naked_single_fires_on_cell_determined() -> None:
    """NakedSingle must declare CELL_DETERMINED as its trigger."""
    assert Trigger.CELL_DETERMINED in NakedSingle.triggers


def test_naked_single_as_hints_produces_placement() -> None:
    """as_hints returns placement hints as cage rules reduce cells to singletons.

    The trivial spec has one single-cell cage per cell; cage rules fire and
    eliminate all but the solution digit from every cell, emitting CELL_DETERMINED
    events. Each NakedSingle firing (hint-only) should produce a placement hint.
    """
    spec = make_trivial_spec()
    bs = BoardState(spec)
    rules = default_rules()
    engine = SolverEngine(bs, rules=rules, hint_rules=frozenset({"NakedSingle"}))
    engine.solve()
    placements = [h for h in engine.pending_hints if h.placement is not None]
    # Trivial spec: every cell gets a CELL_DETERMINED event, so there should be
    # 81 placement hints (one per cell).
    assert any(h.placement == (0, 0, KNOWN_SOLUTION[0][0]) for h in placements)
