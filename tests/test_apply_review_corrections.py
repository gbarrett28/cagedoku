from killer_sudoku.training.apply_review_corrections import merge_corrections

_RAW_CANDIDATE = {
    "expectedPrior": 3,
    "cropPng": "BB",
    "sourceRect": {"x": 11, "y": 13, "width": 7, "height": 3},
    "sourceWidth": 7,
    "sourceHeight": 3,
    "puzzleType": "classic",
}


def test_merge_corrections_preserves_raw_crop_metadata() -> None:
    review = [{"id": "guardian|b.jpg|3|4", "chosen": 8, "currentLabel": 3}]
    candidates = {"guardian|b.jpg|3|4": _RAW_CANDIDATE}

    merged = merge_corrections({}, review, candidates)

    assert merged["guardian|b.jpg|3|4"] == {
        "label": 8,
        **_RAW_CANDIDATE,
    }


def test_merge_corrections_overwrites_existing_entry() -> None:
    existing: dict[str, object] = {
        "guardian|a.jpg|1|2": {
            "label": 6,
            **_RAW_CANDIDATE,
        }
    }
    review = [{"id": "guardian|a.jpg|1|2", "chosen": "exclude", "currentLabel": 6}]
    candidates = {"guardian|a.jpg|1|2": _RAW_CANDIDATE}

    merged = merge_corrections(existing, review, candidates)

    assert merged["guardian|a.jpg|1|2"]["label"] == "exclude"
    assert merged["guardian|a.jpg|1|2"]["sourceWidth"] == 7


def test_merge_corrections_skips_review_entry_with_no_candidate_record() -> None:
    review = [{"id": "guardian|missing.jpg|0|0", "chosen": 5, "currentLabel": 2}]

    merged = merge_corrections({}, review, candidates={})

    assert merged == {}
