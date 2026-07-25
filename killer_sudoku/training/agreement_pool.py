"""Builds a pool of digit samples corroborated by PCA/HOG agreement.

A sample is only included when both a clean solve and a per-character match
between two independently-trained recognisers hold -- see
docs/superpowers/plans/2026-07-24-pca-hog-agreement-recogniser.md for why
this is a stronger ground-truth signal than either check alone.
"""

import dataclasses
import sys
from pathlib import Path

import numpy as np
import numpy.typing as npt

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "web"))
from train_recogniser import HogRecogniser

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.training.digit_rects import (
    DigitRect,
    locate_cage_total_rects,
    locate_classic_digit_rects,
)
from killer_sudoku.training.hog_model_loader import HogNumber, load_hog_classifier


@dataclasses.dataclass(frozen=True)
class AgreedSample:
    corpus: str
    puzzle_type: str
    row: int
    col: int
    rect: npt.NDArray[np.float32]
    label: int
    source_path: Path
    # Extracted directly from warped_blk at pool-build time -- rect's
    # coordinates are in the warped grid's coordinate space, not the raw
    # source image's, so this crop cannot be correctly re-derived later from
    # source_path alone.
    crop: npt.NDArray[np.uint8]


def _make_hog_recogniser() -> HogNumber:
    hog_params, classifier, _threshold = load_hog_classifier(
        Path("killer_sudoku/data/hog_recogniser_99cbb70.bin"),
        Path("killer_sudoku/data/hog_recogniser_99cbb70.json"),
    )
    warp = HogRecogniser().warp_from_rect
    return HogNumber(
        hog_params, classifier,
        lambda img: warp(0, 0, img.shape[1], img.shape[0], img, hog_params.win_size),
    )


def build_agreement_pool(corpus_dir: Path, corpus_name: str) -> list[AgreedSample]:
    """Build the agreement pool from corpus_dir.

    corpus_dir MUST be a scratch copy, never guardian/ or observer/ directly
    -- rework=True is required (the cache-hit path never recomputes
    warped_blk, so cached reads can't yield crop rects at all), and
    rework=True re-writes .jpk/status.pkl in whatever directory it's pointed
    at.
    """
    config = ImagePipelineConfig(puzzle_dir=corpus_dir, rework=True)
    pca = InpImage.make_num_recogniser()
    hog = _make_hog_recogniser()

    def extract_crop(warped_blk: npt.NDArray[np.uint8], rect: npt.NDArray[np.float32]) -> npt.NDArray[np.uint8]:
        x0, y0 = float(rect[:, 0].min()), float(rect[:, 1].min())
        x1, y1 = float(rect[:, 0].max()), float(rect[:, 1].max())
        return np.asarray(warped_blk[int(y0) : int(y1), int(x0) : int(x1)], dtype=np.uint8)

    samples: list[AgreedSample] = []
    for f in sorted(corpus_dir.glob("*.jpg")):
        inp_pca = InpImage(f, config, pca)
        if inp_pca.spec_error is not None or inp_pca.warped_blk is None:
            continue
        inp_hog = InpImage(f, config, hog)
        if inp_hog.spec_error is not None:
            continue

        puzzle_type = inp_pca.puzzle_type
        if puzzle_type != inp_hog.puzzle_type:
            continue

        if puzzle_type == "classic":
            given_pca, given_hog = inp_pca.given_digits, inp_hog.given_digits
            if (
                given_pca is None
                or given_hog is None
                or not np.array_equal(given_pca, given_hog)
            ):
                continue
            rects = locate_classic_digit_rects(inp_pca.warped_blk, config.subres, given_pca > 0)
            for dr in rects:
                label = int(given_pca[dr.row, dr.col])
                crop = extract_crop(inp_pca.warped_blk, dr.rect)
                if crop.size == 0:
                    continue
                samples.append(
                    AgreedSample(corpus_name, "classic", dr.row, dr.col, dr.rect, label, f, crop)
                )
        else:
            totals_pca, totals_hog = inp_pca.info.cage_totals, inp_hog.info.cage_totals
            if not np.array_equal(totals_pca, totals_hog):
                continue
            rects = locate_cage_total_rects(inp_pca.warped_blk, config.subres)
            # Group rects by (row, col) -- a cage total can be multi-digit, so
            # a cell may have several rects. Pair them left-to-right against
            # the cage total's characters, same convention bootstrap_numerals
            # already uses (collect_numerals.py): skip the whole cell (not
            # just one character) if the rect count doesn't match the digit
            # count, rather than guessing a partial pairing.
            by_cell: dict[tuple[int, int], list[DigitRect]] = {}
            for dr in rects:
                by_cell.setdefault((dr.row, dr.col), []).append(dr)
            for (row, col), cell_rects in by_cell.items():
                # cage_totals is row-major -- index as [row, col], not [col, row].
                total_str = str(int(totals_pca[row, col]))
                if len(cell_rects) != len(total_str):
                    continue
                cell_rects.sort(key=lambda dr: float(dr.rect[:, 0].min()))
                for dr, digit_char in zip(cell_rects, total_str, strict=True):
                    crop = extract_crop(inp_pca.warped_blk, dr.rect)
                    if crop.size == 0:
                        continue
                    samples.append(
                        AgreedSample(
                            corpus_name, "killer", row, col, dr.rect, int(digit_char), f, crop
                        )
                    )
    return samples
