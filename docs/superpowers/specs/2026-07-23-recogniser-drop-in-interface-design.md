# Digit recogniser drop-in interface — design

## Context

The digit recogniser has had two architectures over its history: HOG+LinearSVC/OVO-SVC
(`classifier_type: "linear"`/`"rbf"`, live 2026-05-01 to 2026-07-22) and PCA+RBF-SVM+templates
(`classifier_type: "pca_rbf"`, current, restored in the Stage 5 revert). Neither the app's
call sites nor the retrainer (`web/train_recogniser.py`) treat these as interchangeable
today — crop geometry (`getWarpFromRect` direct-stretch vs the deleted `letterboxWarp`
aspect-preserving crop) is hardcoded at call sites rather than owned by the active
recogniser, and the retrainer only knows how to produce a PCA+RBF model since last
session's rewrite (`c43e99d`).

This spec covers refactoring both sides so swapping recognisers is a true drop-in change —
enabling a benchmark of the last-committed HOG model (`99cbb70`) against the current PCA
model, without retraining HOG right now (its weights are reused from git history).

**Out of scope:** actually running the benchmark and deciding which architecture to keep;
retraining HOG; the vestigial `_splitRec`/`split_recogniser.bin` dead-code path found
during investigation (unused parameter in `parsePuzzleImage`, pre-existing, unrelated).

## TypeScript side (`web/src/image/numberRecognition.ts`)

### Class hierarchy

Replace the current `NumRecogniser` data interface + free `classify()`/`recognise()`
dispatch functions with a class hierarchy, matching this codebase's existing polymorphism
idiom (`BoardState`/`KillerBoardState`/`BigAppleBoardState` in `web/src/engine/boardState.ts`):

```ts
export abstract class NumRecogniser {
  constructor(readonly confidenceThreshold: number) {}
  abstract recognise(imgs: Uint8Array[]): Recognition[];
  abstract warpForRecognition(cv: Cv, warpedBlk: OpenCVMat, br: BRect, targetSize: number): Uint8Array;
}

class PcaRbfRecogniser extends NumRecogniser {
  constructor(private readonly pca: PCAParams, private readonly classifier: RBFClassifier, confidenceThreshold: number) {
    super(confidenceThreshold);
  }
  recognise(imgs) { /* template-match fast path + PCA+RBF fallback — moved verbatim from today's classify() */ }
  warpForRecognition(cv, warpedBlk, [x, y, w, h], targetSize) {
    // Same axis-aligned quad construction already used 3x in this file today —
    // no new helper, just inlined as it is at each existing call site.
    const src = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    return getWarpFromRect(cv, src, warpedBlk, targetSize, targetSize);
  }
}

class HogRecogniser extends NumRecogniser {
  constructor(private readonly hog: HOGParams, private readonly classifier: Classifier, confidenceThreshold: number) {
    super(confidenceThreshold);
  }
  recognise(imgs) { /* hogExtract + extractHoleFeatures + linear/rbf predict — moved verbatim from today's classify() */ }
  warpForRecognition(cv, warpedBlk, [x, y, w, h], targetSize) {
    return letterboxWarp(cv, x, y, w, h, warpedBlk, targetSize, targetSize);
  }
}
```

`letterboxWarp` is restored verbatim from git history (`701423a^`) — it's a thin wrapper
computing a padded destination quad and delegating to the unchanged `getWarpFromRect`, so
no changes are needed to `getWarpFromRect` itself.

`splitNum`'s *other* `getWarpFromRect` call (the whole-cell `mergedThumb`, used only for
the 1-vs-2-digit split decision via peak detection, never classified) is untouched — crop
geometry there is not a recogniser concern.

### Single active instance, no parameter threading

```ts
let _active: NumRecogniser | null = null;

export function setActiveRecogniser(rec: NumRecogniser): void { _active = rec; }

function activeRecogniser(): NumRecogniser {
  if (_active === null) throw new Error('No recogniser loaded — call setActiveRecogniser() first');
  return _active;
}

export function loadNumRecogniser(binBuffer, manifestJson): NumRecogniser {
  // the ONLY branch point in the whole system
  return manifestJson.classifier_type === 'pca_rbf'
    ? new PcaRbfRecogniser(pca, classifier, confidenceThreshold)
    : new HogRecogniser(hog, classifier, confidenceThreshold);
}
```

`loadNumRecogniser` stays a pure factory (no side effects) — `store.ts` also loads a
second, unrelated `NumRecogniser` instance for the vestigial split-classifier path, and
auto-setting the singleton inside the factory would let that second load silently
overwrite the real active instance. `store.ts`'s main-recogniser loader calls
`setActiveRecogniser()` explicitly right after constructing the primary instance; the
split-classifier loader does not.

`splitNum`, `readClassicDigits`, and `buildCageTotals` drop their `rec: NumRecogniser`
parameter entirely and call `activeRecogniser()` internally instead. Traced the full
chain — parameter threading is exactly 3 layers deep in production code today:
`numberRecognition.ts` (`splitNum`, `readClassicDigits`) → `inpImage.ts`
(`buildCageTotals`, `parsePuzzleImage`) → `session/actions.ts` (`uploadPuzzle`). All of
them currently hold `rec` only to pass it further down; none use it for anything else, so
the parameter disappears cleanly at every layer.

`store.ts`'s existing `getRec()`/`_rec` (used once, in `uploadPuzzle`, purely as a
"has the model finished loading yet" null-check gate for UI purposes) is unaffected —
different concern, no circular-import risk since it doesn't reach into
`numberRecognition.ts` internals.

### Call-site migration (free `recognise()` → method call)

Full enumerated list (6 call sites, 4 files) — the free function is deleted, not kept as
a compatibility wrapper:

- `web/src/image/numberRecognition.ts` — `readClassicDigits` (internal)
- `web/src/image/inpImage.ts` — `buildCageTotals`
- `web/src/image/numberRecognition.test.ts` — 3 call sites
- `web/scripts/report-browser-train-failures.ts` — 1 call site

### Per-architecture test fixture

`numberRecognition.test.ts`'s known-failure hash list becomes per-architecture:
`web/known-model-failure-hashes-{classifier_type}.json`, selected by the loaded model's
`classifier_type` at test setup. `web/known-stale-training-hashes.json` (the trainer's
permanent geometry-exclusion list) is unaffected — that one was already correctly
independent of which model is shipped.

## Python side (`web/train_recogniser.py`)

Same principle: a single active instance, no CLI flag, no branching.

```python
class NumRecogniser(ABC):
    @abstractmethod
    def fit_to_thumbnail(self, crop: NDArray[np.uint8], win_size: int) -> NDArray[np.uint8]: ...
    @abstractmethod
    def extract_features(self, imgs: NDArray[np.uint8]) -> NDArray[np.float64]: ...
    @abstractmethod
    def fit(self, X, y, sample_weights) -> dict[str, Any]: ...
    @abstractmethod
    def save(self, model: dict[str, Any], out_dir: Path, **thresholds) -> None: ...


class PcaRbfRecogniser(NumRecogniser):
    def fit_to_thumbnail(self, crop, win_size):
        # Direct stretch, no aspect preservation — matches getWarpFromRect.
        return np.array(Image.fromarray(crop).resize((win_size, win_size), Image.Resampling.LANCZOS), dtype=np.uint8)
    def extract_features(self, imgs): return imgs.reshape(len(imgs), -1).astype(np.float64)
    def fit(self, X, y, sample_weights): ...   # PCA-on-class-means + RBF-SVM, today's code
    def save(self, model, out_dir, **t): ...    # pca_rbf manifest, today's code


class HogRecogniser(NumRecogniser):
    def fit_to_thumbnail(self, crop, win_size):
        # Pad to a square (aspect-preserving), then uniform-scale — matches letterboxWarp.
        # Today's generate_synthetic_samples logic, moved here unchanged.
        h_c, w_c = crop.shape
        side = max(h_c, w_c)
        square = np.zeros((side, side), dtype=np.uint8)
        square[(side - h_c) // 2:(side - h_c) // 2 + h_c, (side - w_c) // 2:(side - w_c) // 2 + w_c] = crop
        return np.array(Image.fromarray(square).resize((win_size, win_size), Image.Resampling.LANCZOS), dtype=np.uint8)
    def extract_features(self, imgs): return np.hstack([extract_hog(imgs), extract_hole_features(imgs)])
    def fit(self, X, y, sample_weights): ...   # LinearSVC/RBF OVO, restored from git history (99cbb70^)
    def save(self, model, out_dir, **t): ...    # linear/rbf manifest, restored from git history


ACTIVE_RECOGNISER: NumRecogniser = PcaRbfRecogniser()  # the one line that decides everything
```

`main()` becomes: `build_dataset` dithers (shared, architecture-independent, unchanged)
then calls `ACTIVE_RECOGNISER.extract_features(...)`; then `ACTIVE_RECOGNISER.fit(...)`;
then `ACTIVE_RECOGNISER.save(...)`. Switching architectures means changing the one
`ACTIVE_RECOGNISER = ...` line — no `--classifier` flag, no `if`/`else` scattered through
the pipeline. This mirrors the TS side's single point of truth (there, which model files
ship; here, which class is instantiated).

Cropping is partially a Python-class concern, and this needed correcting from an earlier
draft of this spec: `load_training_file` (browser/bulk JSON, already 64×64) and
`dither_batch` (operates on already-fixed-size arrays) never touch variable-aspect-ratio
pixels, so they're unaffected either way. But `generate_synthetic_samples` does — it
crops each rendered glyph to a tight bounding box (variable aspect ratio) and must decide
how to fit that into a 64×64 thumbnail. Today this is hardcoded to pad-to-square-then-scale
(letterbox-style) regardless of which architecture is active, which would silently train
PCA on synthetic samples shaped like HOG's crop geometry — the exact class of mismatch
`known-stale-training-hashes.json` exists to paper over, reintroduced by a different route.
`generate_synthetic_samples` calls `ACTIVE_RECOGNISER.fit_to_thumbnail(crop, win_size)`
instead of doing the pad+resize inline. `extract_hog`/`extract_hole_features` (kept as
utilities in last session's rewrite) become `HogRecogniser.extract_features`'s
implementation; no change to those functions themselves.

`tests/test_train_recogniser.py` gets a `HogRecogniser`-equivalent of
`test_save_model_pca_rbf_keys` (manifest schema round-trip), matching the existing
`_make_samples`/`build_dataset` fixture pattern.

## Benchmark workflow (using this once built — not part of this refactor's own testing)

1. `git show 99cbb70:web/public/num_recogniser.bin` / `.json` → extract to a temp location.
2. Backup current (`pca_rbf`) `web/public/num_recogniser.{bin,json}`.
3. Swap in the extracted HOG files.
4. Run `evaluate-corpus.ts`, record bucket/accuracy stats.
5. Restore the PCA backup.
6. Compare stats between runs.

No new tooling needed for this — it's the same backup/swap/restore pattern already used
last session to validate the CI-rehearsal PCA model before reverting it.

## Testing

- New unit tests for `PcaRbfRecogniser`/`HogRecogniser` in TS: construct via
  `loadNumRecogniser` with a `pca_rbf` vs `linear`/`rbf` manifest, verify
  `warpForRecognition` picks the correct crop method, `recognise` produces sane output on
  a synthetic/known image.
- Existing `numberRecognition.test.ts` accuracy suite continues to run against whichever
  model is currently loaded, gated by the per-architecture hash fixture above — becomes
  the regression gate for either architecture, not just PCA.
- Python: `HogRecogniser` manifest round-trip test as described above.
- Full bronze gate (tsc ×2, `npm test`, ruff, mypy) before any commit, per this repo's
  established workflow.
