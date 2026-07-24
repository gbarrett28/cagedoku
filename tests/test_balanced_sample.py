from pathlib import Path

import numpy as np

from killer_sudoku.training.agreement_pool import AgreedSample
from killer_sudoku.training.balanced_sample import balanced_split


def _fake_sample(label: int, idx: int) -> AgreedSample:
    return AgreedSample(
        corpus="guardian", puzzle_type="killer", row=0, col=0,
        rect=np.zeros((4, 2), dtype=np.float32), label=label,
        source_path=Path(f"guardian/fake_{idx}.jpg"),
        crop=np.zeros((64, 64), dtype=np.uint8),
    )


def test_balanced_split_caps_per_digit_and_splits_holdout() -> None:
    # 150 samples of digit 3, only 150 available -- cap at per_digit=100.
    samples = [_fake_sample(3, i) for i in range(150)]
    result = balanced_split(samples, per_digit=100, holdout_fraction=0.2, seed=0)
    assert len(result.train) + len(result.holdout) == 100
    assert len(result.holdout) == 20
    # No sample appears in both splits.
    train_paths = {s.source_path for s in result.train}
    holdout_paths = {s.source_path for s in result.holdout}
    assert train_paths.isdisjoint(holdout_paths)


def test_balanced_split_is_deterministic_given_seed() -> None:
    samples = [_fake_sample(d % 10, i) for i, d in enumerate(range(500))]
    a = balanced_split(samples, per_digit=100, seed=42)
    b = balanced_split(samples, per_digit=100, seed=42)
    assert [s.source_path for s in a.train] == [s.source_path for s in b.train]
