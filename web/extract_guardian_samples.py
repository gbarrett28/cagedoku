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
import atexit
import base64
import json
import logging
import subprocess
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
# Node contour-detection bridge -- calls production's literal
# isDigitSizedContour + real cv.findContours logic instead of reimplementing
# contour detection a second time in cv2, closing off the cross-language
# drift that caused the original boundary-bleed bug.
# ---------------------------------------------------------------------------

_bridge_proc: 'subprocess.Popen[str] | None' = None


def _get_bridge() -> 'subprocess.Popen[str]':
    """Lazily start the persistent Node contour-detection bridge, reused for
    the whole extraction run rather than spawned per-cell (opencv.js WASM
    init takes real time -- amortising it across thousands of calls matters).
    """
    global _bridge_proc
    if _bridge_proc is None:
        web_dir = Path(__file__).parent
        _bridge_proc = subprocess.Popen(
            'npx vite-node scripts/find-digit-blobs-server.ts',
            shell=True, cwd=web_dir,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        atexit.register(_shutdown_bridge)
    return _bridge_proc


def _shutdown_bridge() -> None:
    global _bridge_proc
    if _bridge_proc is not None:
        proc, _bridge_proc = _bridge_proc, None
        if proc.stdin is not None:
            proc.stdin.close()
        proc.wait(timeout=5)


def _request_blobs(payload: dict) -> dict:
    """Send one request to the bridge and return its decoded JSON response."""
    proc = _get_bridge()
    assert proc.stdin is not None and proc.stdout is not None
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    if not line:
        stderr = proc.stderr.read() if proc.stderr else ""
        raise RuntimeError(f"find-digit-blobs-server.ts produced no output (exited?): {stderr}")
    return json.loads(line)


def find_digit_blobs(roi: NDArray[np.uint8], subres: int) -> list[tuple[int, int, int, int]]:
    """Find digit-sized ink blobs in a cell ROI via the Node contour-detection
    bridge (the literal production isDigitSizedContour + cv.findContours
    logic), sorted left-to-right by x.
    """
    h, w = roi.shape
    payload = {
        "w": w, "h": h, "subres": subres,
        "pixels": base64.b64encode(roi.tobytes()).decode('ascii'),
    }
    response = _request_blobs(payload)
    return [tuple(b) for b in response["blobs"]]


# ---------------------------------------------------------------------------
# Pure helpers -- testable without cv2 or real images
# ---------------------------------------------------------------------------

def is_num_contour(w: int, h: int, subres: int = SUBRES) -> bool:
    """True if bounding-rect dimensions match a cage-total digit glyph."""
    return (subres // 16 <= w <= subres // 2) and (subres // 8 <= h <= subres // 2)


def select_digit_blobs(
    blobs: list[tuple[int, int, int, int]], ndigits: int,
) -> list[tuple[int, int, int, int]] | None:
    """Pick exactly `ndigits` blobs from `blobs`, left-to-right by x.

    Cage-total digits are always drawn at the top of their ROI (that is
    exactly why the ROI is cropped to the cell's top-left quadrant); any
    extra contour beyond the real digit(s) is, in every observed case, a
    fragment of cage-border/underline decoration sitting lower in the ROI --
    a thick decoration band can itself fragment into pieces where it has a
    gap, and one piece can be small enough to slip through the digit-size
    filter. When there are more blobs than expected, keep the `ndigits`
    blobs with the smallest y (topmost) and discard the rest. Returns None
    if there are fewer blobs than `ndigits` (caller decides the fallback).
    """
    if len(blobs) < ndigits:
        return None
    if len(blobs) == ndigits:
        return blobs
    topmost = sorted(blobs, key=lambda b: b[1])[:ndigits]
    return sorted(topmost, key=lambda b: b[0])


# ---------------------------------------------------------------------------
# Thumbnail extraction
# ---------------------------------------------------------------------------

def letterbox_warp(
    ax: float, ay: float, bw: float, bh: float, warped: NDArray[np.uint8],
) -> NDArray[np.uint8]:
    """Extract a letterboxed (no square-stretch) 64x64 thumbnail from the
    warped binary image. Matches the TypeScript letterboxWarp helper exactly.
    """
    scale = min((THUMB - 1) / bw, (THUMB - 1) / bh)
    dest_w, dest_h = bw * scale, bh * scale
    off_x, off_y = ((THUMB - 1) - dest_w) / 2, ((THUMB - 1) - dest_h) / 2
    src = np.array([
        [ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh],
    ], dtype=np.float32)
    dst = np.array([
        [off_x, off_y], [off_x + dest_w, off_y],
        [off_x + dest_w, off_y + dest_h], [off_x, off_y + dest_h],
    ], dtype=np.float32)
    M = cv2.getPerspectiveTransform(src, dst)
    thumb = cv2.warpPerspective(warped, M, (THUMB, THUMB), flags=cv2.INTER_LINEAR)
    return ((thumb > 127).astype(np.uint8) * 255)


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

            blobs = find_digit_blobs(roi, pipe_cell)
            selected = select_digit_blobs(blobs, ndigits)

            if selected is not None:
                digit_blobs = selected
            elif ndigits == 2 and len(blobs) == 1:
                # Genuine touching-digit fallback: split the single merged
                # blob's own bounding rect, not a synthetic full-ROI window.
                bx, by, bw, bh = blobs[0]
                split = split_bounding_rect(cx + bx, cy + by, bw, bh, warped_hr)
                if split is None:
                    continue
                (sax, say, saw, sah), (sbx, sby, sbw, sbh) = split
                halves = [
                    (sax - cx, say - cy, saw, sah),
                    (sbx - cx, sby - cy, sbw, sbh),
                ]
                digit_blobs = [
                    (hx, hy, hw, hh) for (hx, hy, hw, hh) in halves
                    if is_num_contour(hw, hh, subres=pipe_cell)
                ]
                if len(digit_blobs) != 2:
                    _log.debug(
                        "%s col=%d row=%d total=%d: merged-blob split rejected -- skipping",
                        jpg_path.name, col, row, total,
                    )
                    continue
            else:
                _log.debug(
                    "%s col=%d row=%d total=%d: found %d digit blob(s), expected %d -- skipping",
                    jpg_path.name, col, row, total, len(blobs), ndigits,
                )
                continue

            for i, (bx, by, bw, bh) in enumerate(digit_blobs):
                abs_x = cx + bx
                abs_y = cy + by
                ox = int(round(abs_x * scale))
                oy = int(round(abs_y * scale))
                ow = max(1, int(round(bw * scale)))
                oh = max(1, int(round(bh * scale)))
                samples.append((int(total_str[i]), letterbox_warp(ox, oy, ow, oh, warped)))

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
