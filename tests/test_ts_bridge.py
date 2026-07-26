from pathlib import Path

import numpy as np

from killer_sudoku.solver.puzzle_spec import PuzzleSpec
from killer_sudoku.training.ts_bridge import extract_features, predict, solve

KNOWN_SOLUTION = [
    [5, 3, 4, 6, 7, 8, 9, 1, 2],
    [6, 7, 2, 1, 9, 5, 3, 4, 8],
    [1, 9, 8, 3, 4, 2, 5, 6, 7],
    [8, 5, 9, 7, 6, 1, 4, 2, 3],
    [4, 2, 6, 8, 5, 3, 7, 9, 1],
    [7, 1, 3, 9, 2, 4, 8, 5, 6],
    [9, 6, 1, 5, 3, 7, 2, 8, 4],
    [2, 8, 7, 4, 1, 9, 6, 3, 5],
    [3, 4, 5, 2, 8, 6, 1, 7, 9],
]


def test_extract_features_returns_correct_shapes() -> None:
    crops = [np.zeros((64, 64), dtype=np.uint8), np.zeros((64, 64), dtype=np.uint8)]
    hog, hole = extract_features(crops)
    assert hog.shape == (2, 1764)
    assert hole.shape == (2, 5)


def test_predict_returns_one_result_per_crop() -> None:
    crops = [np.zeros((64, 64), dtype=np.uint8)]
    results = predict(
        crops,
        Path("web/public/num_recogniser.bin"),
        Path("web/public/num_recogniser.json"),
    )
    assert len(results) == 1
    assert isinstance(results[0]["label"], int)
    assert isinstance(results[0]["confident"], bool)


def test_predict_surfaces_bridge_failure_as_an_error() -> None:
    crops = [np.zeros((64, 64), dtype=np.uint8)]
    try:
        predict(crops, Path("does/not/exist.bin"), Path("does/not/exist.json"))
        raised = False
    except RuntimeError:
        raised = True
    assert raised, "predict() must raise, never silently fall back"


def test_solve_matches_known_solution_for_a_trivial_one_cell_per_cage_spec() -> None:
    # validate_cage_layout's own regions/cage_totals are col-major ([col, row]),
    # confirmed by reading its union-find loop directly -- NOT what its Args
    # docstring says, and the opposite of the row-major convention ts-bridge.ts's
    # solve() expects (verified empirically by ts-bridge.test.ts's own trivial-spec
    # test). solve() below must transpose to catch a regression here.
    regions = np.arange(1, 82, dtype=np.intp).reshape(9, 9).T
    cage_totals = np.array(KNOWN_SOLUTION, dtype=np.intp).T
    border_x = np.ones((9, 8), dtype=np.bool_)
    border_y = np.ones((8, 9), dtype=np.bool_)
    spec = PuzzleSpec(regions=regions, cage_totals=cage_totals, border_x=border_x, border_y=border_y)

    result = solve(spec)

    assert result["solved"] is True
    assert result["board"] == KNOWN_SOLUTION
