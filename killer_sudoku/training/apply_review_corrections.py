"""Merges a downloaded tick-sheet review JSON into the overrides file.

The JSON comes from review_low_confidence.py's tick sheet. Subsequent
training and review runs pick up the corrections automatically.
"""

import argparse
import json
from pathlib import Path
from typing import Any

DEFAULT_OVERRIDES_PATH = Path("killer_sudoku/training/manual_label_overrides.json")


def merge_corrections(
    existing: dict[str, Any],
    review: list[dict[str, Any]],
    candidates: dict[str, Any],
) -> dict[str, Any]:
    """Join review answers to the raw crop evidence in candidates.json."""
    merged = dict(existing)
    for entry in review:
        candidate = candidates.get(entry["id"])
        if candidate is None:
            continue
        merged[entry["id"]] = {
            "label": entry["chosen"],
            "expectedPrior": candidate["expectedPrior"],
            "cropPng": candidate["cropPng"],
            "sourceRect": candidate["sourceRect"],
            "sourceWidth": candidate["sourceWidth"],
            "sourceHeight": candidate["sourceHeight"],
            "puzzleType": candidate.get("puzzleType", "classic"),
        }
    return merged


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("review", type=Path, help="Downloaded tick_sheet_results.json")
    parser.add_argument(
        "--candidates", type=Path,
        default=Path("killer_sudoku/training/review_output/candidates.json"),
        help="candidates.json written by review_low_confidence.py alongside the tick sheet",
    )
    parser.add_argument("--overrides", type=Path, default=DEFAULT_OVERRIDES_PATH)
    args = parser.parse_args()

    existing: dict[str, Any] = {}
    if args.overrides.exists():
        existing = json.loads(args.overrides.read_text(encoding="utf-8"))

    review = json.loads(args.review.read_text(encoding="utf-8"))
    candidates = json.loads(args.candidates.read_text(encoding="utf-8"))
    merged = merge_corrections(existing, review, candidates)

    skipped = sum(1 for entry in review if entry["id"] not in candidates)
    args.overrides.parent.mkdir(parents=True, exist_ok=True)
    args.overrides.write_text(
        json.dumps(merged, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"Merged {len(review) - skipped} corrections -- {len(merged)} total overrides -- wrote {args.overrides}")
    if skipped:
        print(f"WARNING: {skipped} review entrie(s) had no matching candidates.json record -- skipped")


if __name__ == "__main__":
    main()
