# Bundled Number Recogniser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the joblib-serialised `nums_pca_s.pkl` with a committed `.npz` file so `pip install cagedoku && coach` works out of the box with zero environment variables.

**Architecture:** A new `RBFClassifier` frozen dataclass in `number_recognition.py` implements the `_Classifier` protocol using pure numpy OvO RBF SVM inference (~30 lines). After sklearn SVC training, its internal arrays are extracted into `RBFClassifier` and saved with `numpy.savez_compressed` to `killer_sudoku/data/num_recogniser.npz`. At inference time `make_num_recogniser()` (now no-arg) loads this bundled file via `importlib.resources`, requiring only numpy — not sklearn.

**Tech Stack:** numpy, importlib.resources, scikit-learn (training only), joblib (migration .pkl path only)

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `killer_sudoku/image/number_recognition.py` | Modify | Add `RBFClassifier`, `save_number_recogniser`, update `load_number_recogniser` |
| `killer_sudoku/image/inp_image.py` | Modify | Simplify `make_num_recogniser()` → no-arg, use importlib.resources |
| `killer_sudoku/image/config.py` | Modify | Remove `num_recogniser_file` field and `num_recogniser_path` property |
| `killer_sudoku/api/config.py` | Modify | Remove `num_recogniser_path` field and `COACH_NUM_RECOGNISER_PATH` |
| `killer_sudoku/api/routers/puzzle.py` | Modify | Remove model-path guard + `num_recogniser_file` from `ImagePipelineConfig()` call |
| `killer_sudoku/training/train_number_recogniser.py` | Modify | Extract `RBFClassifier` from SVC, call `save_number_recogniser`, add `--output` flag |
| `killer_sudoku/data/__init__.py` | Create | Makes `data/` a package so importlib.resources can find it |
| `killer_sudoku/data/num_recogniser.npz` | Create (generated) | Committed trained model |
| `tests/image/test_number_recognition.py` | Create | Unit tests: RBF predict, save-load roundtrip, pkl migration |
| `tests/api/test_startup.py` | Modify | Remove `test_upload_returns_500_when_model_not_configured` (obsolete) |
| `pyproject.toml` | Modify | Add `package-data` entry for `.npz` |

---

### Task 1: RBFClassifier + save/load in number_recognition.py

**Files:**
- Modify: `killer_sudoku/image/number_recognition.py`
- Create: `tests/image/test_number_recognition.py`

- [ ] **Step 1: Write failing tests**

Create `tests/image/test_number_recognition.py`:

```python
"""Tests for RBFClassifier, save_number_recogniser, load_number_recogniser."""

from __future__ import annotations

import warnings
from pathlib import Path

import numpy as np
import pytest
from sklearn.svm import SVC  # type: ignore[import-untyped]

from killer_sudoku.image.number_recognition import (
    CayenneNumber,
    RBFClassifier,
    load_number_recogniser,
    save_number_recogniser,
)


def _make_synthetic_svc() -> tuple[SVC, np.ndarray, np.ndarray]:
    """Fit a tiny SVC on synthetic 3-class 5-dim data; return (svc, X, y)."""
    rng = np.random.default_rng(42)
    n_per_class = 20
    X = np.vstack([
        rng.normal(loc=float(c), scale=0.3, size=(n_per_class, 5))
        for c in range(3)
    ])
    y = np.repeat(np.arange(3), n_per_class)
    svc = SVC(kernel="rbf", C=1.0, gamma="scale")
    svc.fit(X, y)
    return svc, X, y


def _make_synthetic_cayenne(tmp_path: Path) -> tuple[CayenneNumber, Path]:
    """Build a minimal CayenneNumber (RBFClassifier) and return it with its path."""
    from sklearn.decomposition import PCA  # type: ignore[import-untyped]

    svc, X, y = _make_synthetic_svc()
    rbf = RBFClassifier.from_svc(svc)

    pca = PCA(n_components=3)
    pca.fit(X)

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
        svc, X, _ = _make_synthetic_svc()
        rbf = RBFClassifier.from_svc(svc)
        sklearn_preds = svc.predict(X)
        rbf_preds = rbf.predict(X.astype(np.float64))
        np.testing.assert_array_equal(rbf_preds, sklearn_preds)

    def test_predict_single_sample(self) -> None:
        """Predict works on a single-row input."""
        svc, X, _ = _make_synthetic_svc()
        rbf = RBFClassifier.from_svc(svc)
        result = rbf.predict(X[:1].astype(np.float64))
        assert result.shape == (1,)


class TestSaveLoadRoundtrip:
    def test_roundtrip_arrays_equal(self, tmp_path: pytest.TempPathFactory) -> None:
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

    def test_roundtrip_predict_identical(self, tmp_path: pytest.TempPathFactory) -> None:
        """Predictions from the loaded model must match the original."""
        svc, X, _ = _make_synthetic_svc()
        model, path = _make_synthetic_cayenne(tmp_path)
        loaded = load_number_recogniser(path)
        orig_preds = model.classifier.predict(X.astype(np.float64))
        loaded_preds = loaded.classifier.predict(X.astype(np.float64))
        np.testing.assert_array_equal(orig_preds, loaded_preds)


class TestPklMigration:
    def test_pkl_loads_and_warns(self, tmp_path: pytest.TempPathFactory) -> None:
        """Loading a .pkl model must succeed and emit DeprecationWarning."""
        import joblib  # type: ignore[import-untyped]
        from sklearn.decomposition import PCA  # type: ignore[import-untyped]

        svc, X, _ = _make_synthetic_svc()
        pca = PCA(n_components=3)
        pca.fit(X)
        old_model = CayenneNumber(pca=pca, dims=3, classifier=svc)
        pkl_path = tmp_path / "old_model.pkl"
        joblib.dump(old_model, pkl_path)

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            loaded = load_number_recogniser(pkl_path)

        assert any(issubclass(w.category, DeprecationWarning) for w in caught)
        assert isinstance(loaded, CayenneNumber)
```

- [ ] **Step 2: Run tests — expect FAIL**

```
python -m pytest tests/image/test_number_recognition.py -v
```

Expected: `ImportError: cannot import name 'RBFClassifier'` and `cannot import name 'save_number_recogniser'`

- [ ] **Step 3: Implement RBFClassifier and save/load**

In `killer_sudoku/image/number_recognition.py`, add these imports at the top (after existing imports, before `ContourInfo`):

```python
import dataclasses
import io
import warnings
```

Replace the entire existing `load_number_recogniser` function (lines ~444-466) and add the new classes/functions. The full additions go between the `_Classifier` Protocol definition and the `contour_hier` function:

```python
@dataclasses.dataclass(frozen=True)
class RBFClassifier:
    """Pure-numpy OvO RBF SVM classifier.

    Extracted from a fitted sklearn SVC so inference requires only numpy.
    Implements the _Classifier protocol.

    Fields mirror sklearn SVC internals:
        support_vectors: (n_sv, n_features) support vectors.
        dual_coef: (n_classes-1, n_sv) dual coefficients.
        intercept: (n_classifiers,) bias terms; n_classifiers = n_classes*(n_classes-1)/2.
        n_support: (n_classes,) number of SVs per class.
        gamma: RBF kernel width.
        classes: (n_classes,) class labels.
    """

    support_vectors: npt.NDArray[np.float64]
    dual_coef: npt.NDArray[np.float64]
    intercept: npt.NDArray[np.float64]
    n_support: npt.NDArray[np.intp]
    gamma: float
    classes: npt.NDArray[np.intp]

    @staticmethod
    def from_svc(svc: Any) -> "RBFClassifier":
        """Extract arrays from a fitted sklearn SVC with kernel='rbf'.

        Args:
            svc: Fitted sklearn SVC instance.

        Returns:
            RBFClassifier with all arrays copied from svc internals.
        """
        return RBFClassifier(
            support_vectors=np.array(svc.support_vectors_, dtype=np.float64),
            dual_coef=np.array(svc.dual_coef_, dtype=np.float64),
            intercept=np.array(svc.intercept_, dtype=np.float64),
            n_support=np.array(svc.n_support_, dtype=np.intp),
            gamma=float(svc._gamma),
            classes=np.array(svc.classes_, dtype=np.intp),
        )

    def predict(self, x: npt.NDArray[np.float64]) -> npt.NDArray[np.intp]:
        """OvO RBF SVM prediction using pure numpy.

        Args:
            x: (n_samples, n_features) query points.

        Returns:
            (n_samples,) predicted class labels.
        """
        sv = self.support_vectors
        # RBF kernel: K[i,j] = exp(-gamma * ||x[i] - sv[j]||^2)
        x_sq = np.sum(x ** 2, axis=1, keepdims=True)       # (n, 1)
        sv_sq = np.sum(sv ** 2, axis=1, keepdims=True).T    # (1, n_sv)
        k = np.exp(-self.gamma * (x_sq + sv_sq - 2.0 * x @ sv.T))  # (n, n_sv)

        n_classes = len(self.classes)
        votes = np.zeros((len(x), n_classes), dtype=np.int32)
        sv_end: npt.NDArray[np.intp] = np.cumsum(self.n_support)
        sv_start: npt.NDArray[np.intp] = np.r_[np.intp(0), sv_end[:-1]]

        clf_idx = 0
        for i in range(n_classes):
            for j in range(i + 1, n_classes):
                si, ei = int(sv_start[i]), int(sv_end[i])
                sj, ej = int(sv_start[j]), int(sv_end[j])
                coef = np.concatenate([
                    self.dual_coef[j - 1, si:ei],
                    self.dual_coef[i, sj:ej],
                ])
                k_sub = np.concatenate([k[:, si:ei], k[:, sj:ej]], axis=1)
                decision = k_sub @ coef + self.intercept[clf_idx]
                votes[:, i] += (decision > 0).astype(np.int32)
                votes[:, j] += (decision <= 0).astype(np.int32)
                clf_idx += 1

        return self.classes[np.argmax(votes, axis=1)]
```

Then replace the existing `load_number_recogniser` function with these two new functions:

```python
def save_number_recogniser(model: CayenneNumber, path: Path) -> None:
    """Save a CayenneNumber model to a compressed .npz file.

    The model's classifier must be an RBFClassifier.  PCA arrays, RBF arrays,
    templates, and scalar parameters are all stored in a single .npz file
    suitable for committing to the repository.

    Args:
        model: Trained CayenneNumber whose classifier is an RBFClassifier.
        path: Destination file path (should end in .npz).

    Raises:
        TypeError: if model.classifier is not an RBFClassifier.
    """
    if not isinstance(model.classifier, RBFClassifier):
        raise TypeError(
            f"save_number_recogniser requires an RBFClassifier; "
            f"got {type(model.classifier).__name__}"
        )
    rbf = model.classifier
    arrays: dict[str, Any] = {
        "pca_components": np.array(model.pca.components_, dtype=np.float64),
        "pca_mean": np.array(model.pca.mean_, dtype=np.float64),
        "dims": np.array(model.dims, dtype=np.int64),
        "rbf_support_vectors": rbf.support_vectors,
        "rbf_dual_coef": rbf.dual_coef,
        "rbf_intercept": rbf.intercept,
        "rbf_n_support": rbf.n_support.astype(np.int64),
        "rbf_gamma": np.array(rbf.gamma, dtype=np.float64),
        "rbf_classes": rbf.classes.astype(np.int64),
        "template_threshold": np.array(model.template_threshold, dtype=np.float64),
    }
    if model.templates is not None:
        for digit, tmpl in model.templates.items():
            arrays[f"template_{digit}"] = np.array(tmpl, dtype=np.float32)
    np.savez_compressed(path, **arrays)


def _load_npz(data: Any) -> CayenneNumber:
    """Reconstruct a CayenneNumber from an open NpzFile.

    Args:
        data: Open numpy NpzFile (from np.load).

    Returns:
        CayenneNumber with RBFClassifier and reconstructed PCA.
    """
    pca: PCA = PCA()
    pca.components_ = data["pca_components"]
    pca.mean_ = data["pca_mean"]
    pca.n_components_ = int(data["pca_components"].shape[0])
    pca.n_features_in_ = int(data["pca_components"].shape[1])

    rbf = RBFClassifier(
        support_vectors=data["rbf_support_vectors"].astype(np.float64),
        dual_coef=data["rbf_dual_coef"].astype(np.float64),
        intercept=data["rbf_intercept"].astype(np.float64),
        n_support=data["rbf_n_support"].astype(np.intp),
        gamma=float(data["rbf_gamma"]),
        classes=data["rbf_classes"].astype(np.intp),
    )

    templates: dict[int, npt.NDArray[np.float32]] | None = None
    template_keys = [k for k in data.files if k.startswith("template_") and k[9:].isdigit()]
    if template_keys:
        templates = {int(k[9:]): data[k].astype(np.float32) for k in template_keys}

    return CayenneNumber(
        pca=pca,
        dims=int(data["dims"]),
        classifier=rbf,
        templates=templates,
        template_threshold=float(data["template_threshold"]),
    )


def load_number_recogniser(model_path: Path) -> CayenneNumber:
    """Load a trained CayenneNumber model from disk.

    Dispatches on file suffix:
      .npz — loads via numpy (no sklearn required at inference).
      .pkl — loads via joblib and emits DeprecationWarning (migration path only).

    Args:
        model_path: Path to the model file (.npz or .pkl).

    Raises:
        ValueError: if the suffix is not .npz or .pkl.
    """
    suffix = model_path.suffix.lower()
    if suffix == ".npz":
        with np.load(model_path) as data:
            return _load_npz(data)
    if suffix == ".pkl":
        warnings.warn(
            f"Loading number recogniser from .pkl ({model_path}) is deprecated. "
            "Re-train with ks-train-numbers to produce a .npz bundle.",
            DeprecationWarning,
            stacklevel=2,
        )
        raw = joblib.load(model_path)
        if hasattr(raw, "neighbs") and not hasattr(raw, "classifier"):
            raw.classifier = raw.neighbs
            raw.templates = None
            raw.template_threshold = 0.85
        result: CayenneNumber = raw
        return result
    raise ValueError(
        f"Unsupported number recogniser format: {model_path.suffix!r}. "
        "Expected .npz or .pkl."
    )
```

Also add `import dataclasses` and `import io` and `import warnings` to the existing imports at the top of `number_recognition.py`. (`io` is needed if we add a streaming load later; `dataclasses` and `warnings` are needed now.)

- [ ] **Step 4: Run tests — expect PASS**

```
python -m pytest tests/image/test_number_recognition.py -v
```

Expected: all 5 tests pass.

- [ ] **Step 5: Run bronze gate**

```
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 6: Commit**

```bash
git add killer_sudoku/image/number_recognition.py tests/image/test_number_recognition.py
git commit -m "feat: add RBFClassifier + .npz save/load for bundled number recogniser

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Update train_number_recogniser.py

**Files:**
- Modify: `killer_sudoku/training/train_number_recogniser.py`

- [ ] **Step 1: Update the training function**

Replace `train_number_recogniser` body from the SVC section onwards. After `svc.fit(...)`, replace:

```python
    model = CayenneNumber(
        pca,
        dims,
        svc,
        templates=templates,
        template_threshold=config.number_recognition.template_threshold,
    )
    joblib.dump(model, config.num_recogniser_path)
    _log.info("Saved number recogniser to %s", config.num_recogniser_path)

    return model
```

With:

```python
    rbf = RBFClassifier.from_svc(svc)
    model = CayenneNumber(
        pca,
        dims,
        rbf,
        templates=templates,
        template_threshold=config.number_recognition.template_threshold,
    )
    save_number_recogniser(model, output_path)
    _log.info("Saved number recogniser to %s", output_path)

    return model
```

And add `output_path: Path` parameter to the function signature:

```python
def train_number_recogniser(
    config: ImagePipelineConfig,
    bootstrap: bool = False,
    output_path: Path | None = None,
) -> CayenneNumber:
```

At the start of the function body, resolve `output_path`:

```python
    if output_path is None:
        output_path = Path(__file__).parent.parent / "data" / "num_recogniser.npz"
```

Update imports at top of `train_number_recogniser.py` — remove `joblib`, add `RBFClassifier` and `save_number_recogniser`:

```python
# Remove:
import joblib  # type: ignore[import-untyped]

# Change import from number_recognition to:
from killer_sudoku.image.number_recognition import (
    CayenneNumber,
    RBFClassifier,
    save_number_recogniser,
)
```

- [ ] **Step 2: Add --output flag to main()**

```python
    parser.add_argument(
        "--output",
        default=None,
        help=(
            "Output path for the .npz model file. "
            "Default: killer_sudoku/data/num_recogniser.npz"
        ),
    )
```

And in `main()`, pass it:

```python
    output_path = Path(args.output) if args.output else None
    train_number_recogniser(config, bootstrap=args.bootstrap, output_path=output_path)
```

- [ ] **Step 3: Update docstring**

Update `train_number_recogniser` docstring line:
```
    Returns:
        Trained CayenneNumber model (also saved to output_path).
```

- [ ] **Step 4: Run bronze gate**

```
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 5: Commit**

```bash
git add killer_sudoku/training/train_number_recogniser.py
git commit -m "feat: train_number_recogniser extracts RBFClassifier and saves .npz

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Create data/ package and generate committed .npz

**Files:**
- Create: `killer_sudoku/data/__init__.py`
- Create: `killer_sudoku/data/num_recogniser.npz` (generated)
- Modify: `pyproject.toml`

- [ ] **Step 1: Create the data package**

Create `killer_sudoku/data/__init__.py` as an empty file (one line):

```python
"""Bundled model data for the cagedoku package."""
```

- [ ] **Step 2: Add package-data entry to pyproject.toml**

In `[tool.setuptools.packages.find]`, add a sibling section:

```toml
[tool.setuptools.package-data]
"killer_sudoku.data" = ["*.npz"]
```

- [ ] **Step 3: Run training to generate the .npz**

You need a directory containing `numerals.pkl` (or `bootstrap_numerals.pkl`). Run:

```bash
python -m killer_sudoku.training.train_number_recogniser --puzzle-dir <dir-with-numerals>
```

This writes to `killer_sudoku/data/num_recogniser.npz` by default.

If you have an existing `nums_pca_s.pkl` and no `numerals.pkl`, you can verify the migration path works and skip generating a new .npz until real training data is available. The bundled .npz must exist for `make_num_recogniser()` to work; commit a placeholder if needed (see next task).

- [ ] **Step 4: Commit**

```bash
git add killer_sudoku/data/__init__.py killer_sudoku/data/num_recogniser.npz pyproject.toml
git commit -m "feat: add killer_sudoku/data package with bundled num_recogniser.npz

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Simplify make_num_recogniser (no-arg, importlib.resources)

**Files:**
- Modify: `killer_sudoku/image/inp_image.py`
- Modify: `killer_sudoku/main.py`
- Modify: `killer_sudoku/training/evaluate.py`
- Modify: `killer_sudoku/training/collect_numerals.py`
- Modify: `killer_sudoku/api/routers/puzzle.py` (partial — full cleanup in Task 5)

- [ ] **Step 1: Write failing test**

Add to `tests/image/test_number_recognition.py`:

```python
class TestMakeNumRecogniser:
    def test_loads_bundled_model(self) -> None:
        """make_num_recogniser() with no args loads the bundled .npz."""
        from killer_sudoku.image.inp_image import InpImage

        model = InpImage.make_num_recogniser()
        assert isinstance(model, CayenneNumber)
        assert isinstance(model.classifier, RBFClassifier)
```

- [ ] **Step 2: Run — expect FAIL**

```
python -m pytest tests/image/test_number_recognition.py::TestMakeNumRecogniser -v
```

Expected: `TypeError: make_num_recogniser() takes 1 positional argument but 0 were given` (or similar).

- [ ] **Step 3: Update make_num_recogniser in inp_image.py**

Add import at top of `inp_image.py`:

```python
from importlib.resources import files
```

Replace the existing `make_num_recogniser` static method:

```python
    @staticmethod
    def make_num_recogniser() -> CayenneNumber:
        """Load the bundled number recogniser model from the package data.

        Uses importlib.resources so the model is found whether the package is
        installed normally or as an editable install.

        Returns:
            Loaded CayenneNumber classifier.
        """
        resource = files("killer_sudoku.data").joinpath("num_recogniser.npz")
        with resource.open("rb") as fh:
            return load_number_recogniser_stream(fh)
```

Add a new helper function in `number_recognition.py` (exported) that loads from a binary stream:

```python
def load_number_recogniser_stream(fh: Any) -> CayenneNumber:
    """Load a CayenneNumber from a binary stream containing .npz data.

    Used by make_num_recogniser() to load from the importlib.resources
    Traversable without materialising a filesystem path.

    Args:
        fh: Binary file-like object containing .npz data.

    Returns:
        CayenneNumber with RBFClassifier.
    """
    with np.load(io.BytesIO(fh.read())) as data:
        return _load_npz(data)
```

Then update `make_num_recogniser` import in `inp_image.py` to also import `load_number_recogniser_stream`.

- [ ] **Step 4: Update all callers (remove config argument)**

In `killer_sudoku/main.py` line ~55:
```python
# Before:
num_recogniser = InpImage.make_num_recogniser(config)
# After:
num_recogniser = InpImage.make_num_recogniser()
```

In `killer_sudoku/training/evaluate.py` (two occurrences):
```python
# Before:
num_recogniser = InpImage.make_num_recogniser(config)
# After:
num_recogniser = InpImage.make_num_recogniser()
```

In `killer_sudoku/training/collect_numerals.py` line ~279:
```python
# Before:
num_recogniser = InpImage.make_num_recogniser(config)
# After:
num_recogniser = InpImage.make_num_recogniser()
```

In `killer_sudoku/api/routers/puzzle.py` line ~717 (full guard removal in Task 5, but update the call for now):
```python
# Before:
num_recogniser = InpImage.make_num_recogniser(img_config)
# After:
num_recogniser = InpImage.make_num_recogniser()
```

- [ ] **Step 5: Run tests — expect PASS**

```
python -m pytest tests/image/test_number_recognition.py -v
```

- [ ] **Step 6: Run bronze gate**

```
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 7: Commit**

```bash
git add killer_sudoku/image/inp_image.py killer_sudoku/image/number_recognition.py \
        killer_sudoku/main.py killer_sudoku/training/evaluate.py \
        killer_sudoku/training/collect_numerals.py killer_sudoku/api/routers/puzzle.py
git commit -m "feat: make_num_recogniser() loads bundled .npz via importlib.resources

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Remove config fields + clean up puzzle.py + test_startup.py

**Files:**
- Modify: `killer_sudoku/image/config.py`
- Modify: `killer_sudoku/api/config.py`
- Modify: `killer_sudoku/api/routers/puzzle.py`
- Modify: `tests/api/test_startup.py`

- [ ] **Step 1: Remove num_recogniser_file from ImagePipelineConfig**

In `killer_sudoku/image/config.py`, remove:

```python
    num_recogniser_file: Path | None = None
    """Explicit path to the number recogniser model (nums_pca_s.pkl).

    When set, overrides the fallback to ``puzzle_dir / "nums_pca_s.pkl"``.
    """
```

Remove the `num_recogniser_path` property (lines ~224-241):

```python
    @property
    def num_recogniser_path(self) -> Path:
        """Path to the number recogniser model file.
        ...
        """
        if self.num_recogniser_file is not None:
            return self.num_recogniser_file
        if self.puzzle_dir is not None:
            return self.puzzle_dir / "nums_pca_s.pkl"
        raise ValueError(
            "Either num_recogniser_file or puzzle_dir must be set "
            "to resolve the number recogniser model path."
        )
```

Update the `ImagePipelineConfig` docstring to remove references to `num_recogniser_file`.

- [ ] **Step 2: Remove num_recogniser_path from CoachConfig**

In `killer_sudoku/api/config.py`, remove:

```python
    num_recogniser_path: Path | None = dataclasses.field(
        default_factory=lambda: Path(v)
        if (v := os.environ.get("COACH_NUM_RECOGNISER_PATH"))
        else None
    )
```

Remove the `COACH_NUM_RECOGNISER_PATH` documentation from the module docstring.

Remove references to `num_recogniser_path` from the `CoachConfig` class docstring.

- [ ] **Step 3: Clean up puzzle.py**

In `killer_sudoku/api/routers/puzzle.py`, remove the entire guard block and the `img_config` line with `num_recogniser_file`:

```python
# Remove this entire block:
            if config.num_recogniser_path is None:
                raise HTTPException(
                    status_code=500,
                    detail=(
                        "Number recogniser model not configured. "
                        "Set the COACH_NUM_RECOGNISER_PATH environment variable "
                        "to the path of nums_pca_s.pkl."
                    ),
                )
            img_config = ImagePipelineConfig(
                num_recogniser_file=config.num_recogniser_path,
                rework=True,
            )
            try:
                num_recogniser = InpImage.make_num_recogniser(img_config)
            except FileNotFoundError as exc:
                raise HTTPException(
                    status_code=500,
                    detail=(
                        f"Number recogniser model not found at "
                        f"{config.num_recogniser_path}. ({exc})"
                    ),
                ) from exc
```

Replace with:

```python
            img_config = ImagePipelineConfig(rework=True)
            num_recogniser = InpImage.make_num_recogniser()
```

Remove `from killer_sudoku.image.config import ImagePipelineConfig` if it becomes unused (check with grep first). It is likely still used for `ImagePipelineConfig(rework=True)`, so keep it.

- [ ] **Step 4: Remove obsolete test from test_startup.py**

In `tests/api/test_startup.py`, remove the entire `TestUploadEndpointWithoutModel` class (lines ~72-99).

Also update `test_coach_config_defaults_without_env_vars` — remove the assertion `assert cfg.num_recogniser_path is None` since that field no longer exists:

```python
    def test_coach_config_defaults_without_env_vars(self) -> None:
        """CoachConfig() must succeed with no env vars set."""
        coach_keys = [k for k in os.environ if k.startswith("COACH_")]
        saved = {k: os.environ.pop(k) for k in coach_keys}
        try:
            cfg = CoachConfig()
            assert cfg.sessions_dir is not None
        finally:
            os.environ.update(saved)
```

- [ ] **Step 5: Run bronze gate**

```
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 6: Commit**

```bash
git add killer_sudoku/image/config.py killer_sudoku/api/config.py \
        killer_sudoku/api/routers/puzzle.py tests/api/test_startup.py
git commit -m "refactor: remove num_recogniser path config — model now bundled in package

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Final verification

- [ ] **Step 1: Silver gate**

```
python -m ruff check killer_sudoku/
python -m mypy --strict killer_sudoku/
```

Both must pass with zero errors.

- [ ] **Step 2: Verify coach starts without env vars**

```bash
python -c "from killer_sudoku.api.app import serve, create_app; print('ok')"
```

Expected: `ok`

- [ ] **Step 3: Verify bundled model loads**

```bash
python -c "from killer_sudoku.image.inp_image import InpImage; m = InpImage.make_num_recogniser(); print('loaded', type(m).__name__)"
```

Expected: `loaded CayenneNumber`
