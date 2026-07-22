"""Dumps InpImage stage checkpoints for one puzzle image to JSON.

For bit-exact comparison against the TS port's bitcheck-dump.ts output.
Temporary tooling for the bit-exact port effort — deleted once the whole
corpus matches (see docs/superpowers/specs/2026-07-21-python-bitexact-port-design.md).

Usage:
    python -m killer_sudoku.scripts.bitcheck_dump <image_path> [--out FILE]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from killer_sudoku.image.cell_scan import detect_rotation, scan_cells
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.grid_location import get_gry_img, locate_grid
from killer_sudoku.image.inp_image import InpImage


def _cage_conf_for(image_path: Path, config: ImagePipelineConfig) -> list[list[float]]:
    """Independently replicates InpImage's locate_grid/warp/rotation/scan_cells.

    Reproduces the killer_sudoku/image/inp_image.py __init__ sequence up to
    scan_cells to get the cage_conf anchors _identify_borders actually
    clusters against — InpImage doesn't expose this as a public attribute.
    Diagnostic only; does not modify the reference pipeline.
    """
    resolution = config.resolution
    subres = config.subres
    gry, _img = get_gry_img(image_path, resolution)
    _blk, grid = locate_grid(gry, config.grid_location)

    dst_size = np.array(
        [[0, 0], [resolution - 1, 0], [resolution - 1, resolution - 1], [0, resolution - 1]],
        dtype=np.float32,
    )
    m = np.asarray(cv2.getPerspectiveTransform(grid, dst_size), dtype=np.float64)
    warped_gry = np.asarray(
        cv2.warpPerspective(gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR), dtype=np.uint8
    )

    rotation_k = detect_rotation(warped_gry, subres, config.cell_scan.rotation_dominance_threshold)
    if rotation_k != 0:
        grid = np.roll(grid, -rotation_k, axis=0)
        m = np.asarray(cv2.getPerspectiveTransform(grid, dst_size), dtype=np.float64)
        warped_gry = np.asarray(
            cv2.warpPerspective(gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR), dtype=np.uint8
        )

    cage_conf, _classic_conf = scan_cells(warped_gry, subres, config.cell_scan)
    result: list[list[float]] = cage_conf.tolist()
    return result


def dump_stages(image_path: Path) -> dict[str, Any]:
    """Runs InpImage on image_path and extracts the bit-check checkpoints."""
    config = ImagePipelineConfig(rework=True)
    num_recogniser = InpImage.make_num_recogniser()
    info = InpImage(image_path, config, num_recogniser)

    return {
        "gray": info.gry.tolist(),
        "gray_shape": list(info.gry.shape),
        "grid_corners": info.info.grid.tolist(),
        "puzzle_type": info.puzzle_type,
        "cage_conf": _cage_conf_for(image_path, config),
        "border_x": info.info.border_x.tolist(),
        "border_y": info.info.border_y.tolist(),
        "cage_totals": info.info.cage_totals.tolist(),
        "given_digits": info.given_digits.tolist() if info.given_digits is not None else None,
        "spec_error": info.spec_error,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image_path", type=Path)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    stages = dump_stages(args.image_path)
    out_path = args.out if args.out is not None else args.image_path.with_suffix(".py.bitcheck.json")
    out_path.write_text(json.dumps(stages))
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
