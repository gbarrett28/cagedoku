#!/usr/bin/env python3
"""Train the web digit recogniser using PCA + RBF-SVM + template matching.

Generates synthetic digit images from system fonts, optionally merges
browser-exported labelled samples and bulk (guardian/observer) samples,
augments all sources with dithering, fits PCA on per-class mean images
followed by an RBF-SVM in PCA space, and writes the trained model to
web/public/.

This mirrors the "warped PCA" architecture used by
killer_sudoku.training.train_number_recogniser (the numerals.pkl-based
trainer that produces the shipped killer_sudoku/data/num_recogniser.npz) --
same PCA-on-class-means + RBF-SVM-in-PCA-space + per-digit template
approach, same manifest schema, different input data source (browser/bulk
JSON samples here vs numerals.pkl there). Kept in sync manually; see
docs/digits.md for the two pipelines' relationship.

Was HOG+LinearSVC/OVO-SVC between commit 212dc57 (2026-05-01) and the
Stage 5 revert (2eb4fa2, 2026-07-22) that moved the shipped model back to
PCA+RBF -- this script was not updated at the time and drifted out of sync
with numberRecognition.ts's manifest schema, which is why the scheduled
"Retrain digit recogniser" GitHub Action has been failing (originally on a
missing psutil import used only by the HOG/LinearSVC OVO path; restoring
PCA removes that dependency entirely).

Usage
-----
    # Standard retrain from accumulated browser training data:
    python web/train_recogniser.py --out web/public --browser-weight 1000 --svm-c 100 web/browser_train.json

    # Train from synthetic fonts only (no puzzle data needed):
    python web/train_recogniser.py --out web/public

    # Skip synthetic font generation:
    python web/train_recogniser.py --no-synthetic web/browser_train.json

Workflow
--------
1. Export training data from the browser (OCR review screen -> Export Training).
2. Run the merge step to add it to web/browser_train.json (or provide the
   exported JSON directly as an additional positional argument).
3. Run this script with --browser-weight 1000 --svm-c 100.
4. The updated model is live immediately: reload the web app.

Model format
------------
The binary layout is documented in web/src/image/numberRecognition.ts
(loadNumRecogniser, classifier_type == 'pca_rbf'). The JSON manifest records
each array's name, dtype, shape, byte offset, and byte length.

Stale-sample filtering
-----------------------
web/browser_train.json accumulates samples captured under whatever crop
geometry was live in-browser at capture time. web/known-stale-training-hashes.json
lists content hashes of samples confirmed captured under crop geometry the
current pipeline no longer produces -- these are excluded from training so
they cannot pollute the PCA/SVM fit. This is a *different* list from
numberRecognition.test.ts's known-model-failure-hashes.json: that one tracks
whatever the currently-shipped model happens to get wrong (regenerated per
model), while this one is permanent (geometry incompatibility doesn't change
across retrains). Do not merge the two files.

Sample weights
--------------
--browser-weight upweights browser-exported samples' influence on the SVM
decision boundary via sklearn's sample_weight (not repetition -- the PCA
basis itself is still fit on unweighted per-class mean images, matching
killer_sudoku.training.train_number_recogniser's convention).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from abc import ABC, abstractmethod
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
from numba import get_num_threads, njit, prange, set_num_threads
from numpy.typing import NDArray
from sklearn.decomposition import PCA
from sklearn.svm import SVC

# ---------------------------------------------------------------------------
# Constants -- must match killer_sudoku/image/config.py's NumberRecognitionConfig
# defaults and web/src/image/numberRecognition.ts's pca_rbf loader.
# ---------------------------------------------------------------------------

THUMBNAIL_SIZE = 64        # splitNum output: 64x64 binary image per digit
N_DIGITS = 10              # digits 0-9
DEFAULT_DITHER = 5         # augmented variants per source sample -- PCA+RBF (fit in an
                            # ~10-dim PCA-projected space) needs far fewer augmented copies
                            # to generalise than the old HOG+LinearSVC architecture did;
                            # RBF-SVM's fit cost also scales worse than linear with sample
                            # count, so keep this small. See MAX_FIT_SAMPLES below for a
                            # hard backstop regardless of this value.
MAX_FIT_SAMPLES = 60_000   # hard cap on rows passed to fit_model (post-dither). Random
                            # subsample if exceeded. killer_sudoku.training.train_number_recogniser
                            # fits comfortably (~1s) on ~36k rows; this leaves headroom above
                            # that proven-fast scale without letting a growing browser_train.json
                            # or a raised --dither silently balloon SVC.fit to minutes/hours.
CONFIDENCE_THRESHOLD = 0.7 # OVO vote fraction to mark a read as confident
SVM_C = 5.0
SVM_GAMMA = "scale"
TEMPLATE_THRESHOLD = 0.85
VARIANCE_THRESHOLD = 0.99  # cumulative explained-variance target for PCA dims
DITHER_BATCH_SIZE = 4096

# HOG descriptor parameters -- identical values used in cv.HOGDescriptor (TypeScript).
# Not used by this file's own PCA+RBF pipeline (fit_model/build_dataset below project
# raw pixels, not HOG features) -- kept here as shared utilities because
# web/train_split_recogniser.py (a separate 1-vs-2-digit binary classifier, unrelated
# to the num_recogniser digit model this file trains) and
# web/scripts/compare-recognisers.py still import extract_hog/extract_hole_features
# from this module.
HOG_WIN_SIZE     = 64
HOG_CELL_SIZE    = 8
HOG_BLOCK_SIZE   = 16
HOG_BLOCK_STRIDE = 8
HOG_NBINS        = 9
# ((64-16)/8+1)^2 * (16/8)^2 * 9 = 7^2 * 4 * 9
HOG_FEAT         = 1764
MIN_HOLE_AREA = 3
N_HOLE_FEATURES = 5  # one-hot hole-count bucket (0/1/2+) + top-2 hole area ratios

_STALE_HASHES_PATH = Path(__file__).parent / "known-stale-training-hashes.json"


def _load_stale_hashes() -> frozenset[str]:
    """Load the shared stale-sample-hash blocklist (see module docstring)."""
    if not _STALE_HASHES_PATH.exists():
        return frozenset()
    return frozenset(json.loads(_STALE_HASHES_PATH.read_text(encoding="utf-8")))


def _sample_hash(pixels: list[int]) -> str:
    """sha256 of the raw pixel array -- must match numberRecognition.test.ts's sha256()."""
    return hashlib.sha256(bytes(pixels)).hexdigest()


# ---------------------------------------------------------------------------
# NumRecogniser -- single active instance, no CLI flag, no branching.
# ---------------------------------------------------------------------------


class NumRecogniser(ABC):
    """One implementation per digit-recogniser architecture.

    ACTIVE_RECOGNISER (bottom of this section) is the single point of truth --
    change that one line to switch every consumer (main(), generate_synthetic_samples,
    extract_guardian_samples.py) to the other architecture at once.
    """

    @abstractmethod
    def fit_to_thumbnail(self, crop: NDArray[np.uint8], win_size: int) -> NDArray[np.uint8]:
        """Fit an already-extracted, variable-aspect-ratio crop into a win_size square."""

    @abstractmethod
    def warp_from_rect(
        self, ax: float, ay: float, bw: float, bh: float,
        source: NDArray[np.uint8], win_size: int,
    ) -> NDArray[np.uint8]:
        """Perspective-warp a bounding rect directly from a full source image."""

    @abstractmethod
    def extract_features(self, imgs: NDArray[np.uint8]) -> NDArray[np.float64]:
        """Convert a stacked (n, 64, 64) uint8 image array into fit-ready features."""

    @abstractmethod
    def fit(
        self, X: NDArray[np.float64], y: NDArray[np.int64],
        sample_weights: NDArray[np.float64] | None,
    ) -> dict[str, Any]:
        """Fit a classifier on X/y, returning an opaque model dict for save()."""

    @abstractmethod
    def save(
        self, model: dict[str, Any], out_dir: Path,
        confidence_threshold: float = CONFIDENCE_THRESHOLD,
        template_threshold: float = TEMPLATE_THRESHOLD,
    ) -> None:
        """Write num_recogniser.json (manifest) and num_recogniser.bin (arrays)."""


class PcaRbfRecogniser(NumRecogniser):
    def fit_to_thumbnail(self, crop: NDArray[np.uint8], win_size: int) -> NDArray[np.uint8]:
        # Direct stretch, no aspect preservation -- matches TS's getWarpFromRect.
        from PIL import Image
        return np.array(
            Image.fromarray(crop).resize((win_size, win_size), Image.Resampling.LANCZOS),
            dtype=np.uint8,
        )

    def warp_from_rect(
        self, ax: float, ay: float, bw: float, bh: float,
        source: NDArray[np.uint8], win_size: int,
    ) -> NDArray[np.uint8]:
        # Direct stretch via cv2.warpPerspective -- matches TS's getWarpFromRect
        # exactly (same mechanism). No square-padding step.
        import cv2
        src = np.array([[ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh]], dtype=np.float32)
        dst = np.array(
            [[0, 0], [win_size - 1, 0], [win_size - 1, win_size - 1], [0, win_size - 1]],
            dtype=np.float32,
        )
        m = cv2.getPerspectiveTransform(src, dst)
        thumb = cv2.warpPerspective(source, m, (win_size, win_size), flags=cv2.INTER_LINEAR)
        return ((thumb > 127).astype(np.uint8) * 255)

    def extract_features(self, imgs: NDArray[np.uint8]) -> NDArray[np.float64]:
        return imgs.reshape(len(imgs), -1).astype(np.float64)

    def fit(
        self, X: NDArray[np.float64], y: NDArray[np.int64],
        sample_weights: NDArray[np.float64] | None,
    ) -> dict[str, Any]:
        return fit_model(X, y, svm_c=SVM_C, svm_gamma=SVM_GAMMA, sample_weights=sample_weights)

    def save(
        self, model: dict[str, Any], out_dir: Path,
        confidence_threshold: float = CONFIDENCE_THRESHOLD,
        template_threshold: float = TEMPLATE_THRESHOLD,
    ) -> None:
        save_model(model, out_dir, confidence_threshold=confidence_threshold, template_threshold=template_threshold)


class HogRecogniser(NumRecogniser):
    def fit_to_thumbnail(self, crop: NDArray[np.uint8], win_size: int) -> NDArray[np.uint8]:
        # Pad to a square (aspect-preserving), then uniform-scale -- matches TS's
        # letterboxWarp. This is generate_synthetic_samples' former inline logic.
        from PIL import Image
        h_c, w_c = crop.shape
        side = max(h_c, w_c)
        square = np.zeros((side, side), dtype=np.uint8)
        square[(side - h_c) // 2:(side - h_c) // 2 + h_c, (side - w_c) // 2:(side - w_c) // 2 + w_c] = crop
        return np.array(
            Image.fromarray(square).resize((win_size, win_size), Image.Resampling.LANCZOS),
            dtype=np.uint8,
        )

    def warp_from_rect(
        self, ax: float, ay: float, bw: float, bh: float,
        source: NDArray[np.uint8], win_size: int,
    ) -> NDArray[np.uint8]:
        # extract_guardian_samples.py's former standalone letterbox_warp, moved here unchanged.
        import cv2
        scale = min((win_size - 1) / bw, (win_size - 1) / bh)
        dest_w, dest_h = bw * scale, bh * scale
        off_x, off_y = ((win_size - 1) - dest_w) / 2, ((win_size - 1) - dest_h) / 2
        src = np.array([[ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh]], dtype=np.float32)
        dst = np.array([
            [off_x, off_y], [off_x + dest_w, off_y],
            [off_x + dest_w, off_y + dest_h], [off_x, off_y + dest_h],
        ], dtype=np.float32)
        m = cv2.getPerspectiveTransform(src, dst)
        thumb = cv2.warpPerspective(source, m, (win_size, win_size), flags=cv2.INTER_LINEAR)
        return ((thumb > 127).astype(np.uint8) * 255)

    def extract_features(self, imgs: NDArray[np.uint8]) -> NDArray[np.float64]:
        return np.hstack([extract_hog(imgs), extract_hole_features(imgs)])

    def fit(
        self, X: NDArray[np.float64], y: NDArray[np.int64],
        sample_weights: NDArray[np.float64] | None,
    ) -> dict[str, Any]:
        # Direct RBF-SVM fit only -- see this repo's implementation plan for why the
        # original checkpointed LinearSVC/OVO path is not restored here.
        svc = SVC(kernel="rbf", C=SVM_C, gamma=SVM_GAMMA, decision_function_shape="ovo")
        svc.fit(X, y, sample_weight=sample_weights)
        return {"kind": "rbf", "clf": svc, "classes": svc.classes_}

    def save(
        self, model: dict[str, Any], out_dir: Path,
        confidence_threshold: float = CONFIDENCE_THRESHOLD,
        # HOG has no templates; kept for a signature substitutable with PcaRbfRecogniser.save.
        template_threshold: float = TEMPLATE_THRESHOLD,
    ) -> None:
        svc: SVC = model["clf"]
        try:
            gamma = float(svc._gamma)  # available after fit(); sklearn >= 0.22
        except AttributeError:
            gamma = 1.0

        named: list[tuple[str, np.ndarray[Any, Any], str]] = [
            ("hog_win_size",         np.array([HOG_WIN_SIZE], dtype=np.int32),     "int32"),
            ("hog_cell_size",        np.array([HOG_CELL_SIZE], dtype=np.int32),    "int32"),
            ("hog_block_size",       np.array([HOG_BLOCK_SIZE], dtype=np.int32),   "int32"),
            ("hog_block_stride",     np.array([HOG_BLOCK_STRIDE], dtype=np.int32), "int32"),
            ("hog_nbins",            np.array([HOG_NBINS], dtype=np.int32),        "int32"),
            ("rbf_support_vectors",  svc.support_vectors_.astype(np.float64),      "float64"),
            ("rbf_dual_coef",        svc.dual_coef_.astype(np.float64),            "float64"),
            ("rbf_intercept",        svc.intercept_.astype(np.float64),            "float64"),
            ("rbf_n_support",        svc.n_support_.astype(np.int32),              "int32"),
            ("rbf_gamma",            np.array([gamma], dtype=np.float64),          "float64"),
            ("classes",              svc.classes_.astype(np.int32),                "int32"),
            ("confidence_threshold", np.array([confidence_threshold], dtype=np.float64), "float64"),
        ]
        blob = bytearray()
        manifest_arrays: dict[str, dict[str, Any]] = {}
        for name, arr, dtype_str in named:
            arr = np.asarray(arr)
            data = arr.tobytes()
            manifest_arrays[name] = {
                "dtype": dtype_str, "shape": list(arr.shape),
                "offset": len(blob), "byteLength": len(data),
            }
            blob.extend(data)

        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "num_recogniser.bin").write_bytes(bytes(blob))
        (out_dir / "num_recogniser.json").write_text(
            json.dumps({"classifier_type": "rbf", "arrays": manifest_arrays}, indent=2),
            encoding="utf-8",
        )
        n_sv = svc.support_vectors_.shape[0]
        print(f"\nSaved to {out_dir}/ [hog/rbf]", flush=True)
        print(f"  SVM: {n_sv} support vectors, classes {svc.classes_.tolist()}", flush=True)
        print(f"  Bin size: {len(blob):,} bytes", flush=True)


ACTIVE_RECOGNISER: NumRecogniser = PcaRbfRecogniser()  # the one line that decides everything


# ---------------------------------------------------------------------------
# Shared feature-extraction utilities -- HOG + hole-count features.
#
# Unused by this file's own PCA+RBF pipeline (see note on the HOG_* constants
# above); kept for web/train_split_recogniser.py and
# web/scripts/compare-recognisers.py, which import extract_hog/
# extract_hole_features from this module.
# ---------------------------------------------------------------------------

@njit(parallel=True, fastmath=True, cache=True)
def _extract_hog_numba(stacked: NDArray[np.uint8], result: NDArray[np.float64]) -> None:
    """Fused per-pixel HOG kernel: gradients, bin assignment, cell histograms, block normalisation.

    One compiled pass per image with no large (n, 64, 64) intermediate arrays.
    Matches the TypeScript hogExtract implementation in numberRecognition.ts:
    centered differences (clamped at borders), unsigned gradients via
    atan2(|Gy|, Gx) mod 180, nearest-bin voting, L2 block normalisation.
    """
    n = stacked.shape[0]
    n_cells = HOG_WIN_SIZE // HOG_CELL_SIZE
    cpb = HOG_BLOCK_SIZE // HOG_CELL_SIZE
    n_blocks = (HOG_WIN_SIZE - HOG_BLOCK_SIZE) // HOG_BLOCK_STRIDE + 1
    bin_width_rad = np.pi / HOG_NBINS
    block_feat = cpb * cpb * HOG_NBINS
    eps2 = 1e-12  # (1e-6)^2 -- matches the original L2-normalisation epsilon

    for i in prange(n):
        cell_hist = np.zeros((n_cells, n_cells, HOG_NBINS))
        for y in range(HOG_WIN_SIZE):
            # Centered difference, clamped at the border -- matches the
            # original Gx[:,:,0]=f[1]-f[0] / Gx[:,:,-1]=f[-1]-f[-2] slicing.
            y0 = y - 1 if y > 0 else 0
            y1 = y + 1 if y < HOG_WIN_SIZE - 1 else HOG_WIN_SIZE - 1
            cy = y // HOG_CELL_SIZE
            for x in range(HOG_WIN_SIZE):
                x0 = x - 1 if x > 0 else 0
                x1 = x + 1 if x < HOG_WIN_SIZE - 1 else HOG_WIN_SIZE - 1
                gx = float(stacked[i, y, x1]) - float(stacked[i, y, x0])
                gy = float(stacked[i, y1, x]) - float(stacked[i, y0, x])
                mag = math.sqrt(gx * gx + gy * gy)
                # atan2(|gy|, gx) is always in [0, pi]; dividing by pi/HOG_NBINS
                # and wrapping mod HOG_NBINS reproduces the original
                # degrees-mod-180 bin assignment exactly.
                angle = math.atan2(abs(gy), gx)
                b = int(angle / bin_width_rad) % HOG_NBINS
                cx = x // HOG_CELL_SIZE
                cell_hist[cy, cx, b] += mag

        for by in range(n_blocks):
            for bx in range(n_blocks):
                base = (by * n_blocks + bx) * block_feat
                s = 0.0
                idx = 0
                for dy in range(cpb):
                    for dx in range(cpb):
                        for bn in range(HOG_NBINS):
                            v = cell_hist[by + dy, bx + dx, bn]
                            result[i, base + idx] = v
                            s += v * v
                            idx += 1
                norm = math.sqrt(s + eps2)
                for k in range(block_feat):
                    result[i, base + k] /= norm


def extract_hog(
    imgs: NDArray[np.uint8], n_jobs: int = -1, out: NDArray[np.float64] | None = None
) -> NDArray[np.float64]:
    """Extract HOG feature vectors matching the TypeScript hogExtract implementation.

    imgs is a pre-stacked (n, 64, 64) uint8 array, dispatched directly to
    _extract_hog_numba. n_jobs=-1 (default) uses all CPU cores; otherwise caps
    the thread count for this call only, restored afterward.

    out, if given, must be a (n, HOG_FEAT) array (or column-slice view of a
    larger array) to write results into directly instead of allocating a
    fresh array.
    """
    t0 = time.time()
    n = len(imgs)
    if n == 0:
        return out if out is not None else np.zeros((0, HOG_FEAT), dtype=np.float64)

    prior_threads = get_num_threads()
    if n_jobs != -1:
        set_num_threads(max(1, n_jobs))
    try:
        result = out if out is not None else np.empty((n, HOG_FEAT), dtype=np.float64)
        print(f"  Extracting HOG for {n} images (numba, threads={get_num_threads()})...", flush=True)
        _extract_hog_numba(imgs, result)
    finally:
        if n_jobs != -1:
            set_num_threads(prior_threads)
    print(f"  [+{time.time() - t0:.0f}s] HOG extraction done", flush=True)
    return result


@njit(parallel=True, cache=True)
def _extract_hole_numba(stacked: NDArray[np.uint8], min_hole_area: int, result: NDArray[np.float64]) -> None:
    """Fused per-image hole-count kernel: outside flood-fill, hole labelling, top-2 area tracking.

    Mirrors extractHoleFeatures in web/src/image/holeFeatures.ts (BFS outside
    flood-fill, then connected-component hole labelling, 4-connectivity
    throughout). The BFS queue is an explicit preallocated (h*w,) int32 array
    with head/tail indices (numba cannot compile collections.deque).
    """
    n, h, w = stacked.shape
    max_q = h * w

    for i in prange(n):
        img = stacked[i]
        visited = np.zeros((h, w), dtype=np.bool_)
        ink_count = 0
        for yy in range(h):
            for xx in range(w):
                if img[yy, xx] != 0:
                    ink_count += 1

        qy = np.empty(max_q, dtype=np.int32)
        qx = np.empty(max_q, dtype=np.int32)
        head = 0
        tail = 0

        # Step 1: flood-fill "outside" from every border background pixel.
        for x in range(w):
            for y in (0, h - 1):
                if img[y, x] == 0 and not visited[y, x]:
                    visited[y, x] = True
                    qy[tail] = y
                    qx[tail] = x
                    tail += 1
        for y in range(h):
            for x in (0, w - 1):
                if img[y, x] == 0 and not visited[y, x]:
                    visited[y, x] = True
                    qy[tail] = y
                    qx[tail] = x
                    tail += 1

        while head < tail:
            y = qy[head]
            x = qx[head]
            head += 1
            if y > 0 and img[y - 1, x] == 0 and not visited[y - 1, x]:
                visited[y - 1, x] = True
                qy[tail] = y - 1
                qx[tail] = x
                tail += 1
            if y < h - 1 and img[y + 1, x] == 0 and not visited[y + 1, x]:
                visited[y + 1, x] = True
                qy[tail] = y + 1
                qx[tail] = x
                tail += 1
            if x > 0 and img[y, x - 1] == 0 and not visited[y, x - 1]:
                visited[y, x - 1] = True
                qy[tail] = y
                qx[tail] = x - 1
                tail += 1
            if x < w - 1 and img[y, x + 1] == 0 and not visited[y, x + 1]:
                visited[y, x + 1] = True
                qy[tail] = y
                qx[tail] = x + 1
                tail += 1

        # Step 2: label remaining unvisited background pixels as hole regions,
        # tracking only the two largest surviving areas.
        n_holes = 0
        largest1 = 0
        largest2 = 0
        for sy in range(h):
            for sx in range(w):
                if visited[sy, sx] or img[sy, sx] != 0:
                    continue
                area = 0
                head = 0
                tail = 0
                visited[sy, sx] = True
                qy[tail] = sy
                qx[tail] = sx
                tail += 1
                while head < tail:
                    y = qy[head]
                    x = qx[head]
                    head += 1
                    area += 1
                    if y > 0 and img[y - 1, x] == 0 and not visited[y - 1, x]:
                        visited[y - 1, x] = True
                        qy[tail] = y - 1
                        qx[tail] = x
                        tail += 1
                    if y < h - 1 and img[y + 1, x] == 0 and not visited[y + 1, x]:
                        visited[y + 1, x] = True
                        qy[tail] = y + 1
                        qx[tail] = x
                        tail += 1
                    if x > 0 and img[y, x - 1] == 0 and not visited[y, x - 1]:
                        visited[y, x - 1] = True
                        qy[tail] = y
                        qx[tail] = x - 1
                        tail += 1
                    if x < w - 1 and img[y, x + 1] == 0 and not visited[y, x + 1]:
                        visited[y, x + 1] = True
                        qy[tail] = y
                        qx[tail] = x + 1
                        tail += 1
                if area >= min_hole_area:
                    n_holes += 1
                    if area > largest1:
                        largest2 = largest1
                        largest1 = area
                    elif area > largest2:
                        largest2 = area

        bucket = n_holes if n_holes < 2 else 2
        result[i, bucket] = 1.0
        denom = ink_count if ink_count > 0 else 1
        result[i, 3] = largest1 / denom
        result[i, 4] = largest2 / denom


def extract_hole_features(
    imgs: NDArray[np.uint8], n_jobs: int = -1, out: NDArray[np.float64] | None = None
) -> NDArray[np.float64]:
    """Extract hole-count topology features matching extractHoleFeatures in holeFeatures.ts.

    imgs is a pre-stacked (n, 64, 64) uint8 array, dispatched directly to
    _extract_hole_numba. n_jobs=-1 (default) uses all CPU cores; otherwise
    caps the thread count for this call only, restored afterward.

    out, if given, must be a (n, N_HOLE_FEATURES) array (or column-slice view
    of a larger array), already zero-filled: the kernel only sets the one-hot
    bucket column it selects (result[i, 0:3]) and leaves the other two as an
    implicit zero, plus columns 3/4 are left at zero when there are no holes.
    """
    t0 = time.time()
    n = len(imgs)
    if n == 0:
        return out if out is not None else np.zeros((0, N_HOLE_FEATURES), dtype=np.float64)

    prior_threads = get_num_threads()
    if n_jobs != -1:
        set_num_threads(max(1, n_jobs))
    try:
        result = out if out is not None else np.zeros((n, N_HOLE_FEATURES), dtype=np.float64)
        print(f"  Extracting hole features for {n} images (numba, threads={get_num_threads()})...", flush=True)
        _extract_hole_numba(imgs, MIN_HOLE_AREA, result)
    finally:
        if n_jobs != -1:
            set_num_threads(prior_threads)
    print(f"  [+{time.time() - t0:.0f}s] Hole feature extraction done", flush=True)
    return result


# ---------------------------------------------------------------------------
# I/O -- loading
# ---------------------------------------------------------------------------

def load_training_file(path: Path, exclude_hashes: frozenset[str] = frozenset()) -> list[tuple[int, NDArray[np.uint8]]]:
    """Load (digit, 64x64 uint8) samples from one browser-exported JSON.

    The JSON is produced by web/src/image/trainingExport.ts and contains
    one sample per extracted digit contour, labelled with the user-verified
    cage total. Samples whose content hash is in exclude_hashes are skipped
    (see module docstring on stale-sample filtering).
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    samples: list[tuple[int, NDArray[np.uint8]]] = []
    skipped = 0
    for s in data["samples"]:
        pixels = s["pixels"]
        if exclude_hashes and _sample_hash(pixels) in exclude_hashes:
            skipped += 1
            continue
        digit = int(s["digit"])
        img = np.array(pixels, dtype=np.uint8).reshape(THUMBNAIL_SIZE, THUMBNAIL_SIZE)
        samples.append((digit, img))
    if skipped:
        print(f"  Excluded {skipped} known-stale-geometry sample(s) from {path.name}", flush=True)
    return samples


def cap_per_class(
    samples: list[tuple[int, NDArray[np.uint8]]],
    max_per_class: int,
    rng: np.random.Generator,
) -> list[tuple[int, NDArray[np.uint8]]]:
    """Randomly subsample each digit class down to at most max_per_class.

    Bounds the largest class regardless of how skewed the input distribution
    is -- e.g. digit '1' is far more common in cage totals than digit '5'.
    A no-op for classes already at or below the cap.
    """
    by_digit: dict[int, list[tuple[int, NDArray[np.uint8]]]] = {}
    for s in samples:
        by_digit.setdefault(s[0], []).append(s)
    capped: list[tuple[int, NDArray[np.uint8]]] = []
    for group in by_digit.values():
        if len(group) <= max_per_class:
            capped.extend(group)
        else:
            idx = rng.choice(len(group), size=max_per_class, replace=False)
            capped.extend(group[i] for i in idx)
    return capped


def generate_synthetic_samples(
    win_size: int = THUMBNAIL_SIZE,
    pt_sizes: tuple[int, ...] = (32, 48, 64),
) -> list[tuple[int, NDArray[np.uint8]]]:
    """Render digits 1-9 in all discoverable system TTF fonts via Pillow.

    Returns (label, win_size x win_size uint8) pairs in the same format as
    load_training_file, supplementing browser-exported samples with coverage
    across common newspaper and system typefaces.
    """
    t0 = time.time()
    print(f"  [+{time.time() - t0:.0f}s] Scanning system fonts (matplotlib font cache "
          f"may take a while on first run)...", flush=True)
    import matplotlib.font_manager as fm
    from PIL import Image, ImageDraw, ImageFont

    font_paths = fm.findSystemFonts(fontext="ttf")
    print(f"  [+{time.time() - t0:.0f}s] Found {len(font_paths)} fonts", flush=True)
    samples: list[tuple[int, NDArray[np.uint8]]] = []
    report_every = max(1, len(font_paths) // 20)

    for fi, font_path in enumerate(font_paths):
        for pt in pt_sizes:
            for digit in range(1, 10):
                try:
                    font = ImageFont.truetype(font_path, pt)
                except Exception:
                    continue
                canvas = win_size * 2
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
                crop = arr[y0:y1, x0:x1]
                out = ACTIVE_RECOGNISER.fit_to_thumbnail(crop, win_size)
                if out.max() > 0:
                    samples.append((digit, out))

        if (fi + 1) % report_every == 0 or fi + 1 == len(font_paths):
            print(f"  [+{time.time() - t0:.0f}s] Rendered fonts {fi + 1}/{len(font_paths)} "
                  f"({len(samples)} samples so far)", flush=True)

    return samples


# ---------------------------------------------------------------------------
# Augmentation: dithering (translate, erode, dilate, pixel noise)
# ---------------------------------------------------------------------------

@njit(parallel=True, cache=True)
def _dither_numba(
    stacked: NDArray[np.uint8],
    dx: NDArray[np.int32],
    dy: NDArray[np.int32],
    op: NDArray[np.int8],
    noise: NDArray[np.bool_],
    out: NDArray[np.uint8],
) -> None:
    """Fused per-image dithering kernel: translate, erode/dilate/none, and pixel-noise.

    One compiled pass per image. out[:, 0] is the unmodified
    original; out[:, 1:] are the n_variants augmented copies.

    Parallelised across images via prange (per-image work is embarrassingly
    parallel; the transform within one image is small and inherently
    sequential). Translation is exact integer array indexing, not
    interpolated, so exact-integer shifts never introduce off-by-one pixel
    noise. Erosion/dilation reproduce scipy.ndimage's default 4-connected,
    border_value=0 semantics.

    All randomness (dx, dy, op selection, per-pixel noise mask) is drawn with
    ordinary numpy Generator calls OUTSIDE this kernel and passed in as plain
    arrays -- numba's parallel=True/prange does not guarantee reproducible
    RNG state across threads. This kernel performs zero RNG, only
    deterministic transforms.
    """
    n, h, w = stacked.shape
    n_variants = dx.shape[1]
    for i in prange(n):
        base = np.empty((h, w), dtype=np.uint8)
        for y in range(h):
            for x in range(w):
                base[y, x] = 1 if stacked[i, y, x] > 0 else 0
                out[i, 0, y, x] = base[y, x] * 255
        for v in range(n_variants):
            ddx = dx[i, v]
            ddy = dy[i, v]
            shifted = np.zeros((h, w), dtype=np.uint8)
            for y in range(h):
                sy = y - ddy
                if sy < 0 or sy >= h:
                    continue
                for x in range(w):
                    sx = x - ddx
                    if sx < 0 or sx >= w:
                        continue
                    shifted[y, x] = base[sy, sx]
            o = op[i, v]
            for y in range(h):
                for x in range(w):
                    if o == 0:
                        val = shifted[y, x]
                    elif o == 1:  # erode: AND with all 4 neighbours, OOB=0
                        val = shifted[y, x]
                        if val and (y == 0 or shifted[y - 1, x] == 0 or y == h - 1 or shifted[y + 1, x] == 0 or x == 0 or shifted[y, x - 1] == 0 or x == w - 1 or shifted[y, x + 1] == 0):
                            val = 0
                    else:  # dilate: OR with all 4 neighbours, OOB contributes nothing
                        val = shifted[y, x]
                        if not val and ((y > 0 and shifted[y - 1, x]) or (y < h - 1 and shifted[y + 1, x]) or (x > 0 and shifted[y, x - 1]) or (x < w - 1 and shifted[y, x + 1])):
                                val = 1
                    if noise[i, v, y, x]:
                        val = 1 - val
                    out[i, v + 1, y, x] = val * 255


def dither_batch(
    samples: list[tuple[int, NDArray[np.uint8], float]],
    n_variants: int,
    rng: np.random.Generator,
) -> tuple[NDArray[np.uint8], list[int], list[float]]:
    """Dither (digit, img, weight) samples into a stacked (n*(n_variants+1), 64, 64) uint8 array.

    Processes DITHER_BATCH_SIZE images at a time to bound the memory used by
    the precomputed per-variant randomness arrays. All randomness is drawn
    sequentially from rng before each batch's kernel call, so the output is
    deterministic for a given rng draw order regardless of batch size.
    """
    n_samples = len(samples)
    out_imgs = np.empty(
        (n_samples * (n_variants + 1), THUMBNAIL_SIZE, THUMBNAIL_SIZE), dtype=np.uint8
    )
    out_labels: list[int] = []
    out_weights: list[float] = []
    write_pos = 0
    for start in range(0, n_samples, DITHER_BATCH_SIZE):
        batch = samples[start:start + DITHER_BATCH_SIZE]
        bn = len(batch)
        stacked = np.stack([img for _, img, _ in batch])
        dx = rng.integers(-2, 3, size=(bn, n_variants)).astype(np.int32)
        dy = rng.integers(-2, 3, size=(bn, n_variants)).astype(np.int32)
        op = rng.integers(0, 3, size=(bn, n_variants)).astype(np.int8)
        noise = rng.random((bn, n_variants, THUMBNAIL_SIZE, THUMBNAIL_SIZE)) < 0.01
        batch_out = np.empty(
            (bn, n_variants + 1, THUMBNAIL_SIZE, THUMBNAIL_SIZE), dtype=np.uint8
        )
        _dither_numba(stacked, dx, dy, op, noise, batch_out)
        n_out = bn * (n_variants + 1)
        out_imgs[write_pos:write_pos + n_out] = batch_out.reshape(
            -1, THUMBNAIL_SIZE, THUMBNAIL_SIZE
        )
        write_pos += n_out
        for digit, _, w in batch:
            out_labels.extend([digit] * (n_variants + 1))
            out_weights.extend([w] * (n_variants + 1))
    return out_imgs, out_labels, out_weights


def build_dataset(
    samples: list[tuple[int, NDArray[np.uint8]]],
    n_dither: int,
    sample_weights: list[float] | None = None,
) -> tuple[NDArray[np.uint8], NDArray[np.int64], NDArray[np.float64]]:
    """Augment samples with dithering, returning the stacked image array.

    Each (digit, img) pair produces n_dither+1 variants (original + n_dither
    augmented copies), generated by dither_batch's numba-JIT kernel.

    sample_weights assigns a per-source weight (before augmentation); all
    augmented variants from a source share the same weight. None means 1.0
    for all samples. Returns (aug_imgs, y, weights) where aug_imgs is the
    stacked (n_aug, 64, 64) uint8 image array -- feature extraction is the
    caller's job via ACTIVE_RECOGNISER.extract_features().
    """
    t0 = time.time()
    n_samples = len(samples)
    weights_in = sample_weights if sample_weights is not None else [1.0] * n_samples
    triples = [(digit, img, w) for (digit, img), w in zip(samples, weights_in, strict=False)]

    print(f"  Dithering {n_samples} samples ({n_dither} variants each, numba)...", flush=True)
    rng = np.random.default_rng(0)
    aug_imgs, aug_labels, aug_weights = dither_batch(triples, n_dither, rng)
    print(f"  [+{time.time() - t0:.0f}s] Dithering done", flush=True)

    assert len(aug_labels) == len(aug_imgs)  # sanity: dither_batch's own invariant, not re-derived here
    return aug_imgs, np.array(aug_labels, dtype=np.int64), np.array(aug_weights, dtype=np.float64)


# ---------------------------------------------------------------------------
# Fitting -- PCA on per-class means + RBF-SVM in PCA space
# ---------------------------------------------------------------------------

def fit_model(
    X: NDArray[np.float64],
    y: NDArray[np.int64],
    svm_c: float = SVM_C,
    svm_gamma: float | str = SVM_GAMMA,
    sample_weights: NDArray[np.float64] | None = None,
) -> dict[str, Any]:
    """Fit PCA + RBF SVM and collect per-digit template images.

    PCA is fitted on the per-class mean images (unweighted -- the PCA basis
    captures inter-digit structure, not decision-boundary placement, so
    sample_weights is applied only at the SVM-fit stage, matching
    killer_sudoku.training.train_number_recogniser's convention). The number
    of components kept is the minimum that explains VARIANCE_THRESHOLD of
    cumulative variance.
    """
    classes = sorted(set(y.tolist()))

    means = np.array([X[y == c].mean(axis=0) for c in classes])
    pca = PCA()
    pca.fit(means)
    cumsum = np.cumsum(pca.explained_variance_ratio_)
    dims = int(np.argmax(cumsum > VARIANCE_THRESHOLD))
    print(f"  PCA dims for {VARIANCE_THRESHOLD:.0%} variance: {dims}", flush=True)

    X_pca = pca.transform(X)[:, :dims]
    svc = SVC(kernel="rbf", C=svm_c, gamma=svm_gamma, decision_function_shape="ovo")
    svc.fit(X_pca, y, sample_weight=sample_weights)
    print(f"  Trained SVC (C={svm_c}, gamma={svm_gamma}) on {len(y)} samples", flush=True)

    templates_out: dict[int, NDArray[np.float32]] = {}
    for c in range(N_DIGITS):
        mask = y == c
        if mask.any():
            tmpl = X[mask].mean(axis=0).reshape(THUMBNAIL_SIZE, THUMBNAIL_SIZE)
        else:
            tmpl = np.zeros((THUMBNAIL_SIZE, THUMBNAIL_SIZE))
        templates_out[c] = tmpl.astype(np.float32)

    return {"pca": pca, "dims": dims, "svc": svc, "classes": classes, "templates": templates_out}


# ---------------------------------------------------------------------------
# I/O -- saving
# ---------------------------------------------------------------------------

def save_model(
    model: dict[str, Any],
    out_dir: Path,
    confidence_threshold: float = CONFIDENCE_THRESHOLD,
    template_threshold: float = TEMPLATE_THRESHOLD,
) -> None:
    """Write num_recogniser.json (manifest) and num_recogniser.bin (arrays).

    The binary layout and 'classifier_type': 'pca_rbf' manifest field must
    match loadNumRecogniser in web/src/image/numberRecognition.ts.
    """
    pca: PCA = model["pca"]
    svc: SVC = model["svc"]
    dims: int = model["dims"]

    try:
        gamma = float(svc._gamma)  # available after fit(); sklearn >= 0.22
    except AttributeError:
        gamma = 1.0 / (float(pca.n_features_in_) * float(np.var(pca.transform(pca.mean_.reshape(1, -1)))))

    named: list[tuple[str, np.ndarray[Any, Any], str]] = [
        ("pca_win_size",         np.array([THUMBNAIL_SIZE], dtype=np.int32),        "int32"),
        ("pca_dims",             np.array([dims], dtype=np.int32),                  "int32"),
        ("pca_components",       pca.components_.astype(np.float64),                "float64"),
        ("pca_mean",             pca.mean_.astype(np.float64),                      "float64"),
        ("rbf_support_vectors",  svc.support_vectors_.astype(np.float64),           "float64"),
        ("rbf_dual_coef",        svc.dual_coef_.astype(np.float64),                 "float64"),
        ("rbf_intercept",        svc.intercept_.astype(np.float64),                 "float64"),
        ("rbf_n_support",        svc.n_support_.astype(np.int32),                   "int32"),
        ("rbf_gamma",            np.array([gamma], dtype=np.float64),               "float64"),
        ("classes",              svc.classes_.astype(np.int32),                     "int32"),
        ("template_threshold",   np.array([template_threshold], dtype=np.float64),  "float64"),
        ("confidence_threshold", np.array([confidence_threshold], dtype=np.float64), "float64"),
    ]
    for d, tmpl in sorted(model["templates"].items()):
        named.append((f"template_{d}", tmpl, "float32"))

    blob = bytearray()
    manifest_arrays: dict[str, dict[str, Any]] = {}
    for name, arr, dtype_str in named:
        arr = np.asarray(arr)
        data = arr.tobytes()
        manifest_arrays[name] = {
            "dtype": dtype_str,
            "shape": list(arr.shape),
            "offset": len(blob),
            "byteLength": len(data),
        }
        blob.extend(data)

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "num_recogniser.bin").write_bytes(bytes(blob))
    (out_dir / "num_recogniser.json").write_text(
        json.dumps({"classifier_type": "pca_rbf", "arrays": manifest_arrays}, indent=2),
        encoding="utf-8",
    )

    n_sv = svc.support_vectors_.shape[0]
    print(f"\nSaved to {out_dir}/ [pca_rbf]", flush=True)
    print(f"  PCA:       {pca.components_.shape[0]} components, {dims} active dims", flush=True)
    print(f"  SVM:       {n_sv} support vectors, classes {svc.classes_.tolist()}", flush=True)
    print(f"  Templates: digits 0-9 ({THUMBNAIL_SIZE}x{THUMBNAIL_SIZE} float32)", flush=True)
    print(f"  Bin size:  {len(blob):,} bytes", flush=True)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "training_json", nargs="*", type=Path,
        help="Bulk training JSON file(s) (e.g. guardian/observer cage-total extractions). "
             "Subject to --max-per-class capping. Optional if synthetic is enabled.",
    )
    parser.add_argument(
        "--browser-file", type=Path, default=Path("web/browser_train.json"),
        help="Hand/app-verified browser-exported training JSON (default: web/browser_train.json). "
             "Always loaded in full (minus known-stale-geometry samples) and NEVER subject to "
             "--max-per-class capping. Pass a nonexistent path or --no-browser-file to skip.",
    )
    parser.add_argument(
        "--no-browser-file", action="store_true",
        help="Skip loading --browser-file entirely.",
    )
    parser.add_argument(
        "--out", type=Path, default=Path("web/public"),
        help="Output directory for model files (default: web/public)",
    )
    parser.add_argument(
        "--dither", type=int, default=DEFAULT_DITHER, metavar="N",
        help=f"Augmented variants per source sample (default: {DEFAULT_DITHER})",
    )
    parser.add_argument(
        "--no-synthetic", action="store_true",
        help="Skip system-font synthetic digit generation",
    )
    parser.add_argument(
        "--confidence-threshold", type=float, default=CONFIDENCE_THRESHOLD, metavar="T",
        help=f"OVO vote fraction to mark a read as confident (default: {CONFIDENCE_THRESHOLD})",
    )
    parser.add_argument(
        "--template-threshold", type=float, default=TEMPLATE_THRESHOLD, metavar="T",
        help=f"Template-match score below which the SVM fallback runs (default: {TEMPLATE_THRESHOLD})",
    )
    parser.add_argument(
        "--browser-weight", type=float, default=0.0, metavar="W",
        help="sklearn sample_weight for --browser-file samples relative to bulk/synthetic "
             "(0 = auto-balance: weight = (n_bulk + n_synthetic) / n_browser)",
    )
    parser.add_argument(
        "--max-per-class", type=int, default=0, metavar="N",
        help="Randomly subsample each digit class of the bulk training_json sources to at most "
             "N samples before dithering (0 = no cap; never applied to --browser-file).",
    )
    parser.add_argument(
        "--max-fit-samples", type=int, default=MAX_FIT_SAMPLES, metavar="N",
        help="Hard cap on rows passed to fit_model, applied by random subsampling after "
             f"dithering (default: {MAX_FIT_SAMPLES}). RBF-SVM fit cost scales worse than "
             "linearly with sample count -- this bounds worst-case fit time regardless of "
             "--dither or how large browser_train.json grows.",
    )
    args = parser.parse_args()

    t_start = time.time()

    def _elapsed() -> str:
        return f"[+{time.time() - t_start:.0f}s]"

    rng_cap = np.random.default_rng(0)
    stale_hashes = _load_stale_hashes()
    if stale_hashes:
        print(f"{_elapsed()} Loaded {len(stale_hashes)} known-stale-geometry sample hashes", flush=True)

    bulk_samples: list[tuple[int, NDArray[np.uint8]]] = []
    for path in args.training_json:
        samples = load_training_file(path, exclude_hashes=stale_hashes)
        print(f"{_elapsed()} Loaded {len(samples)} bulk samples from {path.name}", flush=True)
        bulk_samples.extend(samples)

    if args.max_per_class > 0 and bulk_samples:
        before = len(bulk_samples)
        bulk_samples = cap_per_class(bulk_samples, args.max_per_class, rng_cap)
        print(f"{_elapsed()} Capped bulk samples to {args.max_per_class}/class: "
              f"{before} -> {len(bulk_samples)}", flush=True)

    browser_samples: list[tuple[int, NDArray[np.uint8]]] = []
    if not args.no_browser_file and args.browser_file.exists():
        browser_samples = load_training_file(args.browser_file, exclude_hashes=stale_hashes)
        print(f"{_elapsed()} Loaded {len(browser_samples)} samples from {args.browser_file.name} "
              f"(ground truth, never capped)", flush=True)

    all_samples: list[tuple[int, NDArray[np.uint8]]] = browser_samples + bulk_samples
    n_browser = len(browser_samples)
    n_bulk = len(bulk_samples)

    if not args.no_synthetic:
        print(f"{_elapsed()} Generating synthetic font samples...", flush=True)
        synth = generate_synthetic_samples()
        print(f"{_elapsed()} Generated {len(synth)} synthetic samples", flush=True)
        all_samples.extend(synth)

    if not all_samples:
        import sys as _sys
        print("No samples -- pass JSON files or omit --no-synthetic.", file=_sys.stderr)
        raise SystemExit(1)

    n_synth = len(all_samples) - n_browser - n_bulk
    dist = dict(sorted(Counter(d for d, _ in all_samples).items()))
    print(f"{_elapsed()} Digit distribution: {dist}", flush=True)

    sample_weights: list[float] | None = None
    if n_browser > 0 and (n_bulk + n_synth) > 0:
        bw = args.browser_weight if args.browser_weight > 0 else float(n_bulk + n_synth) / n_browser
        sample_weights = [bw] * n_browser + [1.0] * (n_bulk + n_synth)
        print(f"{_elapsed()} Browser sample weight: {bw:.1f}x ({n_browser} browser, "
              f"{n_bulk} bulk, {n_synth} synthetic)", flush=True)

    print(f"{_elapsed()} Augmenting...", flush=True)
    aug_imgs, y, weights = build_dataset(all_samples, args.dither, sample_weights)
    print(f"{_elapsed()} Dataset: {aug_imgs.shape[0]} augmented images", flush=True)

    if aug_imgs.shape[0] > args.max_fit_samples:
        rng_fit = np.random.default_rng(0)
        idx = rng_fit.choice(aug_imgs.shape[0], size=args.max_fit_samples, replace=False)
        idx.sort()  # preserve original ordering; irrelevant to fit but keeps output deterministic-looking
        before_n = aug_imgs.shape[0]
        aug_imgs, y, weights = aug_imgs[idx], y[idx], (weights[idx] if weights is not None else None)
        print(f"{_elapsed()} Subsampled fit set (RBF-SVM cost backstop): "
              f"{before_n} -> {aug_imgs.shape[0]} rows (--max-fit-samples={args.max_fit_samples})", flush=True)

    print(f"{_elapsed()} Extracting features ({type(ACTIVE_RECOGNISER).__name__})...", flush=True)
    X = ACTIVE_RECOGNISER.extract_features(aug_imgs)
    print(f"{_elapsed()} Dataset: {X.shape[0]} samples x {X.shape[1]} features", flush=True)

    print(f"{_elapsed()} Fitting ({type(ACTIVE_RECOGNISER).__name__})...", flush=True)
    model = ACTIVE_RECOGNISER.fit(X, y, weights)

    print(f"{_elapsed()} Saving model...", flush=True)
    ACTIVE_RECOGNISER.save(
        model, Path(args.out),
        confidence_threshold=args.confidence_threshold,
        template_threshold=args.template_threshold,
    )
    print(f"{_elapsed()} Done.", flush=True)


if __name__ == "__main__":
    main()
