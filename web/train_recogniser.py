#!/usr/bin/env python3
"""Fit and export the production web digit recogniser.

This is Python orchestration around one deployable architecture: an OvO RBF SVM
trained on HOG plus hole-count features. Feature extraction is owned by TypeScript
and called through ``killer_sudoku.training.ts_bridge``; this module does not
reimplement browser inference.

Usage
-----
    # Standard retrain from accumulated browser training data:
    python web/train_recogniser.py --out web/public --browser-weight 1000

    # Train from synthetic fonts only (no puzzle data needed):
    python web/train_recogniser.py --out web/public

    # Skip synthetic font generation:
    python web/train_recogniser.py --no-synthetic

Workflow
--------
1. Export or collect labelled digit samples.
2. Run this script with the desired input sources and weights.
3. Audit the emitted model through ``web/scripts/validate-model.ts``.
4. Evaluate the candidate using the production-browser corpus gate.

The output binary layout is consumed by
``web/src/image/numberRecognition.ts::loadNumRecogniser`` and the manifest must use
``classifier_type: "rbf"``. Known stale-geometry samples are filtered by content
hash before training. Browser and reviewed samples may be upweighted at the SVM fit
stage without duplicating input rows.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import time
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import numpy as np
from numba import njit, prange
from numpy.typing import NDArray
from sklearn.decomposition import PCA
from sklearn.mixture import GaussianMixture
from sklearn.svm import SVC

from killer_sudoku.training import ts_bridge
from killer_sudoku.training.ts_bridge import RawDigitCrop, warp_crops

# ---------------------------------------------------------------------------
# Constants shared with the TypeScript HOG/RBF production model.
# ---------------------------------------------------------------------------

THUMBNAIL_SIZE = 64        # production recognition input is 64x64
DEFAULT_DITHER = 5         # augmented variants per source sample
MAX_FIT_SAMPLES = 60_000   # hard cap on post-dither rows passed to SVC.fit
CONFIDENCE_THRESHOLD = 0.7 # OVO vote fraction to mark a read as confident
SVM_C = 5.0
SVM_GAMMA = "scale"
DITHER_BATCH_SIZE = 4096
PCA_COMPONENTS = 0         # optional dimensionality reduction applied to HOG+hole+aspect features
                           # before the SVM fit, via --pca-components; shrinks the exported model
                           # and speeds up inference. Disabled by default -- PCA is unsupervised
                           # and has no reason to preserve low-variance-but-highly-discriminative
                           # directions (e.g. the 1-vs-7 aspect-ratio signal) over bulk-appearance
                           # variance, so it's opt-in until a labelled reduction (LDA/NCA) replaces it.

# HOG descriptor parameters exported with the active model. The browser reads these
# values and uses the matching cv.HOGDescriptor configuration for inference.
HOG_WIN_SIZE     = 64
HOG_CELL_SIZE    = 8
HOG_BLOCK_SIZE   = 16
HOG_BLOCK_STRIDE = 8
HOG_NBINS        = 9

_STALE_HASHES_PATH = Path(__file__).parent / "known-stale-training-hashes.json"
DEFAULT_OVERRIDES_PATH = Path("killer_sudoku/training/manual_label_overrides.json")


type WarpStrategy = Literal["stretch", "letterbox", "letterbox-centered"]


@dataclass(frozen=True)
class RawTrainingSample:
    """A browser-selected bounding-box crop that has not been recognition-warped."""

    digit: int
    pixels: NDArray[np.uint8]


@dataclass(frozen=True)
class CanonicalTrainingSample:
    """A historical square recogniser input tied to the strategy that produced it."""

    digit: int
    pixels: NDArray[np.uint8]
    warp_strategy: WarpStrategy


type TrainingSample = RawTrainingSample | CanonicalTrainingSample

# Version-1 exports were produced by square-padding before resize, which is
# geometrically equivalent to the deployed single-digit letterbox strategy.
LEGACY_V1_WARP_STRATEGY: WarpStrategy = "letterbox"

def deployed_warp_strategy(
    manifest_path: Path = Path(__file__).parent / "public" / "num_recogniser.json",
) -> WarpStrategy:
    """Read the current browser model's strategy instead of duplicating its default."""
    strategy = json.loads(manifest_path.read_text(encoding="utf-8")).get("warp_strategy")
    if strategy == "stretch":
        return "stretch"
    if strategy == "letterbox":
        return "letterbox"
    if strategy == "letterbox-centered":
        return "letterbox-centered"
    raise ValueError(
        f"{manifest_path}: unsupported deployed warp strategy {strategy!r}"
    )


def _load_stale_hashes() -> frozenset[str]:
    """Load the shared stale-sample-hash blocklist (see module docstring)."""
    if not _STALE_HASHES_PATH.exists():
        return frozenset()
    return frozenset(json.loads(_STALE_HASHES_PATH.read_text(encoding="utf-8")))


def _sample_hash(pixels: list[int]) -> str:
    """Hash canonical audit pixels exactly as numberRecognition.test.ts does."""
    return hashlib.sha256(bytes(pixels)).hexdigest()


def _byte_pixels(value: Any, expected: int, source: str) -> NDArray[np.uint8]:
    if not isinstance(value, list) or len(value) != expected:
        actual = len(value) if isinstance(value, list) else "non-array"
        raise ValueError(f"{source}: expected {expected} pixels, got {actual}")
    if any(not isinstance(pixel, int) or isinstance(pixel, bool) or not 0 <= pixel <= 255 for pixel in value):
        raise ValueError(f"{source}: pixels must be uint8 values")
    return np.asarray(value, dtype=np.uint8)


def _raw_training_sample(
    digit: int,
    pixels: Any,
    width: Any,
    height: Any,
    source: str,
) -> RawTrainingSample:
    if (
        not isinstance(width, int)
        or isinstance(width, bool)
        or not isinstance(height, int)
        or isinstance(height, bool)
        or width <= 0
        or height <= 0
    ):
        raise ValueError(f"{source}: raw crop dimensions must be positive integers")
    return RawTrainingSample(
        digit,
        _byte_pixels(pixels, width * height, source).reshape(height, width),
    )


def _canonical_training_sample(
    digit: int,
    pixels: Any,
    strategy: WarpStrategy,
    source: str,
) -> CanonicalTrainingSample:
    return CanonicalTrainingSample(
        digit,
        _byte_pixels(pixels, THUMBNAIL_SIZE**2, source).reshape(
            THUMBNAIL_SIZE,
            THUMBNAIL_SIZE,
        ),
        strategy,
    )


# ---------------------------------------------------------------------------
# Between-class-mean PCA: an alternative to plain (unsupervised) PCA that
# targets directions where the class means differ, rather than directions of
# maximum total variance. Equivalent to eigendecomposing the between-class
# scatter matrix used in LDA, without needing to invert a within-class
# covariance matrix (which is ill-conditioned in high dimensions relative to
# per-class sample counts).
# ---------------------------------------------------------------------------


def compute_label_means(X: NDArray[np.float64], y: NDArray[np.int64]) -> NDArray[np.float64]:
    """One representative mean vector per unique label, in sorted label order.

    Extension point: this assumes each label's samples form a single cluster.
    If a label turns out to be multi-modal (e.g. two visually distinct font
    styles collapsed under one digit), replace this with a version that fits
    a per-label GaussianMixture (comparing BIC across n_components) and
    returns one row per discovered sub-cluster instead of collapsing the
    label to a single overall mean. The caller (fit_class_mean_pca) only
    requires a matrix of "representative" mean vectors -- it does not require
    exactly one row per label.
    """
    labels = np.unique(y)
    return np.stack([X[y == label].mean(axis=0) for label in labels])


@dataclass(frozen=True)
class ClassMeanReduction:
    mean_of_means: NDArray[np.float64]
    between_components: NDArray[np.float64]           # (n_between, n_features)
    residual_mean: NDArray[np.float64] | None          # (n_features,)
    residual_components: NDArray[np.float64] | None    # (n_residual, n_features)


def fit_class_mean_pca(
    X: NDArray[np.float64], y: NDArray[np.int64], n_residual_components: int,
) -> tuple[NDArray[np.float64], ClassMeanReduction]:
    """Reduce X to the directions where label means differ most.

    Optionally supplemented by ordinary PCA on the residual (orthogonal-
    complement) variance so the reduced space isn't limited to purely-
    discriminative directions.
    """
    means = compute_label_means(X, y)
    n_labels = means.shape[0]
    mean_of_means = means.mean(axis=0)
    centered_means = means - mean_of_means
    # SVD on the (small: n_labels rows) centered means matrix. Centering makes
    # this rank-deficient by exactly one row, so the true rank is n_labels - 1
    # -- the same ceiling LDA has, reached without inverting a within-class
    # scatter matrix. full_matrices=False still returns min(n_labels,
    # n_features) rows regardless (the last one pairs with a ~zero singular
    # value), so it must be truncated explicitly rather than trusted as-is.
    _, _, vt = np.linalg.svd(centered_means, full_matrices=False)
    between_components = vt[: n_labels - 1]

    centered_X = X - mean_of_means
    between_proj = centered_X @ between_components.T

    if n_residual_components <= 0:
        return between_proj, ClassMeanReduction(mean_of_means, between_components, None, None)

    reconstruction = between_proj @ between_components
    residual = centered_X - reconstruction
    residual_pca = PCA(n_components=n_residual_components, random_state=0)
    residual_proj = residual_pca.fit_transform(residual)

    reduced = np.hstack([between_proj, residual_proj])
    return reduced, ClassMeanReduction(
        mean_of_means,
        between_components,
        residual_pca.mean_.astype(np.float64),
        residual_pca.components_.astype(np.float64),
    )


CLUSTER_N_COMPONENTS = 20
CLUSTER_N_CLUSTERS = 4


def cluster_pseudo_labels(
    imgs: NDArray[np.uint8], y: NDArray[np.int64], n_clusters: int = CLUSTER_N_CLUSTERS,
) -> NDArray[np.int64]:
    """Per-digit GMM clustering on HOG+hole+aspect features, training-time only.

    Returns pseudo_label = digit * 10 + cluster_id, so downstream code can
    recover the true digit via integer division by 10. Never reaches
    production inference -- production PcaRecogniser never computes HOG.
    """
    hog, hole, aspect = ts_bridge.extract_features(list(imgs))
    cluster_features = np.hstack([hog, hole, aspect.reshape(-1, 1)])
    pseudo = np.zeros(len(y), dtype=np.int64)
    for digit in np.unique(y):
        mask = y == digit
        digit_features = cluster_features[mask]
        k = min(n_clusters, mask.sum())
        if k <= 1:
            pseudo[mask] = digit * 10
            continue
        reduced = PCA(
            n_components=min(CLUSTER_N_COMPONENTS, digit_features.shape[1]), random_state=0,
        ).fit_transform(digit_features)
        gmm = GaussianMixture(n_components=k, random_state=0, n_init=5)
        cluster_ids = gmm.fit_predict(reduced)
        pseudo[mask] = digit * 10 + cluster_ids
    return pseudo


# ---------------------------------------------------------------------------
# Production HOG/RBF trainer.
# ---------------------------------------------------------------------------


class HogRecogniser:
    def extract_features(self, imgs: NDArray[np.uint8]) -> NDArray[np.float64]:
        hog, hole, aspect = ts_bridge.extract_features(list(imgs))
        return np.hstack([hog, hole, aspect.reshape(-1, 1)])

    def fit(
        self, X: NDArray[np.float64], y: NDArray[np.int64],
        sample_weights: NDArray[np.float64] | None,
        pca_components: int = PCA_COMPONENTS,
        class_mean_residual_components: int = -1,
    ) -> dict[str, Any]:
        # Fit the sole production classifier architecture.
        pca: PCA | None = None
        class_mean: ClassMeanReduction | None = None
        if class_mean_residual_components >= 0:
            X, class_mean = fit_class_mean_pca(X, y, class_mean_residual_components)
        elif pca_components > 0:
            pca = PCA(n_components=pca_components, random_state=0)
            X = pca.fit_transform(X)
        svc = SVC(kernel="rbf", C=SVM_C, gamma=SVM_GAMMA, decision_function_shape="ovo")
        svc.fit(X, y, sample_weight=sample_weights)
        return {
            "kind": "rbf", "clf": svc, "classes": svc.classes_,
            "pca": pca, "class_mean": class_mean,
        }

    def save(
        self, model: dict[str, Any], out_dir: Path,
        warp_strategy: WarpStrategy,
        confidence_threshold: float = CONFIDENCE_THRESHOLD,
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
            ("use_aspect_feature",   np.array([1], dtype=np.int32),                "int32"),
        ]
        pca: PCA | None = model.get("pca")
        if pca is not None:
            named.append(("pca_mean", pca.mean_.astype(np.float64), "float64"))
            named.append(("pca_components", pca.components_.astype(np.float64), "float64"))

        class_mean: ClassMeanReduction | None = model.get("class_mean")
        if class_mean is not None:
            named.append(("cm_mean_of_means", class_mean.mean_of_means.astype(np.float64), "float64"))
            named.append(("cm_between_components", class_mean.between_components.astype(np.float64), "float64"))
            if class_mean.residual_components is not None:
                assert class_mean.residual_mean is not None
                named.append(("cm_residual_mean", class_mean.residual_mean.astype(np.float64), "float64"))
                named.append(("cm_residual_components", class_mean.residual_components.astype(np.float64), "float64"))

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
            json.dumps(
                {
                    "classifier_type": "rbf",
                    "warp_strategy": warp_strategy,
                    "arrays": manifest_arrays,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        n_sv = svc.support_vectors_.shape[0]
        print(f"\nSaved to {out_dir}/ [hog/rbf]", flush=True)
        print(f"  SVM: {n_sv} support vectors, classes {svc.classes_.tolist()}", flush=True)
        if pca is not None:
            print(f"  PCA: {pca.n_components_} components ({pca.explained_variance_ratio_.sum():.1%} variance retained)", flush=True)
        if class_mean is not None:
            n_between = class_mean.between_components.shape[0]
            n_residual = 0 if class_mean.residual_components is None else class_mean.residual_components.shape[0]
            print(f"  Class-mean PCA: {n_between} between-class + {n_residual} residual components", flush=True)
        print(f"  Bin size: {len(blob):,} bytes", flush=True)


class PcaRecogniser:
    def extract_features(self, imgs: NDArray[np.uint8]) -> NDArray[np.float64]:
        return imgs.reshape(imgs.shape[0], -1).astype(np.float64)

    def fit(
        self, X: NDArray[np.float64], y: NDArray[np.int64],
        sample_weights: NDArray[np.float64] | None,
        imgs_for_clustering: NDArray[np.uint8],
        n_clusters: int = CLUSTER_N_CLUSTERS,
        class_mean_residual_components: int = 0,
    ) -> dict[str, Any]:
        pseudo_y = cluster_pseudo_labels(imgs_for_clustering, y, n_clusters=n_clusters)
        template_pixels = compute_label_means(X, pseudo_y)
        template_labels = np.array(
            [label // 10 for label in np.unique(pseudo_y)], dtype=np.int64,
        )

        reduced, class_mean = fit_class_mean_pca(X, pseudo_y, class_mean_residual_components)
        svc = SVC(kernel="rbf", C=SVM_C, gamma=SVM_GAMMA, decision_function_shape="ovo")
        svc.fit(reduced, y, sample_weight=sample_weights)
        return {
            "kind": "rbf", "clf": svc, "classes": svc.classes_,
            "class_mean": class_mean,
            "template_pixels": template_pixels,
            "template_labels": template_labels,
        }

    def save(
        self, model: dict[str, Any], out_dir: Path,
        warp_strategy: WarpStrategy,
        confidence_threshold: float = CONFIDENCE_THRESHOLD,
    ) -> None:
        svc: SVC = model["clf"]
        try:
            gamma = float(svc._gamma)
        except AttributeError:
            gamma = 1.0

        class_mean: ClassMeanReduction = model["class_mean"]
        named: list[tuple[str, np.ndarray[Any, Any], str]] = [
            ("rbf_support_vectors",  svc.support_vectors_.astype(np.float64),      "float64"),
            ("rbf_dual_coef",        svc.dual_coef_.astype(np.float64),            "float64"),
            ("rbf_intercept",        svc.intercept_.astype(np.float64),            "float64"),
            ("rbf_n_support",        svc.n_support_.astype(np.int32),              "int32"),
            ("rbf_gamma",            np.array([gamma], dtype=np.float64),          "float64"),
            ("classes",              svc.classes_.astype(np.int32),                "int32"),
            ("confidence_threshold", np.array([confidence_threshold], dtype=np.float64), "float64"),
            ("cm_mean_of_means",       class_mean.mean_of_means.astype(np.float64), "float64"),
            ("cm_between_components", class_mean.between_components.astype(np.float64), "float64"),
            ("template_pixels", model["template_pixels"].astype(np.float64), "float64"),
            ("template_labels", model["template_labels"].astype(np.int32), "int32"),
        ]
        if class_mean.residual_components is not None:
            assert class_mean.residual_mean is not None
            named.append(("cm_residual_mean", class_mean.residual_mean.astype(np.float64), "float64"))
            named.append(("cm_residual_components", class_mean.residual_components.astype(np.float64), "float64"))

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
            json.dumps(
                {
                    "classifier_type": "rbf",
                    "recogniser_type": "pca",
                    "warp_strategy": warp_strategy,
                    "arrays": manifest_arrays,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        n_sv = svc.support_vectors_.shape[0]
        n_templates = model["template_pixels"].shape[0]
        print(f"\nSaved to {out_dir}/ [pca/rbf]", flush=True)
        print(f"  SVM: {n_sv} support vectors, classes {svc.classes_.tolist()}", flush=True)
        print(f"  Templates: {n_templates}", flush=True)
        n_between = class_mean.between_components.shape[0]
        n_residual = 0 if class_mean.residual_components is None else class_mean.residual_components.shape[0]
        print(f"  Class-mean PCA: {n_between} between-cluster + {n_residual} residual components", flush=True)
        print(f"  Bin size: {len(blob):,} bytes", flush=True)


# ---------------------------------------------------------------------------
# I/O -- loading
# ---------------------------------------------------------------------------

def load_training_file(
    path: Path,
    exclude_hashes: frozenset[str] = frozenset(),
) -> list[TrainingSample]:
    """Discriminate raw and canonical records without using array shape as a hint."""
    data = json.loads(path.read_text(encoding="utf-8"))
    schema_version = data.get("schemaVersion", data.get("version"))
    if schema_version not in (1, 2):
        raise ValueError(f"{path.name}: unsupported training schema version {schema_version!r}")
    if data.get("thumbnailSize", THUMBNAIL_SIZE) != THUMBNAIL_SIZE:
        raise ValueError(
            f"{path.name}: canonical samples must be "
            f"{THUMBNAIL_SIZE}x{THUMBNAIL_SIZE}"
        )

    samples: list[TrainingSample] = []
    skipped = 0
    raw_fields = ("sourceRect", "sourceWidth", "sourceHeight", "sourcePixels")
    for index, sample in enumerate(data["samples"]):
        source = f"{path.name} sample {index}"
        digit = int(sample["digit"])
        raw_present = [field in sample for field in raw_fields]
        if any(raw_present) and not all(raw_present):
            raise ValueError(f"{source}: raw crop metadata is incomplete")

        if all(raw_present):
            audit_pixels = sample.get("recognitionPixels")
            _byte_pixels(
                audit_pixels,
                THUMBNAIL_SIZE**2,
                f"{source} recognitionPixels",
            )
            if exclude_hashes and _sample_hash(audit_pixels) in exclude_hashes:
                skipped += 1
                continue
            width = sample.get("sourceWidth")
            height = sample.get("sourceHeight")
            rect = sample.get("sourceRect")
            if (
                not isinstance(rect, list)
                or len(rect) != 4
                or any(not isinstance(value, int) or isinstance(value, bool) for value in rect)
                or rect[2] != width
                or rect[3] != height
            ):
                raise ValueError(f"{source}: sourceRect must match source dimensions")
            samples.append(_raw_training_sample(
                digit,
                sample.get("sourcePixels"),
                width,
                height,
                source,
            ))
            continue

        if "pixels" in sample:
            pixels = sample.get("pixels")
            strategy = LEGACY_V1_WARP_STRATEGY
        elif "recognitionPixels" in sample:
            pixels = sample.get("recognitionPixels")
            stored_strategy = sample.get("warpStrategy")
            if stored_strategy == "stretch":
                strategy = "stretch"
            elif stored_strategy == "letterbox":
                strategy = "letterbox"
            elif stored_strategy == "letterbox-centered":
                strategy = "letterbox-centered"
            else:
                raise ValueError(
                    f"{source}: canonical sample has unsupported warp strategy "
                    f"{stored_strategy!r}"
                )
        else:
            raise ValueError(f"{source}: sample is neither raw nor explicitly canonical")

        canonical_sample = _canonical_training_sample(digit, pixels, strategy, source)
        if exclude_hashes and _sample_hash(pixels) in exclude_hashes:
            skipped += 1
            continue
        samples.append(canonical_sample)

    if skipped:
        print(
            f"  Excluded {skipped} known-stale-geometry sample(s) from {path.name}",
            flush=True,
        )
    return samples


def load_overrides_file(path: Path) -> list[TrainingSample]:
    """Load human-reviewed raw crops and historical canonical overrides."""
    if not path.exists():
        return []
    import base64
    import io

    from PIL import Image

    overrides: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    samples: list[TrainingSample] = []
    for key, entry in overrides.items():
        if entry["label"] == "exclude":
            continue
        crop = np.array(
            Image.open(io.BytesIO(base64.b64decode(entry["cropPng"]))).convert("L"),
            dtype=np.uint8,
        )
        metadata_fields = ("sourceRect", "sourceWidth", "sourceHeight")
        present = [field in entry for field in metadata_fields]
        if any(present) and not all(present):
            raise ValueError(f"{key}: raw crop metadata is incomplete")
        digit = int(entry["label"])
        if all(present):
            width = entry["sourceWidth"]
            height = entry["sourceHeight"]
            rect = entry["sourceRect"]
            if not isinstance(width, int) or not isinstance(height, int):
                raise ValueError(f"{key}: source dimensions must be integers")
            if width <= 0 or height <= 0:
                raise ValueError(f"{key}: source dimensions must be positive")
            if int(rect["width"]) != width or int(rect["height"]) != height:
                raise ValueError(f"{key}: sourceRect dimensions disagree with source dimensions")
            if crop.shape != (height, width):
                raise ValueError(
                    f"{key}: PNG dimensions {crop.shape[1]}x{crop.shape[0]} "
                    f"do not match source metadata {width}x{height}"
                )
            samples.append(RawTrainingSample(digit, crop))
        else:
            if crop.shape != (THUMBNAIL_SIZE, THUMBNAIL_SIZE):
                raise ValueError(
                    f"{key}: legacy override lacks raw crop metadata and is not "
                    f"{THUMBNAIL_SIZE}x{THUMBNAIL_SIZE}"
                )
            samples.append(CanonicalTrainingSample(
                digit,
                crop,
                LEGACY_V1_WARP_STRATEGY,
            ))
    return samples


def cap_per_class(
    samples: list[TrainingSample],
    max_per_class: int,
    rng: np.random.Generator,
) -> list[TrainingSample]:
    """Randomly subsample each digit class down to at most max_per_class."""
    by_digit: dict[int, list[TrainingSample]] = {}
    for sample in samples:
        by_digit.setdefault(sample.digit, []).append(sample)
    capped: list[TrainingSample] = []
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
) -> list[TrainingSample]:
    """Render training-only raw glyph crops without emulating browser selection."""
    t0 = time.time()
    print(f"  [+{time.time() - t0:.0f}s] Scanning system fonts (matplotlib font cache "
          f"may take a while on first run)...", flush=True)
    import matplotlib.font_manager as fm
    from PIL import Image, ImageDraw, ImageFont

    font_paths = fm.findSystemFonts(fontext="ttf")
    print(f"  [+{time.time() - t0:.0f}s] Found {len(font_paths)} fonts", flush=True)
    samples: list[TrainingSample] = []
    report_every = max(1, len(font_paths) // 20)

    for fi, font_path in enumerate(font_paths):
        for pt in pt_sizes:
            for digit in range(1, 10):
                try:
                    font = ImageFont.truetype(font_path, pt)
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
                except Exception:
                    continue
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
                if crop.max() > 0:
                    samples.append(RawTrainingSample(digit, crop))

        if (fi + 1) % report_every == 0 or fi + 1 == len(font_paths):
            print(f"  [+{time.time() - t0:.0f}s] Rendered fonts {fi + 1}/{len(font_paths)} "
                  f"({len(samples)} samples so far)", flush=True)

    return samples


def deduplicate_training_samples(
    samples: list[TrainingSample],
) -> list[TrainingSample]:
    """Keep the first exact input from the merged sources and discard later duplicates."""
    seen: set[tuple[int, str, int, int, WarpStrategy | None, bytes]] = set()
    deduplicated: list[TrainingSample] = []

    for index, sample in enumerate(samples):
        if sample.pixels.ndim != 2:
            raise ValueError(
                f"training sample {index} must have two-dimensional pixels, "
                f"got {sample.pixels.shape}"
            )
        height, width = sample.pixels.shape
        if isinstance(sample, RawTrainingSample):
            sample_kind = "raw"
            warp_strategy = None
        else:
            sample_kind = "canonical"
            warp_strategy = sample.warp_strategy
        key = (
            sample.digit,
            sample_kind,
            width,
            height,
            warp_strategy,
            sample.pixels.tobytes(order="C"),
        )
        if key in seen:
            continue
        seen.add(key)
        deduplicated.append(sample)

    return deduplicated


def canonicalize_samples(
    samples: list[TrainingSample],
    strategy: WarpStrategy,
) -> list[tuple[int, NDArray[np.uint8]]]:
    """Warp each raw input once in TS and retain only compatible canonical inputs."""
    raw_samples = [sample for sample in samples if isinstance(sample, RawTrainingSample)]
    raw_crops: list[RawDigitCrop] = []
    for index, raw_sample in enumerate(raw_samples):
        if raw_sample.pixels.ndim != 2 or 0 in raw_sample.pixels.shape:
            raise ValueError(
                f"raw training sample {index} must have positive two-dimensional pixels, "
                f"got {raw_sample.pixels.shape}"
            )
        if raw_sample.pixels.dtype != np.uint8:
            raise ValueError(
                f"raw training sample {index} must have dtype uint8, got {raw_sample.pixels.dtype}"
            )
        raw_crops.append(RawDigitCrop(raw_sample.pixels))

    warped = warp_crops(raw_crops, strategy, THUMBNAIL_SIZE)
    if warped.shape != (len(raw_samples), THUMBNAIL_SIZE, THUMBNAIL_SIZE):
        raise RuntimeError(
            "warp bridge returned invalid training array shape "
            f"{warped.shape}, expected {(len(raw_samples), THUMBNAIL_SIZE, THUMBNAIL_SIZE)}"
        )
    raw_iter = iter(warped)

    canonical: list[tuple[int, NDArray[np.uint8]]] = []
    for sample in samples:
        if isinstance(sample, RawTrainingSample):
            canonical.append((sample.digit, next(raw_iter)))
            continue
        if sample.warp_strategy != strategy:
            continue
        if sample.pixels.shape != (THUMBNAIL_SIZE, THUMBNAIL_SIZE):
            raise ValueError(
                f"canonical training sample must be {THUMBNAIL_SIZE}x{THUMBNAIL_SIZE}, "
                f"got {sample.pixels.shape}"
            )
        if sample.pixels.dtype != np.uint8:
            raise ValueError(
                f"canonical training sample must have dtype uint8, got {sample.pixels.dtype}"
            )
        canonical.append((sample.digit, sample.pixels))
    return canonical


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
    translate: bool = True,
) -> tuple[NDArray[np.uint8], list[int], list[float]]:
    """Dither (digit, img, weight) samples into a stacked (n*(n_variants+1), 64, 64) uint8 array.

    Processes DITHER_BATCH_SIZE images at a time to bound the memory used by
    the precomputed per-variant randomness arrays. All randomness is drawn
    sequentially from rng before each batch's kernel call, so the output is
    deterministic for a given rng draw order regardless of batch size.

    translate=False zeroes the dx/dy shift range (still applies
    erode/dilate/noise) -- for recognisers whose crop normalization already
    handles translation deterministically (see centerByCentroid), so the
    jitter augmentation doesn't need to re-teach that robustness
    stochastically.
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
        shift_lo, shift_hi = (-2, 3) if translate else (0, 1)
        dx = rng.integers(shift_lo, shift_hi, size=(bn, n_variants)).astype(np.int32)
        dy = rng.integers(shift_lo, shift_hi, size=(bn, n_variants)).astype(np.int32)
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
    translate: bool = True,
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
    aug_imgs, aug_labels, aug_weights = dither_batch(triples, n_dither, rng, translate=translate)
    print(f"  [+{time.time() - t0:.0f}s] Dithering done", flush=True)

    assert len(aug_labels) == len(aug_imgs)  # sanity: dither_batch's own invariant, not re-derived here
    return aug_imgs, np.array(aug_labels, dtype=np.int64), np.array(aug_weights, dtype=np.float64)


def _git_commit() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        )
        return result.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def write_training_manifest(
    out_dir: Path,
    *,
    sources: dict[str, Any],
    digit_distribution: dict[int, int],
    warp_strategy: WarpStrategy,
    dither: int,
    pca_components: int,
    class_mean_residual_components: int,
    confidence_threshold: float,
    dataset_size_post_dither: int,
    dataset_size_fit: int,
) -> None:
    """Record what a checked-in model was trained on, alongside the model itself.

    Written every run so `git log -- web/public/training_manifest.json` gives a
    per-checkin history of input sources and dataset composition -- the model
    binary alone doesn't say what produced it.
    """
    manifest = {
        "trained_at": datetime.now(UTC).isoformat(),
        "git_commit": _git_commit(),
        "warp_strategy": warp_strategy,
        "dither": dither,
        "pca_components": pca_components,
        "class_mean_residual_components": class_mean_residual_components,
        "confidence_threshold": confidence_threshold,
        "sources": sources,
        "digit_distribution": {str(k): v for k, v in sorted(digit_distribution.items())},
        "dataset_size_post_dither": dataset_size_post_dither,
        "dataset_size_fit": dataset_size_fit,
    }
    (out_dir / "training_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8",
    )


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
        "--browser-file", type=Path, default=Path("web/corpus_train.json"),
        help="Hand/app-verified training JSON, corpus.db-sourced (default: web/corpus_train.json). "
             "Always loaded in full (minus known-stale-geometry samples) and NEVER subject to "
             "--max-per-class capping. Pass a nonexistent path or --no-browser-file to skip.",
    )
    parser.add_argument(
        "--no-browser-file", action="store_true",
        help="Skip loading --browser-file entirely.",
    )
    parser.add_argument(
        "--overrides-file", type=Path, default=DEFAULT_OVERRIDES_PATH,
        help="Human-verified corrections from review_low_confidence.py's tick-sheet workflow "
             f"(default: {DEFAULT_OVERRIDES_PATH}). Folded into the same ground-truth weight "
             "bucket as --browser-file. Pass a nonexistent path or --no-overrides-file to skip.",
    )
    parser.add_argument(
        "--no-overrides-file", action="store_true",
        help="Skip loading --overrides-file entirely.",
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
        "--warp-strategy",
        choices=("stretch", "letterbox", "letterbox-centered"),
        default=deployed_warp_strategy(),
        help="Production TypeScript crop warp used for raw training inputs "
             "(default: strategy in the deployed model manifest)",
    )
    parser.add_argument(
        "--confidence-threshold", type=float, default=CONFIDENCE_THRESHOLD, metavar="T",
        help=f"OVO vote fraction to mark a read as confident (default: {CONFIDENCE_THRESHOLD})",
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
        help="Hard cap on rows passed to SVC.fit, applied by random subsampling after "
             f"dithering (default: {MAX_FIT_SAMPLES}). RBF-SVM fit cost scales worse than "
             "linearly with sample count -- this bounds worst-case fit time regardless of "
             "--dither or how large corpus_train.json grows.",
    )
    parser.add_argument(
        "--pca-components", type=int, default=PCA_COMPONENTS, metavar="N",
        help="Reduce HOG+hole features to N components via PCA before the SVM fit, "
             f"shrinking the exported model and speeding up inference (default: {PCA_COMPONENTS}; "
             "0 disables PCA and fits on raw features).",
    )
    parser.add_argument(
        "--class-mean-residual-components", type=int, default=-1, metavar="N",
        help="Reduce features to the directions where digit-class means differ most "
             "(at most n_classes-1 dimensions, equivalent to the between-class scatter "
             "used in LDA, without inverting a within-class covariance matrix), plus N "
             "residual PCA components for general variance. Overrides --pca-components "
             "when set. -1 (default) disables it; 0 keeps only the between-class directions.",
    )
    parser.add_argument(
        "--recogniser", choices=("hog", "pca"), default="hog",
        help="Recogniser architecture to train (default: hog, the current "
             "production classifier). 'pca' trains the cluster-mean-seeded "
             "PCA+RBF recogniser instead -- see "
             "docs/superpowers/specs/2026-07-31-cluster-mean-pca-recogniser-design.md.",
    )
    args = parser.parse_args()

    active_recogniser: HogRecogniser | PcaRecogniser = (
        PcaRecogniser() if args.recogniser == "pca" else HogRecogniser()
    )

    t_start = time.time()

    def _elapsed() -> str:
        return f"[+{time.time() - t_start:.0f}s]"

    rng_cap = np.random.default_rng(0)
    stale_hashes = _load_stale_hashes()
    if stale_hashes:
        print(f"{_elapsed()} Loaded {len(stale_hashes)} known-stale-geometry sample hashes", flush=True)

    bulk_inputs: list[TrainingSample] = []
    for path in args.training_json:
        samples = load_training_file(path, exclude_hashes=stale_hashes)
        print(f"{_elapsed()} Loaded {len(samples)} bulk samples from {path.name}", flush=True)
        bulk_inputs.extend(samples)

    if args.max_per_class > 0 and bulk_inputs:
        before = len(bulk_inputs)
        bulk_inputs = cap_per_class(bulk_inputs, args.max_per_class, rng_cap)
        print(f"{_elapsed()} Capped bulk samples to {args.max_per_class}/class: "
              f"{before} -> {len(bulk_inputs)}", flush=True)

    browser_inputs: list[TrainingSample] = []
    if not args.no_browser_file and args.browser_file.exists():
        browser_inputs = load_training_file(args.browser_file, exclude_hashes=stale_hashes)
        print(f"{_elapsed()} Loaded {len(browser_inputs)} samples from {args.browser_file.name} "
              f"(ground truth, never capped)", flush=True)

    if not args.no_overrides_file:
        override_samples = load_overrides_file(args.overrides_file)
        if override_samples:
            print(f"{_elapsed()} Loaded {len(override_samples)} human-reviewed corrections from "
                  f"{args.overrides_file.name} (ground truth, folded into browser weight bucket)",
                  flush=True)
            browser_inputs.extend(override_samples)

    synthetic_inputs: list[TrainingSample] = []
    if not args.no_synthetic:
        print(f"{_elapsed()} Generating synthetic font samples...", flush=True)
        synthetic_inputs = generate_synthetic_samples()
        print(f"{_elapsed()} Generated {len(synthetic_inputs)} synthetic samples", flush=True)

    merged_inputs = browser_inputs + bulk_inputs + synthetic_inputs
    deduplicated_inputs = deduplicate_training_samples(merged_inputs)
    if len(deduplicated_inputs) != len(merged_inputs):
        print(
            f"{_elapsed()} Deduplicated merged inputs: "
            f"{len(merged_inputs)} -> {len(deduplicated_inputs)} (first occurrence wins)",
            flush=True,
        )

    retained_ids = {id(sample) for sample in deduplicated_inputs}
    browser_inputs = [sample for sample in browser_inputs if id(sample) in retained_ids]
    bulk_inputs = [sample for sample in bulk_inputs if id(sample) in retained_ids]
    synthetic_inputs = [sample for sample in synthetic_inputs if id(sample) in retained_ids]

    strategy: WarpStrategy = args.warp_strategy
    print(f"{_elapsed()} Applying production TS {strategy} warp to raw samples...", flush=True)
    browser_samples = canonicalize_samples(browser_inputs, strategy)
    bulk_samples = canonicalize_samples(bulk_inputs, strategy)
    synthetic_samples = canonicalize_samples(synthetic_inputs, strategy)
    excluded_legacy = (
        len(deduplicated_inputs)
        - len(browser_samples) - len(bulk_samples) - len(synthetic_samples)
    )
    if excluded_legacy:
        print(
            f"{_elapsed()} Excluded {excluded_legacy} canonical sample(s) produced by a different warp",
            flush=True,
        )

    all_samples = browser_samples + bulk_samples + synthetic_samples
    n_browser = len(browser_samples)
    n_bulk = len(bulk_samples)

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
    aug_imgs, y, weights = build_dataset(
        all_samples, args.dither, sample_weights,
        translate=(args.recogniser != "pca"),
    )
    print(f"{_elapsed()} Dataset: {aug_imgs.shape[0]} augmented images", flush=True)
    dataset_size_post_dither = aug_imgs.shape[0]

    if aug_imgs.shape[0] > args.max_fit_samples:
        rng_fit = np.random.default_rng(0)
        idx = rng_fit.choice(aug_imgs.shape[0], size=args.max_fit_samples, replace=False)
        idx.sort()  # preserve original ordering; irrelevant to fit but keeps output deterministic-looking
        before_n = aug_imgs.shape[0]
        aug_imgs, y, weights = aug_imgs[idx], y[idx], (weights[idx] if weights is not None else None)
        print(f"{_elapsed()} Subsampled fit set (RBF-SVM cost backstop): "
              f"{before_n} -> {aug_imgs.shape[0]} rows (--max-fit-samples={args.max_fit_samples})", flush=True)

    print(f"{_elapsed()} Extracting features ({type(active_recogniser).__name__})...", flush=True)
    X = active_recogniser.extract_features(aug_imgs)
    print(f"{_elapsed()} Dataset: {X.shape[0]} samples x {X.shape[1]} features", flush=True)

    print(f"{_elapsed()} Fitting ({type(active_recogniser).__name__})...", flush=True)
    if isinstance(active_recogniser, PcaRecogniser):
        model = active_recogniser.fit(
            X, y, weights,
            imgs_for_clustering=aug_imgs,
            class_mean_residual_components=max(args.class_mean_residual_components, 0),
        )
    else:
        model = active_recogniser.fit(
            X, y, weights,
            pca_components=args.pca_components,
            class_mean_residual_components=args.class_mean_residual_components,
        )

    print(f"{_elapsed()} Saving model...", flush=True)
    out_dir = Path(args.out)
    active_recogniser.save(
        model, out_dir,
        confidence_threshold=args.confidence_threshold,
        warp_strategy=strategy,
    )
    write_training_manifest(
        out_dir,
        sources={
            "browser_file": (
                None if args.no_browser_file or not args.browser_file.exists()
                else str(args.browser_file)
            ),
            "overrides_file": (
                None if args.no_overrides_file or not args.overrides_file.exists()
                else str(args.overrides_file)
            ),
            "bulk_files": [str(p) for p in args.training_json],
            "n_browser": n_browser,
            "n_bulk": n_bulk,
            "n_synthetic": n_synth,
        },
        digit_distribution=dist,
        warp_strategy=strategy,
        dither=args.dither,
        pca_components=args.pca_components,
        class_mean_residual_components=args.class_mean_residual_components,
        confidence_threshold=args.confidence_threshold,
        dataset_size_post_dither=dataset_size_post_dither,
        dataset_size_fit=aug_imgs.shape[0],
    )
    print(f"{_elapsed()} Done.", flush=True)


if __name__ == "__main__":
    main()
