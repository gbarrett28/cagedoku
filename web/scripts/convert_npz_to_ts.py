#!/usr/bin/env python3
r"""Convert killer_sudoku/data/num_recogniser.npz to the TS pca_rbf binary format.

The output files (num_recogniser.bin + num_recogniser.json) are consumed by
loadNumRecogniser() in web/src/image/numberRecognition.ts when classifier_type
is 'pca_rbf'.  The PCA+RBF model was trained on cv2.imread (ICC-free) images,
matching what cv.imdecode now provides in the browser pipeline.

Usage (from repo root):
    python web/scripts/convert_npz_to_ts.py \
        --npz killer_sudoku/data/num_recogniser.npz \
        --out web/public
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

CONFIDENCE_THRESHOLD = 0.7


def convert(npz_path: Path, out_dir: Path) -> None:
    d = np.load(str(npz_path), allow_pickle=False)

    dims = int(d["dims"])
    pca_components = d["pca_components"][:dims].astype(np.float64)  # (dims, 4096)
    pca_mean = d["pca_mean"].astype(np.float64)                     # (4096,)
    win_size = round(np.sqrt(pca_mean.shape[0]))               # 64

    rbf_support_vectors = d["rbf_support_vectors"].astype(np.float64)  # (118, 8)
    rbf_dual_coef       = d["rbf_dual_coef"].astype(np.float64)        # (9, 118)
    rbf_intercept       = d["rbf_intercept"].astype(np.float64)        # (45,)
    rbf_n_support       = d["rbf_n_support"].astype(np.int32)          # (10,)
    rbf_gamma           = float(d["rbf_gamma"])
    classes             = d["rbf_classes"].astype(np.int32)            # (10,)

    # Per-digit mean templates (float32, 64x64) for TM_CCOEFF_NORMED fast path.
    template_keys = sorted(
        k for k in d.files if k.startswith("template_") and k[9:].isdigit()
    )
    templates: list[tuple[str, npt.NDArray[Any], str]] = []
    if template_keys:
        for k in template_keys:
            templates.append((k, d[k].astype(np.float32), "float32"))
        template_threshold = float(d["template_threshold"]) if "template_threshold" in d.files else 0.85
    else:
        template_threshold = 0.85

    named: list[tuple[str, npt.NDArray[Any], str]] = [
        ("pca_win_size",         np.array(win_size,              dtype=np.int32),   "int32"),
        ("pca_dims",             np.array(dims,                  dtype=np.int32),   "int32"),
        ("confidence_threshold", np.array(CONFIDENCE_THRESHOLD,  dtype=np.float64), "float64"),
        ("template_threshold",   np.array(template_threshold,    dtype=np.float64), "float64"),
        ("classes",              classes,                                             "int32"),
        ("pca_mean",             pca_mean,                                           "float64"),
        ("pca_components",       pca_components,                                     "float64"),
        ("rbf_support_vectors",  rbf_support_vectors,                                "float64"),
        ("rbf_dual_coef",        rbf_dual_coef,                                      "float64"),
        ("rbf_intercept",        rbf_intercept,                                      "float64"),
        ("rbf_n_support",        rbf_n_support,                                      "int32"),
        ("rbf_gamma",            np.array([rbf_gamma],           dtype=np.float64), "float64"),
        *templates,
    ]

    blob = bytearray()
    manifest_arrays: dict[str, Any] = {}
    for name, arr, dtype_str in named:
        data = np.asarray(arr).tobytes()
        manifest_arrays[name] = {
            "dtype":      dtype_str,
            "shape":      list(arr.shape),
            "offset":     len(blob),
            "byteLength": len(data),
        }
        blob.extend(data)

    out_dir.mkdir(parents=True, exist_ok=True)
    bin_path  = out_dir / "num_recogniser.bin"
    json_path = out_dir / "num_recogniser.json"

    bin_path.write_bytes(blob)

    manifest = {"classifier_type": "pca_rbf", "arrays": manifest_arrays}
    json_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"Wrote {bin_path}  ({len(blob):,} bytes)")
    print(f"Wrote {json_path}")
    print(f"  pca_win_size={win_size}, dims={dims}")
    print(f"  support_vectors={rbf_support_vectors.shape}, gamma={rbf_gamma:.3e}")
    print(f"  classes={classes.tolist()}")
    print(f"  templates={len(template_keys)}, threshold={template_threshold}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--npz",
        default="killer_sudoku/data/num_recogniser.npz",
        help="Path to the Python num_recogniser.npz model file",
    )
    parser.add_argument(
        "--out",
        default="web/public",
        help="Output directory for .bin and .json files",
    )
    args = parser.parse_args()
    convert(Path(args.npz), Path(args.out))


if __name__ == "__main__":
    main()
