import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
from train_recogniser import generate_synthetic_samples, extract_hog, HOG_FEAT


def test_generate_synthetic_samples_covers_digits_1_to_9():
    samples = generate_synthetic_samples()
    assert len(samples) > 0
    labels = {label for label, _ in samples}
    assert labels == set(range(1, 10)), f"Missing: {set(range(1,10)) - labels}"
    for _, img in samples[:5]:
        assert img.shape == (64, 64)
        assert img.dtype == np.uint8
        assert img.max() > 0


def test_extract_hog_output_shape():
    imgs = [np.zeros((64, 64), dtype=np.uint8) for _ in range(3)]
    imgs[0][20:44, 28:36] = 200   # rough digit stroke
    X = extract_hog(imgs)
    assert X.shape == (3, HOG_FEAT), f"Expected (3, {HOG_FEAT}), got {X.shape}"
    assert X.dtype == np.float64


import json
import tempfile
from train_recogniser import build_dataset, fit_model, save_model, CONFIDENCE_THRESHOLD


def _make_samples() -> list[tuple[int, np.ndarray]]:
    rng = np.random.default_rng(0)
    return [(d, rng.integers(0, 255, (64, 64), dtype=np.uint8)) for d in range(1, 10)]


def test_build_dataset_shape():
    samples = _make_samples()
    X, y = build_dataset(samples, n_dither=2)
    # 9 digits x (1 original + 2 dither) = 27
    assert X.shape == (27, HOG_FEAT)
    assert y.shape == (27,)
    assert set(y.tolist()) == set(range(1, 10))


_COMMON_KEYS = {
    "hog_win_size", "hog_cell_size", "hog_block_size", "hog_block_stride",
    "hog_nbins", "confidence_threshold", "classes",
}


def _train_and_save(classifier: str) -> dict:
    samples = _make_samples()
    X, y = build_dataset(samples, n_dither=1)
    model = fit_model(X, y, classifier=classifier)
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        save_model(model, out, confidence_threshold=CONFIDENCE_THRESHOLD)
        manifest = json.loads((out / "num_recogniser.json").read_text())
    return manifest


def test_save_model_linear_keys():
    manifest = _train_and_save("linear")
    assert manifest["classifier_type"] == "linear"
    keys = set(manifest["arrays"].keys())
    assert keys == _COMMON_KEYS | {"linear_coef", "linear_intercept"}
    # 9 classes -> C(9,2)=36 binary classifiers
    coef_shape = manifest["arrays"]["linear_coef"]["shape"]
    assert coef_shape == [36, HOG_FEAT], f"Unexpected coef shape: {coef_shape}"


def test_save_model_rbf_keys():
    manifest = _train_and_save("rbf")
    assert manifest["classifier_type"] == "rbf"
    keys = set(manifest["arrays"].keys())
    assert keys == _COMMON_KEYS | {"rbf_support_vectors", "rbf_dual_coef",
                                    "rbf_intercept", "rbf_n_support", "rbf_gamma"}
    assert not any(k.startswith("pca") or k.startswith("template") or k == "dims"
                   for k in keys)
