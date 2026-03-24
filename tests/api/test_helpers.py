"""Tests for the pure conversion helpers in killer_sudoku.api.routers.puzzle.

These helpers have no I/O and can be tested without a running server or model files.
"""

from __future__ import annotations

import numpy as np
import pytest

from killer_sudoku.api.routers.puzzle import (
    _cage_label,
    _cage_states_to_spec,
    _data_to_spec,
    _spec_to_cage_states,
    _spec_to_data,
)
from tests.fixtures.minimal_puzzle import (
    KNOWN_SOLUTION,
    make_three_cell_cage_spec,
    make_trivial_spec,
)


class TestCageLabel:
    """_cage_label(i) generates Excel-column-style labels for cage indices."""

    def test_first_label_is_a(self) -> None:
        assert _cage_label(0) == "A"

    def test_last_single_letter_is_z(self) -> None:
        assert _cage_label(25) == "Z"

    def test_first_overflow_is_aa(self) -> None:
        assert _cage_label(26) == "AA"

    def test_second_overflow(self) -> None:
        assert _cage_label(27) == "AB"

    def test_end_of_first_double_block(self) -> None:
        assert _cage_label(51) == "AZ"

    def test_start_of_second_double_block(self) -> None:
        assert _cage_label(52) == "BA"

    def test_81_cages_all_unique(self) -> None:
        # A real puzzle can have up to 81 single-cell cages
        labels = [_cage_label(i) for i in range(81)]
        assert len(set(labels)) == 81

    def test_81_cages_no_index_error(self) -> None:
        # Regression: original code used string.ascii_uppercase[i] which crashes at i=26
        for i in range(81):
            _cage_label(i)  # must not raise


class TestSpecToCageStates:
    """_spec_to_cage_states converts a PuzzleSpec into a list of CageState models."""

    def test_trivial_spec_produces_81_cages(self) -> None:
        cages = _spec_to_cage_states(make_trivial_spec())
        assert len(cages) == 81

    def test_index_zero_not_included(self) -> None:
        # PuzzleSpec.regions uses 0 for unassigned cells; those must be skipped
        cages = _spec_to_cage_states(make_trivial_spec())
        # If 0 were included, there would be 82 entries and labels would overflow
        assert len(cages) == 81

    def test_all_81_cells_covered(self) -> None:
        cages = _spec_to_cage_states(make_trivial_spec())
        cells = {(cell.row, cell.col) for cage in cages for cell in cage.cells}
        expected = {(r + 1, c + 1) for r in range(9) for c in range(9)}
        assert cells == expected

    def test_labels_are_unique(self) -> None:
        cages = _spec_to_cage_states(make_trivial_spec())
        labels = [c.label for c in cages]
        assert len(labels) == len(set(labels))

    def test_trivial_spec_each_cage_has_one_cell(self) -> None:
        cages = _spec_to_cage_states(make_trivial_spec())
        assert all(len(c.cells) == 1 for c in cages)

    def test_trivial_spec_totals_match_known_solution(self) -> None:
        # In the trivial spec every cage total equals the digit at that cell
        cages = _spec_to_cage_states(make_trivial_spec())
        solution_digits = sorted(
            KNOWN_SOLUTION[r][c] for r in range(9) for c in range(9)
        )
        cage_totals = sorted(c.total for c in cages)
        assert cage_totals == solution_digits

    def test_three_cell_cage_spec_has_correct_count(self) -> None:
        # 1 three-cell cage + 78 single-cell cages = 79 cages total
        cages = _spec_to_cage_states(make_three_cell_cage_spec())
        assert len(cages) == 79

    def test_three_cell_cage_has_three_cells(self) -> None:
        cages = _spec_to_cage_states(make_three_cell_cage_spec())
        multi = [c for c in cages if len(c.cells) > 1]
        assert len(multi) == 1
        assert len(multi[0].cells) == 3


class TestSpecDataRoundTrip:
    """_spec_to_data and _data_to_spec must round-trip all four numpy arrays exactly."""

    @pytest.fixture
    def spec(self):  # type: ignore[override]
        return make_trivial_spec()

    def test_regions_preserved(self, spec) -> None:  # type: ignore[override]
        np.testing.assert_array_equal(
            _data_to_spec(_spec_to_data(spec)).regions, spec.regions
        )

    def test_cage_totals_preserved(self, spec) -> None:  # type: ignore[override]
        np.testing.assert_array_equal(
            _data_to_spec(_spec_to_data(spec)).cage_totals, spec.cage_totals
        )

    def test_border_x_preserved(self, spec) -> None:  # type: ignore[override]
        np.testing.assert_array_equal(
            _data_to_spec(_spec_to_data(spec)).border_x, spec.border_x
        )

    def test_border_y_preserved(self, spec) -> None:  # type: ignore[override]
        np.testing.assert_array_equal(
            _data_to_spec(_spec_to_data(spec)).border_y, spec.border_y
        )


class TestCageStatesToSpec:
    """_cage_states_to_spec rebuilds a PuzzleSpec from the current (editable) cage
    list."""

    def test_all_cells_assigned(self) -> None:
        spec = make_trivial_spec()
        rebuilt = _cage_states_to_spec(_spec_to_cage_states(spec), _spec_to_data(spec))
        assert (rebuilt.regions > 0).all()

    def test_no_cell_unassigned(self) -> None:
        spec = make_trivial_spec()
        cages = _spec_to_cage_states(spec)
        rebuilt = _cage_states_to_spec(cages, _spec_to_data(spec))
        assert int(np.count_nonzero(rebuilt.regions == 0)) == 0

    def test_edited_total_reflected_in_cage_totals(self) -> None:
        spec = make_trivial_spec()
        cages = _spec_to_cage_states(spec)
        data = _spec_to_data(spec)

        original_total = cages[0].total
        new_total = original_total + 10
        edited = [cages[0].model_copy(update={"total": new_total}), *cages[1:]]

        rebuilt = _cage_states_to_spec(edited, data)

        # The head cell of the first cage must carry the updated total
        head = edited[0].cells[0]
        assert int(rebuilt.cage_totals[head.row - 1, head.col - 1]) == new_total

    def test_original_total_unchanged_for_other_cages(self) -> None:
        spec = make_trivial_spec()
        cages = _spec_to_cage_states(spec)
        data = _spec_to_data(spec)

        # Edit only the first cage
        edited = [cages[0].model_copy(update={"total": 99}), *cages[1:]]
        rebuilt = _cage_states_to_spec(edited, data)

        # Second cage total must not have changed
        head2 = cages[1].cells[0]
        assert int(rebuilt.cage_totals[head2.row - 1, head2.col - 1]) == cages[1].total

    def test_border_arrays_come_from_stored_data(self) -> None:
        spec = make_trivial_spec()
        cages = _spec_to_cage_states(spec)
        data = _spec_to_data(spec)
        rebuilt = _cage_states_to_spec(cages, data)
        # Borders should match the stored (original OCR) arrays, not be recomputed
        np.testing.assert_array_equal(rebuilt.border_x, spec.border_x)
        np.testing.assert_array_equal(rebuilt.border_y, spec.border_y)
