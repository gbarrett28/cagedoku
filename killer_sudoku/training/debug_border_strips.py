"""Debug tool: visualise where border-sampling strips land on the warped image.

Draws the theoretical grid line positions (k * subres) and the sampling strip
bounds on the warped grayscale image so you can judge whether the strip
is well-centred on the actual ink grid lines.

Usage:
    python -m killer_sudoku.training.debug_border_strips observer/killer_sudoku_20.jpg
    python -m killer_sudoku.training.debug_border_strips observer/killer_sudoku_20.jpg \
        --out debug_20.png
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np
import numpy.typing as npt

from killer_sudoku.image.border_clustering import BoundaryKind, boundary_kind
from killer_sudoku.image.config import BorderClusteringConfig, ImagePipelineConfig
from killer_sudoku.image.grid_location import get_gry_img, locate_grid


def _draw_annotations(
    warped_gry: npt.NDArray[np.uint8],
    subres: int,
    config: BorderClusteringConfig,
) -> npt.NDArray[np.uint8]:
    """Return an annotated BGR image showing grid lines and sampling strips.

    Draws:
    - Grid lines at k*subres (k=1..8): blue=cell boundary, red=box boundary
    - Sampling strip outer bounds (yl, yr around each grid line): green dashed band
    """
    # Convert grayscale to BGR for colour annotations
    vis: npt.NDArray[np.uint8] = np.asarray(
        cv2.cvtColor(warped_gry, cv2.COLOR_GRAY2BGR), dtype=np.uint8
    )
    resolution = 9 * subres
    sample_half = subres // config.sample_fraction

    for gap_idx in range(8):
        border_px = (gap_idx + 1) * subres  # theoretical grid line pixel position
        yl = border_px - sample_half
        yr = border_px + sample_half
        kind = boundary_kind(gap_idx)

        # Sampling strip extent — thin green lines
        for px in (yl, yr):
            # Horizontal strip band
            cv2.line(vis, (0, px), (resolution - 1, px), (0, 200, 0), 1)
            # Vertical strip band
            cv2.line(vis, (px, 0), (px, resolution - 1), (0, 200, 0), 1)

        # Theoretical grid line — thick blue (cell) or red (box)
        colour = (0, 0, 200) if kind == BoundaryKind.BOX else (200, 100, 0)
        thickness = 2 if kind == BoundaryKind.BOX else 1
        # Horizontal line
        cv2.line(vis, (0, border_px), (resolution - 1, border_px), colour, thickness)
        # Vertical line
        cv2.line(vis, (border_px, 0), (border_px, resolution - 1), colour, thickness)

    return vis


def main(argv: list[str] | None = None) -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="Input puzzle image path")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output path for annotated PNG (default: <image-stem>_strips.png)",
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
    _blk, grid = locate_grid(gry, img, config.grid_location)

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

    annotated = _draw_annotations(warped_gry, subres, config.border_clustering)

    out_path: Path = args.out or image_path.with_name(image_path.stem + "_strips.png")
    cv2.imwrite(str(out_path), annotated)
    print(f"Saved: {out_path}  ({resolution}x{resolution}px, subres={subres})")
    print(
        f"Strip half-width: {subres // config.border_clustering.sample_fraction}px "
        f"on each side of the grid line."
    )
    print("Green lines = strip bounds, blue = cell grid line, red = box grid line.")


if __name__ == "__main__":
    main()
