import base64
import io
import json
import sys
import tempfile
from pathlib import Path
from typing import Any, Literal

import matplotlib.font_manager as fm
import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
import train_recogniser
from train_recogniser import (
    ACTIVE_RECOGNISER,
    CONFIDENCE_THRESHOLD,
    THUMBNAIL_SIZE,
    CanonicalTrainingSample,
    HogRecogniser,
    RawTrainingSample,
    build_dataset,
    canonicalize_samples,
    compute_label_means,
    deduplicate_training_samples,
    fit_class_mean_pca,
    generate_synthetic_samples,
    load_overrides_file,
    load_training_file,
)


def test_generate_synthetic_samples_covers_digits_1_to_9() -> None:
    samples = generate_synthetic_samples()
    assert len(samples) > 0
    labels = {sample.digit for sample in samples}
    assert labels == set(range(1, 10)), f"Missing: {set(range(1,10)) - labels}"
    for sample in samples[:5]:
        assert isinstance(sample, RawTrainingSample)
        assert sample.pixels.ndim == 2
        assert sample.pixels.dtype == np.uint8
        assert sample.pixels.max() > 0


def test_generate_synthetic_samples_skips_fonts_that_fail_during_render(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def find_broken_font(*, fontext: str) -> list[str]:
        assert fontext == "ttf"
        return ["broken.ttf"]

    def load_broken_font(path: str, size: int) -> object:
        assert path == "broken.ttf"
        assert size == 32
        return object()

    def fail_text_bbox(*args: object, **kwargs: object) -> tuple[int, int, int, int]:
        del args, kwargs
        raise OSError("invalid reference")

    monkeypatch.setattr(fm, "findSystemFonts", find_broken_font)
    monkeypatch.setattr(ImageFont, "truetype", load_broken_font)
    monkeypatch.setattr(ImageDraw.ImageDraw, "textbbox", fail_text_bbox)

    assert generate_synthetic_samples(pt_sizes=(32,)) == []


def _make_samples() -> list[tuple[int, np.ndarray[Any, np.dtype[np.uint8]]]]:
    rng = np.random.default_rng(0)
    return [(d, rng.integers(0, 255, (64, 64), dtype=np.uint8)) for d in range(1, 10)]


def test_build_dataset_shape() -> None:
    samples = _make_samples()
    aug_imgs, y, _w = build_dataset(samples, n_dither=2)
    # 9 digits x (1 original + 2 dither) = 27 stacked 64x64 uint8 images --
    # feature extraction is the caller's job via ACTIVE_RECOGNISER.extract_features.
    assert aug_imgs.shape == (27, THUMBNAIL_SIZE, THUMBNAIL_SIZE)
    assert aug_imgs.dtype == np.uint8
    assert y.shape == (27,)
    assert set(y.tolist()) == set(range(1, 10))



def test_active_recogniser_is_hog_by_default() -> None:
    assert isinstance(ACTIVE_RECOGNISER, HogRecogniser)


def test_load_training_file_reads_schema_v2_raw_source_pixels(tmp_path: Path) -> None:
    recognition_pixels = [index % 256 for index in range(THUMBNAIL_SIZE**2)]
    export_path = tmp_path / "training-v2.json"
    export_path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "samples": [
                    {
                        "digit": 7,
                        "sourceRect": [4, 5, 3, 2],
                        "sourceWidth": 3,
                        "sourceHeight": 2,
                        "sourcePixels": [12, 13, 14, 22, 23, 24],
                        "recognitionPixels": recognition_pixels,
                        "warpStrategy": "letterbox",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    samples = load_training_file(export_path)

    assert len(samples) == 1
    sample = samples[0]
    assert isinstance(sample, RawTrainingSample)
    assert sample.digit == 7
    assert sample.pixels.shape == (2, 3)
    assert sample.pixels.ravel().tolist() == [12, 13, 14, 22, 23, 24]


def test_load_training_file_migrates_version_1_to_explicit_canonical(tmp_path: Path) -> None:
    pixels = [index % 256 for index in range(THUMBNAIL_SIZE**2)]
    export_path = tmp_path / "training-v1.json"
    export_path.write_text(
        json.dumps({"version": 1, "thumbnailSize": 64, "samples": [{"digit": 4, "pixels": pixels}]}),
        encoding="utf-8",
    )

    samples = load_training_file(export_path)

    assert len(samples) == 1
    sample = samples[0]
    assert isinstance(sample, CanonicalTrainingSample)
    assert sample.digit == 4
    assert sample.warp_strategy == "letterbox"
    assert sample.pixels.shape == (64, 64)


def test_load_training_file_supports_mixed_legacy_and_raw_records(tmp_path: Path) -> None:
    canonical = [0] * (THUMBNAIL_SIZE**2)
    export_path = tmp_path / "mixed.json"
    export_path.write_text(
        json.dumps({
            "version": 1,
            "thumbnailSize": 64,
            "samples": [
                {"digit": 4, "pixels": canonical},
                {
                    "digit": 7,
                    "sourceRect": [2, 3, 3, 2],
                    "sourceWidth": 3,
                    "sourceHeight": 2,
                    "sourcePixels": [12, 13, 14, 22, 23, 24],
                    "recognitionPixels": canonical,
                    "warpStrategy": "letterbox",
                },
            ],
        }),
        encoding="utf-8",
    )

    samples = load_training_file(export_path)

    assert isinstance(samples[0], CanonicalTrainingSample)
    assert isinstance(samples[1], RawTrainingSample)
    assert samples[1].pixels.shape == (2, 3)


def test_load_training_file_rejects_invalid_raw_dimensions_with_source(tmp_path: Path) -> None:
    export_path = tmp_path / "bad-v2.json"
    export_path.write_text(
        json.dumps({
            "schemaVersion": 2,
            "samples": [{
                "digit": 7,
                "sourceRect": [0, 0, 3, 2],
                "sourceWidth": 3,
                "sourceHeight": 2,
                "sourcePixels": [1, 2, 3],
                "recognitionPixels": [0] * (THUMBNAIL_SIZE**2),
                "warpStrategy": "letterbox",
            }],
        }),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match=r"bad-v2\.json sample 0.*expected 6 pixels"):
        load_training_file(export_path)


@pytest.mark.parametrize("strategy", ["stretch", "letterbox"])
def test_canonicalize_samples_uses_selected_ts_warp_and_filters_incompatible_legacy(
    monkeypatch: pytest.MonkeyPatch,
    strategy: Literal["stretch", "letterbox"],
) -> None:
    calls: list[tuple[str, tuple[int, int]]] = []

    def fake_warp(crops: list[Any], selected: str, size: int) -> np.ndarray[Any, np.dtype[np.uint8]]:
        calls.append((selected, crops[0].pixels.shape))
        fill = 31 if selected == "stretch" else 47
        return np.full((len(crops), size, size), fill, dtype=np.uint8)

    monkeypatch.setattr(train_recogniser, "warp_crops", fake_warp)
    raw = RawTrainingSample(1, np.arange(6, dtype=np.uint8).reshape(2, 3))
    matching = CanonicalTrainingSample(2, np.full((64, 64), 19, dtype=np.uint8), strategy)
    other_strategy: Literal["stretch", "letterbox"] = (
        "letterbox" if strategy == "stretch" else "stretch"
    )
    incompatible = CanonicalTrainingSample(
        3,
        np.full((64, 64), 23, dtype=np.uint8),
        other_strategy,
    )

    prepared = canonicalize_samples([raw, matching, incompatible], strategy)

    assert calls == [(strategy, (2, 3))]
    assert [digit for digit, _image in prepared] == [1, 2]
    assert prepared[0][1][0, 0] == (31 if strategy == "stretch" else 47)
    assert prepared[1][1][0, 0] == 19


def test_canonicalize_samples_surfaces_ts_bridge_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_warp(_crops: list[Any], _strategy: str, _size: int) -> np.ndarray[Any, np.dtype[np.uint8]]:
        raise RuntimeError("warp bridge failed")

    monkeypatch.setattr(train_recogniser, "warp_crops", fail_warp)

    with pytest.raises(RuntimeError, match="warp bridge failed"):
        canonicalize_samples(
            [RawTrainingSample(8, np.ones((2, 3), dtype=np.uint8))],
            "letterbox",
        )


def test_deduplicate_training_samples_uses_label_kind_geometry_and_strategy() -> None:
    raw_pixels = np.arange(6, dtype=np.uint8)
    raw_first = RawTrainingSample(4, raw_pixels.reshape(2, 3))
    raw_duplicate = RawTrainingSample(4, raw_pixels.reshape(2, 3).copy())
    raw_other_label = RawTrainingSample(5, raw_pixels.reshape(2, 3).copy())
    raw_other_shape = RawTrainingSample(4, raw_pixels.reshape(3, 2).copy())
    canonical_pixels = np.zeros((64, 64), dtype=np.uint8)
    raw_square = RawTrainingSample(4, canonical_pixels.copy())
    canonical_letterbox = CanonicalTrainingSample(4, canonical_pixels.copy(), "letterbox")
    canonical_duplicate = CanonicalTrainingSample(4, canonical_pixels.copy(), "letterbox")
    canonical_stretch = CanonicalTrainingSample(4, canonical_pixels.copy(), "stretch")

    deduped = deduplicate_training_samples([
        raw_first,
        raw_duplicate,
        raw_other_label,
        raw_other_shape,
        raw_square,
        canonical_letterbox,
        canonical_duplicate,
        canonical_stretch,
    ])

    assert len(deduped) == 6
    assert deduped[0] is raw_first
    assert deduped[1] is raw_other_label
    assert deduped[2] is raw_other_shape
    assert deduped[3] is raw_square
    assert deduped[4] is canonical_letterbox
    assert deduped[5] is canonical_stretch


_EXPECTED_HOG_KEYS = {
    "hog_win_size", "hog_cell_size", "hog_block_size", "hog_block_stride", "hog_nbins",
    "rbf_support_vectors", "rbf_dual_coef", "rbf_intercept", "rbf_n_support", "rbf_gamma",
    "classes", "confidence_threshold", "use_aspect_feature",
}


def test_hog_recogniser_save_keys() -> None:
    hog = HogRecogniser()
    samples = _make_samples()
    aug_imgs, y, _w = build_dataset(samples, n_dither=1)
    X = hog.extract_features(aug_imgs)
    model = hog.fit(X, y, None, pca_components=0)
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        hog.save(
            model,
            out,
            confidence_threshold=CONFIDENCE_THRESHOLD,
            warp_strategy="stretch",
        )
        manifest: dict[str, Any] = json.loads((out / "num_recogniser.json").read_text())

    assert manifest["classifier_type"] == "rbf"
    assert manifest["warp_strategy"] == "stretch"
    assert set(manifest["arrays"].keys()) == _EXPECTED_HOG_KEYS
    # No PCA/template keys when pca_components=0 explicitly disables the reduction step.
    assert not any(k.startswith("pca") or k.startswith("template") for k in manifest["arrays"])


def test_hog_recogniser_save_keys_with_pca() -> None:
    hog = HogRecogniser()
    samples = _make_samples()
    aug_imgs, y, _w = build_dataset(samples, n_dither=1)
    X = hog.extract_features(aug_imgs)
    n_features = X.shape[1]
    model = hog.fit(X, y, None, pca_components=5)
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        hog.save(
            model,
            out,
            confidence_threshold=CONFIDENCE_THRESHOLD,
            warp_strategy="letterbox",
        )
        manifest: dict[str, Any] = json.loads((out / "num_recogniser.json").read_text())

    assert set(manifest["arrays"].keys()) == _EXPECTED_HOG_KEYS | {"pca_mean", "pca_components"}
    assert manifest["arrays"]["pca_mean"]["shape"] == [n_features]
    assert manifest["arrays"]["pca_components"]["shape"] == [5, n_features]
    # The SVM itself was fit on PCA-reduced features, not the raw HOG+hole vector.
    assert manifest["arrays"]["rbf_support_vectors"]["shape"][1] == 5


def test_compute_label_means_returns_one_row_per_unique_label() -> None:
    X = np.array([[1.0, 1.0], [3.0, 3.0], [10.0, 0.0], [20.0, 0.0]])
    y = np.array([0, 0, 1, 1])
    means = compute_label_means(X, y)
    assert means.shape == (2, 2)
    np.testing.assert_allclose(means[0], [2.0, 2.0])
    np.testing.assert_allclose(means[1], [15.0, 0.0])


def test_fit_class_mean_pca_rank_is_at_most_n_labels_minus_one() -> None:
    rng = np.random.default_rng(0)
    # 4 labels, tight clusters -> between-class directions span at most 3 dims,
    # regardless of the ambient (10) feature dimensionality.
    X = np.concatenate([rng.normal(loc=label * 5.0, scale=0.1, size=(20, 10)) for label in range(4)])
    y = np.concatenate([np.full(20, label) for label in range(4)])
    reduced, reduction = fit_class_mean_pca(X, y, n_residual_components=0)
    assert reduced.shape == (80, 3)
    assert reduction.between_components.shape == (3, 10)
    assert reduction.residual_components is None


def test_fit_class_mean_pca_appends_residual_components() -> None:
    rng = np.random.default_rng(0)
    X = np.concatenate([rng.normal(loc=label * 5.0, scale=0.1, size=(20, 10)) for label in range(4)])
    y = np.concatenate([np.full(20, label) for label in range(4)])
    reduced, reduction = fit_class_mean_pca(X, y, n_residual_components=2)
    assert reduced.shape == (80, 5)  # 3 between-class + 2 residual
    assert reduction.residual_components is not None
    assert reduction.residual_components.shape == (2, 10)
    assert reduction.residual_mean is not None
    assert reduction.residual_mean.shape == (10,)


def test_hog_recogniser_save_keys_with_class_mean_pca() -> None:
    hog = HogRecogniser()
    samples = _make_samples()  # 9 samples, one per digit 1-9
    aug_imgs, y, _w = build_dataset(samples, n_dither=1)
    X = hog.extract_features(aug_imgs)
    n_features = X.shape[1]
    model = hog.fit(X, y, None, pca_components=6, class_mean_residual_components=2)
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        hog.save(
            model,
            out,
            confidence_threshold=CONFIDENCE_THRESHOLD,
            warp_strategy="letterbox",
        )
        manifest: dict[str, Any] = json.loads((out / "num_recogniser.json").read_text())

    expected_keys = _EXPECTED_HOG_KEYS | {
        "cm_mean_of_means", "cm_between_components", "cm_residual_mean", "cm_residual_components",
    }
    assert set(manifest["arrays"].keys()) == expected_keys
    # 9 unique digit labels -> at most 8 between-class directions.
    assert manifest["arrays"]["cm_between_components"]["shape"] == [8, n_features]
    assert manifest["arrays"]["cm_residual_components"]["shape"] == [2, n_features]
    assert manifest["arrays"]["rbf_support_vectors"]["shape"][1] == 10  # 8 between + 2 residual
    # class_mean takes priority over pca_components when both are set.
    assert "pca_mean" not in manifest["arrays"]


def _make_override_png_b64(w: int, h: int) -> str:
    img = np.zeros((h, w), dtype=np.uint8)
    img[h // 4 : 3 * h // 4, w // 4 : 3 * w // 4] = 255
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_load_overrides_file_decodes_crops_and_skips_excluded() -> None:
    raw = np.arange(21, dtype=np.uint8).reshape(3, 7)
    buf = io.BytesIO()
    Image.fromarray(raw).save(buf, format="PNG")
    raw_png = base64.b64encode(buf.getvalue()).decode("ascii")
    overrides = {
        "classic_guardian|killer_sudoku_1.jpg|0|0": {
            "label": 7,
            "expectedPrior": 3,
            "cropPng": raw_png,
            "sourceRect": {"x": 11, "y": 13, "width": 7, "height": 3},
            "sourceWidth": 7,
            "sourceHeight": 3,
            "puzzleType": "classic",
        },
        "classic_guardian|killer_sudoku_1.jpg|1|1": {
            "label": "exclude",
            "expectedPrior": 5,
            "cropPng": _make_override_png_b64(40, 60),
            "sourceRect": {"x": 2, "y": 4, "width": 40, "height": 60},
            "sourceWidth": 40,
            "sourceHeight": 60,
            "puzzleType": "classic",
        },
    }
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "manual_label_overrides.json"
        path.write_text(json.dumps(overrides), encoding="utf-8")
        samples = load_overrides_file(path)

    assert len(samples) == 1
    sample = samples[0]
    assert isinstance(sample, RawTrainingSample)
    assert sample.digit == 7
    assert sample.pixels.shape == (3, 7)
    assert sample.pixels.dtype == np.uint8
    assert np.array_equal(sample.pixels, raw)


def test_load_overrides_file_rejects_png_metadata_dimension_mismatch() -> None:
    overrides = {
        "guardian|puzzle.jpg|0|0": {
            "label": 4,
            "expectedPrior": 8,
            "cropPng": _make_override_png_b64(7, 3),
            "sourceRect": {"x": 1, "y": 2, "width": 8, "height": 3},
            "sourceWidth": 8,
            "sourceHeight": 3,
            "puzzleType": "classic",
        },
    }
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "manual_label_overrides.json"
        path.write_text(json.dumps(overrides), encoding="utf-8")
        with pytest.raises(ValueError, match="PNG dimensions"):
            load_overrides_file(path)


def test_load_overrides_file_missing_path_returns_empty() -> None:
    assert load_overrides_file(Path("does/not/exist.json")) == []
