# Design: Bit-Exact TS Port of the Python Image Pipeline

## Context

`feature/python-baseline` built a Python reference implementation of the image
pipeline (`killer_sudoku/image/*.py`, `killer_sudoku/solver/*.py`,
`killer_sudoku/scripts/evaluate_corpus.py`) specifically to use as a
pixel-accurate oracle, then tried to bring the existing TS pipeline
(`web/src/image/*.ts`) into agreement with it through a long series of ad-hoc
patches (JPEG decode method, ICC colour profile handling, `isblack` threshold
formula, digit recogniser swap, etc.).

The corpus evaluator (2,968-puzzle corpus, `corpus.db`) shows this didn't
converge:

| | clean rate | notSolved rate |
|---|---|---|
| Python reference (`262ef03`) | 99.93% (2966/2968) | 0.07% (2) |
| master (current TS pipeline) | 94.47% | 4.08% |
| TS branch's best point (`2a203f6`) | 96.6% | 1.9% |
| TS branch's current tip (`1186036`) | 69.2% | 27.4% |

The TS pipeline never actually reached Python parity even at its best
recorded point, and a late commit (`1186036`, "prioritise confidence-based
split over splitRec gate in splitNum") caused a severe regression on top of
that. Continuing to patch forward from the regressed tip is not a good
foundation.

This spec covers restarting the port with the Python pipeline as an explicit,
line-by-line reference, verified stage-by-stage and bit-for-bit against a
growing set of individual images, instead of judging progress only by
corpus-wide pass/fail statistics.

## Goal

Bring `web/src/image/*.ts` to bit-exact behavioural parity with
`killer_sudoku/image/*.py`, one image at a time, until the whole corpus
matches. Success is measured by the existing evaluator
(`evaluate-corpus.ts` / `evaluate_corpus.py`) reaching parity with the
Python reference's 99.9% clean rate — not by improving on master's 94.5%
baseline as an incremental patch target.

## Branch & code baseline

New branch `feature/python-bitexact-port`, created off master (done).

- `killer_sudoku/image/`, `killer_sudoku/solver/`, `killer_sudoku/scripts/evaluate_corpus.py`,
  `tests/test_evaluate_corpus.py`, `tests/test_inp_image_diagnostics.py`, and the
  `pyproject.toml` / `stubs/sklearn/decomposition.pyi` changes are copied over from
  `feature/python-baseline` **unchanged** — this is the reference oracle and isn't
  being modified by this effort.
- `web/src/image/*.ts`, `web/public/opencv.js`, `web/public/num_recogniser.*`,
  `web/scripts/evaluate-corpus.ts`, and `web/scripts/opencv-whitelist.json` stay at
  **master's pristine versions** — none of `feature/python-baseline`'s TS-side
  commits are cherry-picked. Every past "pixel-matching" patch (JPEG decode,
  ICC profile, `isblack` formula, PCA+RBF recogniser swap, template-matching
  fast path) gets re-derived through the new instrumented process below, since
  we don't know which of them were sound and which contributed to the
  regression.
- `feature/python-baseline` is left parked (not deleted, not merged) until this
  effort completes.

## Stage boundaries

Per `docs/image-pipeline.md`, verified in this fixed order for a given image —
never advancing to the next stage until the current one is bit-exact:

1. **Image Acquisition** — `gry` / `img` arrays (grayscale + BGR, post
   pyrUp-to-resolution, post 3px border)
2. **Grid Location** — grid corners (4×2), perspective warp matrix `M`,
   warped image
3. **Cell Scan** — `cage_total_confidence` (9×9), `classic_digit_confidence` (9×9)
4. **Border Extraction** — per-edge border probabilities, then the clustered
   hard `border_x` / `border_y`
5. **Digit Recognition** — per-candidate digit probability distributions,
   final `cage_totals`
6. **Joint Constraint Validation** — final `brdrs` (9×9×4), final
   `PuzzleSpec`, `spec_error`

## Instrumentation (temporary — deleted once the whole corpus matches)

Three small scripts, none of which become permanent test infrastructure:

- `killer_sudoku/scripts/bitcheck_dump.py <image>` — runs `InpImage` on one
  image, serialises the checkpoint values for each stage above to JSON.
- `web/scripts/bitcheck-dump.ts <image>` — same checkpoints, from the TS
  pipeline. Needs a real browser page (opencv.js requires canvas/Image APIs),
  so it follows the same Playwright-driven pattern as the existing
  `dump-contour-trees.ts`.
- `scripts/bitcheck_diff.py <dump_a.json> <dump_b.json>` — loads both dumps,
  compares stage-by-stage, and reports the **first** stage that diverges,
  with max-abs-diff and a sample of the differing indices. Stages after the
  first divergence are not evaluated (they're expected to differ until the
  root cause is fixed).

**Tolerance policy:** integer/boolean arrays (grid corners rounded to pixel,
borders, cage totals) require exact equality. Floating-point confidence /
probability arrays allow `1e-6` absolute tolerance, to absorb harmless
cross-language float-summation-order noise — not as slack for algorithmic
differences.

## Per-image workflow

1. Pick the next image (see below).
2. Run both dump scripts, then the diff script.
3. If a stage diverges: fix that stage's TS implementation to mirror the
   Python module's logic exactly (function-by-function port, not a
   reimplementation from first principles), re-dump, re-diff.
4. Repeat until all 6 stages match for that image.
5. Move to the next image, using the same harness — this will often
   re-surface Stage 1/2 issues on the new image before reaching Stage 6
   again, which is expected and fine.
6. Once the whole corpus passes under `evaluate-corpus.ts` /
   `evaluate_corpus.py` at Python-reference parity, delete the three
   `bitcheck_*` scripts and rely on the standard corpus evaluator for
   ongoing regression coverage.

**First image:** `classic_guardian/easy/killer_sudoku_0.jpg` (simple, and
alphabetically first in the corpus).

**Excluded images:** `guardian/killer_sudoku_247.jpg` and
`guardian/killer_sudoku_275.jpg` are the two puzzles where the Python
reference itself returns `spec_error` (`notSolved`, git_hash `262ef03c...`).
Never pick either as a bit-check target — there is no valid Python-side
oracle output to diff against, so a TS mismatch there is uninformative.
They stay unaddressed until the rest of the corpus matches (see Out of
scope).

## Out of scope

- Any change to `killer_sudoku/image/*.py` itself (it's the reference,
  assumed correct given its 99.9% corpus clean rate — the two known
  `spec_error` failures above are not addressed by this effort unless they
  block porting an image that happens to hit them).
- Merging or deleting `feature/python-baseline` (parked until this
  branch's work is complete, then revisited).
- Any permanent addition to the Vitest suite for bit-exact comparison —
  the `bitcheck_*` tooling is explicitly temporary.
