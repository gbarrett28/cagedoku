# Classic Sudoku Recognition Design

**Goal:** Extend the image pipeline so that a photograph of a plain (classic) sudoku
puzzle is recognised end-to-end: grid located, given digits extracted, and a valid
`PuzzleSpec` produced — then loaded into the coaching app with given digits locked
and the cage structure hidden from the user.

**Architecture:** A new classic-sudoku branch is inserted after Stage 3 (cell scan).
When the puzzle is detected as classic, border detection is skipped (borders are
deterministic), center digits are read, and a `PuzzleSpec` with 9 row-cages
(sum=45 each) is constructed.  Given digits travel alongside the spec as a separate
array and are applied as locked solved cells by the API.

**Tech stack:** OpenCV, numpy, existing `CayenneNumber` PCA+KNN recogniser,
FastAPI/Pydantic schemas, TypeScript frontend.

---

## Test fixtures

A small set of clean printed classic sudoku images lives in
`tests/fixtures/sudoku/`.  Each image is accompanied by a Python module that
records the known given-digit clues and solution so pipeline tests can assert
correctness without manually inspecting images.

Images are downloaded from openly licensed sources (e.g. newspaper puzzle archives).
Three images covering easy, medium, and hard givens density are sufficient to
validate the recognition path.  **Images are not committed to the repository** —
`tests/fixtures/sudoku/*.jpg` and `tests/fixtures/sudoku/*.png` are listed in
`.gitignore`.  A companion `tests/fixtures/sudoku/README.md` explains where to
obtain them and how to name them to match the test fixtures.

---

## Puzzle type detection

`scan_cells` (Stage 3, existing) already returns `classic_digit_confidence[9][9]`
alongside `cage_total_confidence[9][9]`.

Detection is already size-based — this is the right signal:

- **Cage total** (killer): a small contour in the **top-left quadrant** of the cell
  (`subres/16 ≤ w < subres/2`, `subres/8 ≤ h < subres/2`).
- **Classic digit** (classic): a large contour in the **central region** of the cell
  (contour width or height ≥ `subres/3`).

These two signatures do not overlap: killer cage totals are small corner glyphs;
classic digits are large centred glyphs.  The existing `scan_cells` implementation
scores each independently, so the discrimination is already correct.

A new `detect_puzzle_type` function sums `classic_digit_confidence` across all 81
cells.  A typical classic puzzle has 20–35 givens (each scoring 1.0); a killer
puzzle has none.  Threshold at `classic_digit_threshold = 10.0` (stored in
`CellScanConfig`) gives a wide margin above the killer baseline of 0.

```
sum(classic_conf) > classic_digit_threshold  →  "classic"
otherwise                                    →  "killer"
```

---

## Image pipeline: classic path

`InpImage.__init__` gains two new attributes:

```python
self.puzzle_type: Literal["killer", "classic"]
self.given_digits: npt.NDArray[np.intp] | None  # shape (9,9), 0=empty; None for killer
```

**Stage 4 (border detection) is skipped for classic.**  The border layout is
constructed deterministically:

- `border_x`: all True — a cage wall at every horizontal row boundary (9 × 8 True
  values).
- `border_y`: all False — no vertical walls within rows (8 × 9 False values).

This produces 9 connected row-shaped cages, one per row.

**New function `read_classic_digits`** in `killer_sudoku/image/number_recognition.py`
(alongside the existing `CayenneNumber` and digit-reading helpers):

```python
def read_classic_digits(
    warped_blk: npt.NDArray[np.uint8],
    num_recogniser: CayenneNumber,
    subres: int,
    classic_conf: npt.NDArray[np.float64],
) -> npt.NDArray[np.intp]:
    """Read pre-filled digits from the centre of each cell."""
```

For each cell `(r, c)` where `classic_conf[r, c] > 0`:
- Extract the central `(subres//2) × (subres//2)` crop of the warped binary image.
- Pass to `CayenneNumber.get_sums` (existing recogniser; reused as-is for the
  initial implementation).
- Record predicted digit in `given_digits[r, c]`.

Cells with `classic_conf[r, c] == 0` stay 0 (empty).

**PuzzleSpec construction:**

```python
cage_totals = np.zeros((9, 9), dtype=np.intp)
for r in range(9):
    cage_totals[0, r] = 45          # cage head at leftmost cell of each row
border_x = np.ones((9, 8), dtype=bool)
border_y = np.zeros((8, 9), dtype=bool)
spec = validate_cage_layout(cage_totals, border_x, border_y)
```

---

## Solver integration

`Grid.set_up` gains an optional keyword argument:

```python
def set_up(
    self,
    cage_totals: npt.NDArray[np.intp],
    brdrs: npt.NDArray[np.bool_],
    given_digits: npt.NDArray[np.intp] | None = None,
) -> None:
```

After the existing equation setup, if `given_digits` is not None, every non-zero
cell `(r, c)` reduces `sq_poss[r][c]` to the singleton `{d}`.  Constraint
propagation then starts from those fixed points.

---

## API / session changes

### Schema additions (`schemas.py`)

```python
class PuzzleState(BaseModel):
    ...
    puzzle_type: Literal["killer", "classic"] = "killer"
    given_digits: list[list[int]] | None = None   # 9×9; 0 = empty
```

### Confirm screen

The confirm screen (the preview shown before the user commits to a puzzle) must
display the detected puzzle type: **"Killer Sudoku"** or **"Classic Sudoku"**.
This gives the user an early signal if the pipeline has misclassified the image.
The type is exposed in the GET /puzzle response via `puzzle_type`.

### Confirm endpoint (`routers/puzzle.py`)

When `puzzle_type == "classic"`, `confirm_puzzle`:

1. Calls `Grid.set_up(..., given_digits=np.array(state.given_digits))` so the
   solver respects the fixed clues when computing `golden_solution`.
2. After confirming, pre-populates `state.user_grid` with the given digits.
3. Appends a `place_digit` `UserAction` with `source="given"` for each given cell
   into `state.history`.  The undo endpoint must not rewind past `source="given"`
   actions (treat them as the initial state boundary).

---

## UI changes (`static/main.ts`, `static/index.html`)

The GET /puzzle response includes `puzzle_type`.

When `puzzle_type == "classic"`:
- Suppress the cage-border overlay (the thick lines drawn between cages).
- Suppress corner cage-total labels.
- Cells with `source=="given"` in the history are rendered with a distinct visual
  style (e.g. a slightly different background or font weight) and are not
  interactive (no digit entry, no candidate toggling).

Standard 3×3 box lines are unaffected — those come from the existing CSS grid
structure and are always shown.

---

## Error handling

- If `read_classic_digits` produces no non-zero cells (all crops fail), surface a
  `ProcessingError("No given digits recognised in classic sudoku")`.
- If `sum(given_digits) == 0` after reading, same error.
- No attempt is made to verify the given digits against the solution at pipeline
  time; verification happens implicitly when `confirm_puzzle` runs the solver (a
  contradictory clue set causes the solver to fail, which is surfaced as a
  `ProcessingError` to the user).

---

## Out of scope

- Retraining `CayenneNumber` on classic-sudoku digit images (deferred; try the
  existing model first and retrain if accuracy is unsatisfactory).
- Orientation correction (90°/180°/270° rotation detection) — already deferred in
  the migration plan.
- Classic-sudoku-specific coaching rules (hidden single, etc.) — deferred to a
  separate feature.
- The newspaper select UI element is unchanged; classic detection is automatic and
  does not require a user-facing format switch.
