from killer_sudoku.training.apply_review_corrections import merge_corrections


def test_merge_corrections_adds_new_entries() -> None:
    existing: dict[str, object] = {"guardian|a.jpg|1|2": {"label": 6, "expectedPrior": 6, "cropPng": "AA", "puzzleType": "classic"}}
    review = [{"id": "guardian|b.jpg|3|4", "chosen": 8, "currentLabel": 3}]
    candidates = {"guardian|b.jpg|3|4": {"expectedPrior": 3, "cropPng": "BB", "puzzleType": "classic"}}

    merged = merge_corrections(existing, review, candidates)

    assert merged["guardian|a.jpg|1|2"] == {"label": 6, "expectedPrior": 6, "cropPng": "AA", "puzzleType": "classic"}
    assert merged["guardian|b.jpg|3|4"] == {"label": 8, "expectedPrior": 3, "cropPng": "BB", "puzzleType": "classic"}


def test_merge_corrections_overwrites_existing_entry() -> None:
    existing: dict[str, object] = {"guardian|a.jpg|1|2": {"label": 6, "expectedPrior": 6, "cropPng": "AA", "puzzleType": "classic"}}
    review = [{"id": "guardian|a.jpg|1|2", "chosen": "exclude", "currentLabel": 6}]
    candidates = {"guardian|a.jpg|1|2": {"expectedPrior": 6, "cropPng": "AA", "puzzleType": "classic"}}

    merged = merge_corrections(existing, review, candidates)

    assert merged["guardian|a.jpg|1|2"]["label"] == "exclude"


def test_merge_corrections_skips_review_entry_with_no_candidate_record() -> None:
    review = [{"id": "guardian|missing.jpg|0|0", "chosen": 5, "currentLabel": 2}]

    merged = merge_corrections({}, review, candidates={})

    assert merged == {}
