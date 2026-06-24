#!/usr/bin/env python3
"""
Convert guardian/observer .jpk pickle caches to plain JSON.

Usage
-----
    python web/migrate_pic_cache.py
    python web/migrate_pic_cache.py --puzzle-dirs guardian observer
    python web/migrate_pic_cache.py --delete-jpk   # remove .jpk after conversion

Each .jpk is written as <name>.json next to the original file.  Skips
puzzles that already have an up-to-date .json (mtime >= .jpk).
"""

from __future__ import annotations
import argparse
import json
import logging
import pickle
import sys
import types
from pathlib import Path

import numpy as np

_log = logging.getLogger(__name__)


def _register_stub() -> None:
    for mod in ('killer_sudoku.image', 'killer_sudoku.image.inp_image'):
        if mod not in sys.modules:
            sys.modules[mod] = types.ModuleType(mod)

    class PicInfo:
        pass

    sys.modules['killer_sudoku.image.inp_image'].PicInfo = PicInfo  # type: ignore[attr-defined]


def migrate_one(jpk_path: Path, delete_jpk: bool = False) -> bool:
    """Convert one .jpk to .json.  Returns True if written, False if skipped."""
    json_path = jpk_path.with_suffix('.json')
    if json_path.exists() and json_path.stat().st_mtime >= jpk_path.stat().st_mtime:
        return False   # already up to date

    _register_stub()
    with open(jpk_path, 'rb') as fh:
        p = pickle.load(fh)  # trusted own-generated data

    data = {
        'grid':        np.array(p.grid).tolist(),
        'cage_totals': np.array(p.cage_totals).tolist(),
        'border_x':    np.array(p.border_x).tolist(),
        'border_y':    np.array(p.border_y).tolist(),
        'brdrs':       np.array(p.brdrs).tolist(),
    }
    json_path.write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
    if delete_jpk:
        jpk_path.unlink()
    return True


def main() -> None:
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--puzzle-dirs', nargs='+', default=['guardian', 'observer'])
    parser.add_argument('--delete-jpk', action='store_true',
                        help='Delete .jpk files after successful conversion')
    args = parser.parse_args()

    repo_root = Path(__file__).parent.parent
    for dir_name in args.puzzle_dirs:
        puzzle_dir = repo_root / dir_name
        jpks = sorted(puzzle_dir.glob('*.jpk'))
        if not jpks:
            _log.warning('%s: no .jpk files found', dir_name)
            continue
        written = sum(migrate_one(p, args.delete_jpk) for p in jpks)
        _log.info('%s: %d converted, %d already up to date',
                  dir_name, written, len(jpks) - written)


if __name__ == '__main__':
    main()
