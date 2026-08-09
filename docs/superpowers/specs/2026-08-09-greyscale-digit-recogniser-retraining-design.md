# Greyscale Digit Recogniser Retraining Design

## Goal

Prepare, review, train, and validate a digit recogniser whose input is a crop
from the warped greyscale puzzle grid rather than a crop from the binarised
grid. Complete this recognition-only change before resuming the Canny-based
binarisation investigation, so segmentation and recognition changes can be
measured independently.

## Scope

This design starts from the `corpus.db` evidence introduced by commit
`b708d8b`:

- `evaluations.grid_corners` records the detected grid quadrilateral in the
  original image;
- `cell_reads.gray_pixels` records the variable-sized greyscale crop from the
  same warped-grid bounding box as `source_pixels`;
- `cell_reads.predicted_label` and the existing puzzle, evaluation, cell, and
  rectangle fields provide the provisional label and provenance.

Capturing those fields is an upstream dependency, not part of this work. This
work covers dataset export, label review, dataset selection, training,
validation, and the eventual production pipeline switch.

The first greyscale training experiment uses only real corpus crops. Synthetic
font samples are excluded entirely.

## Non-goals

- Do not change digit segmentation, bounding-box selection, cage-border
  detection, or puzzle binarisation while preparing or evaluating the new
  recogniser.
- Do not add another Python implementation of grid location, crop geometry,
  normalisation, feature extraction, or inference. Production image operations
  remain TypeScript-owned and Python invokes retained TypeScript operations
  through the private bridge.
- Do not mutate provisional labels or raw evidence in `corpus.db`.
- Do not deploy a candidate merely because it fits or performs well on its
  training samples.

## Entry Conditions

The selected source evaluation is `full-corpus-b708d8b`, produced from
`master` commit `b708d8be538d816c37c9a42e3dc5b4a9f59e5bbe`. Its completed
entry audit records 3,001 terminal evaluations for 3,001 distinct registered
puzzles, with no duplicate or unfinished evaluations. It contains 96,278 digit
reads, with no missing `gray_pixels`, `source_pixels`, or `grid_corners`.
Older evaluation identities must not be mixed into this source population.

Dataset export may begin only after the selected evaluation run has completed.
The exporter must fail before writing an output if any of these checks fails:

1. No evaluation rows for the selected `git_hash` remain `running`.
2. Every puzzle expected in the selected corpus has one terminal evaluation
   row for that `git_hash`, with duplicates and missing puzzles reported.
3. Every selected `cell_reads` row has non-null, positive source dimensions,
   complete bounding-box coordinates, and `gray_pixels` of exactly
   `source_width * source_height` bytes.
4. Every selected row has a label in `0..9` and a supported cell type
   (`given_digit` or `cage_total_digit`).
5. Grid-corner and greyscale-crop coverage is reported for the full run before
   any quality filter is applied. Historical rows that predate these fields are
   reported and excluded, never reconstructed silently.

## Source Population and Provisional Labels

The initial source pool consists of digit reads joined to terminal evaluations
from one explicitly selected evaluation identity. A row is eligible for label
review when:

- `evaluations.status = 'done'`;
- `evaluations.bucket = 'clean'`;
- `evaluations.spec_error IS NULL`;
- its greyscale crop and bounding-box evidence pass the entry checks above.

Both given digits and cage-total digits are included. The provisional expected
label is `cell_reads.predicted_label`. A clean solve is strong evidence for that
label but not ground truth; clustering and human review remain mandatory.

The exported source record retains:

- puzzle content hash and original path;
- evaluation identity and grid corners;
- cell type, row, column, and digit index;
- provisional label, confidence, and clash evidence;
- source rectangle and variable-sized greyscale pixels;
- the corresponding binarised source crop and deployed recognition crop for
  audit only.

Exact duplicates are removed before clustering using label, geometry, and
greyscale pixels. Duplicate counts and all source identities represented by a
retained sample remain in the export report. Near-duplicate detection may be
reported for review, but the first version does not delete near duplicates
automatically.

## Greyscale Normalisation Candidates

The raw variable-sized greyscale crop is the durable source of truth. A named,
versioned production TypeScript operation converts it to a 64x64 recogniser
input. The first comparison uses a deliberately small set of candidates:

1. polarity normalisation plus centred, aspect-preserving letterboxing;
2. percentile contrast normalisation before the same centred letterboxing;
3. local-background subtraction followed by contrast normalisation and the
   same centred letterboxing.

All candidates use deterministic greyscale ink-mass centring. None uses
positional jitter or converts the crop through the puzzle's binarisation method.
The comparison chooses one production operation using the validation split and
visual inspection of normalised cluster populations. Configuration and output
representation are recorded in the training manifest, and unsupported or
missing values are rejected when loading a model.

## Four-cluster Label Review

For each provisional digit `0..9`, normalise its greyscale samples with the
candidate preprocessing under review, compute a deterministic feature
representation, reduce it deterministically where necessary, and fit four
clusters with random seed 0.

The review artifact contains 40 groups: ten digits times four clusters. Each
group shows:

- the greyscale cluster mean;
- the number of members;
- representative samples nearest the cluster centre;
- distant or outlying members;
- the given-digit/cage-total composition;
- source corpus or publication composition;
- puzzle and cell identifiers for every displayed example.

Means provide the fast label sanity check that previously exposed the 3-to-7
mislabel population. Representatives and outliers are also required because a
mixed cluster can average into a plausible-looking but misleading mean.

Human decisions are written to a separate, versioned corrections file keyed by
`(puzzle_hash, evaluation identity, cell_type, row, col, digit_index)`. Each
decision is either a corrected label or an exclusion with a reason. The review
tool never updates `corpus.db`.

After review, the exporter reapplies corrections and exclusions, reclusters the
population, and regenerates the artifact. The post-correction cluster means and
representatives must be reviewed before the dataset is frozen.

## Dataset Selection and Splitting

Balancing happens only after label review. Selection balances digits and their
four reviewed appearance clusters while retaining legitimate difficult
examples. It also limits dominance by a single puzzle or publication source.

Training, validation, and final test allocations are made by puzzle hash, never
by individual crop. Consequently, no digit crop from a puzzle can occur in more
than one split. The final test split is not used for preprocessing selection,
model selection, thresholds, or confidence calibration.

The frozen dataset manifest records:

- source evaluation and corpus identities;
- evaluation-completeness audit;
- exporter and selection versions;
- selection and clustering seeds;
- corrections-file content hash;
- chosen preprocessing identifier and parameters;
- exact sample identities and split membership;
- per-digit, per-cluster, per-cell-type, and per-source counts;
- exclusions and shortfalls.

The manifest and correction file are authoritative; generated pixel bundles and
review images are reproducible artifacts rather than hand-edited sources.

## Training

The first candidate retains the current two-stage recogniser architecture so
the input representation is the primary experimental variable:

1. four cluster-mean templates per digit provide the fast path;
2. a class-mean projection plus one-vs-one RBF SVM provides the fallback.

Training consumes only reviewed real greyscale crops. It does not generate or
load synthetic fonts. It applies no translation jitter. Binary-specific
erosion/dilation augmentation is disabled for the initial candidate. Any later
photometric augmentation is a separately evaluated experiment and must be
described in the manifest.

Every training run writes a complete manifest including pre-augmentation and
fit-set sizes, class and cluster distributions, source weights, random seeds,
preprocessing configuration, model parameters, input representation, and Git
commit. No machine-dependent source such as the installed system-font set may
affect the run.

## Offline Validation

Before browser integration, compare candidate preprocessing and models using
only the training and validation puzzle splits. Report:

- overall and per-digit accuracy;
- confusion matrix;
- given-digit and cage-total accuracy separately;
- accuracy and sample count by reviewed cluster and source;
- template fast-path precision, recall, and fallback rate;
- RBF fallback accuracy;
- confidence calibration;
- explicit results for historically difficult confusion pairs, including
  1/7, 3/7, 3/8, 6/8, 6/9, and narrow zeroes.

After all choices and thresholds are frozen, run the final test split once and
publish the same report. Acceptance requires no important regression against
the current binary recogniser evaluated on exactly the same held-out reads; a
high aggregate score alone is insufficient.

## Production Integration

Only after offline acceptance does the browser switch recognition input:

1. segmentation and bounding-box selection continue to use the existing
   binarised grid;
2. each selected rectangle is paired with the corresponding crop from
   `warped_gry`;
3. the chosen production TypeScript greyscale normalisation produces the 64x64
   model input;
4. the greyscale-trained model performs recognition;
5. evaluation continues to retain greyscale, binarised, rectangle, label, and
   grid evidence.

The model manifest must identify the greyscale input representation and named
normalisation operation. Model loading fails explicitly if the browser cannot
provide the declared representation. A binary model must never silently
receive greyscale input, or vice versa.

## Full-corpus Validation

Run the integrated candidate through the complete production browser corpus
after the source evaluation and all offline work are complete. Compare it with
the current baseline using:

- clean, backtracked, not-solved, timeout, and failure counts;
- puzzle-level fixes and regressions;
- `spec_hash` changes;
- digit-read changes by digit, cell type, cluster, and source;
- processing time, fallback rate, and model size.

Every regression receives a puzzle-level explanation before deployment. The
greyscale recogniser becomes the new baseline only after explicit review and
approval. Canny-based segmentation or binarisation experiments resume only
after that baseline is established.

## Deliverables and Sequence

1. Audited greyscale source-pool export from a completed evaluation.
2. Initial four-cluster review artifact and durable correction decisions.
3. Corrected/reclustered review artifact and approval.
4. Frozen puzzle-level train/validation/test manifest.
5. Greyscale normalisation comparison and selected production operation.
6. Reproducible model candidate and offline validation report.
7. Browser integration behind an explicit model/input contract.
8. Full-corpus comparison and deployment decision.

Each deliverable is independently reviewable. No later stage starts by
silently accepting an incomplete or unreviewed artifact from an earlier stage.
