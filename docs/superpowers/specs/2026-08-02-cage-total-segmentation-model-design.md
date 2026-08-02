# Cage-Total Digit Segmentation Model — Design

## Problem

Killer cage-total digits are read by binarizing the warped grid (`warpedBlk`),
finding contours, filtering candidates by size/position heuristics
(`isDigitSizedContour`, `contourIsNumber`), and splitting multi-digit
contours by an ink-profile peak search (`splitNum`). This works for the
large majority of cells, but fails when a cage total's ink touches the
dashed cage-boundary line drawn near the same corner: the digit and the
dash merge into a single connected component under binary thresholding,
and no rule-based re-derivation of the threshold or a masking margin has
been found that fixes this without breaking other real puzzles (see
`project_dash_digit_fusion_thresholding_abandoned` memory — every generic
threshold/morphology fix tried this investigation either had no effect or
corrupted previously-correct cells on full-corpus regression testing).

Root cause: binarization is lossy. It collapses grayscale intensity (where
the digit-vs-dash distinction actually lives — differences in stroke
width, anti-aliasing, local contrast) down to a single global ink/no-ink
decision before any classification happens. A single scalar threshold,
however it's derived, cannot recover a distinction that requires local
shape context.

## Goal

Replace the binarize → contour → geometric-filter → `splitNum` pipeline
for cage-total digits with a small trained model that operates on
grayscale pixels directly, so digit-ink and decoration-ink can be
separated by learned shape/texture cues even where they touch.

This is scoped to **killer cage-totals only**. Classic given-digits sit
centred in a cell with no nearby decorative ink and are not affected by
this failure mode — the existing pipeline handles them correctly and is
left unchanged.

## Model

**Input:** a fixed 64×64px grayscale patch — the top-left quadrant of each
cell, matching the existing `contourIsNumber` top-left-quadrant convention
— taken from `warpedGry` (never `warpedBlk`).

**Output, per pixel, one of four classes:**
- `background`
- `decoration-ink` (dash / grid line)
- `digit-ink`, instance slot `0`
- `digit-ink`, instance slot `1`

A killer cage total is always 1 or 2 digits, so instance count is capped
at 2 — this is a bounded 4-way per-pixel classification, not open-ended
instance segmentation.

**Post-processing:** group instance-0 and instance-1 digit-ink pixels into
(up to two) crops and feed each directly into the existing
`activeRecogniser().recognise()` call, unchanged.

This model replaces `isDigitSizedContour`/`contourIsNumber`'s geometric
filtering, the connected-component contour walk, and `splitNum`'s
peak-detection splitting all at once — all three were rule-based
approximations of the same underlying task this model performs directly.

## Label derivation

No new manual labeling. Labels are derived from parts of the existing
pipeline that already work correctly on the non-fusion majority of cells:

- **Digit-ink + instance labels:** for cells where the current pipeline
  already cleanly segments 1-2 digits, `splitNum`'s resulting per-digit
  bounding boxes give ground-truth instance slots 0/1. Within each box,
  the existing `warpedBlk` binary value is a trustworthy per-pixel
  ink/no-ink mask — trustworthy specifically because these are the clean
  cases where binarization never had a touching-ink problem.
- **Decoration-ink labels:** within regions at/near a wall or dash
  position already confirmed by `clusterBorders` (reliable throughout this
  investigation — border/cage-topology detection was never the bug),
  the same `warpedBlk` ink/no-ink value marks decoration-ink pixels.
- **Background:** everything else. Pixels that are "ink" per the old
  binary mask but fall outside both a known digit box and a known wall
  position are **excluded** from training rather than force-labeled — we
  don't have real confidence in what they are.

### Central risk

Every derivable label comes from an *isolated* example of one class. The
model never sees a real instance of dash-ink actually touching digit-ink
during training, because those are exactly the cases the current pipeline
can't produce clean labels for. The project is a bet that a model taught
each class's shape separately will correctly separate them where they
touch in a novel image — the way a person can tell a stray dash from a
digit stroke even where they overlap.

Synthetic touching-ink augmentation (compositing known-clean digit crops
against known-clean decoration crops with deliberate overlap) is the
natural mitigation if recall/holdout results fall short, but is explicitly
**out of scope for this first pass** — add later only if needed.

## Phase 1 (this project): Python-side prototyping

- **Data capture (TS-side):** extend `evaluate-corpus.ts` (or a small
  sibling script reusing its real-pipeline-per-image machinery) to write a
  new corpus.db table for a **training/validation subset** of the killer
  corpus — not the whole corpus. Proposed shape:
  `segmentation_labels(puzzle_hash, row, col, patch_pixels, label_mask,
  git_hash)`, where `patch_pixels` is the grayscale 64×64 corner crop and
  `label_mask` is the derived per-pixel class+instance label. This is a
  one-time batch pass — no live browser round-trips per training
  iteration. Crop extraction stays TS-side deliberately: Python must not
  re-derive grid-location/warp geometry itself (this is the same
  single-source-of-truth boundary documented in CLAUDE.md, learned the
  hard way earlier in this project when a hand-reimplemented Python grid
  locator silently diverged from the TS one).
- **Training & eval (Python-side):** query the new table directly (same
  pattern as `train_recogniser.py` reading `corpus_train.json`), train,
  and judge the model on **per-class recall/precision** against a held-out
  validation split of the captured data. No full-pipeline solve-eval in
  this phase. Concrete network architecture (e.g. a small U-Net-style
  encoder/decoder vs. something lighter) is deliberately left as an
  implementation-time decision, not fixed by this spec.
- **Holdout test:** the PDF that motivated this investigation, plus
  whatever other real puzzles are available outside the training/eval
  capture, checked by hand against the model's output. This is the real
  signal on whether the central-risk generalization bet paid off,
  independent of recall numbers on the training distribution.

## Phase 2 (future, not this project): production integration

Only pursued if Phase 1's holdout results justify it. Deferred details,
noted here for context so Phase 1 isn't designed into a corner:

- Export the trained model to ONNX; add ONNX Runtime Web as a new
  browser-side dependency for inference (a deliberate departure from the
  existing hand-rolled-TS-inference precedent used by the PCA/RBF
  recognizer, chosen because hand-rolling a segmentation network's forward
  pass is a materially bigger lift than the linear PCA+RBF-SVM case).
- Run inference on each cell's fixed corner patch (up to 81 per puzzle)
  inside `buildCageTotals`, **replacing** the contour-extraction path
  entirely rather than running alongside it as a fallback.
- Ship gate: **zero regressions** on a full-corpus run via
  `evaluate-corpus.ts` against the current baseline, plus explicit
  confirmation of recovery on known fusion cases. This investigation's
  hybrid-threshold experiment passed 3 hand-picked spot checks and then
  regressed 4 previously-clean puzzles on the first 361/2968 of a full
  corpus run — spot checks alone are not sufficient evidence before
  replacing production digit-reading logic.

## Out of scope

- Classic given-digit reading (not affected by this failure mode).
- Synthetic touching-ink training augmentation (deferred mitigation, not
  part of this pass).
- Any ONNX/browser integration work (Phase 2, contingent on Phase 1
  results).
- Any change to the production `buildCageTotals` pipeline as part of this
  project — this spec covers data capture, training, and evaluation only.
