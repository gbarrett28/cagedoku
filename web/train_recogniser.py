#!/usr/bin/env python3
"""
Train the web digit recogniser using HOG features + LinearSVC.

Generates synthetic digit images from system fonts, optionally merges
browser-exported labelled samples, augments all sources with dithering,
extracts HOG features (identical to hogExtract in numberRecognition.ts),
and writes the trained model to web/public/.

Usage
-----
    # Standard retrain from accumulated browser training data:
    python web/train_recogniser.py --out web/public --browser-weight 1000 --svm-c 100 web/browser_train.json

    # Train from synthetic fonts only (no puzzle data needed):
    python web/train_recogniser.py --out web/public

    # Skip synthetic font generation:
    python web/train_recogniser.py --no-synthetic web/browser_train.json

    # Asymmetric dithering (more browser variants, fewer synthetic):
    python web/train_recogniser.py --dither 200 --synth-dither 5 web/browser_train.json

Workflow
--------
1. Export training data from the browser (OCR review screen → Export Training).
2. Run the merge step to add it to web/browser_train.json (or provide the
   exported JSON directly as an additional positional argument).
3. Run this script with --browser-weight 1000 --svm-c 100.
4. The updated model is live immediately: reload the web app.

Model format
------------
The binary layout is documented in web/src/image/numberRecognition.ts
(loadNumRecogniser).  The JSON manifest records each array's name, dtype,
shape, byte offset, and byte length.

Sample weights
--------------
--browser-weight upweights browser-exported samples relative to synthetic
font samples.  With ~9k synthetic samples and ~66 browser samples, auto-
balance (weight=0) sets weight≈137; weight=1000 gives browser samples
strong priority without causing SVM convergence problems (unlike weight>2000).
--svm-c 100 (vs default 10) enforces a harder margin, ensuring all browser
samples are correctly classified even when they fall near the boundary.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import binary_dilation, binary_erosion, shift
from sklearn.svm import SVC

# ---------------------------------------------------------------------------
# Constants — must match the TypeScript pipeline (web/src/image/numberRecognition.ts)
# ---------------------------------------------------------------------------

THUMBNAIL_SIZE = 64        # splitNum output: 64×64 binary image per digit
N_DIGITS = 10              # digits 0–9
DEFAULT_DITHER = 30        # augmented variants per source sample
CONFIDENCE_THRESHOLD = 0.7 # OVO vote fraction to mark a read as confident
SVM_C = 10.0
SVM_GAMMA = 0.01

# HOG descriptor parameters — identical values used in cv.HOGDescriptor (TypeScript).
HOG_WIN_SIZE     = 64
HOG_CELL_SIZE    = 8
HOG_BLOCK_SIZE   = 16
HOG_BLOCK_STRIDE = 8
HOG_NBINS        = 9
# ((64-16)/8+1)^2 * (16/8)^2 * 9 = 7^2 * 4 * 9
HOG_FEAT         = 1764

# Hole-count topology feature — see docs/superpowers/specs/2026-06-23-hole-count-feature-design.md
MIN_HOLE_AREA   = 6   # discard enclosed regions smaller than this (anti-aliasing/dither noise)
N_HOLE_FEATURES = 5


# ---------------------------------------------------------------------------
# I/O — loading
# ---------------------------------------------------------------------------

def load_training_file(path: Path) -> list[tuple[int, NDArray[np.uint8]]]:
    """Load (digit, 64×64 uint8) samples from one browser-exported JSON.

    The JSON is produced by web/src/image/trainingExport.ts and contains
    one sample per extracted digit contour, labelled with the user-verified
    cage total.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    samples: list[tuple[int, NDArray[np.uint8]]] = []
    for s in data["samples"]:
        digit = int(s["digit"])
        img = np.array(s["pixels"], dtype=np.uint8).reshape(
            THUMBNAIL_SIZE, THUMBNAIL_SIZE
        )
        samples.append((digit, img))
    return samples


def cap_per_class(
    samples: list[tuple[int, NDArray[np.uint8]]],
    max_per_class: int,
    rng: np.random.Generator,
) -> list[tuple[int, NDArray[np.uint8]]]:
    """Randomly subsample each digit class down to at most max_per_class.

    Bounds the largest class (and therefore the worst-case OneVsOne pair size
    that drives SVM fit time and memory) regardless of how skewed the input
    distribution is — e.g. digit '1' is far more common in cage totals than
    digit '5'. A no-op for classes already at or below the cap.
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


# ---------------------------------------------------------------------------
# Synthetic font generation
# ---------------------------------------------------------------------------

def generate_synthetic_samples(
    win_size: int = THUMBNAIL_SIZE,
    pt_sizes: tuple[int, ...] = (32, 48, 64),
) -> list[tuple[int, NDArray[np.uint8]]]:
    """Render digits 1–9 in all discoverable system TTF fonts via Pillow.

    Returns (label, win_size×win_size uint8) pairs in the same format as
    load_training_file, supplementing browser-exported samples with coverage
    across common newspaper and system typefaces.
    """
    import time as _time
    t0 = _time.time()
    print(f"  [+{_time.time() - t0:.0f}s] Scanning system fonts (matplotlib font cache "
          f"may take a while on first run)…", flush=True)
    import matplotlib.font_manager as fm  # type: ignore[import-untyped]
    from PIL import Image, ImageDraw, ImageFont  # type: ignore[import-untyped]

    font_paths = fm.findSystemFonts(fontext="ttf")
    print(f"  [+{_time.time() - t0:.0f}s] Found {len(font_paths)} fonts", flush=True)
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
                h_c, w_c = crop.shape
                side = max(h_c, w_c)
                square = np.zeros((side, side), dtype=np.uint8)
                square[(side - h_c) // 2:(side - h_c) // 2 + h_c,
                       (side - w_c) // 2:(side - w_c) // 2 + w_c] = crop
                out = np.array(
                    Image.fromarray(square).resize((win_size, win_size), Image.LANCZOS),
                    dtype=np.uint8,
                )
                if out.max() > 0:
                    samples.append((digit, out))

        if (fi + 1) % report_every == 0 or fi + 1 == len(font_paths):
            print(f"  [+{_time.time() - t0:.0f}s] Rendered fonts {fi + 1}/{len(font_paths)} "
                  f"({len(samples)} samples so far)", flush=True)

    return samples


# ---------------------------------------------------------------------------
# HOG feature extraction
# ---------------------------------------------------------------------------

def _extract_hog_chunk(imgs: list[NDArray[np.uint8]]) -> NDArray[np.float64]:
    """Per-image HOG extraction core, run on one chunk of images.

    Module-level (not a closure) so joblib's loky backend can pickle and
    dispatch it to worker processes. extract_hog splits the full image list
    into chunks and calls this once per chunk in parallel — each image's HOG
    is independent, so this is embarrassingly parallel.
    """
    n = len(imgs)
    n_cells = HOG_WIN_SIZE // HOG_CELL_SIZE                             # 8
    cpb = HOG_BLOCK_SIZE // HOG_CELL_SIZE                               # cells per block side = 2
    n_blocks = (HOG_WIN_SIZE - HOG_BLOCK_SIZE) // HOG_BLOCK_STRIDE + 1 # 7
    bin_width = 180.0 / HOG_NBINS                                       # 20.0°
    eps = 1e-6
    result = np.zeros((n, HOG_FEAT), dtype=np.float64)

    for idx, img in enumerate(imgs):
        f = img.astype(np.float32)

        # Centered differences with clamped borders.
        Gx = np.empty_like(f)
        Gy = np.empty_like(f)
        Gx[:, 1:-1] = f[:, 2:] - f[:, :-2]
        Gx[:, 0]    = f[:, 1]  - f[:, 0]
        Gx[:, -1]   = f[:, -1] - f[:, -2]
        Gy[1:-1, :] = f[2:, :] - f[:-2, :]
        Gy[0, :]    = f[1, :]  - f[0, :]
        Gy[-1, :]   = f[-1, :] - f[-2, :]

        mag = np.sqrt(Gx ** 2 + Gy ** 2)
        # Unsigned angle in [0, 180): atan2(|Gy|, Gx) → degrees → mod 180.
        ang = np.degrees(np.arctan2(np.abs(Gy), Gx)) % 180.0
        bins = (ang / bin_width).astype(np.int32) % HOG_NBINS

        # Cell histograms — vectorised over cells.
        cell_hists = np.zeros((n_cells, n_cells, HOG_NBINS), dtype=np.float32)
        for cy in range(n_cells):
            for cx in range(n_cells):
                y0, x0 = cy * HOG_CELL_SIZE, cx * HOG_CELL_SIZE
                np.add.at(
                    cell_hists[cy, cx],
                    bins[y0:y0 + HOG_CELL_SIZE, x0:x0 + HOG_CELL_SIZE].ravel(),
                    mag [y0:y0 + HOG_CELL_SIZE, x0:x0 + HOG_CELL_SIZE].ravel(),
                )

        # Block descriptors with L2 normalisation.
        feat_idx = 0
        for by in range(n_blocks):
            for bx in range(n_blocks):
                block = cell_hists[by:by + cpb, bx:bx + cpb].ravel().astype(np.float64)
                norm = np.sqrt(np.dot(block, block) + eps * eps)
                result[idx, feat_idx:feat_idx + len(block)] = block / norm
                feat_idx += len(block)

    return result


def extract_hog(imgs: list[NDArray[np.uint8]], n_jobs: int = -1) -> NDArray[np.float64]:
    """Extract HOG feature vectors matching the TypeScript hogExtract implementation.

    Uses: centered differences (clamped at borders), unsigned gradients via
    atan2(|Gy|, Gx) mod 180, nearest-bin voting, L2 block normalisation.
    Both this function and hogExtract in numberRecognition.ts perform identical
    floating-point operations, guaranteeing training/inference feature parity.

    Splits imgs into n_jobs chunks and extracts each chunk in parallel via
    joblib — each image's HOG is independent (embarrassingly parallel), and
    unlike the OVO SVM fit, per-chunk memory is tiny so no dynamic capping is
    needed; n_jobs=-1 (default) uses all CPU cores. joblib's default Parallel
    call (no return_as=) preserves input order in its results, so chunks
    concatenate back into the same row order as the input image list.
    """
    import time as _time
    import os as _os

    from joblib import Parallel, delayed  # type: ignore[import-untyped]

    t0 = _time.time()
    n = len(imgs)
    if n == 0:
        return np.zeros((0, HOG_FEAT), dtype=np.float64)

    workers = (_os.cpu_count() or 1) if n_jobs == -1 else n_jobs
    workers = max(1, min(workers, n))
    chunk_size = -(-n // workers)  # ceil division
    chunks = [imgs[i:i + chunk_size] for i in range(0, n, chunk_size)]

    print(f"  Extracting HOG for {n} images across {len(chunks)} chunks (n_jobs={workers})…", flush=True)
    chunk_results = Parallel(n_jobs=workers)(delayed(_extract_hog_chunk)(chunk) for chunk in chunks)
    print(f"  [+{_time.time() - t0:.0f}s] HOG extraction done", flush=True)
    return np.vstack(chunk_results)


def _extract_hole_chunk(imgs: list[NDArray[np.uint8]]) -> NDArray[np.float64]:
    """Per-image hole-count feature extraction core, run on one chunk of images.

    Module-level (not a closure) so joblib's loky backend can pickle and
    dispatch it to worker processes, mirroring _extract_hog_chunk. Each
    image's hole-count is independent, so this is embarrassingly parallel.
    Mirrors extractHoleFeatures in web/src/image/holeFeatures.ts exactly:
    BFS outside flood-fill, then connected-component hole labelling, 4-
    connectivity throughout.
    """
    from collections import deque

    n = len(imgs)
    result = np.zeros((n, N_HOLE_FEATURES), dtype=np.float64)

    for idx, img in enumerate(imgs):
        h, w = img.shape
        visited = np.zeros((h, w), dtype=bool)
        ink_count = int(np.count_nonzero(img))
        queue: deque[tuple[int, int]] = deque()

        # Step 1: flood-fill "outside" from every border background pixel.
        for x in range(w):
            for y in (0, h - 1):
                if img[y, x] == 0 and not visited[y, x]:
                    visited[y, x] = True
                    queue.append((y, x))
        for y in range(h):
            for x in (0, w - 1):
                if img[y, x] == 0 and not visited[y, x]:
                    visited[y, x] = True
                    queue.append((y, x))
        while queue:
            y, x = queue.popleft()
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < h and 0 <= nx < w and img[ny, nx] == 0 and not visited[ny, nx]:
                    visited[ny, nx] = True
                    queue.append((ny, nx))

        # Step 2: label remaining unvisited background pixels as hole regions.
        hole_areas: list[int] = []
        for sy in range(h):
            for sx in range(w):
                if visited[sy, sx] or img[sy, sx] != 0:
                    continue
                area = 0
                visited[sy, sx] = True
                queue.append((sy, sx))
                while queue:
                    y, x = queue.popleft()
                    area += 1
                    for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                        if 0 <= ny < h and 0 <= nx < w and img[ny, nx] == 0 and not visited[ny, nx]:
                            visited[ny, nx] = True
                            queue.append((ny, nx))
                if area >= MIN_HOLE_AREA:
                    hole_areas.append(area)

        hole_areas.sort(reverse=True)
        bucket = min(len(hole_areas), 2)
        result[idx, bucket] = 1.0
        denom = max(ink_count, 1)
        result[idx, 3] = (hole_areas[0] if len(hole_areas) > 0 else 0) / denom
        result[idx, 4] = (hole_areas[1] if len(hole_areas) > 1 else 0) / denom

    return result


def extract_hole_features(imgs: list[NDArray[np.uint8]], n_jobs: int = -1) -> NDArray[np.float64]:
    """Extract hole-count topology features matching the TypeScript
    extractHoleFeatures implementation (web/src/image/holeFeatures.ts).

    Fully separate joblib dispatch from extract_hog — same chunking pattern
    (_extract_hole_chunk mirrors _extract_hog_chunk) but its own worker pool,
    so the existing, working HOG path is not touched.
    """
    import time as _time
    import os as _os

    from joblib import Parallel, delayed  # type: ignore[import-untyped]

    t0 = _time.time()
    n = len(imgs)
    if n == 0:
        return np.zeros((0, N_HOLE_FEATURES), dtype=np.float64)

    workers = (_os.cpu_count() or 1) if n_jobs == -1 else n_jobs
    workers = max(1, min(workers, n))
    chunk_size = -(-n // workers)  # ceil division
    chunks = [imgs[i:i + chunk_size] for i in range(0, n, chunk_size)]

    print(f"  Extracting hole features for {n} images across {len(chunks)} chunks (n_jobs={workers})…", flush=True)
    chunk_results = Parallel(n_jobs=workers)(delayed(_extract_hole_chunk)(chunk) for chunk in chunks)
    print(f"  [+{_time.time() - t0:.0f}s] Hole feature extraction done", flush=True)
    return np.vstack(chunk_results)


# ---------------------------------------------------------------------------
# Augmentation
# ---------------------------------------------------------------------------

def dither(
    img: NDArray[np.uint8],
    n_variants: int,
    rng: np.random.Generator,
) -> list[NDArray[np.float64]]:
    """Return n_variants augmented copies of a binary 64×64 digit image.

    Each variant applies a random combination of:
    - Translation: ±2 px in x and y
    - Morphological step: erosion, dilation, or none (thin / thicken stroke)
    - Pixel noise: ~1% random flips

    The original image is included as variant 0.
    """
    base = (img > 0).astype(float)
    variants: list[NDArray[np.float64]] = [base]

    for _ in range(n_variants):
        dx = int(rng.integers(-2, 3))
        dy = int(rng.integers(-2, 3))
        v = shift(base, (dy, dx), mode="constant", cval=0.0)

        op = int(rng.integers(3))  # 0=none 1=erode 2=dilate
        if op == 1:
            v = binary_erosion(v > 0.5).astype(float)
        elif op == 2:
            v = binary_dilation(v > 0.5).astype(float)

        noise_mask = rng.random(v.shape) < 0.01
        v = np.where(noise_mask, 1.0 - v, v)
        variants.append(v)

    return variants


# ---------------------------------------------------------------------------
# Dataset construction
# ---------------------------------------------------------------------------

def build_dataset(
    samples: list[tuple[int, NDArray[np.uint8]]],
    n_dither: int,
    sample_weights: list[float] | None = None,
) -> tuple[NDArray[np.float64], NDArray[np.int64], NDArray[np.float64]]:
    """Augment samples with dithering and extract HOG features.

    Each (digit, img) pair produces n_dither+1 variants (original + n_dither
    augmented copies).  All variants are fed through extract_hog.

    sample_weights assigns a per-source weight (before augmentation); all
    augmented variants from a source share the same weight.  None means 1.0
    for all samples.  Returns (X, y, weights).
    """
    import time as _time
    t0 = _time.time()
    rng = np.random.default_rng(0)
    aug_imgs: list[NDArray[np.uint8]] = []
    aug_labels: list[int] = []
    aug_weights: list[float] = []

    n_samples = len(samples)
    report_every = max(1, n_samples // 20)
    for i, (digit, img) in enumerate(samples):
        w = sample_weights[i] if sample_weights is not None else 1.0
        for v in dither(img, n_dither, rng):
            aug_imgs.append((v * 255).clip(0, 255).astype(np.uint8))
            aug_labels.append(digit)
            aug_weights.append(w)
        if (i + 1) % report_every == 0 or i + 1 == n_samples:
            print(f"  [+{_time.time() - t0:.0f}s] Dithered {i + 1}/{n_samples} samples "
                  f"({len(aug_imgs)} augmented images)", flush=True)

    X_hog = extract_hog(aug_imgs)
    X_hole = extract_hole_features(aug_imgs)
    X = np.hstack([X_hog, X_hole])
    return X, np.array(aug_labels, dtype=np.int64), np.array(aug_weights, dtype=np.float64)


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def _fit_ovo_pair(
    idx: int,
    i: int,
    j: int,
    Xp: NDArray[np.float64],
    yp: NDArray[np.int64],
    wp: NDArray[np.float64] | None,
    svm_c: float,
) -> tuple[int, int, int, NDArray[np.float64], float]:
    """Fit one binary LinearSVC for a single OneVsOne class pair.

    Module-level (not a closure) so joblib's loky backend can pickle and send
    it to worker processes. idx/i/j are threaded through and returned
    alongside the result because joblib's "generator_unordered" mode yields
    completed tasks in arbitrary order — the caller needs them to know which
    pair (and checkpoint file) each result belongs to.

    Negates the fitted coef/intercept: LinearSVC's score>0 predicts
    classes_[1] (the higher-valued class, since classes_ is sorted), but the
    TypeScript ovoVote loop expects score>0 -> the lower-indexed class.
    Negating here keeps both conventions consistent without touching ovoVote.
    """
    from sklearn.svm import LinearSVC  # type: ignore[import-untyped]
    clf = LinearSVC(C=svm_c, max_iter=10000)
    clf.fit(Xp, yp, sample_weight=wp)
    return idx, i, j, -clf.coef_[0], float(-clf.intercept_[0])


def _dynamic_n_jobs(y: NDArray[np.int64], n_features: int, requested: int) -> int:
    """Compute a safe OVO parallelism from available system memory.

    Each parallel OneVsOneClassifier worker holds its own float64 row-slice of
    X for the two largest classes in its pair (plus liblinear's internal
    working copies) — running too many workers concurrently can exceed
    available RAM (this is what caused an OOM on the full guardian/observer
    dataset with n_jobs=-1, sklearn's "all cores" default). requested=-1
    triggers this calculation; any other value is used as-is (explicit
    caller override, e.g. for reproducible single-job debugging).

    The x2.5 multiplier and 80% memory headroom are calibrated against
    observed worker RSS (~1.2-1.3 GB) for a ~0.57 GB base row-slice estimate.
    """
    if requested != -1:
        return requested

    import os as _os
    import psutil  # type: ignore[import-untyped]

    counts = np.sort(np.bincount(y))
    worst_pair_rows = int(counts[-1]) + int(counts[-2]) if len(counts) > 1 else int(counts[-1])
    bytes_per_job = worst_pair_rows * n_features * 8 * 2.5  # margin for solver-internal copies
    available = psutil.virtual_memory().available * 0.8     # leave 20% headroom
    mem_limited = max(1, int(available // bytes_per_job))
    cpu_limited = _os.cpu_count() or 1
    n_jobs = int(min(mem_limited, cpu_limited))
    print(f"  Dynamic n_jobs: {n_jobs} (mem-limited={mem_limited}, cpu-limited={cpu_limited}, "
          f"worst pair={worst_pair_rows} rows -> ~{bytes_per_job / 1e9:.2f} GB/job, "
          f"{available / 1e9:.1f} GB available after headroom)", flush=True)
    return n_jobs


def fit_model(
    X: NDArray[np.float64],
    y: NDArray[np.int64],
    classifier: str = "linear",
    svm_c: float = SVM_C,
    svm_gamma: float | str = SVM_GAMMA,
    sample_weights: NDArray[np.float64] | None = None,
    n_jobs: int = -1,
    checkpoint_dir: Path | None = None,
) -> dict[str, Any]:
    """Train a digit classifier on HOG feature vectors.

    classifier='linear': manual OneVsOne LinearSVC — one binary fit per class
        pair, dispatched via joblib's Parallel (loky backend manages worker
        processes and large-array transfer). Each pair is checkpointed to
        checkpoint_dir as it completes, fingerprinted by dataset + svm_c, so
        an interrupted run only refits whatever pairs are missing rather than
        redoing all of them (this replaces sklearn's OneVsOneClassifier,
        whose single monolithic fit() call has no partial-result recovery).
    classifier='rbf': SVC(kernel='rbf') OVO — more expressive but large model.

    sample_weights, if provided, upweights specific samples (e.g.
    browser-exported samples vs synthetic font samples) during fitting.
    """
    if classifier == "linear":
        import hashlib
        import itertools
        import time as _time

        from joblib import Parallel, delayed  # type: ignore[import-untyped]

        classes = np.unique(y)
        pairs = list(itertools.combinations(range(len(classes)), 2))
        safe_n_jobs = _dynamic_n_jobs(y, X.shape[1], n_jobs)

        ckpt_dir = checkpoint_dir or Path(".svm_checkpoints")
        ckpt_dir.mkdir(parents=True, exist_ok=True)
        # Cheap fingerprint (strided sample, not the full ~GB array) so stale
        # checkpoints from a different dataset/svm_c are never silently reused.
        fp_src = (np.ascontiguousarray(X[::97]).tobytes() + y.tobytes()
                  + str(X.shape).encode() + str(svm_c).encode())
        fingerprint = hashlib.sha256(fp_src).hexdigest()[:16]
        print(f"  Dataset fingerprint {fingerprint}; checkpoints in {ckpt_dir}/", flush=True)

        coefs: list[NDArray[np.float64] | None] = [None] * len(pairs)
        intercepts: list[float | None] = [None] * len(pairs)
        ckpts: list[Path | None] = [None] * len(pairs)
        pending: list[tuple[int, int, int]] = []

        for idx, (i, j) in enumerate(pairs):
            ckpt = ckpt_dir / f"pair_{classes[i]}-{classes[j]}_c{svm_c}_{fingerprint}.npz"
            ckpts[idx] = ckpt
            if ckpt.exists():
                data = np.load(ckpt)
                coefs[idx], intercepts[idx] = data["coef"], float(data["intercept"])
            else:
                pending.append((idx, i, j))

        print(f"  {len(pairs) - len(pending)}/{len(pairs)} pairs already checkpointed; "
              f"fitting {len(pending)} remaining (n_jobs={safe_n_jobs})", flush=True)

        if pending:
            t0 = _time.time()
            tasks = []
            for idx, i, j in pending:
                mask = (y == classes[i]) | (y == classes[j])
                wp = sample_weights[mask] if sample_weights is not None else None
                tasks.append(delayed(_fit_ovo_pair)(idx, i, j, X[mask], y[mask], wp, svm_c))

            results = Parallel(n_jobs=safe_n_jobs, return_as="generator_unordered")(tasks)
            for n_done, (idx, i, j, coef, intercept) in enumerate(results, start=1):
                coefs[idx], intercepts[idx] = coef, intercept
                np.savez(ckpts[idx], coef=coef, intercept=intercept)
                print(f"  [+{_time.time() - t0:.0f}s] [{n_done}/{len(pending)}] "
                      f"pair ({classes[i]},{classes[j]}) done -> {ckpts[idx].name}", flush=True)

        coefs_arr = np.vstack(coefs)
        intercepts_arr = np.array(intercepts, dtype=np.float64)
        return {"kind": "linear", "classes": classes, "coefs": coefs_arr, "intercepts": intercepts_arr}
    else:
        svc = SVC(kernel="rbf", C=svm_c, gamma=svm_gamma, decision_function_shape="ovo")
        svc.fit(X, y, sample_weight=sample_weights)
        return {"kind": "rbf", "clf": svc, "classes": svc.classes_}


# ---------------------------------------------------------------------------
# I/O — saving
# ---------------------------------------------------------------------------

def save_model(
    model: dict[str, Any],
    out_dir: Path,
    confidence_threshold: float = CONFIDENCE_THRESHOLD,
) -> None:
    """Write num_recogniser.{json,bin} with HOG params + classifier weights.

    The manifest top-level includes 'classifier_type' so loadNumRecogniser in
    web/src/image/numberRecognition.ts can select the right inference path.
    Common arrays (hog_*, confidence_threshold, classes) are always present.
    Classifier-specific arrays (linear_coef/intercept or rbf_*) follow.
    """
    kind: str = model["kind"]
    classes: NDArray[np.int_] = model["classes"]

    common: list[tuple[str, np.ndarray, str]] = [
        ("hog_win_size",         np.array(HOG_WIN_SIZE,         dtype=np.int32),   "int32"),
        ("hog_cell_size",        np.array(HOG_CELL_SIZE,        dtype=np.int32),   "int32"),
        ("hog_block_size",       np.array(HOG_BLOCK_SIZE,       dtype=np.int32),   "int32"),
        ("hog_block_stride",     np.array(HOG_BLOCK_STRIDE,     dtype=np.int32),   "int32"),
        ("hog_nbins",            np.array(HOG_NBINS,            dtype=np.int32),   "int32"),
        ("confidence_threshold", np.array(confidence_threshold, dtype=np.float64), "float64"),
        ("classes",              classes.astype(np.int32),                        "int32"),
    ]

    if kind == "linear":
        coefs: NDArray[np.float64] = model["coefs"]
        intercepts: NDArray[np.float64] = model["intercepts"]
        classifier_arrays: list[tuple[str, np.ndarray, str]] = [
            ("linear_coef",      coefs.astype(np.float64),       "float64"),
            ("linear_intercept", intercepts.astype(np.float64),   "float64"),
        ]
        size_info = f"  Linear OVO: {coefs.shape[0]} classifiers x {coefs.shape[1]} features"
    else:
        svc: SVC = model["clf"]
        try:
            gamma = float(svc._gamma)
        except AttributeError:
            gamma = 1.0 / (float(svc.support_vectors_.shape[1]) * float(svc.support_vectors_.var()))
        classifier_arrays = [
            ("rbf_support_vectors", svc.support_vectors_.astype(np.float64), "float64"),
            ("rbf_dual_coef",       svc.dual_coef_.astype(np.float64),       "float64"),
            ("rbf_intercept",       svc.intercept_.astype(np.float64),       "float64"),
            ("rbf_n_support",       svc.n_support_.astype(np.int32),         "int32"),
            ("rbf_gamma",           np.array([gamma], dtype=np.float64),     "float64"),
        ]
        size_info = f"  RBF OVO: {svc.support_vectors_.shape[0]} support vectors"

    named = common + classifier_arrays
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
        json.dumps({"classifier_type": kind, "arrays": manifest_arrays}, indent=2),
        encoding="utf-8",
    )

    print(f"\nSaved to {out_dir}/ [{kind}]", flush=True)
    print(f"  HOG: {HOG_WIN_SIZE}px win / {HOG_CELL_SIZE}px cells / {HOG_BLOCK_SIZE}px block / {HOG_NBINS} bins = {HOG_FEAT} features", flush=True)
    print(size_info, flush=True)
    print(f"  Bin size: {len(blob):,} bytes", flush=True)


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
             "Always loaded in full and NEVER subject to --max-per-class capping — these are the "
             "precious ground-truth samples the accuracy test requires 100%% correctness on. "
             "Pass a nonexistent path or --no-browser-file to skip.",
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
        "--classifier", choices=["linear", "rbf"], default="linear",
        help="Classifier type: 'linear' (OVO LinearSVC, default) or 'rbf' (OVO SVC)",
    )
    parser.add_argument("--svm-c",     type=float, default=SVM_C,
                        help=f"SVM regularisation C (default: {SVM_C})")
    parser.add_argument("--n-jobs",    type=int,   default=-1, metavar="N",
                        help="Parallel jobs for OVO LinearSVC (default: -1 = dynamically computed "
                             "from available RAM and CPU count; pass a positive integer to force a "
                             "specific value, e.g. 1 for reproducible single-job debugging)")
    parser.add_argument("--svm-gamma", type=str,   default=str(SVM_GAMMA),
                        help=f"SVM gamma — float or 'scale'/'auto'; rbf only (default: {SVM_GAMMA})")
    parser.add_argument(
        "--synth-dither", type=int, default=-1, metavar="N",
        help="Dither variants for synthetic samples; -1 = same as --dither (default: -1). "
             "Not compatible with non-empty bulk training_json (asymmetric-dither path predates "
             "the bulk/browser split and only knows about two groups).",
    )
    parser.add_argument(
        "--browser-weight", type=float, default=0.0, metavar="W",
        help="Per-sample weight for --browser-file samples relative to bulk/synthetic "
             "(uniform dither path only; 0 = auto-balance)",
    )
    parser.add_argument(
        "--max-per-class", type=int, default=0, metavar="N",
        help="Randomly subsample each digit class of the bulk training_json sources to at most "
             "N samples before dithering (0 = no cap; never applied to --browser-file). Bounds the "
             "worst-case OVO pair size/fit time regardless of how skewed the input distribution is "
             "(e.g. digit '1' vs digit '5').",
    )
    args = parser.parse_args()

    import time as _time
    t_start = _time.time()

    def _elapsed() -> str:
        return f"[+{_time.time() - t_start:.0f}s]"

    rng_cap = np.random.default_rng(0)

    bulk_samples: list[tuple[int, NDArray[np.uint8]]] = []
    for path in args.training_json:
        samples = load_training_file(path)
        print(f"{_elapsed()} Loaded {len(samples)} bulk samples from {path.name}", flush=True)
        bulk_samples.extend(samples)

    if args.max_per_class > 0 and bulk_samples:
        before = len(bulk_samples)
        bulk_samples = cap_per_class(bulk_samples, args.max_per_class, rng_cap)
        print(f"{_elapsed()} Capped bulk samples to {args.max_per_class}/class: "
              f"{before} -> {len(bulk_samples)}", flush=True)

    browser_samples: list[tuple[int, NDArray[np.uint8]]] = []
    if not args.no_browser_file and args.browser_file.exists():
        browser_samples = load_training_file(args.browser_file)
        print(f"{_elapsed()} Loaded {len(browser_samples)} samples from {args.browser_file.name} "
              f"(ground truth, never capped)", flush=True)

    # browser_samples always first so the asymmetric synth-dither branch below
    # (which slices on n_browser) still treats them as "the browser group".
    all_samples: list[tuple[int, NDArray[np.uint8]]] = browser_samples + bulk_samples
    n_browser = len(browser_samples)
    n_bulk = len(bulk_samples)

    if not args.no_synthetic:
        print(f"{_elapsed()} Generating synthetic font samples…", flush=True)
        synth = generate_synthetic_samples()
        print(f"{_elapsed()} Generated {len(synth)} synthetic samples", flush=True)
        all_samples.extend(synth)

    if not all_samples:
        import sys as _sys
        print("No samples — pass JSON files or omit --no-synthetic.", file=_sys.stderr)
        raise SystemExit(1)

    n_synth = len(all_samples) - n_browser - n_bulk
    dist = dict(sorted(Counter(d for d, _ in all_samples).items()))
    print(f"{_elapsed()} Digit distribution: {dist}", flush=True)

    # When --synth-dither is set, use different dither counts for browser vs
    # synthetic samples so browser samples dominate by count (not by extreme
    # weights that cause SVM convergence problems). Predates the bulk/browser
    # split: bulk samples get folded into the "browser" half here, which is
    # only correct when there are no bulk samples (n_bulk == 0).
    synth_dither = args.synth_dither if args.synth_dither >= 0 else args.dither
    if n_browser + n_bulk > 0 and n_synth > 0 and synth_dither != args.dither:
        if n_bulk > 0:
            raise SystemExit("--synth-dither with non-empty bulk training_json is not supported "
                              "(asymmetric-dither path predates the bulk/browser split)")
        rng = np.random.default_rng(0)
        aug_imgs: list[NDArray[np.uint8]] = []
        aug_labels: list[int] = []
        for digit, img in all_samples[:n_browser]:
            for v in dither(img, args.dither, rng):
                aug_imgs.append((v * 255).clip(0, 255).astype(np.uint8))
                aug_labels.append(digit)
        for digit, img in all_samples[n_browser:]:
            for v in dither(img, synth_dither, rng):
                aug_imgs.append((v * 255).clip(0, 255).astype(np.uint8))
                aug_labels.append(digit)
        n_browser_aug = n_browser * (args.dither + 1)
        n_synth_aug   = n_synth   * (synth_dither + 1)
        print(f"{_elapsed()} Dither: browser {args.dither} variants ({n_browser_aug} aug), synth {synth_dither} variants ({n_synth_aug} aug)", flush=True)
        print(f"{_elapsed()} Extracting HOG features for {len(aug_imgs)} images…", flush=True)
        X_hog = extract_hog(aug_imgs)
        X_hole = extract_hole_features(aug_imgs)
        X = np.hstack([X_hog, X_hole])
        y = np.array(aug_labels, dtype=np.int64)
        weights: NDArray[np.float64] | None = None
    else:
        # Uniform dither; use sample_weight to balance the three groups.
        # browser_file samples are the precious ground truth the accuracy test
        # requires 100% on, so they get the full --browser-weight; bulk and
        # synthetic both get baseline weight 1.0 (bulk is already plentiful
        # real data — it doesn't need upweighting the way browser samples do).
        sample_weights: list[float] | None = None
        if n_browser > 0 and (n_bulk + n_synth) > 0:
            bw = args.browser_weight if args.browser_weight > 0 else float(n_bulk + n_synth) / n_browser
            sample_weights = [bw] * n_browser + [1.0] * (n_bulk + n_synth)
            print(f"{_elapsed()} Browser sample weight: {bw:.1f}× ({n_browser} browser, "
                  f"{n_bulk} bulk, {n_synth} synthetic)", flush=True)
        print(f"{_elapsed()} Augmenting and extracting HOG features…", flush=True)
        X, y, weights = build_dataset(all_samples, args.dither, sample_weights)

    print(f"{_elapsed()} Dataset: {X.shape[0]} samples × {X.shape[1]} HOG features", flush=True)

    svm_gamma: float | str = args.svm_gamma
    try:
        svm_gamma = float(args.svm_gamma)
    except ValueError:
        pass  # keep as 'scale' or 'auto'

    print(f"{_elapsed()} Training {args.classifier} classifier (n_jobs={args.n_jobs})…", flush=True)
    model = fit_model(
        X, y,
        classifier=args.classifier,
        svm_c=args.svm_c,
        svm_gamma=svm_gamma,
        sample_weights=weights,
        n_jobs=args.n_jobs,
    )

    print(f"{_elapsed()} Saving model…", flush=True)
    save_model(model, Path(args.out), confidence_threshold=args.confidence_threshold)
    print(f"{_elapsed()} Done.", flush=True)


if __name__ == "__main__":
    main()
