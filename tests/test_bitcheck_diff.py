from killer_sudoku.scripts.bitcheck_diff import diff_dumps


def test_matching_dumps_return_none() -> None:
    dump = {
        "gray": [[1, 2], [3, 4]], "grid_corners": [[0, 0], [1, 0], [1, 1], [0, 1]],
        "puzzle_type": "killer", "border_x": [[True]], "border_y": [[False]],
        "cage_totals": [[5]], "given_digits": None, "spec_error": None,
    }
    ts_dump = {
        "gray": [[1, 2], [3, 4]], "gridCorners": [[0, 0], [1, 0], [1, 1], [0, 1]],
        "puzzleType": "killer", "borderX": [[True]], "borderY": [[False]],
        "cageTotals": [[5]], "givenDigits": None, "specError": None,
    }
    assert diff_dumps(dump, ts_dump) is None


def test_reports_first_divergence_only() -> None:
    dump = {"gray": [[1, 2]], "grid_corners": [[9, 9]], "puzzle_type": "killer",
            "border_x": None, "border_y": None, "cage_totals": None,
            "given_digits": None, "spec_error": None}
    ts_dump = {"gray": [[1, 99]], "gridCorners": [[0, 0]], "puzzleType": "classic",
               "borderX": None, "borderY": None, "cageTotals": None,
               "givenDigits": None, "specError": None}
    result = diff_dumps(dump, ts_dump)
    assert result is not None
    assert result.startswith("Stage 1: grayscale image")


def test_shape_mismatch_reported() -> None:
    dump = {"gray": [[1, 2], [3, 4]], "grid_corners": None, "puzzle_type": None,
            "border_x": None, "border_y": None, "cage_totals": None,
            "given_digits": None, "spec_error": None}
    ts_dump = {"gray": [[1, 2, 3]], "gridCorners": None, "puzzleType": None,
               "borderX": None, "borderY": None, "cageTotals": None,
               "givenDigits": None, "specError": None}
    result = diff_dumps(dump, ts_dump)
    assert result is not None
    assert "shape mismatch" in result
