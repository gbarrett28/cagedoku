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

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage


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
