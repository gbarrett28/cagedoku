# Partial Result Display on OCR Validation Error — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When image-pipeline validation fails, show the interactive confirmation screen with detected borders and cage totals (plus a warning banner) instead of returning an HTTP 422 error; also always show the warped grid image alongside the original photo.

**Architecture:** `InpImage.__init__` catches validation errors and stores them in `self.spec_error` instead of raising; the API builds a best-effort spec using union-find connected components for the diagnostic display path; both original and warped images are always returned in `UploadResponse`.

**Tech Stack:** Python 3.13, FastAPI, Pydantic, OpenCV, NumPy, TypeScript.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `killer_sudoku/image/inp_image.py` | Store `warped_img`; catch validation errors; add `spec_error` attribute |
| Modify | `killer_sudoku/api/schemas.py` | Add `warning` and `warped_image_b64` to `UploadResponse` |
| Modify | `killer_sudoku/api/routers/puzzle.py` | Add `_build_diagnostic_spec`; use `spec_error`; include warped image |
| Modify | `killer_sudoku/static/index.html` | Add "Warped Grid" `<img>` column |
| Modify | `killer_sudoku/static/main.ts` | Handle new response fields; show warped image and warning |
| Create | `tests/image/test_diagnostic_spec.py` | Unit tests for `_build_diagnostic_spec` |

---

## Task 1: Non-raising constructor + warped image in InpImage

**Files:**
- Modify: `killer_sudoku/image/inp_image.py`

The three failure modes that currently raise from `__init__`—"too many digits",
"sum out of range", and `validate_cage_layout` errors—all occur **after** border
detection has succeeded.  The fix wraps them in a try/except and stores the
message in `self.spec_error`.  The warped colour image is computed from the
same perspective matrix `m` and stored as `self.warped_img`.

- [ ] **Step 1: Update the docstring and add `warped_img` + `spec_error` to the cache path**

Replace the existing cache-path block (lines 115–121):

```python
        jpk = filepath.with_suffix(".jpk")
        if not config.rework and jpk.exists():
            self.info: PicInfo = InpImage.load_cached(jpk)
            dst_size_cached = np.array(
                [
                    [0, 0],
                    [resolution - 1, 0],
                    [resolution - 1, resolution - 1],
                    [0, resolution - 1],
                ],
                dtype=np.float32,
            )
            m_cached: npt.NDArray[np.float64] = np.asarray(
                cv2.getPerspectiveTransform(self.info.grid, dst_size_cached),
                dtype=np.float64,
            )
            self.warped_img: npt.NDArray[np.uint8] = np.asarray(
                cv2.warpPerspective(
                    img, m_cached, (resolution, resolution), flags=cv2.INTER_LINEAR
                ),
                dtype=np.uint8,
            )
            self.spec: PuzzleSpec | None = None
            self.spec_error: str | None = None
            try:
                self.spec = validate_cage_layout(
                    self.info.cage_totals, self.info.border_x, self.info.border_y
                )
            except (ValueError, ProcessingError) as exc:
                self.spec_error = str(exc)
            return
```

- [ ] **Step 2: Compute `warped_img` in the main pipeline path**

After the existing `warped_blk` computation (after line 153), insert:

```python
        self.warped_img = np.asarray(
            cv2.warpPerspective(
                img, m, (resolution, resolution), flags=cv2.INTER_LINEAR
            ),
            dtype=np.uint8,
        )
```

- [ ] **Step 3: Wrap cage-total extraction and validation in try/except**

Replace lines 174–224 (from `cage_totals = self._build_cage_totals(...)` through
`self.spec = validate_cage_layout(...)`) with:

```python
        self.spec = None
        self.spec_error = None

        try:
            cage_totals = self._build_cage_totals(
                warped_blk, num_recogniser, subres, self.info.brdrs
            )

            # Sum sanity check with adaptive-threshold fallback (see original comments)
            total_sum = int(cage_totals.sum())
            if not (360 <= total_sum <= 450):
                warped_gry: npt.NDArray[np.uint8] = np.asarray(
                    cv2.warpPerspective(
                        gry, m, (resolution, resolution), flags=cv2.INTER_LINEAR
                    ),
                    dtype=np.uint8,
                )
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

- [ ] **Step 4: Update the docstring**

Replace the `Raises:` section of `__init__`:

```python
        """Parse a puzzle image file and populate self.info with extracted data.

        Checks for a cached .jpk file alongside the image; if found and rework
        is False, loads from cache. Otherwise runs the full pipeline: grid
        location, border identification, and number recognition.

        Validation errors (invalid cage layout, digit extraction failures) are
        stored in self.spec_error rather than raised; callers must check
        self.spec_error is None before using self.spec.

        Args:
            filepath: Path to the puzzle image file.
            config: Pipeline configuration (newspaper, resolution, thresholds).
            border_detector: Observer border model, or None for Guardian.
            num_recogniser: Trained digit classifier.

        Raises:
            AssertionError: if grid lines or intersections cannot be found
                (no useful data has been extracted).
        """
```

- [ ] **Step 5: Run the bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/image/inp_image.py
python -m ruff format killer_sudoku/image/inp_image.py
python -m mypy --strict killer_sudoku/image/inp_image.py
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

Expected: no errors, all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add killer_sudoku/image/inp_image.py
git commit -m "feat: store warped_img on InpImage; make constructor non-raising for validation errors

InpImage.__init__ no longer raises ValueError or ProcessingError for cage-layout
validation failures.  Errors are stored in self.spec_error; callers check this
before using self.spec.  self.warped_img (perspective-corrected colour image) is
now always populated, enabling the API to return it for diagnostic display.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Schema — add `warning` and `warped_image_b64` to `UploadResponse`

**Files:**
- Modify: `killer_sudoku/api/schemas.py`

- [ ] **Step 1: Add the two new fields to `UploadResponse`**

Replace the existing `UploadResponse` class body:

```python
class UploadResponse(BaseModel):
    """Response to a puzzle image upload (successful or partial).

    On a clean pipeline run, warning is None and state is fully usable.
    When the pipeline extracts borders and cage totals but fails cage-layout
    validation, warning is set and state contains the best-effort diagnostic
    layout (still interactive — the user can correct it).
    """

    session_id: str
    state: PuzzleState
    warning: str | None = None
    """Validation error message; None on a clean pipeline run."""

    warped_image_b64: str | None = None
    """Base64-encoded JPEG of the perspective-corrected grid image.
    Always populated by the upload endpoint; None only for mock responses.
    """
```

- [ ] **Step 2: Run the bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/api/schemas.py
python -m ruff format killer_sudoku/api/schemas.py
python -m mypy --strict killer_sudoku/api/schemas.py
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

Expected: no errors, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add killer_sudoku/api/schemas.py
git commit -m "feat: add warning and warped_image_b64 to UploadResponse

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: `_build_diagnostic_spec` + API upload handler changes

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py`
- Create: `tests/image/test_diagnostic_spec.py`

`_build_diagnostic_spec` uses the same union-find connected-components logic as
`validate_cage_layout` but skips all validity checks, so it always returns a
renderable `PuzzleSpec` even when cage totals are wrong.

- [ ] **Step 1: Write the failing tests**

Create `tests/image/test_diagnostic_spec.py`:

```python
"""Tests for _build_diagnostic_spec in the puzzle router."""

import numpy as np

from killer_sudoku.api.routers.puzzle import _build_diagnostic_spec


def _all_borders_on() -> tuple[np.ndarray, np.ndarray]:
    """Return border arrays with every inner border as a cage wall."""
    return np.ones((9, 8), dtype=bool), np.ones((8, 9), dtype=bool)


def _no_borders() -> tuple[np.ndarray, np.ndarray]:
    """Return border arrays with no inner cage walls (whole grid = one component)."""
    return np.zeros((9, 8), dtype=bool), np.zeros((8, 9), dtype=bool)


def test_all_borders_on_produces_81_regions() -> None:
    """With every border on, each cell is its own region."""
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    bx, by = _all_borders_on()
    spec = _build_diagnostic_spec(cage_totals, bx, by)
    assert spec.regions.shape == (9, 9)
    assert len(set(spec.regions.flatten().tolist())) == 81


def test_no_borders_produces_one_region() -> None:
    """With no borders, the entire grid is one connected component."""
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    bx, by = _no_borders()
    spec = _build_diagnostic_spec(cage_totals, bx, by)
    assert len(set(spec.regions.flatten().tolist())) == 1


def test_cage_totals_passed_through_unchanged() -> None:
    """cage_totals are stored verbatim even when geometrically invalid."""
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    cage_totals[0, 0] = 14  # impossible for any cage size
    bx, by = _no_borders()
    spec = _build_diagnostic_spec(cage_totals, bx, by)
    assert spec.cage_totals[0, 0] == 14


def test_regions_are_positive_integers() -> None:
    """Every cell has a region ID >= 1."""
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    bx, by = _all_borders_on()
    spec = _build_diagnostic_spec(cage_totals, bx, by)
    assert int(spec.regions.min()) >= 1


def test_output_border_arrays_equal_inputs() -> None:
    """border_x and border_y are stored without modification."""
    cage_totals = np.zeros((9, 9), dtype=np.intp)
    bx, by = _all_borders_on()
    spec = _build_diagnostic_spec(cage_totals, bx, by)
    assert np.array_equal(spec.border_x, bx)
    assert np.array_equal(spec.border_y, by)
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
python -m pytest tests/image/test_diagnostic_spec.py -v
```

Expected: `ImportError` — `_build_diagnostic_spec` does not exist yet.

- [ ] **Step 3: Add `_build_diagnostic_spec` to `puzzle.py`**

Insert immediately after the existing `_spec_to_data` function (after line 123):

```python
def _build_diagnostic_spec(
    cage_totals: npt.NDArray[np.intp],
    border_x: npt.NDArray[np.bool_],
    border_y: npt.NDArray[np.bool_],
) -> PuzzleSpec:
    """Build an unvalidated PuzzleSpec for diagnostic display.

    Uses the same union-find connected-components logic as validate_cage_layout
    but skips all cage-validity checks.  The result may contain invalid cages
    (wrong totals, multiple heads, headless regions) but is safe to render and
    interact with in the confirmation UI.

    Args:
        cage_totals: (9,9) int array; non-zero at cage-head cells.
        border_x: (9,8) horizontal cage-wall flags.
        border_y: (8,9) vertical cage-wall flags.

    Returns:
        PuzzleSpec with connected-component regions; cage_totals unchanged.
    """
    rmap: dict[tuple[int, int], tuple[int, int]] = {
        (c, r): (c, r) for c in range(9) for r in range(9)
    }
    members: dict[tuple[int, int], set[tuple[int, int]]] = {
        (c, r): {(c, r)} for c in range(9) for r in range(9)
    }

    def union(a: tuple[int, int], b: tuple[int, int]) -> None:
        ra, rb = sorted((rmap[a], rmap[b]))
        if ra == rb:
            return
        for p in members[rb]:
            rmap[p] = ra
        members[ra] |= members[rb]
        del members[rb]

    for col in range(9):
        for row in range(8):
            if not border_x[col, row]:
                union((col, row), (col, row + 1))

    for col in range(8):
        for row in range(9):
            if not border_y[col, row]:
                union((col, row), (col + 1, row))

    rep_to_id: dict[tuple[int, int], int] = {}
    regions: npt.NDArray[np.intp] = np.zeros((9, 9), dtype=np.intp)
    for col in range(9):
        for row in range(9):
            rep = rmap[(col, row)]
            if rep not in rep_to_id:
                rep_to_id[rep] = len(rep_to_id) + 1
            regions[col, row] = rep_to_id[rep]

    return PuzzleSpec(
        regions=regions,
        cage_totals=cage_totals,
        border_x=border_x,
        border_y=border_y,
    )
```

You will also need to add `npt` to the imports at the top of `puzzle.py`. Check whether `import numpy.typing as npt` is already there; if not, add it alongside the existing `import numpy as np`.

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
python -m pytest tests/image/test_diagnostic_spec.py -v
```

Expected: all 5 tests pass.

- [ ] **Step 5: Update the upload handler to use `spec_error` and include `warped_image_b64`**

Replace the inner try/except block and the response-building code (lines 655–674):

```python
            try:
                inp = InpImage(tmp_path, img_config, border_detector, num_recogniser)
            except AssertionError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

            warped_b64: str | None = _encode_image(
                _resize_for_display(inp.warped_img)
            )

            if inp.spec_error is not None:
                try:
                    spec = _build_diagnostic_spec(
                        inp.info.cage_totals,
                        inp.info.border_x,
                        inp.info.border_y,
                    )
                except Exception as exc:
                    raise HTTPException(status_code=422, detail=str(exc)) from exc
                warning: str | None = inp.spec_error
            else:
                assert inp.spec is not None
                spec = inp.spec
                warning = None

            cages = _spec_to_cage_states(spec)
            spec_data = _spec_to_data(spec)
            original_b64 = _encode_image(_resize_for_display(inp.img))

            session_id = str(uuid.uuid4())
            state = PuzzleState(
                session_id=session_id,
                newspaper=newspaper,
                cages=cages,
                spec_data=spec_data,
                original_image_b64=original_b64,
            )
            store.save(state)
            return UploadResponse(
                session_id=session_id,
                state=state,
                warning=warning,
                warped_image_b64=warped_b64,
            )
```

- [ ] **Step 6: Also remove `ProcessingError` from the import if it is now unused in `puzzle.py`**

Check: `ProcessingError` was previously caught in the except clause we just removed. Search for other uses:

```bash
grep -n "ProcessingError" killer_sudoku/api/routers/puzzle.py
```

If the only remaining reference was in the removed except block, remove it from the import on line 61–64.

- [ ] **Step 7: Run the full bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/api/routers/puzzle.py tests/image/test_diagnostic_spec.py
python -m ruff format killer_sudoku/api/routers/puzzle.py tests/image/test_diagnostic_spec.py
python -m mypy --strict killer_sudoku/api/routers/puzzle.py
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

Expected: no errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add killer_sudoku/api/routers/puzzle.py tests/image/test_diagnostic_spec.py
git commit -m "feat: add _build_diagnostic_spec; show partial result on OCR validation error

When InpImage.spec_error is set, the upload endpoint now builds a best-effort
PuzzleSpec using unvalidated connected components and returns it as a normal
UploadResponse with warning set.  warped_image_b64 is always included.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Frontend — warped image column and warning banner

**Files:**
- Modify: `killer_sudoku/static/index.html`
- Modify: `killer_sudoku/static/main.ts`

- [ ] **Step 1: Add the warped-grid column to `index.html`**

In `#images-row`, add a new column immediately after `#original-col` (after line 54):

```html
      <div class="image-col" id="warped-col" hidden>
        <h2>Warped Grid</h2>
        <img id="warped-img" alt="Perspective-corrected grid">
      </div>
```

The column starts `hidden`; `main.ts` will unhide it when the image is available.

- [ ] **Step 2: Update the `UploadResponse` TypeScript interface**

Replace the existing `UploadResponse` interface in `main.ts` (lines 91–94):

```typescript
interface UploadResponse {
  session_id: string;
  state: PuzzleState;
  warning?: string;
  warped_image_b64?: string;
}
```

- [ ] **Step 3: Populate the warped image and show the warning in `handleProcess`**

In `handleProcess`, replace the success block (from `const data = ...` through `setStatus("")`):

```typescript
    const data = (await res.json()) as UploadResponse;
    currentSessionId = data.session_id;
    renderState(data.state);

    // Show the perspective-corrected grid image when available.
    const warpedCol = el<HTMLElement>("warped-col");
    const warpedImg = el<HTMLImageElement>("warped-img");
    if (data.warped_image_b64) {
      warpedImg.src = `data:image/jpeg;base64,${data.warped_image_b64}`;
      warpedCol.hidden = false;
    } else {
      warpedCol.hidden = true;
    }

    if (data.warning) {
      setStatus(`Warning: ${data.warning}`, false);
    } else {
      setStatus("");
    }
```

- [ ] **Step 4: Compile TypeScript**

```bash
tsc
```

Expected: `killer_sudoku/static/main.js` updated with no errors.

- [ ] **Step 5: Run the full bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/
python -m ruff check --unsafe-fixes --ignore PLR0912,PLR0915,C901 killer_sudoku/
python -m ruff format killer_sudoku/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

Expected: zero errors, all tests pass.

- [ ] **Step 6: Manual smoke test**

```bash
python -c "
from pathlib import Path
from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
img = sorted(Path('guardian').glob('*.jpg'))[247]
cfg = ImagePipelineConfig(puzzle_dir=Path('guardian'), newspaper='guardian', rework=True)
bd = InpImage.make_border_detector(cfg)
nr = InpImage.make_num_recogniser(cfg)
inp = InpImage(img, cfg, bd, nr)
print('spec_error:', inp.spec_error)
print('warped_img shape:', inp.warped_img.shape)
print('spec:', inp.spec)
"
```

Expected: `spec_error` is set with the cagesize error message, `warped_img.shape` is `(1152, 1152, 3)` (or similar), `spec` is `None`.

- [ ] **Step 7: Commit**

```bash
git add killer_sudoku/static/index.html killer_sudoku/static/main.ts killer_sudoku/static/main.js
git commit -m "feat: show warped grid image and warning banner on confirmation screen

The review panel now shows a 'Warped Grid' column alongside the original photo.
When the OCR pipeline partially fails, a warning banner is shown at the top of
the screen and the user can still interact with the detected layout.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
