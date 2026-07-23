import json
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

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


def test_active_recogniser_is_pca_rbf_by_default() -> None:
    assert isinstance(ACTIVE_RECOGNISER, PcaRbfRecogniser)


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
