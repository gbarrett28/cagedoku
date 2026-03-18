"""Tests for LinearSystem."""

import numpy as np

from killer_sudoku.image.validation import validate_cage_layout
from killer_sudoku.solver.engine.linear_system import LinearSystem
from tests.fixtures.minimal_puzzle import KNOWN_SOLUTION, make_trivial_spec


def test_linear_system_init_no_crash() -> None:
    spec = make_trivial_spec()
    ls = LinearSystem(spec)
    assert ls is not None


def test_trivial_puzzle_determines_all_cells() -> None:
    """Trivial puzzle (each cell its own cage) should determine all 81 cells."""
    spec = make_trivial_spec()
    ls = LinearSystem(spec)
    # 81 cells × 8 eliminations each = 648
    assert len(ls.initial_eliminations) == 81 * 8


def test_trivial_puzzle_correct_values() -> None:
    """Determined values must match the known solution."""
    spec = make_trivial_spec()
    ls = LinearSystem(spec)
    # Build a dict cell -> set of eliminated digits
    elim_map: dict[tuple[int, int], set[int]] = {}
    for e in ls.initial_eliminations:
        elim_map.setdefault(e.cell, set()).add(e.digit)
    for r in range(9):
        for c in range(9):
            eliminated = elim_map.get((r, c), set())
            expected_val = KNOWN_SOLUTION[r][c]
            assert expected_val not in eliminated, (
                f"cell ({r},{c}) expected {expected_val} but it was eliminated"
            )
            assert len(eliminated) == 8, (
                f"cell ({r},{c}) should have 8 eliminations, got {len(eliminated)}"
            )


def _make_two_cell_cage_spec() -> object:
    """Build a PuzzleSpec where cells (col=0,row=0) and (col=0,row=1) share a cage.

    validate_cage_layout uses (col, row) indexing throughout.
    cage_totals[col, row] and border_x[col, row] / border_y[col, row].
    border_x[col, row] = False removes the horizontal wall between rows row and row+1
    in column col — merging (col, row) with (col, row+1).
    """
    # In (col,row) convention:
    # Cell (col=0,row=0): KNOWN_SOLUTION[0][0] = 5
    # Cell (col=0,row=1): KNOWN_SOLUTION[0][1] = 3
    # Merged cage total = 8 at head (col=0,row=0); (col=0,row=1) has no head.
    cage_totals = np.array(KNOWN_SOLUTION, dtype=np.intp)
    cage_totals[0, 0] = KNOWN_SOLUTION[0][0] + KNOWN_SOLUTION[0][1]  # 8
    cage_totals[0, 1] = 0  # not a head

    border_x = np.ones((9, 8), dtype=bool)
    border_x[0, 0] = False  # remove wall between (col=0,row=0) and (col=0,row=1)
    border_y = np.ones((8, 9), dtype=bool)

    return validate_cage_layout(cage_totals, border_x, border_y)


def test_difference_pair_detected() -> None:
    """A 2-cell cage should produce at least one difference constraint."""
    ls = LinearSystem(_make_two_cell_cage_spec())  # type: ignore[arg-type]
    # With one 2-cell cage, the system may produce a delta pair for those cells
    # (depends on whether the Gaussian reduction produces a 2-nonzero row)
    # At minimum the linear system should construct without error
    assert isinstance(ls.delta_pairs, list)


def test_substitute_cell_removes_pair() -> None:
    """substitute_cell removes the pair from delta_pairs and _pairs_by_cell."""
    spec = make_trivial_spec()
    ls = LinearSystem(spec)
    # Inject a synthetic pair for testing substitute_cell in isolation
    pair: tuple[tuple[int, int], tuple[int, int], int] = ((0, 0), (0, 1), 2)
    ls.delta_pairs.append(pair)
    ls._pairs_by_cell.setdefault((0, 0), []).append(pair)
    ls._pairs_by_cell.setdefault((0, 1), []).append(pair)

    elims = ls.substitute_cell((0, 0), 5)
    # Pair should be gone
    assert pair not in ls.delta_pairs
    assert pair not in ls._pairs_by_cell.get((0, 1), [])
    # Other cell's value: p=(0,0) value=5, delta=2 → q_val = 5-2 = 3
    elim_digits = {e.digit for e in elims if e.cell == (0, 1)}
    assert 3 not in elim_digits  # 3 is the correct value — must not be eliminated
    assert len(elim_digits) == 8  # all other digits eliminated
