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

## Follow-up investigation: is the 0/20 result a bug or a real accuracy limit?

The 0/20 result above was surprising enough (and the failure mode — whole
digits going missing, not just misread — unusual enough) to warrant checking
for an integration bug before accepting it. It was a good instinct: there
*was* a real, confirmed bug, but fixing it doesn't change the conclusion.

**Bug found and confirmed: montage merging.** `TesseractNumber` tiles multiple
crops into one canvas per `get_sums` call, separated by 24px of blank padding.
Real crops (unlike the clean, generously-margined synthetic digits used in
Task 2's unit tests) fill their 64×64 frame edge-to-edge — one recorded crop
had ink pixels literally on column 0. With only 24px between two such crops,
Tesseract's layout analysis sometimes fuses them into a single character
blob: one recorded 2-crop call returned exactly one detected character (`'8'`)
with a bounding box of `left=24, right=173` — spanning *both* slots, not one.
Tuning `pad` on that exact failing pair gave inconsistent results (24→fail,
48→correct `[1,8]`, 64→fail, 96→fail, 128→detected but wrong digit `[6,8]`),
so this isn't a one-constant fix — the montage-batching approach is fragile
at this crop scale regardless of tuning.

**Isolating the bug from raw accuracy:** re-ran with batching removed
entirely — one crop per Tesseract call, `--psm 10` (single-character mode),
so merging is structurally impossible. Compared against the shipped
recogniser's own prediction for the same 150 individual crops (one full
puzzle image, `guardian/killer_sudoku_0.jpg`):

**Result: 83/150 (55.3%) agreement**, with a specific recurring confusion —
shipped reads `1`, Tesseract reads `7` — appearing at least 7 times in the
mismatch sample, not scattered randomly across digit pairs.

**Conclusion: the verdict holds, but for a more precise reason.** The montage
bug was real and worth fixing (and is fixed, committed separately — see the
`image_to_boxes`/empty-dict-guard commits), but it was not the dominant cause
of the gap. Even with batching removed altogether, Tesseract only agrees with
the shipped recogniser on ~55% of individual glyphs, with a systematic
digit-shape confusion pattern — the same *category* of failure already seen
twice elsewhere in this codebase (HOG's 7↔1 confusion, the shipped PCA+RBF
model's own 2↔7 confusion): a font-specific OCR weakness on this newspaper
typeface, not a pipeline defect. Tesseract's built-in model is tuned for
standard document fonts at document DPI; this is a different, unfamiliar
typeface at small size with no surrounding word/sentence context to lean on.

(Caveat: this 55.3% figure uses the shipped recogniser's own predictions as
the reference, which has its own circularity concerns — see
[[project_digit_recogniser_investigation]]. But the shipped model
independently solves 463/465 real puzzles end-to-end, which would be very
unlikely if it were subtly wrong on ~45% of individual digits; the recurring
1→7 pattern specifically also lines up with confusions already documented
elsewhere in this codebase. Taken together this is much more consistent with
"Tesseract has a real accuracy gap on this font" than "the shipped model's
predictions aren't a fair reference.")

## Verdict

**NOT TRUSTWORTHY as a ground-truth relabelling source, for Tesseract's raw
OCR accuracy on this font/crop-type — not primarily an integration defect.**
The montage-merging bug was real and is now fixed in the codebase regardless,
but the accuracy gap persists even with it fully removed from the picture.

**Recommendation:** given a confirmed ~55% single-glyph agreement ceiling
(not a bug artifact) plus the original 20/20-vs-0/20 solve-rate gap, the full
889-image corpus run does not need to be executed — both the pilot-scale and
per-glyph-isolated experiments already answer the question. Do not proceed to
relabel the corpus via Tesseract. If Tesseract remains worth pursuing, the
open question is no longer "is there an integration bug" (answered: partially
yes, now fixed, but not the dominant factor) but "can `--psm`/`--oem` tuning,
much larger upscaling, or a custom-trained Tesseract language model close a
~45-point accuracy gap on this specific font" — a materially different,
larger investigation than this validation gate was scoped for.
