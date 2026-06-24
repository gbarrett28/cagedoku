"""
Deduplicate exact byte-identical samples in browser_train.json.

Usage:
    python web/dedupe_browser_train.py [path/to/browser_train.json]

Drops exact duplicate (digit, pixels) entries, keeping the first occurrence,
and rewrites the file in place. Duplicate browser-exported crops get
multiply-counted under --browser-weight, pulling the SVM boundary harder
than the underlying evidence (one real crop, captured more than once)
actually warrants.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


def dedupe_samples(samples: list[dict]) -> tuple[list[dict], int]:
    """Drop exact pixel-duplicate samples, keeping first occurrence.

    Returns (deduped_samples, num_duplicates_removed).
    """
    seen: set[str] = set()
    deduped: list[dict] = []
    for sample in samples:
        digest = hashlib.sha256(bytes(sample['pixels'])).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        deduped.append(sample)
    return deduped, len(samples) - len(deduped)


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('web/browser_train.json')
    data = json.loads(path.read_text(encoding='utf-8'))
    deduped, n_removed = dedupe_samples(data['samples'])
    print(f"{path}: {len(data['samples'])} -> {len(deduped)} samples ({n_removed} duplicates removed)")
    data['samples'] = deduped
    data['sampleCount'] = len(deduped)
    path.write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')


if __name__ == '__main__':
    main()
