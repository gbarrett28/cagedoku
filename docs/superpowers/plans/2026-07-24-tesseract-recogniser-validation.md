# Tesseract Recogniser Validation Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine whether Tesseract OCR is a trustworthy *independent* ground-truth
labeller for our digit corpus, by substituting it for the shipped `CayenneNumber`
recogniser throughout the existing image pipeline and checking whether the full
guardian+observer corpus solves substantially *more* cleanly with Tesseract reading
digits than with the current self-trained recogniser.

**Architecture:** Introduce a structural `NumberSource` Protocol that both
`CayenneNumber` and a new `TesseractNumber` satisfy (`get_sums(list[image]) ->
labels`), since every call site in `inp_image.py`/`evaluate.py` already only calls
`.get_sums(...)` duck-typed. `TesseractNumber` batches many small digit crops into
one montage image per call and does a single `pytesseract.image_to_data` pass per
batch — per-crop subprocess calls were the historical performance problem (each
`tesseract` invocation forks a process and reloads language data), so batching is
the fix, not switching to a different binding. All runs against real corpus images
happen on **copies** in the scratchpad, never against `guardian/`/`observer/`
in place — those `.jpg` files and their `.jpk`/`status.pkl`/`eval_report.json`
derivatives are irreplaceable project data (see project memory
`project_training_data`) and this plan's own `--rework` runs would silently
overwrite the cached ground truth used elsewhere if pointed at the live corpus.

**Tech Stack:** Python 3.12, existing `killer_sudoku` package (opencv-python-headless,
numpy, scikit-learn), new dependency: `pytesseract` (Python wrapper) + system
`tesseract-ocr` binary (external, not pip-installable).

## Global Constraints

- Never write into `guardian/` or `observer/` from any task in this plan — always
  operate on a copy under the scratchpad directory
  (`C:\Users\geoff\AppData\Local\Temp\claude\...\scratchpad`).
- `pytesseract`/`tesseract` calls MUST be batched (one call per montage of many
  crops), never one call per digit crop — this was the documented cause of the
  original "too slow" experience.
- This plan produces a **decision artifact** (a comparison report + a written
  verdict), not a shipped feature. Do not touch `web/` or any TypeScript in this
  plan — that only becomes relevant if this gate passes and a follow-on plan for
  retraining/benchmarking is written.
- Follow `killer_sudoku`'s existing `_Classifier`/`CayenneNumber` code style in
  `killer_sudoku/image/number_recognition.py` (dataclasses, `npt.NDArray[...]`
  type hints, Google-style docstrings with Args/Returns/Raises).
- All new/modified `.py` files must pass `ruff check` and `mypy` per
  `pyproject.toml`'s `[tool.ruff]`/`[tool.mypy]` config before commit.

---

## Task 1: `NumberSource` Protocol and call-site retyping

**Files:**
- Modify: `killer_sudoku/image/number_recognition.py` (add `NumberSource` Protocol near the existing `_Classifier` Protocol, ~line 28)
- Modify: `killer_sudoku/image/inp_image.py:91,327,500` (change `num_recogniser: CayenneNumber` → `num_recogniser: NumberSource` on `InpImage.__init__`, `_identify_borders`, `_build_cage_totals`)
- Modify: `killer_sudoku/training/evaluate.py:163` (`_process_one_image`'s `num_recogniser: CayenneNumber` → `NumberSource`)
- Test: `tests/test_number_source_protocol.py`

**Interfaces:**
- Produces: `NumberSource` Protocol with one method: `get_sums(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]`. Both `CayenneNumber` (existing) and `TesseractNumber` (Task 2) satisfy it structurally — no inheritance needed.

This task is a pure typing refactor (no behavior change): it lets later tasks pass
a `TesseractNumber` anywhere a `CayenneNumber` currently goes, without touching
`InpImage`'s internals (which already only ever call `.get_sums(...)`).

- [x] **Step 1: Write the failing test**

```python
# tests/test_number_source_protocol.py
import numpy as np
import numpy.typing as npt

from killer_sudoku.image.number_recognition import CayenneNumber, NumberSource
from killer_sudoku.image.inp_image import InpImage


def test_cayenne_number_satisfies_number_source() -> None:
    num_recogniser = InpImage.make_num_recogniser()
    source: NumberSource = num_recogniser  # mypy-checked assignment
    assert isinstance(source, CayenneNumber)


class _FakeSource:
    def get_sums(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        return np.zeros(len(nums), dtype=np.intp)


def test_arbitrary_class_satisfies_number_source_structurally() -> None:
    source: NumberSource = _FakeSource()
    result = source.get_sums([np.zeros((64, 64), dtype=np.uint8)])
    assert result.tolist() == [0]
```

- [x] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_number_source_protocol.py -v`
Expected: FAIL with `ImportError: cannot import name 'NumberSource'`

- [x] **Step 3: Add the Protocol and retype call sites**

In `killer_sudoku/image/number_recognition.py`, immediately after the existing
`_Classifier` Protocol (around line 38), add:

```python
class NumberSource(Protocol):
    """Protocol for anything that can label a batch of digit-image crops.

    CayenneNumber (the shipped PCA+RBF recogniser) and TesseractNumber both
    satisfy this structurally, so evaluate.py and InpImage can swap between
    them without any inheritance relationship.
    """

    def get_sums(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        """Classify a list of digit-image crops, returning one label per crop."""
        ...
```

`Protocol` is already available from `typing` — check the existing import line at
the top of `number_recognition.py` and add `Protocol` to it if not already present.

In `killer_sudoku/image/inp_image.py`, change the three `num_recogniser:
CayenneNumber` parameter annotations (on `InpImage.__init__`, `_identify_borders`,
`_build_cage_totals`) to `num_recogniser: NumberSource`, and add `NumberSource` to
the existing `from killer_sudoku.image.number_recognition import ...` line.

In `killer_sudoku/training/evaluate.py`, change `_process_one_image`'s
`num_recogniser: CayenneNumber` parameter to `num_recogniser: NumberSource`, and
add `NumberSource` to its import from `number_recognition`. Leave
`collect_status`'s local `num_recogniser = InpImage.make_num_recogniser()` as-is
for now — Task 3 changes how it's constructed.

- [x] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_number_source_protocol.py -v`
Expected: PASS (2 passed)

- [x] **Step 5: Run mypy and the full fast test suite to confirm no regressions**

Run: `mypy killer_sudoku`
Expected: no new errors (structural Protocol typing, all existing concrete
`CayenneNumber` usages remain valid since `CayenneNumber` still has `get_sums`)

Run: `python -m pytest tests -x -q`
Expected: all existing tests still pass (no behavior changed, only type hints)

- [x] **Step 6: Commit**

```bash
git add killer_sudoku/image/number_recognition.py killer_sudoku/image/inp_image.py killer_sudoku/training/evaluate.py tests/test_number_source_protocol.py
git commit -m "refactor: introduce NumberSource protocol for recogniser substitution"
```

---

## Task 2: `TesseractNumber` — batched-montage Tesseract recogniser

**Files:**
- Create: `killer_sudoku/image/tesseract_recognition.py`
- Test: `tests/test_tesseract_recognition.py`
- Modify: `pyproject.toml` (add `pytesseract` to `dependencies`)

**Interfaces:**
- Consumes: `NumberSource` Protocol (Task 1).
- Produces: `TesseractNumber` class with `get_sums(nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]`, constructor `TesseractNumber(cols: int = 10, cell: int = 64, pad: int = 24)`. Unrecognised crops (no digit detected in a slot) get label `-1`, matching the existing `-1`-as-placeholder convention already used in `CayenneNumber.get_sums`.

**Why montage-batching:** the user's recollection is that Tesseract was "very slow
to load... called via a shell" originally — `pytesseract` shells out to the
`tesseract` binary on every call, and process-spawn + language-model-load
overhead (tens of ms minimum) dominates when called once per tiny digit crop
across tens of thousands of crops. Tiling N crops into one canvas and calling
`image_to_data` once cuts the number of subprocess spawns by a factor of N.

- [ ] **Step 1: Add the dependency**

In `pyproject.toml`, add `"pytesseract"` to the `dependencies` list (alongside
`opencv-python-headless`, `numpy`, etc.). Then:

```bash
pip install -e .
```

Tesseract itself is a system binary, not pip-installable. Verify it's on PATH:

```bash
tesseract --version
```

If this fails, the system binary must be installed first (e.g. via a Windows
installer or `choco install tesseract`) before continuing — **do not proceed to
Step 2 until this succeeds**, and confirm with the user before installing
system-wide software.

- [ ] **Step 2: Write the failing test**

```python
# tests/test_tesseract_recognition.py
import shutil

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

from killer_sudoku.image.tesseract_recognition import TesseractNumber

pytestmark = pytest.mark.skipif(
    shutil.which("tesseract") is None, reason="tesseract binary not installed"
)


def _render_digit(digit: int, size: int = 64) -> "np.ndarray":
    img = Image.new("L", (size, size), color=255)
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=48)
    bbox = draw.textbbox((0, 0), str(digit), font=font)
    x = (size - (bbox[2] - bbox[0])) // 2 - bbox[0]
    y = (size - (bbox[3] - bbox[1])) // 2 - bbox[1]
    draw.text((x, y), str(digit), fill=0, font=font)
    return np.asarray(img, dtype=np.uint8)


def test_get_sums_reads_rendered_digits() -> None:
    digits = [1, 2, 3, 7, 9]
    crops = [_render_digit(d) for d in digits]
    recogniser = TesseractNumber()
    labels = recogniser.get_sums(crops)
    assert labels.tolist() == digits


def test_get_sums_empty_input() -> None:
    recogniser = TesseractNumber()
    labels = recogniser.get_sums([])
    assert labels.tolist() == []
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python -m pytest tests/test_tesseract_recognition.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'killer_sudoku.image.tesseract_recognition'`

- [ ] **Step 4: Implement `TesseractNumber`**

```python
# killer_sudoku/image/tesseract_recognition.py
"""Tesseract-OCR-backed digit recogniser, batched via image montage.

Calling `tesseract` once per digit crop is prohibitively slow (each invocation
forks a subprocess and reloads language data). TesseractNumber instead tiles
many crops into a single canvas and issues one `image_to_data` call per batch,
then maps detected text boxes back to their originating crop by position.
"""

import math

import numpy as np
import numpy.typing as npt
import pytesseract
from PIL import Image


class TesseractNumber:
    """Digit recogniser backed by Tesseract OCR, batched via image montage.

    Attributes:
        cols: Number of crops per montage row.
        cell: Side length (pixels) each crop is resized to before tiling.
        pad: Padding (pixels) between adjacent crops and around the canvas
            edge, large enough that Tesseract does not merge neighbouring
            digits into one token.
    """

    def __init__(self, cols: int = 10, cell: int = 64, pad: int = 24) -> None:
        self.cols = cols
        self.cell = cell
        self.pad = pad

    def get_sums(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        """Classify a list of digit-image crops, returning one label per crop.

        Args:
            nums: List of digit image arrays (grayscale, any size — resized to
                self.cell before tiling).

        Returns:
            Array of predicted digit labels, one per input crop. -1 where no
            digit was detected in that crop's slot.
        """
        if not nums:
            return np.array([], dtype=np.intp)

        step = self.cell + self.pad
        rows = math.ceil(len(nums) / self.cols)
        canvas = np.full(
            (rows * step + self.pad, self.cols * step + self.pad), 255, dtype=np.uint8
        )
        slots: list[tuple[int, int, int, int]] = []
        for idx, img in enumerate(nums):
            r, c = divmod(idx, self.cols)
            y0 = self.pad + r * step
            x0 = self.pad + c * step
            resized = np.asarray(
                Image.fromarray(img).resize((self.cell, self.cell)), dtype=np.uint8
            )
            # Tesseract expects dark ink on light background.
            canvas[y0 : y0 + self.cell, x0 : x0 + self.cell] = 255 - resized
            slots.append((x0, y0, x0 + self.cell, y0 + self.cell))

        data = pytesseract.image_to_data(
            Image.fromarray(canvas),
            config="--psm 11 -c tessedit_char_whitelist=0123456789",
            output_type=pytesseract.Output.DICT,
        )

        labels = [-1] * len(nums)
        for text, left, top, width, height in zip(
            data["text"], data["left"], data["top"], data["width"], data["height"], strict=True
        ):
            text = text.strip()
            if not text or not text[0].isdigit():
                continue
            cx, cy = left + width // 2, top + height // 2
            for idx, (x0, y0, x1, y1) in enumerate(slots):
                if x0 <= cx < x1 and y0 <= cy < y1 and labels[idx] == -1:
                    labels[idx] = int(text[0])
                    break

        return np.array(labels, dtype=np.intp)
```

Note the inversion (`255 - resized`) assumes input crops are ink-bright /
background-dark (matching `warped_blk`'s thresholded convention where digit ink
is the foreground fill value). Before trusting this in Task 4, dump one real
montage canvas to the scratchpad (`Image.fromarray(canvas).save(...)`) and
visually confirm the digits render as dark strokes on light background, not
inverted — adjust the `255 -` inversion if the real crop polarity turns out to
be the opposite of what this assumes.

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_tesseract_recognition.py -v`
Expected: PASS if tesseract is installed; SKIPPED otherwise (both are acceptable
outcomes for this step — SKIPPED just means Step 1's installation didn't happen
yet on this machine).

- [ ] **Step 6: Commit**

```bash
git add killer_sudoku/image/tesseract_recognition.py tests/test_tesseract_recognition.py pyproject.toml
git commit -m "feat: add batched-montage Tesseract digit recogniser"
```

---

## Task 3: `--recogniser` flag on `evaluate.py`

**Files:**
- Modify: `killer_sudoku/training/evaluate.py` (`collect_status`, `main`)
- Test: `tests/test_evaluate_recogniser_flag.py`

**Interfaces:**
- Consumes: `TesseractNumber` (Task 2), `NumberSource` (Task 1).
- Produces: `collect_status(config: ImagePipelineConfig, num_recogniser: NumberSource | None = None) -> StatusStore` — if `num_recogniser` is `None`, falls back to today's `InpImage.make_num_recogniser()` (no behavior change for existing callers).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_evaluate_recogniser_flag.py
from pathlib import Path

import numpy as np
import numpy.typing as npt

from killer_sudoku.training.evaluate import collect_status
from killer_sudoku.image.config import ImagePipelineConfig


class _AllOnesSource:
    def get_sums(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        return np.ones(len(nums), dtype=np.intp)


def test_collect_status_accepts_injected_recogniser(tmp_path: Path) -> None:
    config = ImagePipelineConfig(puzzle_dir=Path("guardian"), rework=False)
    status = collect_status(config, num_recogniser=_AllOnesSource())
    assert len(status) > 0
```

`ImagePipelineConfig` is imported from `killer_sudoku.image.config` (confirmed
from `evaluate.py`'s own import line).

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_evaluate_recogniser_flag.py -v`
Expected: FAIL with `TypeError: collect_status() got an unexpected keyword argument 'num_recogniser'`

- [ ] **Step 3: Add the parameter and CLI flag**

In `killer_sudoku/training/evaluate.py`, change `collect_status`'s signature:

```python
def collect_status(
    config: ImagePipelineConfig,
    num_recogniser: NumberSource | None = None,
) -> StatusStore:
    ...
    if num_recogniser is None:
        num_recogniser = InpImage.make_num_recogniser()
    status = StatusStore(config.status_path, config.puzzle_dir_required)
    ...
```

(Only the first two lines of the body change — replace the existing
`num_recogniser = InpImage.make_num_recogniser()` line with the `if` block
above, keep everything else in `collect_status` unchanged.)

In `main()`, add a new CLI flag and thread it through:

```python
    parser.add_argument(
        "--recogniser",
        choices=["shipped", "tesseract"],
        default="shipped",
        help="Digit recogniser to use: 'shipped' (default, CayenneNumber) or "
             "'tesseract' (TesseractNumber, for ground-truth validation runs)",
    )
```

and just before the `collect_status(config)` call at the end of `main()`:

```python
    num_recogniser: NumberSource | None = None
    if args.recogniser == "tesseract":
        num_recogniser = TesseractNumber()
    collect_status(config, num_recogniser=num_recogniser)
```

Add `from killer_sudoku.image.tesseract_recognition import TesseractNumber` and
`from killer_sudoku.image.number_recognition import NumberSource` to
`evaluate.py`'s imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_evaluate_recogniser_flag.py -v`
Expected: PASS

- [ ] **Step 5: Run the full fast test suite**

Run: `python -m pytest tests -x -q`
Expected: all pass, no regressions (default `num_recogniser=None` path is
behaviorally identical to before)

- [ ] **Step 6: Commit**

```bash
git add killer_sudoku/training/evaluate.py tests/test_evaluate_recogniser_flag.py
git commit -m "feat: add --recogniser flag to swap in TesseractNumber for evaluate.py"
```

---

## Task 4: Timing pilot on a scratch copy

**Files:**
- Create (scratch, not committed): `<scratchpad>/tesseract_pilot/*.jpg` (copies of ~20 images)
- Create: `docs/tesseract-validation-notes.md` (records the timing result and go/no-go decision — this file IS committed, as the plan's decision log)

**Interfaces:**
- Consumes: `--recogniser tesseract` flag (Task 3).

This task has no unit test — its "test" is an actual timing measurement against
an explicit threshold, because the thing being validated is wall-clock
performance, not code correctness.

- [ ] **Step 1: Copy a small sample to scratch — never touch `guardian/` directly**

```bash
mkdir -p /c/Users/geoff/AppData/Local/Temp/claude/C--Users-geoff-PycharmProjects-killer-sudoku/*/scratchpad/tesseract_pilot
cp guardian/killer_sudoku_0.jpg guardian/killer_sudoku_1.jpg /path/to/scratchpad/tesseract_pilot/
# repeat for ~20 guardian images total (a mix of killer and classic if guardian has both;
# check corpus.db or just glob-select 20 arbitrarily since this is only a timing pilot)
```

- [ ] **Step 2: Run the tesseract-substituted pipeline on the copy, timed**

```bash
cd /path/to/scratchpad/tesseract_pilot
time python -m killer_sudoku.training.evaluate --puzzle-dir . --recogniser tesseract --rework
```

Record wall-clock time for these ~20 images.

- [ ] **Step 3: Extrapolate and decide go/no-go**

Guardian + observer together are on the order of a few thousand puzzle images
(each contributing up to 81 cage-total crops or ~30 given-digit crops). Compute:

```
per_image_seconds = pilot_wall_clock_seconds / 20
estimated_total_seconds = per_image_seconds * (guardian_image_count + observer_image_count)
```

Get the actual image counts first: `ls guardian/*.jpg | wc -l` and `ls
observer/*.jpg | wc -l` (read-only, safe).

Write the pilot result, the extrapolation, and a decision to
`docs/tesseract-validation-notes.md`:

```markdown
# Tesseract Validation Notes

## Timing pilot (Task 4)

- Pilot: N images, T seconds wall-clock (`time python -m killer_sudoku.training.evaluate --recogniser tesseract --rework`)
- Per-image: T/N seconds
- Guardian: G images, Observer: O images
- Estimated full-corpus time: (T/N) * (G+O) seconds

## Decision

[ACCEPTABLE / TOO SLOW — needs larger montage batches or fewer cols] — pick
based on whether the estimate is within a few hours. If too slow, increase
`TesseractNumber.cols` (fewer, larger montage canvases = fewer subprocess
calls) and re-run the pilot before proceeding to Task 5.
```

- [ ] **Step 4: Commit the notes file (pilot images stay in scratch, not committed)**

```bash
git add docs/tesseract-validation-notes.md
git commit -m "docs: record Tesseract timing pilot result and go/no-go decision"
```

---

## Task 5: Full-corpus comparison and verdict

**Files:**
- Create (scratch, not committed): `<scratchpad>/tesseract_full/guardian/*.jpg`, `<scratchpad>/tesseract_full/observer/*.jpg` (full copies)
- Modify: `docs/tesseract-validation-notes.md` (append the final comparison and verdict)

**Interfaces:**
- Consumes: everything above. This is the actual gate check the user asked for:
  "verify that tesseract gets the numbers right by expecting a much higher
  correctly solved count if we substitute tesseract as the recogniser."

Only proceed with this task if Task 4's decision was ACCEPTABLE.

- [ ] **Step 1: Copy full corpora to scratch**

```bash
mkdir -p /path/to/scratchpad/tesseract_full/guardian /path/to/scratchpad/tesseract_full/observer
cp guardian/*.jpg /path/to/scratchpad/tesseract_full/guardian/
cp observer/*.jpg /path/to/scratchpad/tesseract_full/observer/
```

- [ ] **Step 2: Establish the shipped-recogniser baseline on the same copies**

```bash
cd /path/to/scratchpad/tesseract_full
python -m killer_sudoku.training.evaluate --puzzle-dir guardian --recogniser shipped
cp guardian/eval_report.json guardian/eval_report_shipped.json
python -m killer_sudoku.training.evaluate --puzzle-dir observer --recogniser shipped
cp observer/eval_report.json observer/eval_report_shipped.json
```

(Running on the fresh copy — not the live `guardian/`/`observer/` — means this
baseline run is also safe to redo if anything needs re-checking.)

- [ ] **Step 3: Run the Tesseract-substituted pass and compare**

```bash
python -m killer_sudoku.training.evaluate --puzzle-dir guardian --recogniser tesseract --rework
python -m killer_sudoku.training.evaluate --puzzle-dir guardian --recogniser tesseract --compare guardian/eval_report_shipped.json
python -m killer_sudoku.training.evaluate --puzzle-dir observer --recogniser tesseract --rework
python -m killer_sudoku.training.evaluate --puzzle-dir observer --recogniser tesseract --compare observer/eval_report_shipped.json
```

`--compare` already exists in `evaluate.py` (`compare_reports`) and prints a diff
table between two `eval_report.json` files — no new comparison code needed.

- [ ] **Step 4: Record the verdict**

Append to `docs/tesseract-validation-notes.md`:

```markdown
## Full-corpus comparison (Task 5)

| Corpus | Shipped SOLVED | Tesseract SOLVED | Delta |
|--------|-----------------|-------------------|-------|
| guardian | ... | ... | ... |
| observer | ... | ... | ... |

## Verdict

[TRUSTWORTHY — Tesseract solves substantially more cleanly than the shipped
recogniser; proceed to write the relabelling/retraining plan] OR
[NOT TRUSTWORTHY — Tesseract's solve rate is not substantially higher than
baseline; do not use it as a ground-truth labeller without further
investigation into why].
```

Fill in the actual SOLVED counts from each `eval_report.json` and the printed
`--compare` diff output.

- [ ] **Step 5: Commit**

```bash
git add docs/tesseract-validation-notes.md
git commit -m "docs: record full-corpus Tesseract-vs-shipped comparison and verdict"
```

---

## What this plan deliberately does not cover

Per the Scope Check discipline, the rest of the original request — full-corpus
relabelling via Tesseract, balanced 100-per-digit-per-subcorpus resampling,
retraining PCA+RBF and HOG (with hole-detection features) on both stretched and
letterboxed crops, training a new CNN recogniser, and a 6-way benchmark — is
follow-on work that depends entirely on this plan's verdict. If Task 5 concludes
Tesseract is trustworthy, write a separate plan for the relabelling/resampling
pipeline next; if not, the labelling strategy needs rethinking before any of
that retraining work is worth specifying in detail.
