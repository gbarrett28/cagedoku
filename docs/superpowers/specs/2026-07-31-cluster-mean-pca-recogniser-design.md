# Cluster-mean PCA recogniser design

## Context

The digit recogniser currently uses HOG+hole+aspect-ratio features feeding an
OvO RBF-SVM (`HogRecogniser` in `web/src/image/numberRecognition.ts` and
`web/train_recogniser.py`). Across this session's investigation:

- The full-corpus given-digit population, clustered per digit, showed **no**
  1-vs-7 cross-contamination in the source labels (confirmed via a 40-cell
  labeled contact sheet — 4 clusters × 10 digits, all correctly labeled).
- A production candidate model trained on this cluster-verified data
  (`web/corpus_train.json`, 400 samples/digit stratified across each digit's
  clusters, plus synthetic font samples and `--browser-weight` auto-balance)
  still misclassified 229/400 (57%) of digit-7 training samples as digit 1 —
  reproduced across multiple configurations (with/without
  `manual_label_overrides.json`, with/without the aspect feature in isolated
  tests).
- The aspect-ratio feature itself is not degenerate — isolated binary 1-vs-7
  tests (raw pixels, no augmentation) achieve 100% accuracy with or without
  it. The most likely mechanism: aspect is a single dimension among 1770
  total (1764 HOG + 5 hole + 1 aspect); a single highly-informative dimension
  can be diluted by cumulative variance across many secondary HOG dimensions
  in an isotropic RBF-kernel distance, especially once ~9000 synthetic-font
  samples (aspect ratio ranging 0.29–1.44, vs the real corpus's tight
  0.67–0.84 for digit 7) are mixed in.
- Root cause not fully pinned to one mechanism, but HOG+aspect has now failed
  to cleanly separate 1-vs-7 across several independent full-pipeline
  retrains. Per user direction: drop HOG, move to a PCA-based feature space
  instead.

## Decisions from brainstorming

1. **Architecture: PCA + RBF-SVM only.** The historical `PcaRbfRecogniser`
   (commit `ab8d94b`, since removed) was a two-stage classifier — template
   matching against per-digit mean images as a fast path, falling back to
   PCA-projected RBF-SVM. The template-matching stage is not being revived;
   it was a speed optimization, not an accuracy contributor, and today's
   RBF-SVM is fast enough without it.

2. **PCA basis construction: cluster-means-first, residual-filled.**
   Rather than ordinary (unsupervised, variance-maximizing) PCA or the
   existing per-*digit*-mean class-mean PCA, fit the basis from
   per-**(digit, cluster)** means — using the same clustering already
   performed for this session's review (GMM, k=4, on HOG+hole+aspect
   features, per digit) as a **training-time-only labeling tool**. This
   never reaches production inference; production never computes HOG.
   - Compute one raw-pixel (4096-dim) mean vector per (digit, cluster) group
     — up to 40 mean vectors total (0 has fewer clusters in practice).
   - SVD the centered 40-row mean matrix to get up to 39 "between-cluster"
     principal axes (rank-deficient by exactly 1 after centering, same math
     as the existing `fit_class_mean_pca`).
   - Measure cumulative explained variance these axes cover across the full
     training pool. If insufficient, add ordinary residual PCA components on
     the orthogonal complement (the existing `n_residual_components`
     mechanism) until coverage is adequate. The exact target coverage
     threshold is not fixed upfront — tune empirically once results are in,
     since the mechanism already supports an arbitrary residual count.

3. **Training pool: corpus + synthetic, combined, from the start.** The
   clustering step (and therefore the cluster means) operates on the
   combined pool of `corpus_train.json`'s cluster-reviewed crops (given +
   cage-total digits unified, 4000 samples) and the ~9045 synthetic
   font-rendered digits — not corpus-only with synthetic added later as
   filler. This directly targets the known PCA-vs-HOG generalization
   tradeoff (PCA on raw pixels is more sensitive to exact stroke geometry
   than HOG; broadening the basis with font diversity partially offsets it).
   `manual_label_overrides.json` stays excluded (per this session's finding
   that removing it didn't fix 1-vs-7, but its provenance/timing — captured
   right around the `0c860c8` regression and a mid-stream crop-format
   refactor — remains untrusted).

## Components

### Python (`web/train_recogniser.py`)

- New clustering step: for each digit 0–9, fit `PCA(n_components=20) +
  GaussianMixture(n_components=4, random_state=0, n_init=5)` on
  HOG+hole+aspect features of the combined corpus+synthetic pool for that
  digit (mirrors this session's `bin_check_all.py`/
  `build_cluster_catalog.py` scratch methodology, now promoted into the
  production trainer). Output: a `(digit, cluster_id)` pseudo-label per
  sample.
- `compute_label_means()` (already exists) is reused unchanged — call it
  with `pseudo_label = digit * 10 + cluster_id` instead of `digit`, and with
  raw flattened pixel vectors (not HOG features) as `X`.
- `fit_class_mean_pca()` (already exists, generic over labels) is reused
  unchanged.
- `HogRecogniser` is not modified. A new `PcaRecogniser` class is added
  alongside it (see naming note below), implementing `extract_features()` as
  a raw-pixel flatten (no HOG/hole/aspect call) and `fit()`/`save()` using
  the cluster-mean-PCA path instead of the current PCA/class-mean-PCA
  branches built for HOG-derived features.
- Manifest schema: reuses the existing `cm_mean_of_means`,
  `cm_between_components`, `cm_residual_mean`, `cm_residual_components`
  array names — already implemented and already round-trips through
  `loadNumRecogniser`. `classifier_type` stays `"rbf"`; a new field
  distinguishes feature-extraction mode (HOG vs raw-pixel) so
  `loadNumRecogniser` knows which recogniser class to construct.

### TypeScript (`web/src/image/numberRecognition.ts`)

- `pcaProject()` / `classMeanProject()` / `ClassMeanReduction` are reused
  as-is — they're already generic linear-projection functions, agnostic to
  what the input feature vector represents.
- New `PcaRecogniser` class (naming: `HogRecogniser` doing no HOG would be
  confusing, so this is a new sibling class, not a mode flag on the
  existing one) implementing the `NumRecogniser` abstract base:
  `extractFeatures()` returns the flattened raw pixel array; `recognise()`
  mean-subtracts, projects via `classMeanProject`, and feeds the existing
  `RBFClassifier`/`ovoVote`/`rbfPredictWithConfidence` inference path
  unchanged.
- `loadNumRecogniser()` picks `HogRecogniser` vs `PcaRecogniser` based on
  the new manifest field.

## Testing

- Existing `numberRecognition.test.ts` accuracy-floor test against
  `corpus_train.json` is updated to load whichever recogniser class the
  manifest specifies (already reads `classifier_type`/warp strategy
  generically; needs the new feature-extraction-mode field added to its
  loading logic).
- New Python unit tests for the `(digit, cluster)` pseudo-labeling step and
  the cluster-mean SVD, mirroring the existing
  `test_compute_label_means_returns_one_row_per_unique_label` /
  `test_fit_class_mean_pca_rank_is_at_most_n_labels_minus_one` tests.
- New TS unit tests for `PcaRecogniser` construction and inference, mirroring
  `HogRecogniser`'s existing test coverage.
- Validation gate before considering deployment: same methodology already
  used for the HOG candidate — stratified-sample-and-check-disagreement
  against raw `predicted_label` across the full corpus.db population, plus
  bronze/silver gates and a full corpus evaluation.

## Open questions / risks

- **Residual-component count** is not fixed by this spec — determined
  empirically from the first fit's explained-variance coverage.
- **Naming**: `PcaRecogniser` is a placeholder; final name TBD at
  implementation time if a clearer one emerges.
- **Speed**: RBF-SVM fit cost depends on feature dimensionality; raw-pixel
  PCA output dimensionality (≤39 between-cluster + N residual) is much
  smaller than HOG's 1764, so fit/inference should be faster, not slower —
  worth confirming empirically rather than assuming.
- Cage-total digits (`cell_type='cage_total_digit'`) are already unified
  into `corpus_train.json`'s clustering (per task #56) and carry through
  unchanged into this design's clustering step.
