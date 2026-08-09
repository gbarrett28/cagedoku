# Greyscale Digit Recogniser — Interim Results

## Scope and source

- Source evaluation: `full-corpus-b708d8b` only (master `b708d8be538d816c37c9a42e3dc5b4a9f59e5bbe`).
- Eligible source: 3,001/3,001 completed puzzles and 95,585 digit rows from clean solves with complete greyscale evidence.
- Review set: 400 samples per digit, stratified over four clusters per digit (4,000 samples total). All 40 cluster means were visually consistent with their provisional labels.
- The existing trainer deduplicated the review set to 3,528 unique crops.
- Synthetic fonts and translation jitter were disabled in every candidate.

## Candidate results

| Candidate | Training rows | Projection | Model size | Review-set accuracy | 53-puzzle smoke result |
|---|---:|---:|---:|---:|---:|
| Initial experiment | 3,528 | 39 between-cluster, 0 residual | 2,852,456 bytes | 3,583/4,000 (89.6%) | 19 clean, 6 backtracked, 28 not solved |
| Residual diagnostic | 3,528 | 39 between-cluster, 200 residual | 11,414,632 bytes | 3,680/4,000 (92.0%) | 26 clean, 4 backtracked, 23 not solved |
| Non-spatial augmentation diagnostic | 21,168 | 39 between-cluster, 50 residual | 5,840,840 bytes | 3,955/4,000 (98.9%) | 42 clean, 2 backtracked, 9 not solved |

The smoke puzzles were all `clean` in the baseline `full-corpus-b708d8b` evaluation. The non-spatial augmentation diagnostic used the trainer's existing PCA mode, which disables translation and keeps every crop centred, but it does add morphology/noise variants and therefore is not the zero-augmentation first experiment specified in the plan.

## Decision

Reject all current greyscale models for deployment. The best candidate still regressed 9 of 53 baseline-clean puzzles, so a 3,001-puzzle evaluation would not be a responsible use of time and its failures must not be added to the recogniser allowlist.

The production binary model and `web/corpus_train.json` remain unchanged. The safe preparatory changes retain the greyscale exporter, model manifest support, and same-box greyscale pipeline wiring; those paths remain dormant while the bundled manifest selects binary input.

## Recommended next experiment

Increase the number of real corpus crops per digit before changing the recogniser architecture or adding more tooling. The completed corpus contains far more than the 400-per-digit review sample, and the smoke progression shows that additional variation materially improves greyscale recognition. Re-run the existing exporter with a larger per-digit cap, retain the same four-cluster review, then train with centred crops and no translation jitter.
