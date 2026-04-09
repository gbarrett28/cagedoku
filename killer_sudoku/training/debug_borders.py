"""Debug tool: visualise the classified cage/non-cage border decisions.

Runs the full border-clustering pipeline (scan_cells + cluster_borders) and
draws the resulting cage border decisions on the warped image so you can see
exactly which borders were misclassified.

Usage:
    python -m killer_sudoku.training.debug_borders observer/killer_sudoku_20.jpg
    python -m killer_sudoku.training.debug_borders observer/killer_sudoku_20.jpg \
        --out debug.png
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np
import numpy.typing as npt

from killer_sudoku.image.border_clustering import cluster_borders
from killer_sudoku.image.cell_scan import detect_rotation, scan_cells
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.grid_location import get_gry_img, locate_grid


def _draw_borders(
    warped_gry: npt.NDArray[np.uint8],
    border_x_prob: npt.NDArray[np.float64],
    border_y_prob: npt.NDArray[np.float64],
    subres: int,
) -> npt.NDArray[np.uint8]:
    """Draw cage border decisions on a colour copy of the warped image.

    border_x_prob[along, gap]: probability that the horizontal border between
    row gap and row gap+1 at column along is a cage border.  Drawn as a
    horizontal line segment at y = (gap+1)*subres, centred on column along.

    border_y_prob[gap, along]: probability for vertical borders. Drawn as a
    vertical line segment at x = (gap+1)*subres, centred on row along.

    Colour: bright green = cage border (prob>0.5), transparent = non-cage.
    """
    vis: npt.NDArray[np.uint8] = np.asarray(
        cv2.cvtColor(warped_gry, cv2.COLOR_GRAY2BGR), dtype=np.uint8
    )

    # Horizontal borders: border_x_prob shape (9, 8) = (along_col, gap_row)
    for gap_idx in range(8):
        border_y = (gap_idx + 1) * subres
        for along_idx in range(9):
            prob = float(border_x_prob[along_idx, gap_idx])
            if prob > 0.5:
                x_start = along_idx * subres + 4
                x_end = (along_idx + 1) * subres - 4
                cv2.line(vis, (x_start, border_y), (x_end, border_y), (0, 255, 0), 3)

    # Vertical borders: border_y_prob shape (8, 9) = (gap_col, along_row)
    for gap_idx in range(8):
        border_x = (gap_idx + 1) * subres
        for along_idx in range(9):
            prob = float(border_y_prob[gap_idx, along_idx])
            if prob > 0.5:
                y_start = along_idx * subres + 4
                y_end = (along_idx + 1) * subres - 4
                cv2.line(vis, (border_x, y_start), (border_x, y_end), (0, 255, 0), 3)

    # Draw faint grid lines for reference
    resolution = 9 * subres
    for k in range(1, 9):
        px = k * subres
        cv2.line(vis, (0, px), (resolution - 1, px), (100, 100, 100), 1)
        cv2.line(vis, (px, 0), (px, resolution - 1), (100, 100, 100), 1)

    return vis


def main(argv: list[str] | None = None) -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="Input puzzle image path")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output path for annotated PNG (default: <image-stem>_borders.png)",
    )
    args = parser.parse_args(argv)

    image_path: Path = args.image
    if not image_path.exists():
        print(f"ERROR: {image_path} not found", file=sys.stderr)
        sys.exit(1)

    config = ImagePipelineConfig()
    subres = config.subres
    resolution = config.resolution

    gry, img = get_gry_img(image_path, resolution)
    _blk, grid = locate_grid(gry, config.grid_location)

    dst_size = np.array(
        [
            [0, 0],
            [resolution - 1, 0],
            [resolution - 1, resolution - 1],
            [0, resolution - 1],
        ],
        dtype=np.float32,
    )
    m: npt.NDArray[np.float64] = np.asarray(
        cv2.getPerspectiveTransform(grid, dst_size), dtype=np.float64
    )
    warped_gry: npt.NDArray[np.uint8] = np.asarray(
        cv2.warpPerspective(gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR),
        dtype=np.uint8,
    )

    # Correct rotation if needed (mirrors _identify_borders flow)
    rotation_k = detect_rotation(
        warped_gry, subres, config.cell_scan.rotation_dominance_threshold
    )
    if rotation_k != 0:
        grid = np.roll(grid, -rotation_k, axis=0)
        m = np.asarray(cv2.getPerspectiveTransform(grid, dst_size), dtype=np.float64)
        warped_gry = np.asarray(
            cv2.warpPerspective(
                gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
            dtype=np.uint8,
        )

    cage_conf, _classic_conf = scan_cells(warped_gry, subres, config.cell_scan)

    n_anchors = int(
        np.count_nonzero(cage_conf >= config.cell_scan.anchor_confidence_threshold)
    )
    print(f"Cage-total cells detected: {n_anchors}")

    bx_prob, by_prob = cluster_borders(
        warped_gry,
        cage_conf,
        subres,
        config.border_clustering,
        config.cell_scan.anchor_confidence_threshold,
    )

    n_cage_h = int(np.count_nonzero(bx_prob > 0.5))
    n_cage_v = int(np.count_nonzero(by_prob > 0.5))
    print(f"Cage borders detected: {n_cage_h} horizontal, {n_cage_v} vertical")

    annotated = _draw_borders(warped_gry, bx_prob, by_prob, subres)

    out_path = args.out or image_path.with_name(image_path.stem + "_borders.png")
    cv2.imwrite(str(out_path), annotated)
    print(f"Saved: {out_path}")
    print("Green = classified cage border, grey = non-cage (or uncertain).")


if __name__ == "__main__":
    main()
