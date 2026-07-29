# Digit Recognition

The production web app has one digit-recognition architecture: 64×64 letterboxed
crops, TypeScript HOG plus hole-count feature extraction, and an OvO RBF SVM. The
model manifest uses `classifier_type: "rbf"`; the browser rejects the retired
`pca_rbf` and `linear` formats explicitly.

TypeScript is the source of truth for every operation required by production:
bounding-box crop handling, recognition warping, feature extraction, model loading,
and inference. Python is limited to orchestration and fitting. When Python needs
production features or predictions it calls the TypeScript implementation through
`killer_sudoku/training/ts_bridge.py`; it must not reproduce those algorithms.

## Crop contract

A corpus sample stores the raw bounding-box pixels copied from the warped grid,
together with its width and height. Cropping is therefore fixed at acquisition time,
while the training/evaluation pipeline may select a named recognition warp such as
`letterbox` or `stretch`. A raw crop must never be described as a thumbnail or used as
classifier input without first applying the selected production warp.

Schema-v2 browser exports distinguish strategy-neutral source pixels from canonical
64×64 `recognitionPixels`. The latter exist for exact deployed-model auditing;
`web/scripts/validate-model.ts` consumes them through the real `loadNumRecogniser`
path and never rewarps them.

## Historical note

Earlier investigations compared a warped PCA/template recogniser with a letterbox
HOG recogniser. Those paths did not isolate crop geometry from classifier choice and
kept independently implemented Python and TypeScript inference alive. The PCA,
linear-classifier, comparison, and NPZ-conversion paths have been retired. Historical
measurements remain in `docs/pca-hog-combination-results.md`, but they are not current
architecture or operating instructions.
