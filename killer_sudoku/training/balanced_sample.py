"""Caps samples per digit class and splits into train/holdout, deterministically."""

import dataclasses
import random

from killer_sudoku.training.agreement_pool import AgreedSample


@dataclasses.dataclass(frozen=True)
class SplitDataset:
    train: list[AgreedSample]
    holdout: list[AgreedSample]


def balanced_split(
    samples: list[AgreedSample],
    per_digit: int = 100,
    holdout_fraction: float = 0.2,
    seed: int = 0,
) -> SplitDataset:
    rng = random.Random(seed)
    by_digit: dict[int, list[AgreedSample]] = {}
    for s in samples:
        by_digit.setdefault(s.label, []).append(s)

    train: list[AgreedSample] = []
    holdout: list[AgreedSample] = []
    for digit in sorted(by_digit):
        pool = by_digit[digit][:]
        rng.shuffle(pool)
        capped = pool[:per_digit]
        n_holdout = round(len(capped) * holdout_fraction)
        holdout.extend(capped[:n_holdout])
        train.extend(capped[n_holdout:])
    return SplitDataset(train=train, holdout=holdout)
