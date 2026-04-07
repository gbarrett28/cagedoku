# Classic Sudoku Recognition Implementation Plan

**Goal:** Extend the image pipeline to recognise classic (non-killer) sudoku puzzles end-to-end, locking given digits as fixed cells and hiding the cage overlay in the UI.

**Architecture:** Puzzle type detection (classic vs killer) is size-based, using the existing `scan_cells` output. Classic puzzles skip border detection entirely and use deterministic row cages. Given digits travel outside `PuzzleSpec` as a separate array applied at confirm time as pre-fixed cells.

**Tech Stack:** OpenCV, numpy, existing `CayenneNumber` PCA+KNN recogniser, FastAPI/Pydantic, TypeScript.

---

### Task 1: Add `classic_digit_threshold` to `CellScanConfig` + `detect_puzzle_type`

**Files:**
- Modify: `killer_sudoku/image/config.py:129-149`
- Modify: `killer_sudoku/image/cell_scan.py:1-21` (imports/top)
- Modify: `killer_sudoku/image/cell_scan.py` (new function after `scan_cells`)

- [ ] **Step 1: Add `classic_digit_threshold` to `CellScanConfig`**

In `killer_sudoku/image/config.py`, add a new field after `anchor_confidence_threshold` (line 149):

```python
    classic_digit_threshold: float = 10.0
    """Minimum sum of classic_digit_confidence to classify a puzzle as classic.

    A typical classic puzzle has 20-35 given digits (each scoring 1.0);
    a killer puzzle has none.  A threshold of 10.0 gives wide margin.
    """
```

- [ ] **Step 2: Add `Literal` import to `cell_scan.py`**

In `killer_sudoku/image/cell_scan.py`, add `Literal` to the `typing` import:

```python
from typing import Literal
```

- [ ] **Step 3: Add `detect_puzzle_type` function to `cell_scan.py`**

Add after `scan_cells` (currently ending at line ~112):

```python
def detect_puzzle_type(
    classic_conf: npt.NDArray[np.float64],
    threshold: float,
) -> Literal["killer", "classic"]:
    """Classify a puzzle as classic or killer from cell-scan confidence.

    Sums classic_digit_confidence across all 81 cells.  A classic puzzle
    typically has 20-35 given digits (confidence 1.0 each); a killer has
    none.

    Args:
        classic_conf: (9, 9) float array from scan_cells.
        threshold: Minimum sum to classify as classic (default 10.0).

    Returns:
        "classic" if sum(classic_conf) > threshold, else "killer".
    """
    return "classic" if float(classic_conf.sum()) > threshold else "killer"
```

- [ ] **Step 4: Run bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/image/config.py killer_sudoku/image/cell_scan.py
python -m mypy --strict killer_sudoku/image/config.py killer_sudoku/image/cell_scan.py
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add killer_sudoku/image/config.py killer_sudoku/image/cell_scan.py
git commit -m "feat: add classic_digit_threshold to CellScanConfig + detect_puzzle_type

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Add `read_classic_digits` to `number_recognition.py`

**Files:**
- Modify: `killer_sudoku/image/number_recognition.py` (add function after existing helpers)

- [ ] **Step 1: Write the failing test**

Create `tests/image/test_classic_digits.py`:

```python
"""Tests for read_classic_digits in number_recognition."""
from __future__ import annotations

from typing import cast
from unittest.mock import MagicMock

import numpy as np
import numpy.typing as npt

from killer_sudoku.image.number_recognition import read_classic_digits


def _blank_warped(subres: int = 32) -> npt.NDArray[np.uint8]:
    return np.zeros((subres * 9, subres * 9), dtype=np.uint8)


def _make_recogniser(digit: int) -> MagicMock:
    rec = MagicMock()
    rec.get_sums.return_value = np.array([digit], dtype=np.intp)
    return rec


class TestReadClassicDigits:
    def test_empty_conf_returns_zeros(self) -> None:
        warped_blk = _blank_warped()
        classic_conf = np.zeros((9, 9), dtype=np.float64)
        result = read_classic_digits(warped_blk, _make_recogniser(0), 32, classic_conf)
        assert result.shape == (9, 9)
        assert not np.any(result)

    def test_single_cell_with_contour_calls_recogniser(self) -> None:
        subres = 32
        half = subres // 2
        warped_blk = _blank_warped(subres)
        # Draw a white square (contour) in centre of cell (0, 0)
        y0 = 0 * subres + subres // 4
        x0 = 0 * subres + subres // 4
        warped_blk[y0 + 4 : y0 + half - 4, x0 + 4 : x0 + half - 4] = 255

        classic_conf = np.zeros((9, 9), dtype=np.float64)
        classic_conf[0, 0] = 1.0
        rec = _make_recogniser(5)
        result = read_classic_digits(warped_blk, rec, subres, classic_conf)
        assert result[0, 0] == 5
        assert rec.get_sums.called

    def test_cell_with_no_contour_stays_zero(self) -> None:
        subres = 32
        warped_blk = _blank_warped(subres)
        classic_conf = np.zeros((9, 9), dtype=np.float64)
        classic_conf[1, 1] = 1.0  # No ink pixels → no contour
        result = read_classic_digits(warped_blk, _make_recogniser(7), subres, classic_conf)
        assert result[1, 1] == 0

    def test_zero_confidence_cell_skipped(self) -> None:
        subres = 32
        half = subres // 2
        warped_blk = _blank_warped(subres)
        # Draw ink in cell (2, 3)
        y0 = 2 * subres + subres // 4
        x0 = 3 * subres + subres // 4
        warped_blk[y0 + 4 : y0 + half - 4, x0 + 4 : x0 + half - 4] = 255
        classic_conf = np.zeros((9, 9), dtype=np.float64)
        # classic_conf[2, 3] = 0.0 — should not call recogniser
        rec = _make_recogniser(3)
        result = read_classic_digits(warped_blk, rec, subres, classic_conf)
        assert result[2, 3] == 0
        assert not rec.get_sums.called
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/image/test_classic_digits.py -v
```

Expected: `ImportError` — `read_classic_digits` not yet defined.

- [ ] **Step 3: Add `read_classic_digits` to `number_recognition.py`**

Add after the last top-level function. The function also needs `cv2` which is already imported. Add `get_warp_from_rect` which is already in the same file.

```python
def read_classic_digits(
    warped_blk: npt.NDArray[np.uint8],
    num_recogniser: CayenneNumber,
    subres: int,
    classic_conf: npt.NDArray[np.float64],
) -> npt.NDArray[np.intp]:
    """Read pre-filled digits from the centre of each cell.

    For each cell flagged by classic_conf, extracts the central half-cell
    crop of the warped binary image, finds the largest contour, warps its
    bounding rect to canonical size, and passes it to the digit recogniser.

    Args:
        warped_blk: Warped binary image (ink=white, background=black).
        num_recogniser: Loaded digit classifier.
        subres: Pixels per cell side in warped_blk.
        classic_conf: (9, 9) array from scan_cells; > 0 means cell has a digit.

    Returns:
        (9, 9) int array of given digits (0 for empty or unrecognised cells).
    """
    half = subres // 2
    given_digits = np.zeros((9, 9), dtype=np.intp)
    for r in range(9):
        for c in range(9):
            if classic_conf[r, c] == 0.0:
                continue
            y0 = r * subres + subres // 4
            x0 = c * subres + subres // 4
            patch: npt.NDArray[np.uint8] = warped_blk[y0 : y0 + half, x0 : x0 + half]
            cnts_raw: Any
            cnts_raw, _ = cv2.findContours(
                patch, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
            )
            if not cnts_raw:
                continue
            largest = max(
                (np.asarray(cnt, dtype=np.int32) for cnt in cnts_raw),
                key=cv2.contourArea,
            )
            bx, by, bw, bh = cv2.boundingRect(largest)
            if bw == 0 or bh == 0:
                continue
            ax, ay = x0 + bx, y0 + by
            rect = np.array(
                [[ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh]],
                dtype=np.float32,
            )
            thumb = get_warp_from_rect(rect, warped_blk, res=(half, half))
            labels = num_recogniser.get_sums([thumb])
            d = int(labels[0])
            if d > 0:
                given_digits[r, c] = d
    return given_digits
```

Note: `Any` is already imported at the top of `number_recognition.py`.

- [ ] **Step 4: Run tests**

```bash
python -m pytest tests/image/test_classic_digits.py -v
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/image/number_recognition.py tests/image/test_classic_digits.py
python -m mypy --strict killer_sudoku/image/number_recognition.py
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add killer_sudoku/image/number_recognition.py tests/image/test_classic_digits.py
git commit -m "feat: add read_classic_digits to number_recognition

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Add `puzzle_type`/`given_digits` to `InpImage`, restructure `__init__`

**Files:**
- Modify: `killer_sudoku/image/inp_image.py:1-42` (imports)
- Modify: `killer_sudoku/image/inp_image.py:83-263` (`__init__` body)

- [ ] **Step 1: Add `Literal` to imports in `inp_image.py`**

Change `from typing import Any` to:

```python
from typing import Any, Literal
```

Also add `detect_puzzle_type` to the `cell_scan` import:

```python
from killer_sudoku.image.cell_scan import detect_puzzle_type, scan_cells
```

Also add `read_classic_digits` to the `number_recognition` import:

```python
from killer_sudoku.image.number_recognition import (
    CayenneNumber,
    contour_hier,
    get_num_contours,
    get_warp_from_rect,
    load_number_recogniser,
    read_classic_digits,
    split_num,
)
```

- [ ] **Step 2: Add `puzzle_type` and `given_digits` attributes to `InpImage.__init__` — fresh path**

The fresh-processing path starts after the cache check (`self.info = PicInfo()`). Restructure it as follows.

The current structure (lines ~109-263) is:
```
self.info = PicInfo()
blk, self.info.grid = locate_grid(...)
# build m (perspective transform)
self.info.border_x, ... = self._identify_borders(...)
self.info.brdrs = _borders_to_brdrs(...)
warped_blk = cv2.warpPerspective(blk, ...)
self.warped_img = cv2.warpPerspective(img, ...)
if poc_border_clustering: ...
self.spec = None; self.spec_error = None
try:
    cage_totals = self._build_cage_totals(...)
    ...
    self.spec = validate_cage_layout(...)
except ...: self.spec_error = str(exc)
```

Replace with:

```python
        self.info = PicInfo()

        blk, self.info.grid = locate_grid(gry, img, config.grid_location)

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
            cv2.getPerspectiveTransform(self.info.grid, dst_size), dtype=np.float64
        )

        # Warp blk, gry, and img now so scan_cells can run before border detection.
        warped_blk: npt.NDArray[np.uint8] = np.asarray(
            cv2.warpPerspective(
                blk, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
            dtype=np.uint8,
        )
        warped_gry: npt.NDArray[np.uint8] = np.asarray(
            cv2.warpPerspective(
                gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
            dtype=np.uint8,
        )
        self.warped_img = np.asarray(
            cv2.warpPerspective(
                img, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
            dtype=np.uint8,
        )

        # Detect puzzle type before border detection.
        _cage_conf, classic_conf = scan_cells(warped_gry, subres, config.cell_scan)
        self.puzzle_type: Literal["killer", "classic"] = detect_puzzle_type(
            classic_conf, config.cell_scan.classic_digit_threshold
        )
        self.spec = None
        self.spec_error = None

        if self.puzzle_type == "classic":
            self.given_digits: npt.NDArray[np.intp] | None = read_classic_digits(
                warped_blk, num_recogniser, subres, classic_conf
            )
            self.info.border_x = np.ones((9, 8), dtype=bool)
            self.info.border_y = np.zeros((8, 9), dtype=bool)
            self.info.brdrs = InpImage._borders_to_brdrs(
                self.info.border_x, self.info.border_y
            )
            cage_totals_classic: npt.NDArray[np.intp] = np.zeros(
                (9, 9), dtype=np.intp
            )
            for r_idx in range(9):
                cage_totals_classic[0, r_idx] = 45
            try:
                self.spec = validate_cage_layout(
                    cage_totals_classic,
                    self.info.border_x,
                    self.info.border_y,
                )
            except (ValueError, ProcessingError) as exc:
                self.spec_error = str(exc)
            return

        # Killer path: run border detection and cage-total extraction.
        self.given_digits = None
        self.info.border_x, self.info.border_y = self._identify_borders(
            gry, m, config, border_detector
        )
        self.info.brdrs = InpImage._borders_to_brdrs(
            self.info.border_x, self.info.border_y
        )

        if config.poc_border_clustering:
            poc_bx, poc_by = self._identify_borders_poc(
                gry, m, config, warped_blk, num_recogniser
            )
            diff_x = int(np.sum(poc_bx != self.info.border_x))
            diff_y = int(np.sum(poc_by != self.info.border_y))
            total = int(self.info.border_x.size + self.info.border_y.size)
            if diff_x + diff_y == 0:
                _log.info("poc_border_clustering: MATCH — all %d borders agree", total)
            else:
                _log.warning(
                    "poc_border_clustering: MISMATCH — %d/%d borders differ "
                    "(border_x: %d, border_y: %d)",
                    diff_x + diff_y,
                    total,
                    diff_x,
                    diff_y,
                )

        try:
            cage_totals = self._build_cage_totals(
                warped_blk, num_recogniser, subres, self.info.brdrs
            )

            total_sum = int(cage_totals.sum())
            if not (360 <= total_sum <= 450):
                fallback_c = config.number_recognition.contour_fallback_adaptive_c
                warped_blk = np.asarray(
                    cv2.adaptiveThreshold(
                        warped_gry,
                        255,
                        cv2.ADAPTIVE_THRESH_MEAN_C,
                        cv2.THRESH_BINARY_INV,
                        config.adaptive_block_size,
                        fallback_c,
                    ),
                    dtype=np.uint8,
                )
                cage_totals = self._build_cage_totals(
                    warped_blk, num_recogniser, subres, self.info.brdrs
                )
                total_sum = int(cage_totals.sum())

            self.info.cage_totals = cage_totals

            if total_sum < 360 or total_sum > 450:
                raise ProcessingError(
                    f"Cage totals sum to {total_sum}, expected 405",
                    cage_totals,
                    self.info.brdrs,
                )

            with open(jpk, "wb") as fh:
                pk.dump(self.info, fh)

            self.spec = validate_cage_layout(
                self.info.cage_totals, self.info.border_x, self.info.border_y
            )
        except (ValueError, ProcessingError) as exc:
            self.spec_error = str(exc)
```

Note: the original code computed a local `warped_gry` only in the fallback branch. Now `warped_gry` is always computed earlier and can be reused.

- [ ] **Step 3: Add `puzzle_type` and `given_digits` to the cached path**

In the cached path (lines ~109-140, the `if not config.rework and jpk.exists():` branch), add at the end before `return`:

```python
            # Cached data is always killer (classic puzzles are not cached).
            self.puzzle_type = "killer"
            self.given_digits = None
```

- [ ] **Step 4: Run bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/image/inp_image.py
python -m mypy --strict killer_sudoku/image/inp_image.py
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add killer_sudoku/image/inp_image.py
git commit -m "feat: detect puzzle type in InpImage, add classic branch with given_digits

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Unit tests for `detect_puzzle_type` and `InpImage` classic path

**Files:**
- Create: `tests/image/test_detect_puzzle_type.py`
- Create: `tests/fixtures/sudoku/__init__.py`
- Create: `tests/fixtures/sudoku/README.md`

- [ ] **Step 1: Create `tests/fixtures/sudoku/__init__.py`**

```python
"""Test fixture metadata for classic sudoku recognition tests."""
```

- [ ] **Step 2: Create `tests/fixtures/sudoku/README.md`**

```markdown
# Classic Sudoku Test Fixtures

Test images are NOT committed to the repository (see `.gitignore`).

To run integration tests:
1. Download three openly-licensed classic sudoku images (easy/medium/hard givens density).
2. Save as `easy.png`, `medium.png`, `hard.png` in this directory.
3. Create matching `easy_fixture.py`, `medium_fixture.py`, `hard_fixture.py` modules
   with `GIVEN_DIGITS: list[list[int]]` (9×9, 0=empty) and `SOLUTION: list[list[int]]`
   (9×9, 1–9 everywhere).
```

- [ ] **Step 3: Write tests for `detect_puzzle_type`**

Create `tests/image/test_detect_puzzle_type.py`:

```python
"""Unit tests for detect_puzzle_type in cell_scan."""
from __future__ import annotations

import numpy as np

from killer_sudoku.image.cell_scan import detect_puzzle_type


class TestDetectPuzzleType:
    def test_zero_confidence_is_killer(self) -> None:
        conf = np.zeros((9, 9), dtype=np.float64)
        assert detect_puzzle_type(conf, 10.0) == "killer"

    def test_low_confidence_sum_is_killer(self) -> None:
        conf = np.zeros((9, 9), dtype=np.float64)
        conf[0, 0] = 1.0  # sum = 1.0, below threshold 10.0
        assert detect_puzzle_type(conf, 10.0) == "killer"

    def test_high_confidence_sum_is_classic(self) -> None:
        conf = np.zeros((9, 9), dtype=np.float64)
        conf[:2, :] = 1.0  # 18 cells, sum = 18.0 > 10.0
        assert detect_puzzle_type(conf, 10.0) == "classic"

    def test_sum_exactly_at_threshold_is_killer(self) -> None:
        # Threshold is strictly greater than, so equal → killer
        conf = np.full((9, 9), 10.0 / 81.0, dtype=np.float64)
        assert abs(float(conf.sum()) - 10.0) < 0.01
        assert detect_puzzle_type(conf, 10.0) == "killer"

    def test_custom_threshold(self) -> None:
        conf = np.zeros((9, 9), dtype=np.float64)
        conf[0, 0] = 5.0
        assert detect_puzzle_type(conf, 4.0) == "classic"
        assert detect_puzzle_type(conf, 6.0) == "killer"
```

- [ ] **Step 4: Run tests**

```bash
python -m pytest tests/image/test_detect_puzzle_type.py -v
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Bronze gate + commit**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 tests/image/test_detect_puzzle_type.py
python -m mypy --strict tests/image/test_detect_puzzle_type.py
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term

git add tests/image/test_detect_puzzle_type.py tests/image/test_classic_digits.py tests/fixtures/sudoku/__init__.py tests/fixtures/sudoku/README.md
git commit -m "test: add unit tests for detect_puzzle_type and read_classic_digits

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Add `given_digits` parameter to `Grid.set_up`

**Files:**
- Modify: `killer_sudoku/solver/grid.py:351-386`

- [ ] **Step 1: Write failing test**

Add to `tests/solver/test_grid.py` (or create if it doesn't exist):

```python
def test_set_up_with_given_digits_reduces_sq_poss() -> None:
    """Given digits pre-fix cells to singletons before solving."""
    from killer_sudoku.image.validation import validate_cage_layout
    import numpy as np

    # Simple 1-cage killer spec — just needs to be valid
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    cage_totals[0, 0] = 45  # 9-cell row cage
    border_x = np.zeros((9, 8), dtype=bool)
    border_y = np.zeros((8, 9), dtype=bool)
    # Single cage covering entire first row — make it 9 cells = row 0
    border_x[:, 0] = True   # wall below row 0 at all columns

    # Actually use the classic row-cage layout to keep the test simple
    border_x_classic = np.ones((9, 8), dtype=bool)
    border_y_classic = np.zeros((8, 9), dtype=bool)
    cage_totals_classic = np.zeros((9, 9), dtype=np.intp)
    for r in range(9):
        cage_totals_classic[0, r] = 45
    spec = validate_cage_layout(cage_totals_classic, border_x_classic, border_y_classic)

    given = np.zeros((9, 9), dtype=np.intp)
    given[0, 0] = 7  # cell (0,0) is pre-fixed to 7

    grd = Grid()
    grd.set_up(spec, given_digits=given)

    assert grd.sq_poss[0][0] == {7}, "Given digit should reduce sq_poss to singleton"
    assert len(grd.sq_poss[0][1]) == 9, "Other cells should still have all candidates"
```

- [ ] **Step 2: Run to verify it fails**

```bash
python -m pytest tests/solver/test_grid.py::test_set_up_with_given_digits_reduces_sq_poss -v
```

Expected: FAIL — `set_up()` does not accept `given_digits` keyword argument.

- [ ] **Step 3: Add `given_digits` parameter to `Grid.set_up`**

In `killer_sudoku/solver/grid.py`, replace the `set_up` signature and add post-setup logic:

```python
    def set_up(
        self,
        spec: PuzzleSpec,
        given_digits: npt.NDArray[np.intp] | None = None,
    ) -> None:
        """Populate cage structure and equations from a validated PuzzleSpec.

        Takes the pre-validated PuzzleSpec produced by validate_cage_layout:
        cage regions have already been flood-filled and all consistency checks
        have been applied. This method renders the borders and cage totals onto
        the solution image, then builds the equation list for solving.

        Args:
            spec: Validated puzzle specification from validate_cage_layout.
            given_digits: Optional (9, 9) array of pre-fixed digits (0 = empty).
                If provided, each non-zero cell is reduced to a singleton set
                before solving begins, fixing those cells as givens.
        """
        brdrs = spec.brdrs
        self.sol_img.draw_borders(brdrs)
        self.region = spec.regions.copy()
        for i in range(9):
            for j in range(9):
                if spec.cage_totals[i][j] != 0:
                    self.sol_img.draw_sum(i, j, int(spec.cage_totals[i][j]))
        self.CAGES = [set() for _ in np.unique(self.region)]
        self.VALS = [0 for _ in np.unique(self.region)]
        for i in range(9):
            for j in range(9):
                idx = int(self.region[i][j]) - 1
                self.CAGES[idx].add((i, j))
                self.VALS[idx] = max(self.VALS[idx], int(spec.cage_totals[i][j]))
        self.equns = [Equation(s, 45, self) for s in ROWS + COLS + BOXS]
        self.equns += [
            Equation(s, v, self) for s, v in zip(self.CAGES, self.VALS, strict=False)
        ]
        self.DFFS = set()
        self.equns += self.add_equns(ROWS)
        self.equns += self.add_equns(COLS)
        self.equns += self.add_equns(ROWS[::-1])
        self.equns += self.add_equns(COLS[::-1])
        for b in range(len(BOXS)):
            self.equns += self.add_equns_r(box=b, cvr=set())

        if given_digits is not None:
            for r, c in (
                (r, c) for r in range(9) for c in range(9) if given_digits[r, c] > 0
            ):
                self.sq_poss[r][c] = {int(given_digits[r, c])}
```

- [ ] **Step 4: Run test**

```bash
python -m pytest tests/solver/test_grid.py::test_set_up_with_given_digits_reduces_sq_poss -v
```

Expected: PASS.

- [ ] **Step 5: Bronze gate + commit**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/solver/grid.py
python -m mypy --strict killer_sudoku/solver/grid.py
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term

git add killer_sudoku/solver/grid.py tests/solver/test_grid.py
git commit -m "feat: add given_digits parameter to Grid.set_up

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Add `puzzle_type`/`given_digits` to `PuzzleState`, update `upload_puzzle`

**Files:**
- Modify: `killer_sudoku/api/schemas.py:183-219` (`PuzzleState`)
- Modify: `killer_sudoku/api/routers/puzzle.py:665-752` (`upload_puzzle`)

- [ ] **Step 1: Add fields to `PuzzleState` in `schemas.py`**

In `PuzzleState` (schemas.py:183-219), add two fields after `virtual_cages`:

```python
    puzzle_type: Literal["killer", "classic"] = "killer"
    # Detected puzzle format. "classic" suppresses cage overlay and totals in the UI.

    given_digits: list[list[int]] | None = None
    # None for killer puzzles; 9×9 array (0=empty) of pre-fixed digits for classic.
```

- [ ] **Step 2: Update `upload_puzzle` to store `puzzle_type` and `given_digits`**

In `upload_puzzle` (puzzle.py:665-752), after `inp = InpImage(...)` is called and `spec` is resolved, update the `PuzzleState` constructor call:

```python
            state = PuzzleState(
                session_id=session_id,
                cages=cages,
                spec_data=spec_data,
                original_image_b64=original_b64,
                puzzle_type=inp.puzzle_type,
                given_digits=(
                    inp.given_digits.tolist() if inp.given_digits is not None else None
                ),
            )
```

- [ ] **Step 3: Run bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/api/schemas.py killer_sudoku/api/routers/puzzle.py
python -m mypy --strict killer_sudoku/api/schemas.py killer_sudoku/api/routers/puzzle.py
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add killer_sudoku/api/schemas.py killer_sudoku/api/routers/puzzle.py
git commit -m "feat: add puzzle_type and given_digits to PuzzleState; populate in upload_puzzle

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Update `confirm_puzzle` and `undo_move`

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py:830-873` (`confirm_puzzle`)
- Modify: `killer_sudoku/api/routers/puzzle.py:1027-1049` (`undo_move`)

- [ ] **Step 1: Update `confirm_puzzle`**

Replace the body of `confirm_puzzle` (puzzle.py:830-873) with:

```python
        state = store.load(session_id)
        # ... (keep existing 404 and 409 guards unchanged)

        spec = _cage_states_to_spec(state.cages, state.spec_data)
        grd = Grid()
        try:
            given = (
                np.array(state.given_digits, dtype=np.intp)
                if state.given_digits is not None
                else None
            )
            grd.set_up(spec, given_digits=given)
            alts_sum, _ = grd.engine_solve()
        except (AssertionError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        if alts_sum != 81:
            grd.cheat_solve()

        golden: list[list[int]] = [
            [
                int(next(iter(grd.sq_poss[r][c]))) if len(grd.sq_poss[r][c]) == 1 else 0
                for c in range(9)
            ]
            for r in range(9)
        ]

        # Build initial user_grid: zeros for killer, given digits pre-filled for classic.
        user_grid: list[list[int]] = [[0] * 9 for _ in range(9)]
        given_turns: list[Turn] = []
        if state.given_digits is not None:
            for r in range(9):
                for c in range(9):
                    d = state.given_digits[r][c]
                    if d > 0:
                        user_grid[r][c] = d
                        given_turns.append(
                            Turn(
                                user_action=UserAction(
                                    type="place_digit",
                                    row=r,
                                    col=c,
                                    digit=d,
                                    source="given",
                                ),
                                auto_mutations=[],
                            )
                        )

        updated = state.model_copy(
            update={
                "golden_solution": golden,
                "user_grid": user_grid,
                "history": given_turns,
            }
        )
        always_apply = frozenset(settings_store.load().always_apply_rules)
        _board, _engine = _build_engine(updated, always_apply)
        store.save(updated)
        return updated
```

Note: `Turn`, `UserAction`, and `AutoMutation` are already imported in `puzzle.py`. Verify with `grep` if `AutoMutation` needs importing (it's used by `Turn`).

- [ ] **Step 2: Update `undo_move` to guard given digits**

In `undo_move` (puzzle.py:1027-1049), add a guard before popping history:

```python
        if not state.history:
            raise HTTPException(status_code=409, detail="Nothing to undo")

        if state.history[-1].user_action.source == "given":
            raise HTTPException(status_code=409, detail="Nothing to undo")

        trimmed = state.model_copy(update={"history": state.history[:-1]})
        # ... (rest unchanged)
```

- [ ] **Step 3: Check `Turn` and `UserAction` imports in `puzzle.py`**

```bash
grep -n "from killer_sudoku.api.schemas import" killer_sudoku/api/routers/puzzle.py | head -5
```

Verify `Turn` and `UserAction` are imported. If not, add them to the schemas import line.

- [ ] **Step 4: Run bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/api/routers/puzzle.py
python -m mypy --strict killer_sudoku/api/routers/puzzle.py
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add killer_sudoku/api/routers/puzzle.py
git commit -m "feat: confirm_puzzle pre-fills given digits; undo_move guards source=given

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Update `main.ts` and `index.html` for classic UI

**Files:**
- Modify: `killer_sudoku/static/main.ts:80-88` (`PuzzleState` interface)
- Modify: `killer_sudoku/static/main.ts:285-374` (cage overlay + totals sections)
- Modify: `killer_sudoku/static/index.html:43` (review panel heading)

- [ ] **Step 1: Add `puzzle_type` to the `PuzzleState` TypeScript interface**

In `main.ts`, find the `PuzzleState` interface (line 80-88) and add `puzzle_type`:

```typescript
interface PuzzleState {
  session_id: string;
  cages: CageState[];
  spec_data: PuzzleSpecData;
  original_image_b64: string;
  golden_solution: number[][] | null;
  user_grid: number[][] | null;
  move_history: MoveRecord[];
  puzzle_type: "killer" | "classic";
}
```

- [ ] **Step 2: Suppress cage overlay for classic puzzles**

In `drawGrid`, the cage-boundary drawing section is lines 285-318:

```typescript
  // 2. Cage boundaries in red — ...
  ctx.strokeStyle = "#cc0000";
  ctx.lineWidth = 7.5;
  const reg = state.spec_data.regions;  // [9][9]
  // ... (horizontal walls loop, vertical walls loop)
```

Wrap the entire section (lines 285-318) in a classic guard:

```typescript
  // 2. Cage boundaries in red (killer only)
  if (state.puzzle_type !== "classic") {
    ctx.strokeStyle = "#cc0000";
    ctx.lineWidth = 7.5;
    const reg = state.spec_data.regions;

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 9; c++) {
        if ((reg[r]?.[c] ?? 0) !== (reg[r + 1]?.[c] ?? 0)) {
          const y = MARGIN + (r + 1) * CELL;
          ctx.beginPath();
          ctx.moveTo(MARGIN + c * CELL, y);
          ctx.lineTo(MARGIN + (c + 1) * CELL, y);
          ctx.stroke();
        }
      }
    }

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 8; c++) {
        if ((reg[r]?.[c] ?? 0) !== (reg[r]?.[c + 1] ?? 0)) {
          const x = MARGIN + (c + 1) * CELL;
          ctx.beginPath();
          ctx.moveTo(x, MARGIN + r * CELL);
          ctx.lineTo(x, MARGIN + (r + 1) * CELL);
          ctx.stroke();
        }
      }
    }
  }
```

- [ ] **Step 3: Suppress cage totals for classic puzzles**

The cage totals section is lines 357-374:

```typescript
  // 6. Cage totals (killer only)
  if (state.puzzle_type !== "classic") {
    ctx.fillStyle = "#000";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const headCells = state.spec_data.cage_totals;
    const regions = state.spec_data.regions;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if ((headCells[r]?.[c] ?? 0) > 0) {
          const cageIdx = (regions[r]?.[c] ?? 1) - 1;
          const cage = state.cages[cageIdx];
          const total = cage !== undefined ? cage.total : headCells[r][c];
          ctx.fillText(String(total), MARGIN + c * CELL + 2, MARGIN + r * CELL + 2);
        }
      }
    }
  }
```

- [ ] **Step 4: Render given digits in a distinct style**

In the user-entered digits section (lines 376-388), change the color for given digits. Given digits have `source == "given"` in `move_history`. Add a helper and use it:

Add just before the digit rendering loop (after `if (state.user_grid !== null) {`):

```typescript
    // Build a set of "given" cell keys for classic puzzles.
    const givenCells = new Set<string>();
    if (state.puzzle_type === "classic") {
      for (const m of state.move_history) {
        if ((m as { source?: string }).source === "given") {
          givenCells.add(`${m.row - 1},${m.col - 1}`);
        }
      }
    }
```

Then in the digit rendering loop, vary the color:

```typescript
        if (digit > 0) {
          const isGiven = givenCells.has(`${r},${c}`);
          ctx.fillStyle = isGiven ? "#000" : "#2563eb";
          ctx.fillText(
            String(digit),
            MARGIN + c * CELL + CELL / 2,
            MARGIN + r * CELL + CELL / 2
          );
        }
```

Note: `MoveRecord` likely doesn't have `source` in its TypeScript type. The cast `(m as { source?: string })` handles this without breaking the existing type.

Actually, check whether `MoveRecord` already has `source` in `main.ts`. If not, add it:

```typescript
interface MoveRecord {
  row: number;
  col: number;
  digit: number;
  prev_digit: number;
  source?: string;
}
```

- [ ] **Step 5: Update confirm-panel heading in `index.html`**

In `index.html` line 43, change the heading to include puzzle type dynamically. Add an `id` to the heading:

```html
        <h2 id="detected-layout-heading">Detected Layout</h2>
```

In `main.ts`, in the function that populates the review panel (find where `review-panel` is shown and `drawGrid` is called for review), add after displaying the state:

```typescript
  const heading = document.getElementById("detected-layout-heading");
  if (heading !== null) {
    heading.textContent =
      state.puzzle_type === "classic"
        ? "Detected Layout — Classic Sudoku"
        : "Detected Layout — Killer Sudoku";
  }
```

Find the location by searching for where `review-panel` is unhidden and `drawGrid` is called (approximately line 451-452 in `main.ts`).

- [ ] **Step 6: Compile TypeScript**

```bash
tsc
```

Expected: no errors, `killer_sudoku/static/main.js` generated.

- [ ] **Step 7: Bronze gate + commit**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term

git add killer_sudoku/static/main.ts killer_sudoku/static/index.html
git commit -m "feat: suppress cage overlay/totals for classic sudoku in UI

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `detect_puzzle_type` using `classic_digit_confidence` sum | Task 1 |
| `classic_digit_threshold` in `CellScanConfig` | Task 1 |
| `read_classic_digits` in `number_recognition.py` | Task 2 |
| `InpImage.puzzle_type` + `InpImage.given_digits` attributes | Task 3 |
| Classic branch skips `_identify_borders`, uses deterministic borders | Task 3 |
| `validate_cage_layout` called with 9 row-cages (sum=45) for classic | Task 3 |
| `Grid.set_up` accepts `given_digits` | Task 5 |
| `PuzzleState.puzzle_type` + `PuzzleState.given_digits` | Task 6 |
| `upload_puzzle` stores puzzle type and given digits | Task 6 |
| `confirm_puzzle` pre-fills user_grid for classic, adds given turns to history | Task 7 |
| `undo_move` guards against undoing source="given" | Task 7 |
| Cage overlay suppressed in UI for classic | Task 8 |
| Cage totals suppressed in UI for classic | Task 8 |
| Given digits rendered distinctly (black vs blue) | Task 8 |
| Confirm screen shows puzzle type | Task 8 |
| Test fixtures directory with README | Task 4 |

**No placeholders found.**

**Type consistency:**
- `given_digits` type: `npt.NDArray[np.intp]` in Python image layer → `list[list[int]] | None` in `PuzzleState` (serialised via `.tolist()`) — consistent.
- `puzzle_type`: `Literal["killer", "classic"]` throughout Python; `"killer" | "classic"` in TypeScript — consistent.
- `source="given"` on `UserAction`: existing `source: str` field — no type change needed.
