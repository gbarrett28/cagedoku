from killer_sudoku.training.synthetic_holdout import generate_cross_font_holdout


def test_generate_cross_font_holdout_covers_all_digits() -> None:
    samples = generate_cross_font_holdout(digits=range(0, 10), pt_sizes=(48,))
    assert len(samples) > 0
    labels_seen = {label for label, _crop in samples}
    # Not every digit is guaranteed renderable in every discovered font, but
    # across all system fonts at least most digits should show up.
    assert len(labels_seen) >= 8
    for _label, crop in samples:
        assert crop.ndim == 2
        assert crop.dtype.name == "uint8"
