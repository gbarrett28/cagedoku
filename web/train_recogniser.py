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
import math
import time
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
from numba import get_num_threads, njit, prange, set_num_threads
from numpy.typing import NDArray
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

# Hole-count topology feature — see docs/image-pipeline.md, Stage 5
MIN_HOLE_AREA   = 6   # discard enclosed regions smaller than this (anti-aliasing/dither noise)
N_HOLE_FEATURES = 5

# Caps memory used by dither_batch's precomputed per-variant randomness arrays
# (the noise mask alone is n_variants*64*64 bytes per source image in this batch).
DITHER_BATCH_SIZE = 4096


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

@njit(parallel=True, fastmath=True, cache=True)
def _extract_hog_numba(stacked: NDArray[np.uint8], result: NDArray[np.float64]) -> None:
    """Fused per-pixel HOG kernel: gradients, bin assignment, cell histograms,
    and block normalisation in one compiled pass per image, with no large
    (n, 64, 64) intermediate arrays.

    Replaces an earlier pure-numpy vectorisation that computed Gx/Gy/mag/bins
    as full-size arrays — profiling showed that version was memory-bandwidth
    bound (threading vs. process-based parallelism gave near-identical
    throughput, ruling out the GIL as the bottleneck), so the fix is moving
    bytes, not Python call overhead. This kernel reads each image once and
    writes only the final (1764,) feature row, parallelised across images via
    prange using all CPU cores by default.
    """
    n = stacked.shape[0]
    n_cells = HOG_WIN_SIZE // HOG_CELL_SIZE
    cpb = HOG_BLOCK_SIZE // HOG_CELL_SIZE
    n_blocks = (HOG_WIN_SIZE - HOG_BLOCK_SIZE) // HOG_BLOCK_STRIDE + 1
    bin_width_rad = np.pi / HOG_NBINS
    block_feat = cpb * cpb * HOG_NBINS
    eps2 = 1e-12  # (1e-6)^2 — matches the original L2-normalisation epsilon

    for i in prange(n):
        cell_hist = np.zeros((n_cells, n_cells, HOG_NBINS))
        for y in range(HOG_WIN_SIZE):
            # Centered difference, clamped at the border — matches the
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
                # degrees-mod-180 bin assignment exactly (see extract_hog).
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

    Uses: centered differences (clamped at borders), unsigned gradients via
    atan2(|Gy|, Gx) mod 180, nearest-bin voting, L2 block normalisation. Both
    this function and hogExtract in numberRecognition.ts perform equivalent
    floating-point operations (within float tolerance), guaranteeing
    training/inference feature parity.

    imgs is a pre-stacked (n, 64, 64) uint8 array (dither_batch already
    produces one) and is dispatched directly to _extract_hog_numba, a
    JIT-compiled kernel parallelised across images via prange — replacing an
    earlier joblib/numpy-vectorised version that hit a memory-bandwidth
    ceiling at full dataset scale (see _extract_hog_numba's docstring).
    n_jobs=-1 (default) uses all CPU cores; otherwise caps the thread count
    for this call only, restored afterward.

    out, if given, must be a (n, HOG_FEAT) array (or column-slice view of a
    larger array) to write results into directly, instead of allocating a
    fresh array — lets callers fuse HOG and hole features into one
    preallocated buffer and avoid np.hstack's transient ~2x peak memory.
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
        print(f"  Extracting HOG for {n} images (numba, threads={get_num_threads()})…", flush=True)
        _extract_hog_numba(imgs, result)
    finally:
        if n_jobs != -1:
            set_num_threads(prior_threads)
    print(f"  [+{time.time() - t0:.0f}s] HOG extraction done", flush=True)
    return result


@njit(parallel=True, cache=True)
def _extract_hole_numba(stacked: NDArray[np.uint8], min_hole_area: int, result: NDArray[np.float64]) -> None:
    """Fused per-image hole-count kernel: outside flood-fill, hole labelling,
    and top-2 area tracking in one compiled pass per image.

    Mirrors extractHoleFeatures in web/src/image/holeFeatures.ts (BFS outside
    flood-fill, then connected-component hole labelling, 4-connectivity
    throughout). The original pure-Python version used collections.deque,
    which numba cannot compile; here the BFS queue is an explicit
    preallocated (h*w,) int32 array with head/tail indices instead. Holes are
    embarrassingly parallel across images (each image's flood-fill is
    sequential by nature and not worth parallelising further), so only the
    outer image loop is parallelised, via prange — this is what actually
    fixes the bottleneck: the original threading-backend dispatch already
    parallelised at the image level but the per-image BFS was pure Python
    and GIL-bound, so threads never ran concurrently. Compiling to native
    code removes the GIL constraint entirely.
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
        # tracking only the two largest surviving areas (no need to keep a
        # full sorted list, matching the TS/numpy version's final 2-area output).
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
    """Extract hole-count topology features matching the TypeScript
    extractHoleFeatures implementation (web/src/image/holeFeatures.ts).

    imgs is a pre-stacked (n, 64, 64) uint8 array (dither_batch already
    produces one) and is dispatched directly to _extract_hole_numba, a
    JIT-compiled kernel parallelised across images via prange — replacing an
    earlier threading-backend dispatch over a pure-Python BFS, which never
    achieved real parallelism because that BFS was GIL-bound (see
    _extract_hole_numba's docstring). n_jobs=-1 (default) uses all CPU cores;
    otherwise caps the thread count for this call only, restored afterward.

    out, if given, must be a (n, N_HOLE_FEATURES) array (or column-slice view
    of a larger array) to write results into directly. It must already be
    zero-filled: the kernel only sets the one-hot bucket column it selects
    (result[i, 0:3]) and leaves the other two as an implicit zero, plus
    columns 3/4 are left at zero when there are no holes at all.
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
        print(f"  Extracting hole features for {n} images (numba, threads={get_num_threads()})…", flush=True)
        _extract_hole_numba(imgs, MIN_HOLE_AREA, result)
    finally:
        if n_jobs != -1:
            set_num_threads(prior_threads)
    print(f"  [+{time.time() - t0:.0f}s] Hole feature extraction done", flush=True)
    return result


# ---------------------------------------------------------------------------
# Augmentation
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
    """Fused per-image dithering kernel: translate, erode/dilate/none, and
    pixel-noise in one compiled pass per image. out[:, 0] is the unmodified
    original; out[:, 1:] are the n_variants augmented copies.

    Replaces an earlier scipy.ndimage-based dither(), which was confirmed by
    direct benchmark to be GIL-bound (threading backend gave ~0.93x
    "speedup" over sequential — no real parallelism at all). This kernel is
    parallelised across images via prange instead (per-image work is
    embarrassingly parallel; the transform within one image is small and
    inherently sequential).

    Translation is done via exact integer array indexing rather than
    scipy.ndimage.shift's default cubic-spline interpolation. The old
    shift()-based code introduced machine-epsilon floating-point noise even
    at an exact-integer shift, which crossed pixel-rounding boundaries after
    the *255+astype(uint8) step and silently flipped ~5% of pixels by 1 on
    every dithered variant — never part of the function's documented intent
    ("Translation: ±2 px" implies exact pixel shift, not sub-pixel
    reconstruction). Confirmed by direct measurement (shift(img, (0,0)) is
    not bit-identical to img) before writing this kernel.

    Erosion/dilation reproduce scipy.ndimage's default 4-connected,
    border_value=0 semantics (verified empirically): erosion ANDs a pixel
    with all 4 neighbours, treating out-of-bounds as background; dilation
    ORs them, with out-of-bounds contributing nothing.

    All randomness (dx, dy, op selection, per-pixel noise mask) is drawn with
    ordinary numpy Generator calls OUTSIDE this kernel and passed in as plain
    arrays — numba's parallel=True/prange does not guarantee reproducible RNG
    state across threads, so drawing randomness inside the kernel would break
    determinism. This kernel performs zero RNG, only deterministic transforms.
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
                        if val:
                            if y == 0 or shifted[y - 1, x] == 0:
                                val = 0
                            elif y == h - 1 or shifted[y + 1, x] == 0:
                                val = 0
                            elif x == 0 or shifted[y, x - 1] == 0:
                                val = 0
                            elif x == w - 1 or shifted[y, x + 1] == 0:
                                val = 0
                    else:  # dilate: OR with all 4 neighbours, OOB contributes nothing
                        val = shifted[y, x]
                        if not val:
                            if y > 0 and shifted[y - 1, x]:
                                val = 1
                            elif y < h - 1 and shifted[y + 1, x]:
                                val = 1
                            elif x > 0 and shifted[y, x - 1]:
                                val = 1
                            elif x < w - 1 and shifted[y, x + 1]:
                                val = 1
                    if noise[i, v, y, x]:
                        val = 1 - val
                    out[i, v + 1, y, x] = val * 255


def dither_batch(
    samples: list[tuple[int, NDArray[np.uint8], float]],
    n_variants: int,
    rng: np.random.Generator,
) -> tuple[NDArray[np.uint8], list[int], list[float]]:
    """Dither (digit, img, weight) samples into a stacked
    (n*(n_variants+1), 64, 64) uint8 array via _dither_numba.

    Processes DITHER_BATCH_SIZE images at a time to bound the memory used by
    the precomputed per-variant randomness arrays (the noise mask alone is
    n_variants*64*64 bytes per source image). All randomness is drawn
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





# ---------------------------------------------------------------------------
# Dataset construction
# ---------------------------------------------------------------------------




def build_dataset(
    samples: list[tuple[int, NDArray[np.uint8]]],
    n_dither: int,
    sample_weights: list[float] | None = None,
) -> tuple[NDArray[np.float64], NDArray[np.int64], NDArray[np.float64]]:
    """Augment samples with dithering and extract HOG + hole features.

    Each (digit, img) pair produces n_dither+1 variants (original + n_dither
    augmented copies), generated by dither_batch's numba-JIT kernel — see its
    docstring for why this replaced an earlier joblib-threading dispatch
    (confirmed GIL-bound, no real parallelism).

    X is one preallocated (n_aug, HOG_FEAT + N_HOLE_FEATURES) buffer that
    extract_hog/extract_hole_features write into directly via column-slice
    views, rather than concatenating two freshly-allocated arrays with
    np.hstack — at full dataset scale the transient second copy hstack needs
    while both source arrays are still alive roughly doubles peak memory,
    which is what actually OOM'd on the full guardian/observer bulk dataset.

    sample_weights assigns a per-source weight (before augmentation); all
    augmented variants from a source share the same weight.  None means 1.0
    for all samples.  Returns (X, y, weights).
    """
    t0 = time.time()
    n_samples = len(samples)
    weights_in = sample_weights if sample_weights is not None else [1.0] * n_samples
    triples = [(digit, img, w) for (digit, img), w in zip(samples, weights_in)]

    print(f"  Dithering {n_samples} samples ({n_dither} variants each, numba)…", flush=True)
    rng = np.random.default_rng(0)
    aug_imgs, aug_labels, aug_weights = dither_batch(triples, n_dither, rng)
    print(f"  [+{time.time() - t0:.0f}s] Dithering done", flush=True)

    n_aug = len(aug_labels)
    X = np.zeros((n_aug, HOG_FEAT + N_HOLE_FEATURES), dtype=np.float64)
    extract_hog(aug_imgs, out=X[:, :HOG_FEAT])
    extract_hole_features(aug_imgs, out=X[:, HOG_FEAT:])
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

            def _make_task(idx: int, i: int, j: int) -> Any:
                mask = (y == classes[i]) | (y == classes[j])
                wp = sample_weights[mask] if sample_weights is not None else None
                return delayed(_fit_ovo_pair)(idx, i, j, X[mask], y[mask], wp, svm_c)

            # A generator, not a list: each pair's X[mask]/y[mask] slice is
            # materialised lazily as joblib's pre_dispatch pulls it, so at
            # most safe_n_jobs slices exist at once. The previous eager
            # `tasks = []; tasks.append(...)` built every pending pair's
            # slice up front regardless of n_jobs — fine for small worst-pair
            # sizes, but at full dataset scale this held all ~45 pairs' worth
            # of slices simultaneously and OOM'd even with n_jobs=1, the
            # exact failure _dynamic_n_jobs's per-job budget was meant to
            # prevent (it only bounds concurrent *workers*, not how many
            # slices the parent process builds ahead of dispatch).
            tasks = (_make_task(idx, i, j) for idx, i, j in pending)

            results = Parallel(
                n_jobs=safe_n_jobs, pre_dispatch="n_jobs", return_as="generator_unordered"
            )(tasks)
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
        browser_triples = [(digit, img, 1.0) for digit, img in all_samples[:n_browser]]
        synth_triples = [(digit, img, 1.0) for digit, img in all_samples[n_browser:]]
        browser_imgs, browser_labels, _ = dither_batch(browser_triples, args.dither, rng)
        synth_imgs, synth_labels, _ = dither_batch(synth_triples, synth_dither, rng)
        aug_imgs = np.concatenate([browser_imgs, synth_imgs])
        aug_labels = browser_labels + synth_labels
        n_browser_aug = n_browser * (args.dither + 1)
        n_synth_aug   = n_synth   * (synth_dither + 1)
        print(f"{_elapsed()} Dither: browser {args.dither} variants ({n_browser_aug} aug), synth {synth_dither} variants ({n_synth_aug} aug)", flush=True)
        print(f"{_elapsed()} Extracting HOG features for {len(aug_labels)} images…", flush=True)
        X = np.zeros((len(aug_labels), HOG_FEAT + N_HOLE_FEATURES), dtype=np.float64)
        extract_hog(aug_imgs, out=X[:, :HOG_FEAT])
        extract_hole_features(aug_imgs, out=X[:, HOG_FEAT:])
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
