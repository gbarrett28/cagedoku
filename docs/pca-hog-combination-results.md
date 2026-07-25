# PCA/HOG Combination Results

Full guardian+observer corpora, gated on PCA/HOG agreement + clean solve
(see `docs/superpowers/plans/2026-07-24-pca-hog-agreement-recogniser.md`),
balanced to 100 samples/digit (80 train / 20 holdout) across all 10 digit
classes — every class reached the full cap (800 = 10×80 exactly), so the
result below isn't skewed by any single starved class. Training data is
dithered (`web/train_recogniser.py`'s `dither_batch`, 5 variants/sample —
translation/morphology/noise, matching the historical training pipeline);
holdouts are never dithered.

Training set: 800 real samples (4800 after dithering). Same-distribution
holdout: 200. Cross-font holdout: 10080 (digits 0-9 rendered in every
discoverable system TTF font, never used in training).

| Combination | Train accuracy | Same-distribution accuracy | Cross-font accuracy |
|---|---|---|---|
| pca_stretch | 0.4825 | 0.5150 | 0.3419 |
| **pca_letterbox** | **0.4925** | **0.5200** | **0.5368** |
| hog_stretch | 0.7850 | 0.4250 | 0.1505 |
| hog_letterbox | 0.7175 | 0.4550 | 0.3314 |

## Why the accuracy is this low — two confirmed, distinct root causes

The first run (no dithering) got same-distribution accuracy of only ~51%,
which was flagged as suspiciously low for a 7-8 dimensional PCA+RBF-SVM
problem with 80 real samples/class — far below what "just needs more data"
would predict. Investigating properly (not just asserting a data-volume
explanation) found two separate, confirmed problems:

**1. Confirmed label noise, with a concrete example.** Visually inspecting
extracted training crops found one labelled `6` that is unambiguously a
printed `9` — the cage total for that cell is `19`, and *both* the shipped
PCA model and the recovered HOG model independently misread it as `16`.
The puzzle still solved cleanly despite the wrong total, so this sample
passed both the "models agree" and the "solves cleanly" gates. Two models
sharing similar training history can share similar blind spots on visually
ambiguous glyphs (6/9 is a natural rotational-symmetry confusion) — agreement
between them is much stronger evidence than either signal alone, but it
is not proof, and this experiment found a real instance of that gap.

**2. Confirmed insufficient training density for HOG specifically**, and a
different underlying problem than for PCA. Adding a train-set self-accuracy
diagnostic (predicting the *exact real crops the model was fit on*, not
holdout data) revealed two distinct failure signatures:

- **PCA: train accuracy (~48-49%) ≈ holdout accuracy (~51-52%).** The model
  can't even fit its own training data well — this is the signature of
  *label noise*, not a generalization gap. `PcaRbfRecogniser.fit` computes
  its low-dimensional PCA basis from only **10 per-class mean images**, so a
  handful of mislabelled samples (like the confirmed 19→16 case) shifts an
  entire class's mean image, corrupting the classifier for every sample of
  that class — not just the mislabelled one. This architecture is unusually
  sensitive to exactly the kind of correlated-confusion noise found above.
- **HOG: train accuracy (72-79%) ≫ holdout accuracy (43-46%).** This is the
  classic overfitting signature — HOG's 1769-dimensional feature space can
  largely memorize ~80 real + ~400 dithered samples per class, but that's
  nowhere near enough data relative to its dimensionality to generalize.
  The historical production HOG model was trained on far more data (the full
  bulk corpus plus extensive synthetic-font rendering — the commit that
  fixed its 3-vs-8 confusion mentions "2.1M augmented images"), not a
  100-per-digit capped sample.

Dithering (added after the first run) closed much of the *cross-font* gap
(`pca_letterbox` cross-font accuracy went from 0.4066 to 0.5368) but barely
moved same-distribution accuracy — consistent with the diagnosis above:
dithering multiplies samples around each training exemplar, which helps
generalization, but does nothing to fix wrong labels already in the set, and
doesn't add enough raw volume to rescue HOG's high-dimensional overfitting.

## Verdict

**`pca_letterbox` still wins** on both same-distribution accuracy
(effectively tied with `pca_stretch`, 0.5200 vs 0.5150) and cross-font
accuracy (0.5368, clearly ahead of the field) — the relative ranking from
the first run holds. **HOG does not win any combination.** But none of
these four numbers should be read as "how good the winning approach could
actually get" — they're depressed by the two confirmed issues above, which
affect all four combinations to different degrees (PCA more from label
noise, HOG more from data volume), not just the deployed choice between
them.

**Recommendation, if pursuing this further:**
1. Don't deploy any of these four models as-is — none are close to the
   shipped model's ~98-99% baseline, and now there's a specific, understood
   reason why, not just "small sample."
2. To fix the label-noise problem: don't just trust agreement + clean-solve
   blindly for confusion-prone digit pairs (6/9 at minimum; likely also 2/7
   and 3/8, per prior documented confusions in this codebase). A cheap
   partial mitigation: flag agreement-pool samples whose digit is in a known
   confusion pair for manual review before use, rather than auto-accepting.
3. To fix HOG's data-volume problem: either train on a much larger
   (uncapped) agreement-verified sample, or accept HOG needs the full
   synthetic-font-augmented pipeline it was originally designed around,
   which this experiment deliberately didn't reproduce (kept scope to
   dithering only, for a fair small-sample comparison across all four
   combinations).
4. Wiring any winning combination into the shipped TypeScript app remains
   out of scope for this (Python-only) plan and would be a separate
   follow-up, only worth doing once accuracy is actually competitive with
   the shipped baseline.
