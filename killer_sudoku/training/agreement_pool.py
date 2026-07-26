"""Builds a pool of digit samples corroborated by PCA/HOG agreement.

A sample is only included when both a clean solve and a per-character match
between two independently-trained recognisers hold -- see
docs/superpowers/plans/2026-07-24-pca-hog-agreement-recogniser.md for why
this is a stronger ground-truth signal than either check alone.
"""

import base64
import dataclasses
import shutil
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import cv2
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
from killer_sudoku.training.ts_bridge import predict


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


class _TsBridgeNumberSource:
    """NumberSource backed by ts_bridge.predict() against a frozen historical checkpoint.

    Replaces HogNumber + LinearOvOClassifier/RBFClassifier.predict() -- both
    reimplementations of numberRecognition.ts's production inference path --
    with a call into the real TS implementation. Still performs the
    letterbox warp itself (same step HogNumber.get_sums used to do): ts_bridge's
    predict() expects already-64x64 crops, matching TS's own
    recogniser.warpForRecognition() -> recognise() split.
    """

    def __init__(
        self, model_bin: Path, model_json: Path,
        warp_fn: Callable[[npt.NDArray[np.uint8]], npt.NDArray[np.uint8]],
    ) -> None:
        self._model_bin = model_bin
        self._model_json = model_json
        self._warp_fn = warp_fn

    def get_sums(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        if not nums:
            return np.array([], dtype=np.intp)
        warped = [self._warp_fn(img) for img in nums]
        predictions = predict(warped, self._model_bin, self._model_json)
        return np.array([p["label"] for p in predictions], dtype=np.intp)


def _make_hog_recogniser() -> _TsBridgeNumberSource:
    warp = HogRecogniser().warp_from_rect
    return _TsBridgeNumberSource(
        Path("killer_sudoku/data/hog_recogniser_99cbb70.bin"),
        Path("killer_sudoku/data/hog_recogniser_99cbb70.json"),
        lambda img: warp(0, 0, img.shape[1], img.shape[0], img, 64),
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


# classic_guardian/easy only: its other difficulty subdirectories
# (medium/hard/expert/other) reuse the same filenames, which would collide
# when flattened into a single scratch dir.
DEFAULT_CORPORA: list[tuple[str, Path]] = [
    ("guardian", Path("guardian")),
    ("observer", Path("observer")),
    ("classic_guardian", Path("classic_guardian/easy")),
    ("classic_observer", Path("classic_observer")),
]


def build_full_corpus_pool(
    corpora: list[tuple[str, Path]] = DEFAULT_CORPORA,
    limit: int | None = None,
) -> list[AgreedSample]:
    """Builds the agreement pool across every registered corpus.

    Each corpus is copied into its own scratch directory first --
    build_agreement_pool requires rework=True, which re-writes .jpk/status.pkl
    wherever it's pointed, so it must never run directly against
    guardian/observer/classic_guardian/classic_observer.
    """
    all_samples: list[AgreedSample] = []
    with tempfile.TemporaryDirectory(prefix="agreement_pool_scratch_") as scratch:
        for corpus_name, corpus_dir in corpora:
            scratch_dir = Path(scratch) / corpus_name
            scratch_dir.mkdir()
            images = sorted(corpus_dir.glob("*.jpg"))
            if limit is not None:
                images = images[:limit]
            for img in images:
                shutil.copy(img, scratch_dir / img.name)
            all_samples.extend(build_agreement_pool(scratch_dir, corpus_name))
    return all_samples


def resolve_corpus_name(path: Path, corpora: list[tuple[str, Path]] = DEFAULT_CORPORA) -> str:
    """Maps a source image path to its DEFAULT_CORPORA name by directory.

    corpus.db's own `corpus` column is NOT reliable for this: it only ever
    records "guardian"/"observer", collapsing the classic/killer split that
    DEFAULT_CORPORA actually uses (classic_guardian's images are physically
    stored under classic_guardian/easy/, a directory with the SAME filenames
    as guardian/ -- e.g. both have a killer_sudoku_140.jpg). Tagging a
    reconstructed sample with the DB's corpus value instead of this
    resolved one risks sample_key colliding with an unrelated real sample
    from the other directory.
    """
    resolved = path.resolve().parent
    for name, corpus_dir in corpora:
        if resolved == corpus_dir.resolve():
            return name
    raise ValueError(f"{path} is not under any registered corpus directory")


def sample_key(corpus: str, source_name: str, row: int, col: int) -> str:
    """Stable identifier for a corpus digit crop, used as the manual-override key.

    Built from (corpus, source image filename, cell row, cell col) rather than
    a pixel hash so it survives a re-crop of the same cell (e.g. after a
    border-detection tweak changes the rect slightly).
    """
    return f"{corpus}|{source_name}|{row}|{col}"


def apply_manual_overrides(
    samples: list[AgreedSample], overrides: dict[str, Any],
) -> tuple[list[AgreedSample], list[str]]:
    """Applies corrections collected via review_low_confidence.py's tick sheet.

    Each override entry (keyed by sample_key(...)) carries: "label" (the
    corrected digit, or "exclude" for a bad/non-digit crop), "expectedPrior"
    (the label the pipeline assigned when the crop was reviewed), and
    "cropPng" (the reviewed crop itself, base64 PNG).

    Most reviewed crops come from puzzles the agreement gate excluded
    entirely -- that disagreement (or a duplicate-digit solve failure) is
    exactly why they needed reviewing -- so there is usually no existing
    AgreedSample to relabel; the override instead introduces a brand new,
    human-verified sample built from its own stored crop.

    Where a matching sample DOES already exist, expectedPrior is checked
    against its current label before relabelling: a mismatch means the
    pipeline's identification of that cell has changed since the correction
    was recorded (rects shifted, a different crop now occupies the same
    (corpus, filename, row, col) key), so relabelling it would silently
    corrupt the ground truth rather than fix it -- such overrides are left
    unapplied and reported back instead of guessed at. A key claimed by more
    than one existing sample (a multi-digit killer cage total puts every
    character at the same row/col) is ambiguous for the same reason and is
    likewise left unapplied.

    Returns (augmented_samples, mismatched_keys).
    """
    by_key: dict[str, list[AgreedSample]] = {}
    for s in samples:
        by_key.setdefault(sample_key(s.corpus, s.source_path.name, s.row, s.col), []).append(s)

    result: list[AgreedSample] = []
    mismatched: list[str] = []
    consumed_keys: set[str] = set()

    for key, group in by_key.items():
        if key not in overrides:
            result.extend(group)
            continue
        consumed_keys.add(key)
        override = overrides[key]
        if len(group) != 1:
            mismatched.append(key)
            result.extend(group)
            continue
        existing = group[0]
        expected_prior = override.get("expectedPrior")
        if expected_prior is not None and int(expected_prior) != existing.label:
            mismatched.append(key)
            result.append(existing)
            continue
        if override["label"] != "exclude":
            result.append(dataclasses.replace(existing, label=int(override["label"])))

    for key, override in overrides.items():
        if key in consumed_keys:
            continue
        new_sample = _sample_from_override(key, override)
        if new_sample is not None:
            result.append(new_sample)

    return result, mismatched


def _sample_from_override(key: str, override: dict[str, Any]) -> AgreedSample | None:
    if override["label"] == "exclude":
        return None
    corpus, source_name, row_str, col_str = key.split("|")
    png_bytes = base64.b64decode(override["cropPng"])
    crop = cv2.imdecode(np.frombuffer(png_bytes, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if crop is None:
        raise ValueError(f"override {key!r}: cropPng did not decode to a valid image")
    return AgreedSample(
        corpus=corpus,
        puzzle_type=override.get("puzzleType", "classic"),
        row=int(row_str),
        col=int(col_str),
        rect=np.zeros((4, 2), dtype=np.float32),
        label=int(override["label"]),
        source_path=Path(source_name),
        crop=crop.astype(np.uint8),
    )
