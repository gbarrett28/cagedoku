"""Tests for RBFClassifier, save_number_recogniser, load_number_recogniser."""

from __future__ import annotations

import warnings
from pathlib import Path

import joblib  # type: ignore[import-untyped]
import numpy as np
import pytest
from sklearn.decomposition import PCA  # type: ignore[import-untyped]
from sklearn.svm import SVC  # type: ignore[import-untyped]

from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.image.number_recognition import (
    CayenneNumber,
    RBFClassifier,
    load_number_recogniser,
    save_number_recogniser,
)


def _make_synthetic_svc() -> tuple[SVC, np.ndarray, np.ndarray]:
    """Fit a tiny SVC on synthetic 3-class 5-dim data; return (svc, x_data, y)."""
    rng = np.random.default_rng(42)
    n_per_class = 20
    x_data = np.vstack(
        [rng.normal(loc=float(c), scale=0.3, size=(n_per_class, 5)) for c in range(3)]
    )
    y = np.repeat(np.arange(3), n_per_class)
    svc = SVC(kernel="rbf", C=1.0, gamma="scale")
    svc.fit(x_data, y)
    return svc, x_data, y


def _make_synthetic_cayenne(tmp_path: Path) -> tuple[CayenneNumber, Path]:
    """Build a minimal CayenneNumber (RBFClassifier), save it, return (model, path)."""
    svc, x_data, _ = _make_synthetic_svc()
    rbf = RBFClassifier.from_svc(svc)

    pca = PCA(n_components=3)
    pca.fit(x_data)

    templates = {i: np.zeros((8, 8), dtype=np.float32) for i in range(10)}
    model = CayenneNumber(
        pca=pca,
        dims=3,
        classifier=rbf,
        templates=templates,
        template_threshold=0.85,
    )
    path = tmp_path / "test_model.npz"
    save_number_recogniser(model, path)
    return model, path


class TestRBFClassifier:
    def test_predict_matches_sklearn(self) -> None:
        """RBFClassifier.predict must return identical labels to sklearn SVC."""
        svc, x_data, _ = _make_synthetic_svc()
        rbf = RBFClassifier.from_svc(svc)
        sklearn_preds = svc.predict(x_data)
        rbf_preds = rbf.predict(x_data.astype(np.float64))
        np.testing.assert_array_equal(rbf_preds, sklearn_preds)

    def test_predict_single_sample(self) -> None:
        """Predict works on a single-row input."""
        svc, x_data, _ = _make_synthetic_svc()
        rbf = RBFClassifier.from_svc(svc)
        result = rbf.predict(x_data[:1].astype(np.float64))
        assert result.shape == (1,)


class TestSaveLoadRoundtrip:
    def test_roundtrip_arrays_equal(self, tmp_path: Path) -> None:
        """Arrays in the loaded model must equal those in the saved model."""
        model, path = _make_synthetic_cayenne(tmp_path)
        loaded = load_number_recogniser(path)
        assert isinstance(loaded.classifier, RBFClassifier)
        orig = model.classifier
        loaded_rbf = loaded.classifier
        assert isinstance(orig, RBFClassifier)
        np.testing.assert_array_equal(orig.support_vectors, loaded_rbf.support_vectors)
        np.testing.assert_array_equal(orig.dual_coef, loaded_rbf.dual_coef)
        np.testing.assert_array_equal(orig.intercept, loaded_rbf.intercept)
        assert orig.gamma == pytest.approx(loaded_rbf.gamma)

    def test_roundtrip_predict_identical(self, tmp_path: Path) -> None:
        """Predictions from the loaded model must match the original."""
        svc, x_data, _ = _make_synthetic_svc()
        model, path = _make_synthetic_cayenne(tmp_path)
        loaded = load_number_recogniser(path)
        orig_preds = model.classifier.predict(x_data.astype(np.float64))
        loaded_preds = loaded.classifier.predict(x_data.astype(np.float64))
        assert isinstance(orig_preds, np.ndarray)
        assert isinstance(loaded_preds, np.ndarray)
        np.testing.assert_array_equal(orig_preds, loaded_preds)


class TestMakeNumRecogniser:
    def test_loads_bundled_model(self) -> None:
        """make_num_recogniser() with no args loads the bundled .npz."""
        model = InpImage.make_num_recogniser()
        assert isinstance(model, CayenneNumber)
        assert isinstance(model.classifier, RBFClassifier)


class TestPklMigration:
    def test_pkl_loads_and_warns(self, tmp_path: Path) -> None:
        """Loading a .pkl model must succeed and emit DeprecationWarning."""
        svc, x_data, _ = _make_synthetic_svc()
        pca = PCA(n_components=3)
        pca.fit(x_data)
        old_model = CayenneNumber(pca=pca, dims=3, classifier=svc)
        pkl_path = tmp_path / "old_model.pkl"
        joblib.dump(old_model, pkl_path)

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            loaded = load_number_recogniser(pkl_path)

        assert any(issubclass(w.category, DeprecationWarning) for w in caught)
        assert isinstance(loaded, CayenneNumber)
