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


if __name__ == '__main__':
    pass  # CLI added in Task 2
