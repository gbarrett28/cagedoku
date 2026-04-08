# Bundled Number Recogniser Design

## Goal

Replace the joblib-serialised nums_pca_s.pkl with a pure-numpy .npz file
committed to the repository, so `pip install cagedoku && coach` works out of
the box with no environment variables and no model download step.

## Architecture

Training still uses scikit-learn SVC to fit the classifier. After fitting,
the SVC internal arrays are extracted into a new RBFClassifier dataclass that
implements the _Classifier protocol using ~25 lines of pure numpy (OvO RBF SVM
decision function). Everything -- PCA arrays, RBF arrays, template images,
scalar parameters -- is saved to a single compressed .npz file via
numpy.savez_compressed. That file is committed to killer_sudoku/data/ and
loaded at runtime via importlib.resources, requiring no configuration.

scikit-learn is a training-only dependency. The coach app (inference path)
requires only numpy.

## Tech Stack

- numpy.savez_compressed / numpy.load  -- serialisation
- importlib.resources                  -- bundled model access
- scikit-learn SVC                     -- training only, not at inference

---

## File Structure

### New files
- killer_sudoku/data/__init__.py           -- empty; makes dir a package
- killer_sudoku/data/num_recogniser.npz   -- committed trained model
- tests/image/test_number_recognition.py  -- new unit tests

### Modified files
- killer_sudoku/image/number_recognition.py  -- RBFClassifier, save/load
- killer_sudoku/image/inp_image.py           -- make_num_recogniser simplified
- killer_sudoku/image/config.py              -- remove num_recogniser_file
- killer_sudoku/api/config.py               -- remove num_recogniser_path
- killer_sudoku/api/routers/puzzle.py        -- remove model path guard
- killer_sudoku/training/train_number_recogniser.py  -- save .npz, --output flag
- pyproject.toml                             -- package-data for .npz

---

## Component Design

### RBFClassifier

New frozen dataclass in killer_sudoku/image/number_recognition.py.
Implements the _Classifier protocol. Constructed from a fitted sklearn SVC
by extracting its internal arrays; sklearn is not imported at inference time.

Fields:
  support_vectors  float64  (n_sv, dims)        SVM support vectors
  dual_coef        float64  (n_classes-1, n_sv)  dual coefficients
  intercept        float64  (n_classifiers,)     intercepts
  n_support        intp     (n_classes,)         SVs per class
  gamma            float                         RBF kernel width
  classes          intp     (n_classes,)         class labels (0-9)

predict(x) algorithm:
  1. K[i,j] = exp(-gamma * ||x_i - sv_j||^2)  -- RBF kernel matrix
  2. For each class pair (i,j) in OvO: compute binary decision value
     from dual_coef and intercept; vote for winning class.
  3. Return classes[argmax(votes, axis=1)].

### .npz file layout

Key                  dtype    shape                 Description
pca_components       float64  (n_components, s^2)   PCA eigenvectors
pca_mean             float64  (s^2,)                PCA training mean
dims                 int64    scalar                PCA dims at inference
rbf_support_vectors  float64  (n_sv, dims)          support vectors
rbf_dual_coef        float64  (n_classes-1, n_sv)   dual coefficients
rbf_intercept        float64  (n_classifiers,)      intercepts
rbf_n_support        int64    (n_classes,)          SVs per class
rbf_gamma            float64  scalar                RBF gamma
rbf_classes          int64    (n_classes,)          class labels (0-9)
template_threshold   float64  scalar                template match threshold
template_0..9        float32  (s, s)                per-digit mean images

s = subres (default 128). Scalars stored as 0-d arrays; read with .item().

### save_number_recogniser(model, path)

New function in number_recognition.py. Requires model.classifier to be
an RBFClassifier. Calls numpy.savez_compressed with all arrays above.

### load_number_recogniser(path)

Updated. Dispatches on suffix:
  .npz  -- reconstructs RBFClassifier and PCA from arrays; no sklearn
  .pkl  -- joblib load (migration only); emits DeprecationWarning
  other -- raises ValueError

PCA reconstruction: set components_, mean_, n_components_, n_features_in_
directly on a bare PCA() instance; transform() then works without re-fitting.

### InpImage.make_num_recogniser()

Simplified to a no-argument static method. Always loads from the bundled
package resource via importlib.resources. All call sites updated.

### train_number_recogniser.py changes

After sklearn SVC fit: extract arrays into RBFClassifier, wrap in
CayenneNumber, call save_number_recogniser(model, output_path).
New --output flag, default killer_sudoku/data/num_recogniser.npz.
joblib.dump removed.

---

## Removed

- num_recogniser_file field on ImagePipelineConfig
- num_recogniser_path property on ImagePipelineConfig
- num_recogniser_path field on CoachConfig
- COACH_NUM_RECOGNISER_PATH environment variable
- test_upload_returns_500_when_model_not_configured in test_startup.py

---

## Tests -- tests/image/test_number_recognition.py

test_rbf_classifier_matches_sklearn_svc
  Fit tiny SVC (3 classes, 5-dim, ~30 samples), extract to RBFClassifier,
  assert predict(X) == svc.predict(X) for all training samples.

test_save_load_roundtrip
  Save synthetic CayenneNumber to tmp .npz, reload, assert arrays equal
  and predict() identical on a small test batch.

test_pkl_migration_still_loads
  Write minimal CayenneNumber via joblib to tmp .pkl, load via
  load_number_recogniser, assert usable and DeprecationWarning emitted.

---

## Developer Re-training Workflow

  ks-collect-numerals --puzzle-dir <dir>
  ks-train-numbers --puzzle-dir <dir>
  # default --output writes to killer_sudoku/data/num_recogniser.npz
  git add killer_sudoku/data/num_recogniser.npz
  git commit -m "chore: retrain number recogniser"

pip install -e . means the written file is live immediately; no reinstall.
