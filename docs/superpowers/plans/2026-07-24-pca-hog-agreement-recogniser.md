# PCA/HOG Agreement Ground-Truth & Recogniser Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a training set whose labels are corroborated two independent
ways (PCA+RBF and a recovered historical HOG+hole-feature model agree on
every digit, **and** the puzzle solves cleanly — a strong, non-tautological
signal for killer specifically, since a genuine misread almost always breaks
solvability outright rather than producing a different valid grid), sample it
into a balanced 100-per-digit set across all four corpus/type combinations,
train four PCA/HOG × stretch/letterbox combinations on it, and evaluate all
four against both a same-distribution holdout and a cross-font holdout to see
which combination is most accurate *and* most robust to fonts never seen in
training.

**Architecture:** Reuses as much already-working code as possible rather than
reimplementing:
- `killer_sudoku.image.number_recognition` (contour finding, digit splitting,
  `RBFClassifier`, `paint_mask`) for locating and warping digit crops.
- `web/train_recogniser.py`'s existing `PcaRbfRecogniser`/`HogRecogniser`
  classes (`warp_from_rect`, `extract_features`, `fit`) — this script already
  has bit-exact-matching stretch and letterbox geometries and a numba-JIT HOG
  + hole-count feature extractor (`extract_hog`, `extract_hole_features`),
  built specifically to produce TS-compatible models. It has no `load()`,
  only `save()` — Task 1 adds loading.
- The `NumberSource` Protocol and `collect_status`'s injectable recogniser
  parameter (`killer_sudoku/training/evaluate.py`), kept from the Tesseract
  validation gate specifically for this kind of substitution.

**Tech Stack:** Python 3.12, existing `killer_sudoku` package + `web/train_recogniser.py` (numba, scikit-learn, Pillow, matplotlib font discovery).

## Global Constraints

- Stay Python-only — no `web/` TypeScript or shipped-app changes. Importing
  from `web/train_recogniser.py` (a Python script) is in scope; nothing under
  `web/src/` is touched. Wiring a winning combination into the shipped app is
  a separate follow-up plan once we know which one wins.
- Never write into `guardian/`/`observer/` directly — the crop-locating and
  agreement-checking tasks only *read* those directories (`InpImage(...,
  rework=False)` uses cached `.jpk` where present; where it doesn't, it reads
  and processes in memory without persisting `.jpk`/`status.pkl` changes back
  unless `config.rework=True` is explicitly passed. Do not pass
  `rework=True` against the live corpus directories in this plan — always
  copy to scratch first if a fresh read is needed, matching the practice
  established in the Tesseract validation gate).
- All new/modified `.py` files must pass `ruff check` and `mypy` per
  `pyproject.toml`.
- `killer_sudoku` cage-total digits span classes 0-9; classic given digits
  span 1-9 only (0 is never a valid sudoku digit). Balanced sampling targets
  differ accordingly per sub-corpus.
- Importing from `web/train_recogniser.py` (outside the `killer_sudoku`
  package) requires adding `web/` to `sys.path` at import time — do this once,
  in one place (Task 1's loader module), not repeated ad hoc in every file.
- **On "magnifying killer digits" for a unified recogniser:** not a separate
  task. Both cage-total and given-digit crops already warp to the same 64x64
  canonical canvas (`get_warp_from_rect`/`PcaRbfRecogniser.warp_from_rect`,
  `letterboxWarp`/`HogRecogniser.warp_from_rect`), confirmed during this
  plan's design discussion — the open question was whether that was already
  true, not a missing step to add.

---

## Task 1: Recover the historical HOG model and add a Python loader

**Files:**
- Create: `killer_sudoku/data/hog_recogniser_99cbb70.bin`, `killer_sudoku/data/hog_recogniser_99cbb70.json` (recovered from git history, binary — not human-diffable, committed as data like `num_recogniser.npz`)
- Create: `killer_sudoku/training/hog_model_loader.py`
- Test: `tests/test_hog_model_loader.py`

**Interfaces:**
- Consumes: `RBFClassifier` from `killer_sudoku.image.number_recognition` (reused as-is for the `classifier_type == 'rbf'` case — it's already a generic OvO-RBF-SVM predictor over raw feature vectors, not PCA-specific).
- Produces: `LinearOvOClassifier` class with `.predict(x: npt.NDArray[np.float64]) -> npt.NDArray[np.intp]` (mirrors TS `linearPredict`/`ovoVote`). `load_hog_classifier(bin_path: Path, json_path: Path) -> tuple[HOGParams, LinearOvOClassifier | RBFClassifier, float]` returning `(hog_params, classifier, confidence_threshold)`. `HogNumber` class satisfying `NumberSource` (`get_sums(nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]`), constructed from a loaded classifier + a `warp_from_rect`-compatible geometry function.

- [x] **Step 1: Recover the model files from git history**

```bash
git show 99cbb70:web/public/num_recogniser.bin > killer_sudoku/data/hog_recogniser_99cbb70.bin
git show 99cbb70:web/public/num_recogniser.json > killer_sudoku/data/hog_recogniser_99cbb70.json
```

Inspect the JSON manifest to confirm `classifier_type` (expected `"linear"`,
per the commit message's "linear OVO boundary" and "LinearSVC" references):

```bash
python -c "import json; print(json.load(open('killer_sudoku/data/hog_recogniser_99cbb70.json'))['classifier_type'])"
```

- [x] **Step 2: Write the failing test for the OvO linear classifier**

```python
# tests/test_hog_model_loader.py
import numpy as np

from killer_sudoku.training.hog_model_loader import LinearOvOClassifier


def test_linear_ovo_classifier_two_class_separable() -> None:
    # 3 classes, 2 features, trivially separable by feature 0's sign/magnitude.
    # OvO for 3 classes = 3 binary classifiers, decision_function sign convention
    # matches sklearn's SVC(decision_function_shape='ovo'): classifier k separates
    # class i (positive) from class j (negative) for pair (i, j) with i < j.
    classifier = LinearOvOClassifier(
        coef=np.array([
            [1.0, 0.0],   # separates class 0 vs class 1
            [1.0, 0.0],   # separates class 0 vs class 2
            [1.0, 0.0],   # separates class 1 vs class 2
        ]),
        intercept=np.array([0.0, 0.0, 0.0]),
        classes=np.array([0, 1, 2]),
        n_classifiers=3,
        n_features=2,
    )
    # class 0 samples: feature0 strongly positive
    x = np.array([[10.0, 0.0], [-10.0, 0.0], [0.1, 0.0]])
    labels = classifier.predict(x)
    assert labels[0] == 0  # strongly positive -> class 0 side of both its pairs
    assert labels.shape == (3,)
```

(This test only pins down the shape/plumbing since a fully worked-out 3-class
OvO vote by hand is fiddly — Step 4's real-data validation is the test that
actually matters for correctness.)

- [x] **Step 3: Run test to verify it fails**

Run: `python -m pytest tests/test_hog_model_loader.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [x] **Step 4: Implement the loader and classifier**

```python
# killer_sudoku/training/hog_model_loader.py
"""Loads the historical letterbox-HOG recogniser (git commit 99cbb70) for use
as an independent second opinion in the PCA/HOG agreement gate.

web/train_recogniser.py has HogRecogniser.save() but no load() — this is the
missing inverse, plus a from-scratch OvO linear-SVM predictor (TS's
linearPredict/ovoVote have no Python equivalent; RBFClassifier in
killer_sudoku.image.number_recognition already covers the RBF case generically).
"""

import dataclasses
import json
import sys
from collections.abc import Callable
from pathlib import Path

import numpy as np
import numpy.typing as npt

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "web"))
from train_recogniser import extract_hog, extract_hole_features  # noqa: E402

from killer_sudoku.image.number_recognition import NumberSource, RBFClassifier  # noqa: E402


@dataclasses.dataclass(frozen=True)
class LinearOvOClassifier:
    """Pure-numpy one-vs-one linear SVM classifier (mirrors TS linearPredict/ovoVote).

    Attributes:
        coef: (n_classifiers, n_features) weight rows, one per class pair (i, j) with i < j.
        intercept: (n_classifiers,) bias per pair.
        classes: (n_classes,) class labels.
        n_classifiers: n_classes * (n_classes - 1) // 2.
        n_features: feature vector length.
    """

    coef: npt.NDArray[np.float64]
    intercept: npt.NDArray[np.float64]
    classes: npt.NDArray[np.intp]
    n_classifiers: int
    n_features: int

    def predict(self, x: npt.NDArray[np.float64]) -> npt.NDArray[np.intp]:
        n_samples = x.shape[0]
        n_classes = len(self.classes)
        votes = np.zeros((n_samples, n_classes), dtype=np.int32)
        clf_idx = 0
        for i in range(n_classes):
            for j in range(i + 1, n_classes):
                decision = x @ self.coef[clf_idx] + self.intercept[clf_idx]
                votes[:, i] += (decision > 0).astype(np.int32)
                votes[:, j] += (decision <= 0).astype(np.int32)
                clf_idx += 1
        return self.classes[np.argmax(votes, axis=1)]


@dataclasses.dataclass(frozen=True)
class HOGParams:
    win_size: int
    cell_size: int
    block_size: int
    block_stride: int
    nbins: int


def load_hog_classifier(
    bin_path: Path, json_path: Path
) -> tuple[HOGParams, LinearOvOClassifier | RBFClassifier, float]:
    """Load a HOG+hole-feature model from the TS .bin/.json export format."""
    manifest = json.loads(json_path.read_text(encoding="utf-8"))
    arrays = manifest["arrays"]
    blob = bin_path.read_bytes()

    def get(name: str, dtype: str) -> npt.NDArray[np.generic]:
        meta = arrays[name]
        np_dtype = {"int32": np.int32, "float64": np.float64}[dtype]
        return np.frombuffer(
            blob, dtype=np_dtype, count=meta["byteLength"] // np.dtype(np_dtype).itemsize,
            offset=meta["offset"],
        ).reshape(meta["shape"])

    hog_params = HOGParams(
        win_size=int(get("hog_win_size", "int32")[0]),
        cell_size=int(get("hog_cell_size", "int32")[0]),
        block_size=int(get("hog_block_size", "int32")[0]),
        block_stride=int(get("hog_block_stride", "int32")[0]),
        nbins=int(get("hog_nbins", "int32")[0]),
    )
    confidence_threshold = float(get("confidence_threshold", "float64")[0])
    classifier_type = manifest.get("classifier_type", "rbf")

    classifier: LinearOvOClassifier | RBFClassifier
    if classifier_type == "linear":
        coef = get("linear_coef", "float64")
        classifier = LinearOvOClassifier(
            coef=coef,
            intercept=get("linear_intercept", "float64"),
            classes=get("classes", "int32").astype(np.intp),
            n_classifiers=coef.shape[0],
            n_features=coef.shape[1],
        )
    else:
        classifier = RBFClassifier(
            support_vectors=get("rbf_support_vectors", "float64"),
            dual_coef=get("rbf_dual_coef", "float64"),
            intercept=get("rbf_intercept", "float64"),
            n_support=get("rbf_n_support", "int32").astype(np.intp),
            gamma=float(get("rbf_gamma", "float64")[0]),
            classes=get("classes", "int32").astype(np.intp),
        )
    return hog_params, classifier, confidence_threshold


class HogNumber:
    """NumberSource backed by the recovered historical HOG+hole-feature model."""

    def __init__(
        self,
        hog_params: HOGParams,
        classifier: LinearOvOClassifier | RBFClassifier,
        warp_fn: Callable[[npt.NDArray[np.uint8]], npt.NDArray[np.uint8]],
    ) -> None:
        self._hog_params = hog_params
        self._classifier = classifier
        self._warp_fn = warp_fn

    def get_sums(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        if not nums:
            return np.array([], dtype=np.intp)
        warped = np.stack([self._warp_fn(img) for img in nums])
        hog_feat = extract_hog(warped)
        hole_feat = extract_hole_features(warped)
        features = np.hstack([hog_feat, hole_feat])
        return self._classifier.predict(features)
```

- [x] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_hog_model_loader.py -v`
Expected: PASS

- [x] **Step 6: Validate against the documented historical accuracy floor**

This is the step that actually matters — confirming the recovered model,
loaded through this new Python path, reproduces its own documented accuracy
rather than silently loading garbage.

```python
# tests/test_hog_model_loader.py (append)
import json as _json
from pathlib import Path

from killer_sudoku.training.hog_model_loader import HogNumber, load_hog_classifier


def _stretch_warp(img: "np.ndarray") -> "np.ndarray":
    # Matches PcaRbfRecogniser.warp_from_rect's geometry but the crop is
    # already a fixed-size thumbnail here, so this is just a passthrough —
    # browser_train.json's samples are pre-warped 64x64 thumbnails already.
    return img


def test_recovered_hog_model_matches_documented_accuracy() -> None:
    hog_params, classifier, threshold = load_hog_classifier(
        Path("killer_sudoku/data/hog_recogniser_99cbb70.bin"),
        Path("killer_sudoku/data/hog_recogniser_99cbb70.json"),
    )
    recogniser = HogNumber(hog_params, classifier, _stretch_warp)

    data = _json.loads(Path("web/browser_train.json").read_text(encoding="utf-8"))
    # Adjust the field names below to match browser_train.json's actual schema
    # (inspect it first — this plan assumes a {"samples": [{"label": int,
    # "pixels": [...64*64 ints...]}, ...]} shape typical of this codebase's
    # exported training files; confirm and adjust before running).
    labels = np.array([s["label"] for s in data["samples"]], dtype=np.intp)
    imgs = [
        np.array(s["pixels"], dtype=np.uint8).reshape(64, 64) for s in data["samples"]
    ]
    predictions = recogniser.get_sums(imgs)
    correct = int((predictions == labels).sum())
    total = len(labels)
    accuracy = correct / total
    print(f"Recovered HOG model: {correct}/{total} ({accuracy:.4f})")
    # Commit message documents 8355/8362 (99.92%) as the known-permanent floor.
    # Allow a small tolerance for warp/preprocessing differences in this port.
    assert accuracy >= 0.95, f"Recovered model only {accuracy:.4f} — loader or port is wrong"
```

Before running: read `web/browser_train.json`'s actual top-level structure
(`python -c "import json; d=json.load(open('web/browser_train.json')); print(list(d.keys()) if isinstance(d,dict) else type(d))"`)
and adjust the field-access code above to match — don't guess blindly, the
schema comment above is this plan's best guess, not a confirmed fact.

Run: `python -m pytest tests/test_hog_model_loader.py -v -s`
Expected: PASS, with printed accuracy close to 99.9%. If it's dramatically
lower (e.g. under 90%), stop and debug the loader/feature-extraction before
proceeding to Task 2 — a faithfulness failure here invalidates everything
downstream.

- [x] **Step 7: Run mypy, ruff, full fast suite**

```bash
python -m ruff check killer_sudoku tests
python -m mypy . --ignore-missing-imports
python -m pytest tests -q
```

- [x] **Step 8: Commit**

```bash
git add killer_sudoku/data/hog_recogniser_99cbb70.bin killer_sudoku/data/hog_recogniser_99cbb70.json killer_sudoku/training/hog_model_loader.py tests/test_hog_model_loader.py
git commit -m "feat: recover historical HOG+hole-feature model with a Python loader"
```

---

## Task 2: Raw digit-rect locator (geometry-independent)

**Files:**
- Create: `killer_sudoku/training/digit_rects.py`
- Test: `tests/test_digit_rects.py`

**Interfaces:**
- Consumes: `contour_hier`, `get_num_contours`, `contour_is_number` from `killer_sudoku.image.number_recognition`; `find_peaks` from scipy (same as `split_num`).
- Produces: `DigitRect` dataclass (`row: int, col: int, rect: npt.NDArray[np.float32]` — the 4-corner source quad, same shape `get_warp_from_rect` expects). `locate_cage_total_rects(warped_blk, subres) -> list[DigitRect]` and `locate_classic_digit_rects(warped_blk, subres, classic_conf) -> list[DigitRect]`.

The existing production code (`InpImage._build_cage_totals`, `split_num`,
`read_classic_digits`) warps digits to a fixed thumbnail *inside* the same
function that locates them, with the geometry hardcoded. This task extracts
just the *locating* half so Task 4 can apply either warp geometry
afterward — without touching the production functions (per this repo's
"don't scope-creep production code for a one-off experiment" convention).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_digit_rects.py
from pathlib import Path

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.training.digit_rects import locate_cage_total_rects


def test_locate_cage_total_rects_matches_production_digit_count() -> None:
    config = ImagePipelineConfig(puzzle_dir=Path("guardian"), rework=False)
    inp = InpImage(Path("guardian/killer_sudoku_0.jpg"), config, InpImage.make_num_recogniser())
    assert inp.spec_error is None

    rects = locate_cage_total_rects(inp.warped_img, config.subres)
    # Every non-zero cage total's digit count should have a matching rect count;
    # cross-check the total number of rects against the sum of digit-string
    # lengths implied by the production-read cage_totals grid.
    expected_digit_count = sum(len(str(t)) for t in inp.info.cage_totals.flatten() if t > 0)
    assert len(rects) == expected_digit_count
```

(`inp.warped_img` — confirm this attribute name matches `InpImage.__init__`;
it was seen as `self.warped_img` in that constructor during earlier work this
session. If `locate_cage_total_rects` needs the *thresholded binary* image
rather than the raw warped grayscale, use `warped_blk`-equivalent instead —
check which one `_build_cage_totals` actually receives before finalizing this
test, since production code reads `self.info.cage_totals` from a binary
`warped_blk`, not `warped_img` directly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_digit_rects.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement, adapting `_build_cage_totals`'s locating half**

```python
# killer_sudoku/training/digit_rects.py
"""Locates digit bounding rects without warping them to any particular
geometry — Task 4 applies stretch or letterbox afterward, independently.
"""

import dataclasses

import cv2
import numpy as np
import numpy.typing as npt
from scipy.signal import find_peaks

from killer_sudoku.image.number_recognition import (
    contour_hier,
    contour_is_number,
    get_num_contours,
)


@dataclasses.dataclass(frozen=True)
class DigitRect:
    row: int
    col: int
    rect: npt.NDArray[np.float32]  # (4, 2) source corners, order matches get_warp_from_rect


def _split_rect(
    br: tuple[int, int, int, int], warped_blk: npt.NDArray[np.uint8], subres: int
) -> list[npt.NDArray[np.float32]]:
    """Split a bounding rect that may contain 1-2 digits into per-digit source quads.

    Mirrors split_num's peak-finding logic but returns source quads instead of
    pre-warped thumbnails.
    """
    x, y, w, h = br
    ys = np.argmax(warped_blk[y : y + h, x : x + w], axis=0)
    peaks, _ = find_peaks(ys, height=4)
    valid_peaks = [
        p
        for p in peaks.tolist()
        if contour_is_number((x, y, p, h), subres)
        and contour_is_number((x + p, y, w - p, h), subres)
    ]

    rects: list[tuple[int, int, int, int]] = []
    if not valid_peaks:
        rects.append((x, y, w, h))
    else:
        sp = valid_peaks[-1]
        rects.append((x, y, sp, h))
        rects.append((x + sp, y, w - sp, h))

    return [
        np.array([[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]], dtype=np.float32)
        for rx, ry, rw, rh in rects
    ]


def locate_cage_total_rects(
    warped_blk: npt.NDArray[np.uint8], subres: int
) -> list[DigitRect]:
    """Locate every cage-total digit's source rect, grouped by (row, col) cell."""
    contours_raw, hiers_raw = cv2.findContours(
        warped_blk, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE
    )
    if hiers_raw is None:
        return []
    [hier_raw] = hiers_raw
    chiers = contour_hier(
        list(zip([np.asarray(c) for c in contours_raw], [np.asarray(r) for r in hier_raw], strict=False)),
        set(),
    )
    raw_nums = get_num_contours(chiers, subres)

    out: list[DigitRect] = []
    for _c, br, _ds in sorted(raw_nums, key=lambda ch: ch[1][0]):
        bx, by, bw, bh = br
        col = (bx + bw // 2) // subres
        row = (by + bh // 2) // subres
        if not (0 <= col < 9 and 0 <= row < 9):
            continue
        for rect in _split_rect(br, warped_blk, subres):
            out.append(DigitRect(row=row, col=col, rect=rect))
    return out


def locate_classic_digit_rects(
    warped_blk: npt.NDArray[np.uint8], subres: int, classic_conf: npt.NDArray[np.float64]
) -> list[DigitRect]:
    """Locate every pre-filled classic-sudoku digit's source rect."""
    out: list[DigitRect] = []
    for r in range(9):
        for c in range(9):
            if classic_conf[r, c] == 0.0:
                continue
            half = subres // 2
            y0 = r * subres + subres // 4
            x0 = c * subres + subres // 4
            patch = warped_blk[y0 : y0 + half, x0 : x0 + half]
            cnts_raw, _ = cv2.findContours(patch, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not cnts_raw:
                continue
            largest = max((np.asarray(cnt) for cnt in cnts_raw), key=cv2.contourArea)
            bx, by, bw, bh = cv2.boundingRect(largest)
            if bw == 0 or bh == 0:
                continue
            ax, ay = x0 + bx, y0 + by
            rect = np.array(
                [[ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh]], dtype=np.float32
            )
            out.append(DigitRect(row=r, col=c, rect=rect))
    return out
```

- [ ] **Step 4: Run test to verify it passes, adjusting for the real `InpImage` attribute**

Run: `python -m pytest tests/test_digit_rects.py -v`
Expected: PASS once Step 1's `warped_img`-vs-`warped_blk` question is resolved
against the actual `InpImage` source.

- [ ] **Step 5: mypy/ruff/full suite, then commit**

```bash
python -m ruff check killer_sudoku tests
python -m mypy . --ignore-missing-imports
python -m pytest tests -q
git add killer_sudoku/training/digit_rects.py tests/test_digit_rects.py
git commit -m "feat: add geometry-independent digit rect locator"
```

---

## Task 3: Agreement + clean-solve pool

**Files:**
- Create: `killer_sudoku/training/agreement_pool.py`
- Test: `tests/test_agreement_pool.py`

**Interfaces:**
- Consumes: `DigitRect`/`locate_cage_total_rects`/`locate_classic_digit_rects` (Task 2), `HogNumber` (Task 1), `InpImage.make_num_recogniser()` (shipped PCA).
- Produces: `AgreedSample` dataclass (`corpus: str, puzzle_type: str, row: int, col: int, rect: npt.NDArray[np.float32], label: int, source_path: Path`). `build_agreement_pool(corpus_dir: Path, corpus_name: str) -> list[AgreedSample]`.

A puzzle contributes samples only if: (a) both PCA and HOG runs produce a
valid, error-free spec (`inp.spec_error is None`) — this is the "solves
cleanly" half of the gate, strongest for killer where a misread total almost
always breaks solvability outright; and (b) the two runs' `cage_totals`/
`given_digits` arrays are identical element-wise — the "two independent
models agree" half.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_agreement_pool.py
from pathlib import Path

from killer_sudoku.training.agreement_pool import build_agreement_pool


def test_build_agreement_pool_only_includes_agreeing_clean_puzzles(tmp_path: Path) -> None:
    import shutil

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_agreement_pool.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement**

```python
# killer_sudoku/training/agreement_pool.py
"""Builds a pool of digit samples corroborated by PCA/HOG agreement plus a
clean solve -- see docs/superpowers/plans/2026-07-24-pca-hog-agreement-recogniser.md
for why this is a stronger ground-truth signal than either check alone.
"""

import dataclasses
from pathlib import Path

import numpy as np
import numpy.typing as npt

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


def _make_hog_recogniser() -> HogNumber:
    from web.train_recogniser import HogRecogniser  # sys.path already patched by hog_model_loader

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
    config = ImagePipelineConfig(puzzle_dir=corpus_dir, rework=False)
    pca = InpImage.make_num_recogniser()
    hog = _make_hog_recogniser()

    samples: list[AgreedSample] = []
    for f in sorted(corpus_dir.glob("*.jpg")):
        inp_pca = InpImage(f, config, pca)
        if inp_pca.spec_error is not None:
            continue
        inp_hog = InpImage(f, config, hog)
        if inp_hog.spec_error is not None:
            continue

        puzzle_type = inp_pca.puzzle_type
        if puzzle_type != inp_hog.puzzle_type:
            continue

        if puzzle_type == "classic":
            given_pca, given_hog = inp_pca.given_digits, inp_hog.given_digits
            if given_pca is None or given_hog is None or not np.array_equal(given_pca, given_hog):
                continue
            rects = locate_classic_digit_rects(inp_pca.warped_img, config.subres, given_pca > 0)
            for dr in rects:
                label = int(given_pca[dr.row, dr.col])
                samples.append(AgreedSample(corpus_name, "classic", dr.row, dr.col, dr.rect, label, f))
        else:
            totals_pca, totals_hog = inp_pca.info.cage_totals, inp_hog.info.cage_totals
            if not np.array_equal(totals_pca, totals_hog):
                continue
            rects = locate_cage_total_rects(inp_pca.warped_img, config.subres)
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
                total_str = str(int(totals_pca[col, row]))
                if len(cell_rects) != len(total_str):
                    continue
                cell_rects.sort(key=lambda dr: float(dr.rect[:, 0].min()))
                for dr, digit_char in zip(cell_rects, total_str, strict=True):
                    samples.append(
                        AgreedSample(corpus_name, "killer", row, col, dr.rect, int(digit_char), f)
                    )
    return samples
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_agreement_pool.py -v`
Expected: PASS

- [ ] **Step 5: mypy/ruff/full suite, then commit**

```bash
python -m ruff check killer_sudoku tests
python -m mypy . --ignore-missing-imports
python -m pytest tests -q
git add killer_sudoku/training/agreement_pool.py tests/test_agreement_pool.py
git commit -m "feat: build PCA/HOG agreement + clean-solve digit sample pool"
```

---

## Task 4: Balanced sampling with train/holdout split

**Files:**
- Create: `killer_sudoku/training/balanced_sample.py`
- Test: `tests/test_balanced_sample.py`

**Interfaces:**
- Consumes: `AgreedSample` (Task 3).
- Produces: `SplitDataset` dataclass (`train: list[AgreedSample], holdout: list[AgreedSample]`). `balanced_split(samples: list[AgreedSample], per_digit: int = 100, holdout_fraction: float = 0.2, seed: int = 0) -> SplitDataset`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_balanced_sample.py
from pathlib import Path

import numpy as np

from killer_sudoku.training.agreement_pool import AgreedSample
from killer_sudoku.training.balanced_sample import balanced_split


def _fake_sample(label: int, idx: int) -> AgreedSample:
    return AgreedSample(
        corpus="guardian", puzzle_type="killer", row=0, col=0,
        rect=np.zeros((4, 2), dtype=np.float32), label=label,
        source_path=Path(f"guardian/fake_{idx}.jpg"),
    )


def test_balanced_split_caps_per_digit_and_splits_holdout() -> None:
    # 150 samples of digit 3, only 150 available -- cap at per_digit=100.
    samples = [_fake_sample(3, i) for i in range(150)]
    result = balanced_split(samples, per_digit=100, holdout_fraction=0.2, seed=0)
    assert len(result.train) + len(result.holdout) == 100
    assert len(result.holdout) == 20
    # No sample appears in both splits.
    train_paths = {s.source_path for s in result.train}
    holdout_paths = {s.source_path for s in result.holdout}
    assert train_paths.isdisjoint(holdout_paths)


def test_balanced_split_is_deterministic_given_seed() -> None:
    samples = [_fake_sample(d % 10, i) for i, d in enumerate(range(500))]
    a = balanced_split(samples, per_digit=100, seed=42)
    b = balanced_split(samples, per_digit=100, seed=42)
    assert [s.source_path for s in a.train] == [s.source_path for s in b.train]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_balanced_sample.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement**

```python
# killer_sudoku/training/balanced_sample.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_balanced_sample.py -v`
Expected: PASS

- [ ] **Step 5: mypy/ruff/full suite, then commit**

```bash
python -m ruff check killer_sudoku tests
python -m mypy . --ignore-missing-imports
python -m pytest tests -q
git add killer_sudoku/training/balanced_sample.py tests/test_balanced_sample.py
git commit -m "feat: add balanced per-digit train/holdout split"
```

---

## Task 5: Cross-font synthetic holdout (never in training)

**Files:**
- Create: `killer_sudoku/training/synthetic_holdout.py`
- Test: `tests/test_synthetic_holdout.py`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (independent generation).
- Produces: `generate_cross_font_holdout(digits: range = range(0, 10), pt_sizes: tuple[int, ...] = (32, 48, 64)) -> list[tuple[int, npt.NDArray[np.uint8]]]` — `(label, raw_crop)` pairs, raw (un-warped, tightly cropped to ink) so Task 6 can apply either geometry, same as `AgreedSample.rect` does for real crops.

This is a fresh implementation, not a call into `web/train_recogniser.py`'s
`generate_synthetic_samples()` — that function covers digits 1-9 only (fine
for its original given-digit-focused purpose) and calls
`ACTIVE_RECOGNISER.fit_to_thumbnail()` internally, which already commits to
one geometry per call. This task needs digits 0-9 and *both* raw-crop output
(deferring geometry choice) and is holdout-only — different enough
requirements that adapting the original in place isn't a clean fit, and it's
production-adjacent training code not worth modifying for this one-off.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_synthetic_holdout.py
from killer_sudoku.training.synthetic_holdout import generate_cross_font_holdout


def test_generate_cross_font_holdout_covers_all_digits() -> None:
    samples = generate_cross_font_holdout(digits=range(0, 10), pt_sizes=(48,))
    assert len(samples) > 0
    labels_seen = {label for label, _crop in samples}
    # Not every digit is guaranteed renderable in every discovered font, but
    # across all system fonts at least most digits should show up.
    assert len(labels_seen) >= 8
    for _label, crop in samples:
        assert crop.ndim == 2
        assert crop.dtype.name == "uint8"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_synthetic_holdout.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement**

```python
# killer_sudoku/training/synthetic_holdout.py
"""Renders digits from system TTF fonts as a cross-font robustness holdout —
these fonts are never used for training, only for measuring how well each
trained combination generalises to typefaces it has never seen.
"""

import numpy as np
import numpy.typing as npt


def generate_cross_font_holdout(
    digits: range = range(0, 10),
    pt_sizes: tuple[int, ...] = (32, 48, 64),
) -> list[tuple[int, npt.NDArray[np.uint8]]]:
    import matplotlib.font_manager as fm
    from PIL import Image, ImageDraw, ImageFont

    font_paths = fm.findSystemFonts(fontext="ttf")
    samples: list[tuple[int, npt.NDArray[np.uint8]]] = []

    for font_path in font_paths:
        for pt in pt_sizes:
            for digit in digits:
                try:
                    font = ImageFont.truetype(font_path, pt)
                except Exception:
                    continue
                canvas = 256
                img = Image.new("L", (canvas, canvas), 0)
                draw = ImageDraw.Draw(img)
                text = str(digit)
                bbox = draw.textbbox((0, 0), text, font=font)
                w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
                if w == 0 or h == 0:
                    continue
                x = (canvas - w) // 2 - bbox[0]
                y = (canvas - h) // 2 - bbox[1]
                draw.text((x, y), text, fill=255, font=font)
                arr = np.array(img, dtype=np.uint8)
                ys, xs = np.where(arr > 0)
                if len(ys) == 0:
                    continue
                margin = 4
                y0 = max(0, int(ys.min()) - margin)
                y1 = min(arr.shape[0], int(ys.max()) + margin + 1)
                x0 = max(0, int(xs.min()) - margin)
                x1 = min(arr.shape[1], int(xs.max()) + margin + 1)
                samples.append((digit, arr[y0:y1, x0:x1]))

    return samples
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_synthetic_holdout.py -v`
Expected: PASS

- [ ] **Step 5: mypy/ruff/full suite, then commit**

```bash
python -m ruff check killer_sudoku tests
python -m mypy . --ignore-missing-imports
python -m pytest tests -q
git add killer_sudoku/training/synthetic_holdout.py tests/test_synthetic_holdout.py
git commit -m "feat: add cross-font synthetic holdout generator"
```

---

## Task 6: Train the 4 combinations and evaluate

**Files:**
- Create: `killer_sudoku/training/train_combinations.py`
- Create: `docs/pca-hog-combination-results.md` (the report — committed, this is the plan's actual deliverable)
- Test: `tests/test_train_combinations.py`

**Interfaces:**
- Consumes: `SplitDataset` (Task 4), `generate_cross_font_holdout` (Task 5), `PcaRbfRecogniser`/`HogRecogniser` from `web/train_recogniser.py`.
- Produces: `train_and_evaluate(train: list[AgreedSample], holdout: list[AgreedSample], cross_font: list[tuple[int, npt.NDArray[np.uint8]]]) -> dict[str, dict[str, float]]` — `{combination_name: {"same_dist_accuracy": ..., "cross_font_accuracy": ...}}` for all 4 combinations.

**Interface note:** `train_and_evaluate` takes plain `(label, raw_crop)` pairs
rather than `AgreedSample`/`generate_cross_font_holdout` objects directly —
`AgreedSample.rect` is a source-image quad that must be loaded from
`sample.source_path` and cropped out before any warping can happen, and
`generate_cross_font_holdout` already returns raw crops directly. Using one
common `(label, raw_crop)` shape for both real and synthetic samples means
`train_and_evaluate` doesn't need to know which kind of sample it's looking
at. A separate `extract_raw_crop(sample: AgreedSample) -> npt.NDArray[np.uint8]`
function (implemented in Step 3 below) does the `AgreedSample` → raw-crop
conversion once, in `main()` (Step 5), before either list reaches
`train_and_evaluate`.

- [ ] **Step 1: Write the failing test with a small synthetic dataset**

```python
# tests/test_train_combinations.py
import numpy as np

from killer_sudoku.training.train_combinations import train_and_evaluate


def _make_crop(digit: int) -> np.ndarray:
    from PIL import Image, ImageDraw

    img = Image.new("L", (40, 60), 0)
    draw = ImageDraw.Draw(img)
    draw.text((5, 5), str(digit), fill=255)
    return np.array(img, dtype=np.uint8)


def test_train_and_evaluate_runs_all_four_combinations() -> None:
    # Not a real accuracy test (too few samples to fit meaningfully) --
    # this only exercises the training/evaluation plumbing end-to-end.
    train = [(d, _make_crop(d)) for d in range(10) for _ in range(3)]
    holdout = [(d, _make_crop(d)) for d in range(10)]
    cross_font: list[tuple[int, np.ndarray]] = []

    results = train_and_evaluate(train, holdout, cross_font)
    assert set(results.keys()) == {
        "pca_stretch", "pca_letterbox", "hog_stretch", "hog_letterbox",
    }
    for combo_results in results.values():
        assert "same_dist_accuracy" in combo_results
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_train_combinations.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement**

```python
# killer_sudoku/training/train_combinations.py
"""Trains PCA/HOG x stretch/letterbox and evaluates all four on same-
distribution and cross-font holdouts.
"""

import sys
from pathlib import Path

import cv2
import numpy as np
import numpy.typing as npt

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "web"))
from train_recogniser import HogRecogniser, PcaRbfRecogniser  # noqa: E402

from killer_sudoku.training.agreement_pool import AgreedSample  # noqa: E402

_WIN_SIZE = 64


def extract_raw_crop(sample: AgreedSample) -> npt.NDArray[np.uint8]:
    """Load sample.source_path and crop out the bounding region of sample.rect."""
    img = cv2.imread(str(sample.source_path), cv2.IMREAD_GRAYSCALE)
    x0, y0 = sample.rect[:, 0].min(), sample.rect[:, 1].min()
    x1, y1 = sample.rect[:, 0].max(), sample.rect[:, 1].max()
    return np.asarray(img[int(y0) : int(y1), int(x0) : int(x1)], dtype=np.uint8)


def _warp_all(
    crops: list[npt.NDArray[np.uint8]], warp_fn: object
) -> npt.NDArray[np.uint8]:
    return np.stack([
        warp_fn(0, 0, c.shape[1], c.shape[0], c, _WIN_SIZE)  # type: ignore[operator]
        for c in crops
    ])


def train_and_evaluate(
    train: list[tuple[int, npt.NDArray[np.uint8]]],
    holdout: list[tuple[int, npt.NDArray[np.uint8]]],
    cross_font: list[tuple[int, npt.NDArray[np.uint8]]],
) -> dict[str, dict[str, float]]:
    train_labels = np.array([label for label, _ in train], dtype=np.int64)
    train_crops = [crop for _, crop in train]
    holdout_labels = np.array([label for label, _ in holdout], dtype=np.int64)
    holdout_crops = [crop for _, crop in holdout]
    cross_font_labels = np.array([label for label, _ in cross_font], dtype=np.int64)
    cross_font_crops = [crop for _, crop in cross_font]

    combinations = {
        "pca_stretch": (PcaRbfRecogniser(), PcaRbfRecogniser().warp_from_rect),
        "pca_letterbox": (PcaRbfRecogniser(), HogRecogniser().warp_from_rect),
        "hog_stretch": (HogRecogniser(), PcaRbfRecogniser().warp_from_rect),
        "hog_letterbox": (HogRecogniser(), HogRecogniser().warp_from_rect),
    }

    results: dict[str, dict[str, float]] = {}
    for name, (recogniser, warp_fn) in combinations.items():
        warped_train = _warp_all(train_crops, warp_fn)
        features = recogniser.extract_features(warped_train)
        model = recogniser.fit(features, train_labels, None)
        clf = model["clf"]

        def _accuracy(crops: list[npt.NDArray[np.uint8]], labels: npt.NDArray[np.int64]) -> float:
            if not crops:
                return float("nan")
            warped = _warp_all(crops, warp_fn)
            preds = clf.predict(recogniser.extract_features(warped))
            return float((preds == labels).mean())

        results[name] = {
            "same_dist_accuracy": _accuracy(holdout_crops, holdout_labels),
            "cross_font_accuracy": _accuracy(cross_font_crops, cross_font_labels),
        }
    return results
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_train_combinations.py -v`
Expected: PASS

- [ ] **Step 5: Assemble the real pipeline end-to-end and write the report**

```python
# Append to killer_sudoku/training/train_combinations.py
def main() -> None:
    from killer_sudoku.training.agreement_pool import build_agreement_pool
    from killer_sudoku.training.balanced_sample import balanced_split
    from killer_sudoku.training.synthetic_holdout import generate_cross_font_holdout

    all_samples: list[AgreedSample] = []
    for corpus_name, corpus_dir in [("guardian", Path("guardian")), ("observer", Path("observer"))]:
        all_samples.extend(build_agreement_pool(corpus_dir, corpus_name))

    split = balanced_split(all_samples, per_digit=100, holdout_fraction=0.2, seed=0)
    train = [(s.label, extract_raw_crop(s)) for s in split.train]
    holdout = [(s.label, extract_raw_crop(s)) for s in split.holdout]
    cross_font = generate_cross_font_holdout()

    results = train_and_evaluate(train, holdout, cross_font)

    lines = ["# PCA/HOG Combination Results\n"]
    lines.append(f"Training set: {len(train)} samples. Same-distribution holdout: {len(holdout)}. "
                 f"Cross-font holdout: {len(cross_font)}.\n")
    lines.append("| Combination | Same-distribution accuracy | Cross-font accuracy |")
    lines.append("|---|---|---|")
    for name, r in results.items():
        lines.append(f"| {name} | {r['same_dist_accuracy']:.4f} | {r['cross_font_accuracy']:.4f} |")
    Path("docs/pca-hog-combination-results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
```

Run: `python -m killer_sudoku.training.train_combinations`

This is a real corpus-scale run (guardian + observer, ~889 images each pass
through `InpImage` twice for the agreement gate, plus training 4 SVMs, plus
scanning every system font for the cross-font holdout) — expect this to take
meaningfully longer than the Tesseract pilot did. Consider running it first
against a small scratch copy (a handful of images per corpus, matching the
Tesseract plan's Task 4 pattern) to sanity-check the whole pipeline runs
without errors before committing to the full run.

- [ ] **Step 6: Review the report and record a verdict**

Read `docs/pca-hog-combination-results.md`. Append a short "Verdict" section
by hand once the numbers are in: which combination has the best
same-distribution accuracy, which is most robust on cross-font (these may not
be the same combination — that tradeoff is exactly what this experiment was
built to surface), and a recommendation for what to wire into the shipped app
next (a separate follow-up plan, per this plan's Global Constraints).

- [ ] **Step 7: mypy/ruff/full suite, then commit**

```bash
python -m ruff check killer_sudoku tests
python -m mypy . --ignore-missing-imports
python -m pytest tests -q
git add killer_sudoku/training/train_combinations.py tests/test_train_combinations.py docs/pca-hog-combination-results.md
git commit -m "feat: train and evaluate 4 PCA/HOG x stretch/letterbox combinations"
```
