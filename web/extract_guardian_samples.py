#!/usr/bin/env python3
"""
Re-extract guardian/observer cage-total digits as square-padded 64x64 thumbnails.

Usage
-----
    python web/extract_guardian_samples.py
    python web/extract_guardian_samples.py --puzzle-dirs guardian observer
    python web/extract_guardian_samples.py --subres 128

Reads each puzzle's .json cache (written by migrate_pic_cache.py) alongside
the original .jpg, re-applies the perspective warp, extracts cage-total
contours, square-pads each digit to 64x64, and writes
<dir>/<dir>_train_sq.json compatible with train_recogniser.py.
"""

from __future__ import annotations
import argparse
import json
import logging
import sys
import types
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np
from numpy.typing import NDArray

_log = logging.getLogger(__name__)

SUBRES = 128
THUMB = 64
RESOLUTION = 9 * SUBRES  # 1152


# ---------------------------------------------------------------------------
# Puzzle cache loading -- prefers .json (from migrate_pic_cache.py), falls
# back to .jpk for puzzles not yet migrated.
# ---------------------------------------------------------------------------

class _PicData:
    """Minimal struct matching the PicInfo interface used by the extractor."""
    __slots__ = ('grid', 'cage_totals', 'border_x', 'border_y', 'brdrs')


def _register_stub() -> None:
    for mod in ('killer_sudoku.image', 'killer_sudoku.image.inp_image'):
        if mod not in sys.modules:
            sys.modules[mod] = types.ModuleType(mod)

    class PicInfo:
        pass

    sys.modules['killer_sudoku.image.inp_image'].PicInfo = PicInfo  # type: ignore[attr-defined]


def load_pic(jpg_path: Path) -> _PicData:
    """Load puzzle cache from .json (preferred) or .jpk fallback."""
    json_path = jpg_path.with_suffix('.json')
    if json_path.exists():
        raw = json.loads(json_path.read_text(encoding='utf-8'))
        p = _PicData()
        p.grid        = np.array(raw['grid'],        dtype=np.float32)
        p.cage_totals = np.array(raw['cage_totals'], dtype=np.int64)
        p.border_x    = np.array(raw['border_x'])
        p.border_y    = np.array(raw['border_y'])
        p.brdrs       = np.array(raw['brdrs'])
        return p

    jpk_path = jpg_path.with_suffix('.jpk')
    if jpk_path.exists():
        import pickle  # noqa: PLC0415
        _register_stub()
        with open(jpk_path, 'rb') as fh:
            return pickle.load(fh)  # trusted own-generated data

    raise FileNotFoundError(f"No .json or .jpk cache for {jpg_path}")


# ---------------------------------------------------------------------------
# Pure helpers -- testable without cv2 or real images
# ---------------------------------------------------------------------------

def square_pad_src(ax: float, ay: float, bw: float, bh: float) -> NDArray[np.float32]:
    """4-corner source region for a square-padded perspective warp.

    Centres the bounding rect in a square whose side = max(bw, bh).
    Returns [[TL],[TR],[BR],[BL]] in (x, y) image coordinates.
    Matches the TypeScript squarePadSrc helper exactly.
    """
    side = max(bw, bh)
    cx, cy = ax + bw / 2, ay + bh / 2
    return np.array([
        [cx - side / 2, cy - side / 2],
        [cx + side / 2, cy - side / 2],
        [cx + side / 2, cy + side / 2],
        [cx - side / 2, cy + side / 2],
    ], dtype=np.float32)


def is_num_contour(w: int, h: int, subres: int = SUBRES) -> bool:
    """True if bounding-rect dimensions match a cage-total digit glyph."""
    return (subres // 16 <= w <= subres // 2) and (subres // 8 <= h <= subres // 2)


# ---------------------------------------------------------------------------
# Thumbnail extraction
# ---------------------------------------------------------------------------

DST64 = np.float32([[0, 0], [THUMB - 1, 0], [THUMB - 1, THUMB - 1], [0, THUMB - 1]])


def warp_thumb(
    ax: float, ay: float, bw: float, bh: float, warped: NDArray[np.uint8],
) -> NDArray[np.uint8]:
    """Extract a square-padded 64x64 thumbnail from the warped binary image."""
    src = square_pad_src(ax, ay, bw, bh)
    M = cv2.getPerspectiveTransform(src, DST64)
    thumb = cv2.warpPerspective(warped, M, (THUMB, THUMB), flags=cv2.INTER_LINEAR)
    return ((thumb > 127).astype(np.uint8) * 255)


def digit_content_extent(col_ink: NDArray[np.floating], roi_w: int, margin: int) -> int:
    """Find where real digit ink ends and trailing decoration begins.

    Some newspapers print a cage-total "flag" -- a thin underline/pointer
    extending from the total to the cell's right edge -- which can touch the
    digit glyphs themselves. A plain ink-column minimum search (used to split
    2-digit totals, or bound a 1-digit total's crop) finds its minimum in the
    empty space *after* this trailing decoration rather than between/around
    the actual digits, since the decoration is themselves low-ink but long.
    Detects the first sustained low-ink run (>= 20% of roi_w, well past any
    brief dip between touching digits) scanning left-to-right, and returns
    where it begins -- callers should stop looking for digit content there.
    """
    if roi_w <= 2 * margin:
        return roi_w - margin
    background = float(np.percentile(col_ink, 20))
    peak = float(col_ink.max())
    threshold = background + 0.15 * (peak - background)
    min_run = max(8, int(roi_w * 0.2))
    run = 0
    for x in range(margin, roi_w - margin):
        if col_ink[x] <= threshold:
            run += 1
            if run >= min_run:
                return x - run + 1
        else:
            run = 0
    return roi_w - margin


def split_bounding_rect(
    ax: int, ay: int, bw: int, bh: int, warped: NDArray[np.uint8],
) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]] | None:
    """Split a bounding rect at the column ink-minimum for 2-digit totals."""
    margin = max(2, bw // 8)
    if bw - 2 * margin <= 0:
        return None
    strip = warped[ay: ay + bh, ax: ax + bw]
    ink = strip.sum(axis=0)
    split_x = margin + int(ink[margin: bw - margin].argmin())
    return (ax, ay, split_x, bh), (ax + split_x, ay, bw - split_x, bh)


def extract_puzzle_samples(
    jpg_path: Path,
    subres: int = SUBRES,
) -> list[tuple[int, NDArray[np.uint8]]]:
    """Extract (digit_label, 64x64_thumb) pairs from one puzzle image."""
    resolution = 9 * subres

    try:
        pic = load_pic(jpg_path)
    except Exception as exc:
        _log.warning("Cannot load cache for %s: %s -- skipping", jpg_path.name, exc)
        return []

    cage_totals: NDArray[np.int64] = np.array(pic.cage_totals, dtype=np.int64)

    img = cv2.imread(str(jpg_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        _log.warning("Cannot read %s -- skipping", jpg_path.name)
        return []

    # Upscale to the resolution grid corners were detected against. Mirrors
    # web/src/image/inpImage.ts's prepareGrayMat exactly: repeatedly pyrUp
    # (doubling, aspect-preserving) until both dimensions reach `resolution`.
    # A plain resize to a square canvas (the previous approach here) silently
    # assumed every source .jpg was a small square thumbnail needing a fixed
    # ~4x upscale -- true for most, but wrong for the minority stored at or
    # near full resolution already (non-square, little/no upscale needed),
    # which produced misaligned/blank-row warps for ~6% of observer/ puzzles.
    grid = np.array(pic.grid, dtype=np.float32)
    img_hr = img
    while img_hr.shape[0] < resolution or img_hr.shape[1] < resolution:
        img_hr = cv2.pyrUp(img_hr)
    blk_hr = cv2.adaptiveThreshold(
        img_hr, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 51, 7,
    )

    # Pipeline-resolution warp for cage-ROI extraction. The destination square
    # size only needs to comfortably contain the grid (grid.max() is the
    # grid's own extent in img_hr's coordinate space) -- it is independent of
    # img_hr's own resolution, since warpPerspective maps the `grid` quad to
    # whatever destination size is requested.
    pipe_res  = int(grid.max()) + 10
    pipe_cell = pipe_res // 9
    dst_hr = np.float32([
        [0, 0], [pipe_res - 1, 0],
        [pipe_res - 1, pipe_res - 1], [0, pipe_res - 1],
    ])
    M_hr = cv2.getPerspectiveTransform(grid, dst_hr)
    warped_hr = cv2.warpPerspective(blk_hr, M_hr, (pipe_res, pipe_res), flags=cv2.INTER_LINEAR)
    warped_hr = ((warped_hr > 127).astype(np.uint8) * 255)

    # Output-resolution warp for square-padded thumbnail extraction.
    dst_out = np.float32([
        [0, 0], [resolution - 1, 0],
        [resolution - 1, resolution - 1], [0, resolution - 1],
    ])
    M_out = cv2.getPerspectiveTransform(grid, dst_out)
    warped = cv2.warpPerspective(blk_hr, M_out, (resolution, resolution), flags=cv2.INTER_LINEAR)
    warped = ((warped > 127).astype(np.uint8) * 255)

    scale = resolution / pipe_res

    samples: list[tuple[int, NDArray[np.uint8]]] = []

    for col in range(9):
        for row in range(9):
            # cage_totals is row-major [row][col], not column-major as earlier
            # docs claimed -- verified by overlaying ROI boxes on the warped
            # image: cage_totals[col, row] picked up the wrong cell's total
            # for most cells, corrupting guardian/observer training labels.
            total = int(cage_totals[row, col])
            if total == 0:
                continue
            total_str = str(total)
            ndigits = len(total_str)

            # Extract the top-left region of the cell at pipeline resolution.
            cy = row * pipe_cell
            cx = col * pipe_cell
            roi_h = pipe_cell // 2
            roi_w = pipe_cell if ndigits == 2 else pipe_cell // 2
            roi = warped_hr[cy: cy + roi_h, cx: cx + roi_w]

            ys, xs = np.where(roi > 0)
            if len(ys) < 10:       # skip near-empty cells (noise threshold)
                _log.debug("%s col=%d row=%d total=%d: too little ink -- skipping",
                           jpg_path.name, col, row, total)
                continue

            margin = max(2, roi_w // 8)
            col_ink = roi.sum(axis=0).astype(np.float64)
            content_end = digit_content_extent(col_ink, roi_w, margin)

            if ndigits == 1:
                # Tight bounding box of ink before any trailing decoration.
                content = roi[:, :content_end]
                cys, cxs = np.where(content > 0)
                if len(cys) < 10:
                    continue
                abs_x = cx + int(cxs.min())
                abs_y = cy + int(cys.min())
                w = int(cxs.max() - cxs.min()) + 1
                h = int(cys.max() - cys.min()) + 1
                ox = int(round(abs_x * scale))
                oy = int(round(abs_y * scale))
                ow = max(1, int(round(w * scale)))
                oh = max(1, int(round(h * scale)))
                samples.append((int(total_str[0]), warp_thumb(ox, oy, ow, oh, warped)))

            else:
                # Column-projection minimum split for 2-digit totals, searched
                # only within the real digit content (excludes any trailing
                # decoration the ink-minimum would otherwise lock onto).
                mid = col_ink[margin: content_end]
                split_x = margin + int(mid.argmin()) if len(mid) > 0 else roi_w // 2

                for i, (x0, x1) in enumerate([(0, split_x), (split_x, content_end)]):
                    half = roi[:, x0: x1]
                    hys, hxs = np.where(half > 0)
                    if len(hys) < 4:
                        continue
                    abs_x = cx + x0 + int(hxs.min())
                    abs_y = cy + int(hys.min())
                    w = int(hxs.max() - hxs.min()) + 1
                    h = int(hys.max() - hys.min()) + 1
                    ox = int(round(abs_x * scale))
                    oy = int(round(abs_y * scale))
                    ow = max(1, int(round(w * scale)))
                    oh = max(1, int(round(h * scale)))
                    samples.append((int(total_str[i]), warp_thumb(ox, oy, ow, oh, warped)))

    return samples



# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def extract_directory(
    puzzle_dir: Path,
    subres: int = SUBRES,
) -> list[tuple[int, NDArray[np.uint8]]]:
    """Extract samples from all .jpg files that have a .json or .jpk cache."""
    jpgs = sorted(puzzle_dir.glob("*.jpg"))
    all_samples: list[tuple[int, NDArray[np.uint8]]] = []
    skipped = 0

    for jpg in jpgs:
        if not jpg.with_suffix('.json').exists() and not jpg.with_suffix('.jpk').exists():
            skipped += 1
            continue
        samples = extract_puzzle_samples(jpg, subres)
        all_samples.extend(samples)

    _log.info(
        "%s: %d puzzles, %d skipped (no cache), %d samples extracted",
        puzzle_dir.name, len(jpgs), skipped, len(all_samples),
    )
    return all_samples


def write_training_json(
    samples: list[tuple[int, NDArray[np.uint8]]],
    out_path: Path,
) -> None:
    """Write samples to browser_train.json-compatible JSON."""
    data = {
        "version": 1,
        "puzzleType": "killer",
        "subres": SUBRES,
        "thumbnailSize": THUMB,
        "exportedAt": datetime.now(UTC).isoformat(),
        "sampleCount": len(samples),
        "samples": [
            {"digit": digit, "pixels": img.ravel().tolist()}
            for digit, img in samples
        ],
    }
    out_path.write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
    _log.info("Wrote %d samples to %s", len(samples), out_path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        '--puzzle-dirs', nargs='+', default=['guardian', 'observer'], metavar='DIR',
        help='Puzzle directories relative to repo root (default: guardian observer)',
    )
    parser.add_argument('--subres', type=int, default=SUBRES,
                        help=f'Pixels per cell side (default: {SUBRES})')
    args = parser.parse_args()

    repo_root = Path(__file__).parent.parent
    for dir_name in args.puzzle_dirs:
        puzzle_dir = repo_root / dir_name
        if not puzzle_dir.is_dir():
            _log.warning("Directory not found: %s -- skipping", puzzle_dir)
            continue
        samples = extract_directory(puzzle_dir, args.subres)
        if not samples:
            _log.warning("No samples extracted from %s", dir_name)
            continue
        out_path = puzzle_dir / f"{dir_name}_train_sq.json"
        write_training_json(samples, out_path)


if __name__ == '__main__':
    main()
