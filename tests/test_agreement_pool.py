import base64
import shutil
from pathlib import Path

import cv2
import numpy as np
import numpy.typing as npt
import pytest

from killer_sudoku.training.agreement_pool import (
    AgreedSample,
    apply_manual_overrides,
    build_agreement_pool,
    resolve_corpus_name,
    sample_key,
)


def test_build_agreement_pool_only_includes_agreeing_clean_puzzles(tmp_path: Path) -> None:
    shutil.copy(Path("guardian/killer_sudoku_0.jpg"), tmp_path / "killer_sudoku_0.jpg")
    samples = build_agreement_pool(tmp_path, corpus_name="guardian")
    # Every returned sample must have a label consistent with what both
    # recognisers would produce -- can't assert an exact count without
    # knowing in advance whether this specific image passes the gate, so
    # assert structural invariants instead.
    for s in samples:
        assert s.corpus == "guardian"
        assert s.puzzle_type in {"killer", "classic"}
        assert 0 <= s.label <= 9
        assert s.rect.shape == (4, 2)
        assert s.crop.size > 0


def _sample(corpus: str, source_name: str, row: int, col: int, label: int) -> AgreedSample:
    return AgreedSample(
        corpus=corpus,
        puzzle_type="classic",
        row=row,
        col=col,
        rect=np.zeros((4, 2), dtype=np.float32),
        label=label,
        source_path=Path(source_name),
        crop=np.zeros((8, 8), dtype=np.uint8),
    )


def _png_b64(pixels: npt.NDArray[np.uint8]) -> str:
    _ok, buf = cv2.imencode(".png", pixels)
    return base64.b64encode(buf.tobytes()).decode("ascii")


def test_apply_manual_overrides_relabels_matching_sample_when_identity_matches() -> None:
    samples = [_sample("guardian", "killer_sudoku_1.jpg", 2, 3, label=6)]
    key = sample_key("guardian", "killer_sudoku_1.jpg", 2, 3)

    result, mismatched = apply_manual_overrides(
        samples, {key: {"label": 9, "expectedPrior": 6, "cropPng": _png_b64(np.zeros((8, 8), dtype=np.uint8))}}
    )

    assert mismatched == []
    assert len(result) == 1
    assert result[0].label == 9
    # Only the label changes -- everything else about the sample is preserved.
    assert result[0].row == 2 and result[0].col == 3


def test_apply_manual_overrides_skips_relabel_when_identity_mismatched() -> None:
    samples = [_sample("guardian", "killer_sudoku_1.jpg", 2, 3, label=6)]
    key = sample_key("guardian", "killer_sudoku_1.jpg", 2, 3)
    # expectedPrior (4) doesn't match the sample's actual current label (6) --
    # the pipeline's read of this cell has drifted since the correction was
    # recorded, so the override must NOT be blindly applied.
    override = {"label": 9, "expectedPrior": 4, "cropPng": _png_b64(np.zeros((8, 8), dtype=np.uint8))}

    result, mismatched = apply_manual_overrides(samples, {key: override})

    assert mismatched == [key]
    assert len(result) == 1
    assert result[0].label == 6


def test_apply_manual_overrides_excludes_flagged_sample() -> None:
    samples = [
        _sample("guardian", "killer_sudoku_1.jpg", 2, 3, label=6),
        _sample("guardian", "killer_sudoku_1.jpg", 4, 5, label=7),
    ]
    key = sample_key("guardian", "killer_sudoku_1.jpg", 2, 3)
    override = {"label": "exclude", "expectedPrior": 6, "cropPng": _png_b64(np.zeros((8, 8), dtype=np.uint8))}

    result, mismatched = apply_manual_overrides(samples, {key: override})

    assert mismatched == []
    assert len(result) == 1
    assert result[0].row == 4 and result[0].col == 5


def test_apply_manual_overrides_leaves_untargeted_samples_unchanged() -> None:
    samples = [_sample("guardian", "killer_sudoku_1.jpg", 2, 3, label=6)]
    override = {"label": 1, "expectedPrior": 0, "cropPng": _png_b64(np.zeros((8, 8), dtype=np.uint8))}

    result, mismatched = apply_manual_overrides(samples, {"observer|other.jpg|0|0": override})

    assert mismatched == []
    assert len(result) == 2  # original sample kept + a brand new one inserted
    assert any(s.label == 6 and s.row == 2 for s in result)


def test_apply_manual_overrides_inserts_new_sample_when_none_exists() -> None:
    # This is the common case: most reviewed crops come from puzzles the
    # agreement gate excluded outright, so there's no existing sample to
    # relabel -- the override must introduce one instead.
    crop = np.full((10, 6), 255, dtype=np.uint8)
    key = sample_key("guardian", "killer_sudoku_9.jpg", 3, 4)
    override = {"label": 7, "expectedPrior": 6, "cropPng": _png_b64(crop)}

    result, mismatched = apply_manual_overrides([], {key: override})

    assert mismatched == []
    assert len(result) == 1
    new_sample = result[0]
    assert new_sample.corpus == "guardian"
    assert new_sample.source_path.name == "killer_sudoku_9.jpg"
    assert new_sample.row == 3 and new_sample.col == 4
    assert new_sample.label == 7
    assert new_sample.crop.shape == crop.shape


def test_apply_manual_overrides_flags_ambiguous_key_shared_by_multiple_samples() -> None:
    # A multi-digit killer cage total puts every character at the same
    # (row, col) -- sample_key can't disambiguate between them, so an
    # override targeting that key must be left unapplied rather than guessed.
    samples = [
        _sample("guardian", "killer_sudoku_1.jpg", 2, 3, label=1),
        _sample("guardian", "killer_sudoku_1.jpg", 2, 3, label=6),
    ]
    key = sample_key("guardian", "killer_sudoku_1.jpg", 2, 3)
    override = {"label": 9, "expectedPrior": 1, "cropPng": _png_b64(np.zeros((8, 8), dtype=np.uint8))}

    result, mismatched = apply_manual_overrides(samples, {key: override})

    assert mismatched == [key]
    assert {s.label for s in result} == {1, 6}


def test_resolve_corpus_name_disambiguates_same_named_directories() -> None:
    # guardian/ and classic_guardian/easy/ use the same filenames -- the
    # correct corpus for a path must come from which directory it's
    # actually under, not from any external (e.g. corpus.db) label.
    corpora = [
        ("guardian", Path("guardian")),
        ("classic_guardian", Path("classic_guardian/easy")),
    ]

    assert resolve_corpus_name(Path("guardian/killer_sudoku_140.jpg"), corpora) == "guardian"
    assert (
        resolve_corpus_name(Path("classic_guardian/easy/killer_sudoku_140.jpg"), corpora)
        == "classic_guardian"
    )


def test_resolve_corpus_name_raises_for_unregistered_directory() -> None:
    corpora = [("classic_guardian", Path("classic_guardian/easy"))]

    with pytest.raises(ValueError, match="not under any registered corpus"):
        resolve_corpus_name(Path("classic_guardian/expert/killer_sudoku_123.jpg"), corpora)
