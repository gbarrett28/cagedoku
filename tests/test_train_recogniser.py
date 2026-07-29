import base64
import io
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

import matplotlib.font_manager as fm
import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
from train_recogniser import (
    ACTIVE_RECOGNISER,
    CONFIDENCE_THRESHOLD,
    THUMBNAIL_SIZE,
    HogRecogniser,
    PcaRbfRecogniser,
    build_dataset,
    fit_model,
    generate_synthetic_samples,
    load_overrides_file,
    load_training_file,
    save_model,
)


def test_generate_synthetic_samples_covers_digits_1_to_9() -> None:
    samples = generate_synthetic_samples()
    assert len(samples) > 0
    labels = {label for label, _ in samples}
    assert labels == set(range(1, 10)), f"Missing: {set(range(1,10)) - labels}"
    for _, img in samples[:5]:
        assert img.shape == (64, 64)
        assert img.dtype == np.uint8
        assert img.max() > 0


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


_EXPECTED_KEYS = {
    "pca_win_size", "pca_dims", "pca_components", "pca_mean",
    "rbf_support_vectors", "rbf_dual_coef", "rbf_intercept", "rbf_n_support", "rbf_gamma",
    "classes", "template_threshold", "confidence_threshold",
} | {f"template_{d}" for d in range(10)}


def test_save_model_pca_rbf_keys() -> None:
    samples = _make_samples()
    aug_imgs, y, _w = build_dataset(samples, n_dither=1)
    X = PcaRbfRecogniser().extract_features(aug_imgs)
    model = fit_model(X, y)
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        save_model(model, out, confidence_threshold=CONFIDENCE_THRESHOLD)
        manifest: dict[str, Any] = json.loads((out / "num_recogniser.json").read_text())

    assert manifest["classifier_type"] == "pca_rbf"
    keys = set(manifest["arrays"].keys())
    assert keys == _EXPECTED_KEYS
    # 9 classes (digits 1-9, no 0 in this synthetic fixture) -> PCA basis has
    # at most 9 components; support vectors share that same feature width.
    sv_shape = manifest["arrays"]["rbf_support_vectors"]["shape"]
    dims = manifest["arrays"]["pca_dims"]["shape"]
    assert dims == [1]
    assert len(sv_shape) == 2
    assert sv_shape[1] <= 9


def test_active_recogniser_is_hog_by_default() -> None:
    assert isinstance(ACTIVE_RECOGNISER, HogRecogniser)


def test_load_training_file_reads_schema_v2_recognition_pixels(tmp_path: Path) -> None:
    recognition_pixels = [index % 256 for index in range(THUMBNAIL_SIZE**2)]
    export_path = tmp_path / "training-v2.json"
    export_path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "samples": [
                    {
                        "digit": 7,
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
    digit, image = samples[0]
    assert digit == 7
    assert image.shape == (THUMBNAIL_SIZE, THUMBNAIL_SIZE)
    assert image.ravel().tolist() == recognition_pixels


_EXPECTED_HOG_KEYS = {
    "hog_win_size", "hog_cell_size", "hog_block_size", "hog_block_stride", "hog_nbins",
    "rbf_support_vectors", "rbf_dual_coef", "rbf_intercept", "rbf_n_support", "rbf_gamma",
    "classes", "confidence_threshold",
}


def test_hog_recogniser_save_keys() -> None:
    hog = HogRecogniser()
    samples = _make_samples()
    aug_imgs, y, _w = build_dataset(samples, n_dither=1)
    X = hog.extract_features(aug_imgs)
    model = hog.fit(X, y, None)
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        hog.save(model, out, confidence_threshold=CONFIDENCE_THRESHOLD)
        manifest: dict[str, Any] = json.loads((out / "num_recogniser.json").read_text())

    assert manifest["classifier_type"] == "rbf"
    assert set(manifest["arrays"].keys()) == _EXPECTED_HOG_KEYS
    # No PCA/template keys on a HOG manifest.
    assert not any(k.startswith("pca") or k.startswith("template") for k in manifest["arrays"])


def test_fit_to_thumbnail_stretch_vs_letterbox_differ() -> None:
    # A tall, narrow crop: stretch and letterbox produce visibly different results
    # (letterbox pads with black bars top/bottom after scaling to fit width; stretch
    # doesn't). Assert they're not just both valid but actually different.
    crop = np.zeros((40, 10), dtype=np.uint8)
    crop[:, 3:7] = 255  # a thin vertical stripe, non-square
    pca_out = PcaRbfRecogniser().fit_to_thumbnail(crop, 64)
    hog_out = HogRecogniser().fit_to_thumbnail(crop, 64)
    assert not np.array_equal(pca_out, hog_out)


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
    label, img = samples[0]
    assert label == 7
    assert img.shape == (3, 7)
    assert img.dtype == np.uint8
    assert np.array_equal(img, raw)


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
