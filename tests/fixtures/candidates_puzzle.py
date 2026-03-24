"""Fixture puzzle for Playwright e2e candidate view tests.

Uses the trivial single-cell-cage spec (make_trivial_spec) as a simple,
valid puzzle that the server can confirm and display. A more complex fixture
with genuinely ambiguous cages can be added later if visual essential-digit
testing is needed.
"""

from killer_sudoku.solver.puzzle_spec import PuzzleSpec
from tests.fixtures.minimal_puzzle import make_trivial_spec


def make_candidates_spec() -> PuzzleSpec:
    """Return a valid PuzzleSpec suitable for Playwright candidate view tests."""
    return make_trivial_spec()
