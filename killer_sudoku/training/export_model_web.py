"""Export the bundled number recogniser model to browser-friendly binary format.

Converts ``num_recogniser.npz`` to two files consumed by the TypeScript port:

  - ``num_recogniser.bin``: flat little-endian binary blob of all arrays in order.
  - ``num_recogniser.json``: manifest mapping array names to dtype, shape, byte
    offset, and byte length within the blob.

Integer arrays (int64/intp) are downcast to int32 on export — all values in
the current model (class labels 0–9, n_support < 200, dims = 70) fit easily.
Float arrays are written as float64 or float32 as stored in the .npz.

Usage::

    python -m killer_sudoku.training.export_model_web

Output goes to ``web/public/`` relative to the project root.
Re-run whenever the model is retrained.
"""

import json
import logging
from importlib.resources import files
from pathlib import Path

import numpy as np

_log = logging.getLogger(__name__)

# Integer dtypes that will be downcast to int32 for the browser.
_INT_DTYPES = {np.dtype("int64"), np.dtype("int32"), np.dtype("intp")}


def export_model(output_dir: Path) -> None:
    """Export num_recogniser.npz to .bin + .json in output_dir.

    Loads the bundled model from package data, serialises each array as a
    C-contiguous little-endian binary block, and writes a JSON manifest
    with the shape and byte offset of each array.

    Args:
        output_dir: Directory to write num_recogniser.bin and
            num_recogniser.json.  Created if it does not exist.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    resource = files("killer_sudoku.data").joinpath("num_recogniser.npz")
    arrays: dict[str, dict[str, object]] = {}
    blob = bytearray()

    with resource.open("rb") as fh:
        with np.load(fh) as data:
            for key in data.files:
                arr = np.asarray(data[key])

                # Downcast integer arrays to int32: all model values fit in 32 bits.
                if arr.dtype in _INT_DTYPES:
                    arr = arr.astype(np.int32)

                # Ensure C-contiguous and explicitly little-endian.
                arr_le = np.ascontiguousarray(arr).astype(
                    arr.dtype.newbyteorder("<"), copy=False
                )
                raw = arr_le.tobytes()

                arrays[key] = {
                    "dtype": arr_le.dtype.name,
                    "shape": list(arr_le.shape),
                    "offset": len(blob),
                    "byteLength": len(raw),
                }
                blob.extend(raw)

    bin_path = output_dir / "num_recogniser.bin"
    json_path = output_dir / "num_recogniser.json"

    bin_path.write_bytes(bytes(blob))
    json_path.write_text(json.dumps({"arrays": arrays}, indent=2), encoding="utf-8")

    _log.info("Wrote %d bytes to %s", len(blob), bin_path)
    _log.info("Wrote manifest (%d arrays) to %s", len(arrays), json_path)


def main() -> None:
    """Entry point: export model to web/public/ relative to the project root."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    project_root = Path(__file__).parent.parent.parent
    output_dir = project_root / "web" / "public"
    export_model(output_dir)
    print(f"Model exported to {output_dir}")


if __name__ == "__main__":
    main()
