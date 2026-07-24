# Tesseract Validation Notes

## Timing pilot (Task 4)

20 guardian images, copied to scratch (never touching the live `guardian/`
directory), run via:
```
python -m killer_sudoku.training.evaluate --puzzle-dir <scratch>/tesseract_pilot --recogniser tesseract --rework
```

- Tesseract: wall-clock 64s for 20 images (parallel, `n_jobs=-1`); per-image
  P50=39.2s, P95=49.5s.
- Shipped (same 20 images, same run harness): wall-clock 6.6s; per-image
  P50=1.3s, P95=1.5s.
- Tesseract is **~30x slower per image** than the shipped recogniser, even
  after montage-batching inside `TesseractNumber`.

**Why batching didn't help as much as expected:** `InpImage._build_cage_totals`
(`killer_sudoku/image/inp_image.py`) calls `num_recogniser.get_sums(...)`
**once per cell** (up to 81 times per image), each call carrying only that
cell's 1-4 digit crops. `TesseractNumber`'s montage batching only reduces
subprocess-spawn overhead *within* a call — it can't help when the call site
itself never hands it more than a handful of crops at once. Getting real
batching benefit would require changing `_build_cage_totals` to accumulate all
cells' crops for the whole image and call `get_sums` once, then redistribute
results — a deeper pipeline change than adding a new recogniser class, out of
scope for this validation gate.

## Accuracy comparison (small-scale, in place of a full Task 5 run)

Same 20 guardian images, both recognisers, via the `--recogniser` flag:

| Recogniser | SOLVED | Per-image time |
|---|---|---|
| shipped (CayenneNumber) | 20/20 | ~1.3s |
| tesseract | 0/20 | ~40s |

All 20 Tesseract-substituted runs failed with `AssertionError` (no valid
`PuzzleSpec` produced). Example (`guardian/killer_sudoku_0.jpg`,
`config.rework=True` so both runs read live, not from `.jpk` cache):

- `spec_error`: `cagesize=3, total=56: total must be in [6, 24]` — impossible
  for a 3-cell killer cage (max is 7+8+9=24).
- Column 0 cage totals, shipped vs tesseract: `[7,18,0,0,15,0,16,17,0]` vs
  `[7,18,0,0,0,0,56,0,0]`.
  - Cells with a real total: tesseract got 7 and 18 right, **missed rows 4
    and 7 entirely** (returned nothing where shipped read 15 and 17), and
    **misread row 6** (16 → 56).

## Verdict

**NOT TRUSTWORTHY as currently integrated** — Tesseract's solve rate is
dramatically *lower* than the shipped recogniser on this corpus (0/20 vs
20/20), not higher as hypothesized. Root cause appears to be raw OCR accuracy
on this specific crop type (tiny, tightly-cropped, perspective-warped
multi-digit cage totals occupying a fraction of a cell) rather than an
integration bug — the montage/polarity/coordinate issues found during Task 2
were fixed and unit-tested before this pilot ran. Tesseract's statistical
models are tuned for normal-DPI printed document text; these crops are a very
different regime (a handful of magnified pixels, no surrounding context,
inconsistent digit-string lengths).

**Not yet ruled out:** whether Tesseract configuration tuning (different
`--psm`/`--oem` modes, disabling any implicit language modeling, upscaling
crops further before OCR, adjusting the binarization/threshold before handing
crops to Tesseract) would close this gap. This pilot used one fixed
configuration (`--psm 6`, digit whitelist, direct polarity inversion, no
upscaling beyond the existing 64px cell size) and did not sweep alternatives —
that's a reasonable next step if pursuing Tesseract further, but is a
different, open-ended investigation from this validation gate's original
scope (confirm-or-deny trustworthiness) and wasn't attempted here.

**Recommendation:** given a 20/20 vs 0/20 gap on a representative sample, the
full 889-image corpus run does not need to be executed to answer the original
question — the pilot already answers it decisively. Do not proceed to relabel
the corpus via Tesseract in its current configuration. If Tesseract remains
worth pursuing, it should be as a separate, scoped investigation into
config/preprocessing tuning specifically for tiny numeric crops, evaluated
again against the same pilot-scale comparison before considering a full-corpus
run.
