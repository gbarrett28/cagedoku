# Unified digit recogniser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-extract 35 k+ guardian/observer cage-total digits as square-padded thumbnails, retrain the model, add a fast Vitest accuracy benchmark, then unify the killer extraction path (`splitNum`) to also use square-padded thumbnails.

**Architecture:** A standalone Python script migrates `.jpk` pickle caches to plain JSON, then re-extracts cage-total digits as square-padded 64×64 thumbnails using only cv2/numpy. The accuracy benchmark extends the existing `numberRecognition.test.ts` describe pattern. `splitNum` individual-digit thumbnails switch to `squarePadSrc`; the merged thumbnail (for the split-recogniser) stays tight-crop.

**Tech Stack:** Python/cv2/numpy (extraction), TypeScript/Vitest (accuracy test), OpenCV.js (runtime inference)

---

### Task 0: Migrate `.jpk` → `.json`

**Files:**
- Create: `web/migrate_pic_cache.py`

The `.jpk` files are Python pickle archives of `PicInfo` objects. All their fields
are plain numpy arrays that serialise trivially to JSON. After migration the stub
hack is not needed in the extractor.

JSON schema (`<puzzle>.json` alongside each `.jpg`):
```json
{
  "grid": [[x0,y0],[x1,y1],[x2,y2],[x3,y3]],
  "cage_totals": [[col0row0, col0row1, ...], ...],
  "border_x": [[...], ...],
  "border_y": [[...], ...],
  "brdrs": [[[...]], ...]
}
```
`cage_totals` remains column-major (`[col][row]`) to match `.jpk` access convention.

- [x] **Step 1: Create `web/migrate_pic_cache.py`**

```python
#!/usr/bin/env python3
"""
Convert guardian/observer .jpk pickle caches to plain JSON.

Usage
-----
    python web/migrate_pic_cache.py
    python web/migrate_pic_cache.py --puzzle-dirs guardian observer
    python web/migrate_pic_cache.py --delete-jpk   # remove .jpk after conversion

Each .jpk is written as <name>.json next to the original file.  Skips
puzzles that already have an up-to-date .json (mtime >= .jpk).
"""

from __future__ import annotations
import argparse
import json
import logging
import pickle
import sys
import types
from pathlib import Path

_log = logging.getLogger(__name__)


def _register_stub() -> None:
    for mod in ('killer_sudoku.image', 'killer_sudoku.image.inp_image'):
        if mod not in sys.modules:
            sys.modules[mod] = types.ModuleType(mod)

    class PicInfo:
        pass

    sys.modules['killer_sudoku.image.inp_image'].PicInfo = PicInfo  # type: ignore[attr-defined]


def migrate_one(jpk_path: Path, delete_jpk: bool = False) -> bool:
    """Convert one .jpk to .json.  Returns True if written, False if skipped."""
    json_path = jpk_path.with_suffix('.json')
    if json_path.exists() and json_path.stat().st_mtime >= jpk_path.stat().st_mtime:
        return False   # already up to date

    _register_stub()
    with open(jpk_path, 'rb') as fh:
        p = pickle.load(fh)  # noqa: S301 — our own data

    import numpy as np
    data = {
        'grid':        np.array(p.grid).tolist(),
        'cage_totals': np.array(p.cage_totals).tolist(),
        'border_x':    np.array(p.border_x).tolist(),
        'border_y':    np.array(p.border_y).tolist(),
        'brdrs':       np.array(p.brdrs).tolist(),
    }
    json_path.write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
    if delete_jpk:
        jpk_path.unlink()
    return True


def main() -> None:
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--puzzle-dirs', nargs='+', default=['guardian', 'observer'])
    parser.add_argument('--delete-jpk', action='store_true',
                        help='Delete .jpk files after successful conversion')
    args = parser.parse_args()

    repo_root = Path(__file__).parent.parent
    for dir_name in args.puzzle_dirs:
        puzzle_dir = repo_root / dir_name
        jpks = sorted(puzzle_dir.glob('*.jpk'))
        written = sum(migrate_one(p, args.delete_jpk) for p in jpks)
        _log.info('%s: %d converted, %d already up to date', dir_name, written, len(jpks) - written)


if __name__ == '__main__':
    main()
```

- [x] **Step 2: Run the migration**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku
python web/migrate_pic_cache.py --delete-jpk
```

Expected:
```
INFO guardian: 465 converted, 0 already up to date
INFO observer: 424 converted, 0 already up to date
```

- [x] **Step 3: Spot-check one converted file**

```bash
python3 -c "
import json
d = json.load(open('guardian/killer_sudoku_0.json'))
print('Keys:', list(d.keys()))
print('grid:', d['grid'])
print('cage_totals nonzero:', sum(1 for col in d['cage_totals'] for v in col if v > 0))
"
```

Expected: keys `['grid', 'cage_totals', 'border_x', 'border_y', 'brdrs']`, grid shows 4 corner points, nonzero ~30.

- [x] **Step 4: Commit**

```bash
git add web/migrate_pic_cache.py
git commit -m "feat: migrate_pic_cache.py converts .jpk to plain JSON"
```

---

### Task 1: Python helper functions + unit tests

**Files:**
- Create: `web/extract_guardian_samples.py`
- Create: `tests/test_extract_guardian_samples.py`

- [x] **Step 1: Write failing tests for pure helper functions**

Create `tests/test_extract_guardian_samples.py`:

```python
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
from extract_guardian_samples import square_pad_src, is_num_contour


def test_square_pad_src_square():
    src = square_pad_src(10, 20, 30, 30)
    np.testing.assert_allclose(src, [[10,20],[40,20],[40,50],[10,50]], atol=0.01)


def test_square_pad_src_tall():
    # bw=10, bh=30 → side=30, cx=15, cy=35
    src = square_pad_src(10, 20, 10, 30)
    np.testing.assert_allclose(src, [[0,20],[30,20],[30,50],[0,50]], atol=0.01)


def test_square_pad_src_wide():
    # bw=30, bh=10 → side=30, cx=25, cy=25
    src = square_pad_src(10, 20, 30, 10)
    np.testing.assert_allclose(src, [[10,10],[40,10],[40,40],[10,40]], atol=0.01)


def test_is_num_contour_accepts_digit_sized():
    assert is_num_contour(10, 10, subres=128) is True


def test_is_num_contour_rejects_too_narrow():
    assert is_num_contour(4, 10, subres=128) is False   # w=4 < 8


def test_is_num_contour_rejects_too_wide():
    assert is_num_contour(70, 10, subres=128) is False  # w=70 > 64


def test_is_num_contour_rejects_too_short():
    assert is_num_contour(20, 5, subres=128) is False   # h=5 < 16
```

- [x] **Step 2: Run tests — expect ImportError**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku && python -m pytest tests/test_extract_guardian_samples.py -v 2>&1 | head -10
```

Expected: `ModuleNotFoundError: No module named 'extract_guardian_samples'`

- [x] **Step 3: Create `web/extract_guardian_samples.py` with helpers only**

```python
#!/usr/bin/env python3
"""
Re-extract guardian/observer cage-total digits as square-padded 64x64 thumbnails.

Usage
-----
    python web/extract_guardian_samples.py
    python web/extract_guardian_samples.py --puzzle-dirs guardian observer
    python web/extract_guardian_samples.py --subres 128

Reads each .jpk (stored PicInfo: grid corners + cage_totals) alongside the
original .jpg, re-applies the perspective warp, extracts cage-total contours,
square-pads each digit to 64x64, and writes <dir>/<dir>_train_sq.json.
"""

from __future__ import annotations
import argparse
import json
import logging
import sys
import types
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np
from numpy.typing import NDArray

_log = logging.getLogger(__name__)

SUBRES = 128
THUMB = 64
RESOLUTION = 9 * SUBRES  # 1152


# ---------------------------------------------------------------------------
# Puzzle cache loading — prefers .json (from migrate_pic_cache.py), falls
# back to .jpk for puzzles not yet migrated.
# ---------------------------------------------------------------------------

class _PicData:
    """Minimal struct matching the PicInfo interface used by the extractor."""
    __slots__ = ('grid', 'cage_totals', 'border_x', 'border_y', 'brdrs')


def _register_stub() -> None:
    for mod in ('killer_sudoku.image', 'killer_sudoku.image.inp_image'):
        if mod not in sys.modules:
            sys.modules[mod] = types.ModuleType(mod)

    class PicInfo:
        pass

    sys.modules['killer_sudoku.image.inp_image'].PicInfo = PicInfo  # type: ignore[attr-defined]


def load_pic(jpg_path: Path) -> _PicData:
    """Load puzzle cache from .json (preferred) or .jpk fallback."""
    json_path = jpg_path.with_suffix('.json')
    if json_path.exists():
        raw = json.loads(json_path.read_text(encoding='utf-8'))
        p = _PicData()
        p.grid        = np.array(raw['grid'],        dtype=np.float32)
        p.cage_totals = np.array(raw['cage_totals'], dtype=np.int64)
        p.border_x    = np.array(raw['border_x'])
        p.border_y    = np.array(raw['border_y'])
        p.brdrs       = np.array(raw['brdrs'])
        return p

    jpk_path = jpg_path.with_suffix('.jpk')
    if jpk_path.exists():
        _register_stub()
        import pickle  # noqa: PLC0415
        with open(jpk_path, 'rb') as fh:
            return pickle.load(fh)  # noqa: S301 — our own data

    raise FileNotFoundError(f"No .json or .jpk cache for {jpg_path}")


# ---------------------------------------------------------------------------
# Pure helpers — testable without cv2 or real images
# ---------------------------------------------------------------------------

def square_pad_src(ax: float, ay: float, bw: float, bh: float) -> NDArray[np.float32]:
    """4-corner source region for a square-padded perspective warp.

    Centres the bounding rect in a square whose side = max(bw, bh).
    Returns [[TL],[TR],[BR],[BL]] in (x, y) image coordinates.
    Matches the TypeScript squarePadSrc helper exactly.
    """
    side = max(bw, bh)
    cx, cy = ax + bw / 2, ay + bh / 2
    return np.array([
        [cx - side / 2, cy - side / 2],
        [cx + side / 2, cy - side / 2],
        [cx + side / 2, cy + side / 2],
        [cx - side / 2, cy + side / 2],
    ], dtype=np.float32)


def is_num_contour(w: int, h: int, subres: int = SUBRES) -> bool:
    """True if bounding-rect dimensions match a cage-total digit glyph."""
    return (subres // 16 <= w <= subres // 2) and (subres // 8 <= h <= subres // 2)


if __name__ == '__main__':
    pass  # CLI added in Task 2
```

- [x] **Step 4: Run tests — expect 7 passing**

```bash
python -m pytest tests/test_extract_guardian_samples.py -v
```

Expected: 7 tests pass.

- [x] **Step 5: Commit**

```bash
git add web/extract_guardian_samples.py tests/test_extract_guardian_samples.py
git commit -m "feat: add square_pad_src and is_num_contour helpers for guardian extraction"
```

---

### Task 2: Full extraction implementation + run

**Files:**
- Modify: `web/extract_guardian_samples.py` (replace `if __name__ == '__main__': pass` with full pipeline)

- [x] **Step 1: Replace the stub `__main__` block with the full pipeline**

Replace the `if __name__ == '__main__': pass` at the bottom of `web/extract_guardian_samples.py` with:

```python
# ---------------------------------------------------------------------------
# Thumbnail extraction
# ---------------------------------------------------------------------------

DST64 = np.float32([[0, 0], [THUMB - 1, 0], [THUMB - 1, THUMB - 1], [0, THUMB - 1]])


def warp_thumb(
    ax: float, ay: float, bw: float, bh: float, warped: NDArray[np.uint8],
) -> NDArray[np.uint8]:
    """Extract a square-padded 64x64 thumbnail from the warped binary image."""
    src = square_pad_src(ax, ay, bw, bh)
    M = cv2.getPerspectiveTransform(src, DST64)
    thumb = cv2.warpPerspective(warped, M, (THUMB, THUMB), flags=cv2.INTER_LINEAR)
    return ((thumb > 127).astype(np.uint8) * 255)


def split_bounding_rect(
    ax: int, ay: int, bw: int, bh: int, warped: NDArray[np.uint8],
) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]] | None:
    """Split a bounding rect at the column ink-minimum for 2-digit totals."""
    margin = max(2, bw // 8)
    if bw - 2 * margin <= 0:
        return None
    strip = warped[ay: ay + bh, ax: ax + bw]
    ink = strip.sum(axis=0)
    split_x = margin + int(ink[margin: bw - margin].argmin())
    return (ax, ay, split_x, bh), (ax + split_x, ay, bw - split_x, bh)


def extract_puzzle_samples(
    jpg_path: Path,
    subres: int = SUBRES,
) -> list[tuple[int, NDArray[np.uint8]]]:
    """Extract (digit_label, 64x64_thumb) pairs from one puzzle image."""
    resolution = 9 * subres

    try:
        pic = load_pic(jpg_path)
    except Exception as exc:
        _log.warning("Cannot load cache for %s: %s -- skipping", jpg_path.name, exc)
        return []

    cage_totals: NDArray[np.int64] = np.array(pic.cage_totals, dtype=np.int64)

    img = cv2.imread(str(jpg_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        _log.warning("Cannot read %s -- skipping", jpg_path.name)
        return []

    blk = cv2.adaptiveThreshold(
        img, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 51, 7,
    )

    dst = np.float32([
        [0, 0], [resolution - 1, 0],
        [resolution - 1, resolution - 1], [0, resolution - 1],
    ])
    M = cv2.getPerspectiveTransform(np.array(pic.grid, dtype=np.float32), dst)
    warped = cv2.warpPerspective(blk, M, (resolution, resolution), flags=cv2.INTER_LINEAR)
    warped = ((warped > 127).astype(np.uint8) * 255)

    contours_raw, _ = cv2.findContours(warped, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Group contours by cell; keep only cage-total sized ones in the top half.
    cell_brs: dict[tuple[int, int], list[tuple[int, int, int, int]]] = {}
    for cnt in contours_raw:
        x, y, w, h = cv2.boundingRect(cnt)
        if not is_num_contour(w, h, subres):
            continue
        if y % subres >= subres // 2:      # cage totals are in the upper half of the cell
            continue
        col, row = x // subres, y // subres
        if not (0 <= col < 9 and 0 <= row < 9):
            continue
        cell_brs.setdefault((col, row), []).append((x, y, w, h))

    samples: list[tuple[int, NDArray[np.uint8]]] = []

    for (col, row), brs in cell_brs.items():
        total = int(cage_totals[col, row])   # cage_totals is column-major [col][row]
        if total == 0:
            continue
        total_str = str(total)
        brs_sorted = sorted(brs, key=lambda b: b[0])   # left-to-right

        if len(brs_sorted) == len(total_str):
            pairs = list(zip(total_str, brs_sorted))
        elif len(brs_sorted) == 1 and len(total_str) == 2:
            ax, ay, bw, bh = brs_sorted[0]
            split = split_bounding_rect(ax, ay, bw, bh, warped)
            if split is None:
                _log.debug("Cannot split %s at col=%d row=%d -- skipping", jpg_path.name, col, row)
                continue
            pairs = list(zip(total_str, split))
        else:
            _log.debug(
                "%s col=%d row=%d: %d contours for total=%d -- skipping",
                jpg_path.name, col, row, len(brs_sorted), total,
            )
            continue

        for digit_char, (ax, ay, bw, bh) in pairs:
            if bw == 0 or bh == 0:
                continue
            thumb = warp_thumb(ax, ay, bw, bh, warped)
            samples.append((int(digit_char), thumb))

    return samples


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def extract_directory(
    puzzle_dir: Path,
    subres: int = SUBRES,
) -> list[tuple[int, NDArray[np.uint8]]]:
    """Extract samples from all .jpg/.jpk pairs in puzzle_dir."""
    jpgs = sorted(puzzle_dir.glob("*.jpg"))
    all_samples: list[tuple[int, NDArray[np.uint8]]] = []
    skipped = 0

    for jpg in jpgs:
        if not jpg.with_suffix('.json').exists() and not jpg.with_suffix('.jpk').exists():
            skipped += 1
            continue
        samples = extract_puzzle_samples(jpg, subres)
        all_samples.extend(samples)

    _log.info(
        "%s: %d puzzles, %d skipped (no .jpk), %d samples extracted",
        puzzle_dir.name, len(jpgs), skipped, len(all_samples),
    )
    return all_samples


def write_training_json(
    samples: list[tuple[int, NDArray[np.uint8]]],
    out_path: Path,
) -> None:
    """Write samples to browser_train.json-compatible JSON."""
    data = {
        "version": 1,
        "puzzleType": "killer",
        "subres": SUBRES,
        "thumbnailSize": THUMB,
        "exportedAt": datetime.now(UTC).isoformat(),
        "sampleCount": len(samples),
        "samples": [
            {"digit": digit, "pixels": img.ravel().tolist()}
            for digit, img in samples
        ],
    }
    out_path.write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
    _log.info("Wrote %d samples to %s", len(samples), out_path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        '--puzzle-dirs', nargs='+', default=['guardian', 'observer'], metavar='DIR',
        help='Puzzle directories relative to repo root (default: guardian observer)',
    )
    parser.add_argument('--subres', type=int, default=SUBRES,
                        help=f'Pixels per cell side (default: {SUBRES})')
    args = parser.parse_args()

    repo_root = Path(__file__).parent.parent
    for dir_name in args.puzzle_dirs:
        puzzle_dir = repo_root / dir_name
        if not puzzle_dir.is_dir():
            _log.warning("Directory not found: %s -- skipping", puzzle_dir)
            continue
        samples = extract_directory(puzzle_dir, args.subres)
        if not samples:
            _log.warning("No samples extracted from %s", dir_name)
            continue
        out_path = puzzle_dir / f"{dir_name}_train_sq.json"
        write_training_json(samples, out_path)


if __name__ == '__main__':
    main()
```

- [x] **Step 2: Run existing unit tests to confirm helpers still pass**

```bash
python -m pytest tests/test_extract_guardian_samples.py -v
```

Expected: 7 tests pass.

- [x] **Step 3: Run the extraction**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku
python web/extract_guardian_samples.py
```

Expected (approximate):
```
INFO guardian: 465 puzzles, 0 skipped (no .jpk), ~20000 samples extracted
INFO Wrote ~20000 samples to guardian/guardian_train_sq.json
INFO observer: 424 puzzles, 0 skipped (no .jpk), ~18000 samples extracted
INFO Wrote ~18000 samples to observer/observer_train_sq.json
```

Flag if either directory reports fewer than 15 000 samples.

- [x] **Step 4: Spot-check digit distribution**

```bash
python3 -c "
import json
from collections import Counter
for f in ['guardian/guardian_train_sq.json', 'observer/observer_train_sq.json']:
    d = json.load(open(f))
    digits = Counter(s['digit'] for s in d['samples'])
    print(f'{f}: {d[\"sampleCount\"]} samples  digits={dict(sorted(digits.items()))}')
"
```

Expected: all digits 1–9 present, reasonable distribution.

- [x] **Step 5: Commit**

```bash
git add web/extract_guardian_samples.py tests/test_extract_guardian_samples.py
git commit -m "feat: full extract_guardian_samples.py pipeline -- square-padded re-extraction"
```

(Use `git add -u` if Task 1 already staged the file.)

---

### Task 3: Guardian accuracy describe block

**Files:**
- Modify: `web/src/image/numberRecognition.test.ts`

- [ ] **Step 1: Add `existsSync` to the import**

In `web/src/image/numberRecognition.test.ts`, change:

```typescript
import { readFileSync } from 'node:fs';
```

To:

```typescript
import { existsSync, readFileSync } from 'node:fs';
```

- [ ] **Step 2: Append guardian describe block at end of file**

```typescript
describe('digit recogniser — guardian square-padded samples', () => {
  it('achieves 100% accuracy on guardian_train_sq.json', () => {
    const path = join(process.cwd(), '..', 'guardian', 'guardian_train_sq.json');
    if (!existsSync(path)) {
      console.log('\n  guardian_train_sq.json not found — run extract_guardian_samples.py first');
      return;
    }
    const trainFile: TrainingFile = JSON.parse(readFileSync(path, 'utf-8'));
    const { correct, total, errors } = runOnSamples(trainFile.samples);
    const pct = ((correct / total) * 100).toFixed(1);
    if (errors.length > 0) {
      console.error(`\nGuardian mispredictions (${errors.length}/${total}):`);
      errors.forEach(e => console.error('  ' + e));
    }
    console.log(`\nGuardian accuracy: ${correct}/${total} (${pct}%)`);
    expect(correct, `Expected 100%; failures:\n${errors.join('\n')}`).toBe(total);
  });
});
```

- [ ] **Step 3: Run — note whether it passes or fails with current model**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku/web && npx vitest run src/image/numberRecognition.test.ts 2>&1 | tail -15
```

The guardian test may fail here if the current model (tight-crop synthetic) doesn't achieve 100% on square-padded thumbnails. Record the failure count. Proceed regardless — the retrain in Task 4 fixes it.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku
git add web/src/image/numberRecognition.test.ts
git commit -m "test: guardian accuracy benchmark in numberRecognition.test.ts"
```

---

### Task 4: Local retrain + verify 100%

**Files:**
- Modify: `web/public/num_recogniser.bin`, `web/public/num_recogniser.json` (generated)

- [ ] **Step 1: Retrain**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku
python web/train_recogniser.py \
  --browser-weight 1000 --svm-c 100 \
  guardian/guardian_train_sq.json \
  observer/observer_train_sq.json \
  web/browser_train.json
```

Expected: completes in a few minutes, prints model saved to `web/public/`.

- [ ] **Step 2: Run accuracy test**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku/web && npx vitest run src/image/numberRecognition.test.ts
```

Expected: all tests pass including the guardian describe block (100% accuracy).

If guardian test fails: inspect mispredictions printed to console, re-examine the extraction output. Do not proceed until 100%.

- [ ] **Step 3: Commit the retrained model**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku
git add web/public/num_recogniser.bin web/public/num_recogniser.json
git commit -m "chore: retrain digit recogniser with square-padded guardian/observer base data"
```

---

### Task 5: `splitNum` square-padding

**Files:**
- Modify: `web/src/image/numberRecognition.ts`

- [ ] **Step 1: Add `sqThumb` for single-digit paths**

In `splitNum` (around line 515), after `mergedThumb` is created, add `sqThumb` and update both single-digit returns:

Replace:
```typescript
  const fullSrc = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const mergedThumb = getWarpFromRect(cv, fullSrc, warpedBlk);

  if (splitRec === undefined) return [[mergedThumb], mergedThumb, x, y];

  const [result] = recognise(splitRec, [mergedThumb]);
  if (result!.label !== 2) return [[mergedThumb], mergedThumb, x, y];
```

With:
```typescript
  const fullSrc = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const mergedThumb = getWarpFromRect(cv, fullSrc, warpedBlk);
  const sqThumb = getWarpFromRect(cv, squarePadSrc(x, y, w, h), warpedBlk);

  if (splitRec === undefined) return [[sqThumb], mergedThumb, x, y];

  const [result] = recognise(splitRec, [mergedThumb]);
  if (result!.label !== 2) return [[sqThumb], mergedThumb, x, y];
```

- [ ] **Step 2: Square-pad confidence candidate thumbnails**

Replace (the two lines inside the candidates loop):
```typescript
      allThumbs.push(getWarpFromRect(cv, lSrc, warpedBlk));
      allThumbs.push(getWarpFromRect(cv, rSrc, warpedBlk));
```

With:
```typescript
      allThumbs.push(getWarpFromRect(cv, squarePadSrc(x,      y, sp,     h), warpedBlk));
      allThumbs.push(getWarpFromRect(cv, squarePadSrc(x + sp, y, w - sp, h), warpedBlk));
```

- [ ] **Step 3: Square-pad confidence-based two-digit return**

Replace:
```typescript
      const lSrc = [[x, y], [x + bestSplit, y], [x + bestSplit, y + h], [x, y + h]];
      const rSrc = [[x + bestSplit, y], [x + w, y], [x + w, y + h], [x + bestSplit, y + h]];
      return [
        [getWarpFromRect(cv, lSrc, warpedBlk), getWarpFromRect(cv, rSrc, warpedBlk)],
        mergedThumb, x, y,
      ];
```

With:
```typescript
      return [
        [
          getWarpFromRect(cv, squarePadSrc(x,             y, bestSplit,     h), warpedBlk),
          getWarpFromRect(cv, squarePadSrc(x + bestSplit, y, w - bestSplit, h), warpedBlk),
        ],
        mergedThumb, x, y,
      ];
```

- [ ] **Step 4: Square-pad ink-projection fallback return**

Replace:
```typescript
  const lSrc = [[x, y], [x + splitCol, y], [x + splitCol, y + h], [x, y + h]];
  const rSrc = [[x + splitCol, y], [x + w, y], [x + w, y + h], [x + splitCol, y + h]];
  return [
    [getWarpFromRect(cv, lSrc, warpedBlk), getWarpFromRect(cv, rSrc, warpedBlk)],
    mergedThumb, x, y,
  ];
```

With:
```typescript
  return [
    [
      getWarpFromRect(cv, squarePadSrc(x,            y, splitCol,     h), warpedBlk),
      getWarpFromRect(cv, squarePadSrc(x + splitCol, y, w - splitCol, h), warpedBlk),
    ],
    mergedThumb, x, y,
  ];
```

- [ ] **Step 5: TypeScript check**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku && npx tsc --noEmit -p web/tsconfig.json 2>&1 | grep error
```

Expected: no output.

- [ ] **Step 6: Full test suite**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku/web && npx vitest run 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku
git add web/src/image/numberRecognition.ts
git commit -m "feat: splitNum uses square-padded thumbnails for individual digit classification"
```

---

### Task 6: Cleanup + docs

**Files:**
- Delete: `guardian_train.json` (repo root)
- Modify: `docs/image-pipeline.md`

- [ ] **Step 1: Delete superseded training file**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku && git rm guardian_train.json
```

- [ ] **Step 2: Update Stage 5 in `docs/image-pipeline.md`**

Locate and replace in `docs/image-pipeline.md`:

```
Each digit thumbnail is a 64×64 binary uint8 image produced by `splitNum`.  Wide
bounding boxes (two adjacent digits merged in the contour tree) are split at the peak
of the column profile before classification.
```

With:

```
Each digit thumbnail is a 64×64 binary uint8 image produced by `splitNum` using
square-padded extraction — the digit is centred in a square canvas before warping,
preserving natural aspect ratio for HOG features (see Classic digit reading below).
Wide bounding boxes (two adjacent digits merged in the contour tree) are split at the
column-profile minimum; each half is square-padded individually.  The pre-split merged
thumbnail (fed to the split-recogniser to decide 1-vs-2 digits) remains tight-crop.
```

- [ ] **Step 3: Commit**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku
git add docs/image-pipeline.md
git commit -m "chore: delete superseded guardian_train.json; update Stage 5 docs"
```

---

### Task 7: Bronze gate + push

- [ ] **Step 1: Run bronze gate**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku && bash scripts/run-bronze-gate.sh
```

Expected: tsc clean, all tests pass, token created.

- [ ] **Step 2: Push feature branch**

```bash
git push -u origin feature/unified-digit-recogniser
```
