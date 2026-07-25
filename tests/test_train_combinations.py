import numpy as np
import numpy.typing as npt
from PIL import Image, ImageDraw

from killer_sudoku.training.train_combinations import train_and_evaluate


def _make_crop(digit: int) -> npt.NDArray[np.uint8]:
    img = Image.new("L", (40, 60), 0)
    draw = ImageDraw.Draw(img)
    draw.text((5, 5), str(digit), fill=255)
    return np.array(img, dtype=np.uint8)


def test_train_and_evaluate_runs_all_four_combinations() -> None:
    # Not a real accuracy test (too few samples to fit meaningfully) --
    # this only exercises the training/evaluation plumbing end-to-end.
    train = [(d, _make_crop(d)) for d in range(10) for _ in range(3)]
    holdout = [(d, _make_crop(d)) for d in range(10)]
    cross_font: list[tuple[int, npt.NDArray[np.uint8]]] = []

    results, fitted_models = train_and_evaluate(train, holdout, cross_font)
    assert set(results.keys()) == {
        "pca_stretch", "pca_letterbox", "hog_stretch", "hog_letterbox",
    }
    for combo_results in results.values():
        assert "same_dist_accuracy" in combo_results
    assert set(fitted_models.keys()) == set(results.keys())
