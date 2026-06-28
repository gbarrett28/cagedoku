import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
from dedupe_browser_train import dedupe_samples


def test_dedupe_samples_drops_exact_duplicates_keeping_first() -> None:
    samples = [
        {"digit": 7, "pixels": [1, 2, 3]},
        {"digit": 7, "pixels": [1, 2, 3]},  # exact duplicate
        {"digit": 1, "pixels": [4, 5, 6]},
    ]
    deduped, n_removed = dedupe_samples(samples)
    assert n_removed == 1
    assert deduped == [
        {"digit": 7, "pixels": [1, 2, 3]},
        {"digit": 1, "pixels": [4, 5, 6]},
    ]


def test_dedupe_samples_keeps_distinct_samples_with_same_digit() -> None:
    samples = [
        {"digit": 2, "pixels": [1, 1, 1]},
        {"digit": 2, "pixels": [2, 2, 2]},
    ]
    deduped, n_removed = dedupe_samples(samples)
    assert n_removed == 0
    assert deduped == samples


def test_dedupe_samples_handles_empty_list() -> None:
    deduped, n_removed = dedupe_samples([])
    assert deduped == []
    assert n_removed == 0
