#!/usr/bin/env python3
"""Traverse contour-dumps/*.json and compute a per-contour feature CSV.

Run from repo root:
    python web/scripts/analyse-contours.py [--dump-dir DIR] [--out PATH]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pandas as pd

ContourNode = list[Any]  # [pts, [x,y,w,h], area, children]


def depth_below(node: ContourNode) -> int:
    children: list[ContourNode] = node[3]
    if not children:
        return 0
    return 1 + max(depth_below(c) for c in children)


def hu_moments(pts: list[list[int]]) -> list[float]:
    arr = np.array(pts, dtype=np.float32).reshape(-1, 1, 2)
    m = cv2.moments(arr)
    hu = cv2.HuMoments(m).flatten()
    # log-scale: sign(h) * log10(|h| + 1e-10)
    return [float(math.copysign(math.log10(abs(h) + 1e-10), h)) for h in hu]


def visit(
    node: ContourNode,
    depth: int,
    parent_area: float,
    num_peers: int,
    selected_set: set[tuple[int, int, int, int]],
    outer_br: tuple[int, int, int, int] | None,
    subres: int,
    meta: dict[str, Any],
    rows: list[dict[str, Any]],
) -> None:
    pts: list[list[int]] = node[0]
    br: list[int] = node[1]
    area: float = float(node[2])
    children: list[ContourNode] = node[3]

    x, y, w, h = br
    br_tuple = (x, y, w, h)

    if w == 0 or h == 0:
        for child in children:
            visit(child, depth + 1, area or 1.0, len(children),
                  selected_set, outer_br, subres, meta, rows)
        return

    hu = hu_moments(pts)
    db = depth_below(node)

    if br_tuple == outer_br:
        label = "grid"
    elif br_tuple in selected_set:
        label = "number"
    else:
        label = "unlabelled"

    cx = x + w / 2
    cy = y + h / 2
    cell_col = int(cx / subres)
    cell_row = int(cy / subres)

    cage_total: int | None = None
    given_digit: int | None = None
    if label == "number":
        cage_totals: list[list[int]] | None = meta.get("cageTotals")
        given_digits: list[list[int | None]] | None = meta.get("givenDigits")
        if cage_totals and 0 <= cell_row < 9 and 0 <= cell_col < 9:
            v = cage_totals[cell_row][cell_col]
            if v:
                cage_total = v
        if given_digits and 0 <= cell_row < 9 and 0 <= cell_col < 9:
            given_digit = given_digits[cell_row][cell_col]

    row: dict[str, Any] = {
        "puzzle_hash": meta["puzzle_hash"],
        "corpus": meta["corpus"],
        "ground_truth": meta["ground_truth"],
        "detected_type": meta["detected_type"],
        "bucket": meta["bucket"],
        "depth": depth,
        "depth_below": db,
        "num_peers": num_peers,
        "num_children": len(children),
        "x": x, "y": y, "w": w, "h": h,
        "cx_norm": cx / subres,
        "cy_norm": cy / subres,
        "w_norm": w / subres,
        "h_norm": h / subres,
        "area_norm": area / (subres * subres),
        "aspect_ratio": w / h,
        "fill_ratio": area / (w * h),
        "area_rel_parent": area / parent_area,
        "label": label,
        "cell_row": cell_row if label == "number" else None,
        "cell_col": cell_col if label == "number" else None,
        "cage_total": cage_total,
        "given_digit": given_digit,
        **{f"hu{i + 1}": hu[i] for i in range(7)},
    }
    rows.append(row)

    for child in children:
        visit(child, depth + 1, area or 1.0, len(children),
              selected_set, outer_br, subres, meta, rows)


def process_dump(dump_path: Path) -> list[dict[str, Any]]:
    with dump_path.open() as f:
        data = json.load(f)

    subres: int = data.get("subres", 128)
    selected: list[list[int]] = data.get("selectedNumbers", [])
    selected_set = {(s[0], s[1], s[2], s[3]) for s in selected}
    outer_br_raw: list[int] | None = data.get("outerGridBR")
    outer_br: tuple[int, int, int, int] | None = (
        (outer_br_raw[0], outer_br_raw[1], outer_br_raw[2], outer_br_raw[3])
        if outer_br_raw else None
    )

    meta: dict[str, Any] = {
        "puzzle_hash": data["puzzle_hash"],
        "corpus": data["corpus"],
        "ground_truth": data["ground_truth"],
        "detected_type": data["detected_type"],
        "bucket": data["bucket"],
        "cageTotals": data.get("cageTotals"),
        "givenDigits": data.get("givenDigits"),
    }

    rows: list[dict[str, Any]] = []
    tree: list[ContourNode] = data.get("tree", [])
    for root in tree:
        visit(root, 0, float(root[2]) or 1.0, len(tree),
              selected_set, outer_br, subres, meta, rows)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dump-dir", default="contour-dumps")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    dump_dir = Path(args.dump_dir)
    out_path = Path(args.out) if args.out else dump_dir / "features.csv"

    files = sorted(dump_dir.glob("*.json"))
    if not files:
        print(f"No JSON files in {dump_dir}", file=sys.stderr)
        sys.exit(1)

    all_rows: list[dict[str, Any]] = []
    for i, f in enumerate(files):
        try:
            all_rows.extend(process_dump(f))
            print(f"[{i + 1}/{len(files)}] {f.name}")
        except Exception as exc:
            print(f"WARNING: skipping {f.name}: {exc}", file=sys.stderr)

    df = pd.DataFrame(all_rows)
    df.to_csv(out_path, index=False)
    print(f"\n{len(df)} contours from {len(files)} puzzles -> {out_path}")


if __name__ == "__main__":
    main()
