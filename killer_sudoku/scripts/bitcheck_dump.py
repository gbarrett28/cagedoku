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
import numpy.typing as npt

from killer_sudoku.image.border_clustering import _sample_strip, strip_features
from killer_sudoku.image.cell_scan import detect_rotation, scan_cells
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.grid_location import get_gry_img, locate_grid
from killer_sudoku.image.inp_image import InpImage


def _warped_gry_for(image_path: Path, config: ImagePipelineConfig) -> npt.NDArray[np.uint8]:
    """Independently replicates InpImage's locate_grid/warp/rotation sequence.

    Reproduces the killer_sudoku/image/inp_image.py __init__ sequence up to
    (and including) rotation correction, to get the same warped_gry
    _identify_borders actually clusters against — InpImage doesn't expose
    this as a public attribute. Diagnostic only; does not modify the
    reference pipeline.
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
    return warped_gry


def _cage_conf_for(warped_gry: npt.NDArray[np.uint8], config: ImagePipelineConfig) -> list[list[float]]:
    """Stage 3 cage_conf anchors, from the independently-replicated warped_gry."""
    cage_conf, _classic_conf = scan_cells(warped_gry, config.subres, config.cell_scan)
    result: list[list[float]] = cage_conf.tolist()
    return result


def _strip_features_for(warped_gry: npt.NDArray[np.uint8], config: ImagePipelineConfig) -> list[list[float]]:
    """All 144 border-strip feature vectors, in canonical order.

    Same order cluster_borders builds them (gap_idx 0..7, along_idx 0..8,
    is_h True then False) — matching web/src/image/borderClustering.ts's
    clusterBorders loop order exactly, so entries are directly comparable
    by index.
    """
    subres = config.subres
    sample_half = subres // config.border_clustering.sample_fraction
    sample_margin_px = subres // config.border_clustering.sample_margin

    features: list[list[float]] = []
    for gap_idx in range(8):
        for along_idx in range(9):
            for is_h in (True, False):
                strip = _sample_strip(warped_gry, is_h, gap_idx, along_idx, subres, sample_half, sample_margin_px)
                features.append(strip_features(strip).tolist())
    return features


def dump_stages(image_path: Path) -> dict[str, Any]:
    """Runs InpImage on image_path and extracts the bit-check checkpoints."""
    config = ImagePipelineConfig(rework=True)
    num_recogniser = InpImage.make_num_recogniser()
    info = InpImage(image_path, config, num_recogniser)
    warped_gry = _warped_gry_for(image_path, config)

    # For classic puzzles, InpImage never assigns self.info.cage_totals (it stays
    # at its all-zero dataclass default) -- the meaningful placeholder (each row
    # modelled as one giant 45-total cage) only flows into self.spec.cage_totals
    # via validate_cage_layout. Prefer spec.cage_totals (same array, by
    # reference, on the killer path) so the dump reflects what actually drives
    # puzzle validation for both puzzle types.
    #
    # Both code paths build this array genuinely col-major ([col][row]),
    # requiring a transpose to compare against TS's row-major array:
    #   - Classic: cage_totals_classic[0, r] = 45 for r in range(9) -- verified
    #     empirically (matches TS only after transposing).
    #   - Killer: _build_cage_totals's contour-to-cell assignment (col from a
    #     contour's x-coordinate, row from y) has the same axis-swap quirk
    #     Stage 4's `_sample_strip` documents ("the first numpy axis is
    #     x/column") and was already fixed for -- verified empirically against
    #     a real killer image (guardian/killer_sudoku_0.jpg): feeding the
    #     bit-exact-matching border_x/border_y and cage_totals into a
    #     from-scratch connectivity check only reaches a perfect 30/30 score
    #     (every cage exactly one head) once cage_totals is transposed: the
    #     un-transposed reading produces geometrically sane cage *shapes*
    #     (proving border detection correct) but attaches each cage's total to
    #     the wrong cell within its own shape.
    #     `killer_sudoku/image/*.py` is out of scope for this port, so TS's
    #     `buildCageTotals` was fixed directly (swap which pixel coordinate
    #     feeds row vs col) rather than mirroring this quirk -- meaning TS's
    #     cage_totals is now the CORRECTLY-oriented array, and it's Python's
    #     raw (unfixed) output that needs transposing to match it. (Python's
    #     own `validate_cage_layout` reads cage_totals with a col/row
    #     loop-variable swap that happens to compensate for this internally,
    #     which is why it doesn't throw for most images -- but that's a
    #     separate, coincidental fact about validate_cage_layout, not a
    #     reason to leave this dump un-transposed.)
    #
    # Normalise to row-major on the way out (this project's canonical
    # convention, see CLAUDE.md) so the dump is always directly comparable to
    # TS without the diff script needing to special-case per field. (border_x/
    # border_y are exempt: both sides intentionally keep those col-first, see
    # web/src/image/validation.ts.)
    cage_totals_raw = info.spec.cage_totals if info.spec is not None else info.info.cage_totals
    cage_totals = cage_totals_raw.T

    # spec.regions is built by validate_cage_layout's same [col, row] union-find
    # as cage_totals (see validation.py), so it needs the same transpose to
    # compare against TS's row-major spec.regions. Only meaningful once spec
    # construction succeeds -- null otherwise, matching TS's own regions field.
    regions = info.spec.regions.T.tolist() if info.spec is not None else None

    return {
        "gray": info.gry.tolist(),
        "gray_shape": list(info.gry.shape),
        "grid_corners": info.info.grid.tolist(),
        "puzzle_type": info.puzzle_type,
        "cage_conf": _cage_conf_for(warped_gry, config),
        "strip_features": _strip_features_for(warped_gry, config),
        "border_x": info.info.border_x.tolist(),
        "border_y": info.info.border_y.tolist(),
        "cage_totals": cage_totals.tolist(),
        "regions": regions,
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
