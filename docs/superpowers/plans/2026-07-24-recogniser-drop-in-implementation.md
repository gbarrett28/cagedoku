# Digit Recogniser Drop-In Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the digit recogniser (TS app + `web/train_recogniser.py` retrainer +
`web/extract_guardian_samples.py` bulk extractor) into a `NumRecogniser` class hierarchy
(`PcaRbfRecogniser`/`HogRecogniser` in both languages) so swapping between the current
PCA+RBF architecture and the historical HOG+LinearSVC one is a true drop-in change, ready
to benchmark the last-committed HOG model (`99cbb70`) against current PCA.

**Architecture:** Per
`docs/superpowers/specs/2026-07-23-recogniser-drop-in-interface-design.md`: an abstract
base class per language, one concrete subclass per architecture, and exactly one dispatch
point per language (TS: `classifier_type` read once in `loadNumRecogniser`; Python: the
`ACTIVE_RECOGNISER = PcaRbfRecogniser()` module constant). No flags, no parameter
threading — a module-level singleton (`activeRecogniser()` in TS) replaces passing `rec`
through every call site.

**Tech Stack:** TypeScript (vitest), Python 3.12 (pytest, numpy, scikit-learn, numba,
Pillow, opencv-python-headless).

## Global Constraints

- Full bronze gate (`bash scripts/run-bronze-gate.sh` from repo root) must pass before
  every commit — `tsc --noEmit` ×2, `npm test`, `ruff check .`, `mypy . --ignore-missing-imports`.
- No `#noqa`/inline `# type: ignore` — per-file-ignores in `pyproject.toml` with a comment,
  per `shipwright:python-guidelines`.
- No backward-compatibility shims: the free `recognise()` TS function and the standalone
  `letterbox_warp` Python function are deleted, not kept as wrappers, once their last
  caller is migrated within the same task.
- **Scoped deviation from the approved spec, flagged here rather than silently applied:**
  `HogRecogniser.fit()` (Python) restores only the direct-RBF-SVM branch of the original
  `fit_model`, not the checkpointed LinearSVC/OVO branch (joblib `Parallel` + hashlib
  fingerprinting + resumable `.svm_checkpoints/` files) that actually produced `99cbb70`'s
  shipped model. That machinery is a resilience/performance optimisation for a specific
  large training run, not exercised by this plan's own tests (the benchmark reuses
  `99cbb70`'s files directly via `git show`, never re-running `fit()` against them) —
  restoring it is deferred to if/when a full from-scratch HOG retrain is actually needed.
  A fresh HOG retrain via this class produces an RBF-kernel HOG model, not bit-identical
  to `99cbb70`.

---

## Task 1: TS — `NumRecogniser` class hierarchy (additive, `numberRecognition.ts` only)

Self-contained to one file. `splitNum`/`readClassicDigits`/all external call sites are
**unchanged** in this task — the free `recognise()` function stays, now implemented as a
one-line delegation to the new classes. This task is safe to land alone: every existing
test (including Playwright e2e, which exercises the real upload pipeline) keeps passing
unchanged, because no external-facing behavior changes yet.

**Files:**
- Modify: `web/src/image/numberRecognition.ts`
- Test: `web/src/image/numberRecognition.test.ts`

**Interfaces:**
- Produces: `export abstract class NumRecogniser { confidenceThreshold: number; abstract recognise(imgs: Uint8Array[]): Recognition[]; abstract warpForRecognition(cv: Cv, warpedBlk: OpenCVMat, br: BRect, targetSize: number): Uint8Array; }`, `export class PcaRbfRecogniser extends NumRecogniser`, `export class HogRecogniser extends NumRecogniser`, `export function loadNumRecogniser(binBuffer, manifestJson): NumRecogniser` (return type changes from the old plain-object interface to the new class instances; call signature unchanged).

- [ ] **Step 1: Write failing dispatch tests**

Add to `web/src/image/numberRecognition.test.ts`, right after the existing `describe('digit recogniser — TypeScript PCA+RBF inference on training data', ...)` block closes (after its final `});`, before the file's other describes if any — this file currently has only that one top-level describe, so append at end of file):

```ts
import { PcaRbfRecogniser, HogRecogniser } from './numberRecognition.js';

describe('loadNumRecogniser class dispatch', () => {
  it('returns a PcaRbfRecogniser instance for classifier_type "pca_rbf"', () => {
    expect(rec).toBeInstanceOf(PcaRbfRecogniser);
    expect(rec).not.toBeInstanceOf(HogRecogniser);
  });

  it('returns a HogRecogniser instance for classifier_type "linear"', () => {
    const manifest = { classifier_type: 'linear', arrays: {
      hog_win_size:     { dtype: 'int32',   shape: [1],  offset: 0,  byteLength: 4 },
      hog_cell_size:    { dtype: 'int32',   shape: [1],  offset: 4,  byteLength: 4 },
      hog_block_size:   { dtype: 'int32',   shape: [1],  offset: 8,  byteLength: 4 },
      hog_block_stride: { dtype: 'int32',   shape: [1],  offset: 12, byteLength: 4 },
      hog_nbins:        { dtype: 'int32',   shape: [1],  offset: 16, byteLength: 4 },
      confidence_threshold: { dtype: 'float64', shape: [1], offset: 24, byteLength: 8 },
      classes:          { dtype: 'int32',   shape: [2],  offset: 32, byteLength: 8 },
      linear_coef:      { dtype: 'float64', shape: [1, 2], offset: 40, byteLength: 16 },
      linear_intercept: { dtype: 'float64', shape: [1],  offset: 56, byteLength: 8 },
    } };
    const buf = new ArrayBuffer(64);
    new DataView(buf).setInt32(0, 64, true);   // hog_win_size
    new DataView(buf).setInt32(4, 8, true);    // hog_cell_size
    new DataView(buf).setInt32(8, 16, true);   // hog_block_size
    new DataView(buf).setInt32(12, 8, true);   // hog_block_stride
    new DataView(buf).setInt32(16, 9, true);   // hog_nbins
    new DataView(buf).setFloat64(24, 0.7, true); // confidence_threshold
    new DataView(buf).setInt32(32, 1, true);   // classes[0]
    new DataView(buf).setInt32(36, 2, true);   // classes[1]
    const hogRec = loadNumRecogniser(buf, manifest);
    expect(hogRec).toBeInstanceOf(HogRecogniser);
    expect(hogRec).not.toBeInstanceOf(PcaRbfRecogniser);
  });
});
```

(`rec` here is the module-level `let rec: NumRecogniser;` already populated in this file's
existing `beforeAll` from `web/public/num_recogniser.{bin,json}` — those ship as
`classifier_type: "pca_rbf"` today, so the first test exercises the real production model.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run numberRecognition`
Expected: FAIL — `PcaRbfRecogniser`/`HogRecogniser` are not exported yet (`SyntaxError` or `undefined` import).

- [ ] **Step 3: Replace the `NumRecogniser` interface with the abstract class + subclasses**

In `web/src/image/numberRecognition.ts`, replace (exact current text, ends the
`// NumRecogniser` section):

```ts
export interface NumRecogniser {
  hog?: HOGParams;
  pca?: PCAParams;
  classifier: Classifier;
  confidenceThreshold: number;
}
```

with:

```ts
export abstract class NumRecogniser {
  constructor(readonly confidenceThreshold: number) {}
  abstract recognise(imgs: Uint8Array[]): Recognition[];
  abstract warpForRecognition(cv: Cv, warpedBlk: OpenCVMat, br: BRect, targetSize: number): Uint8Array;
}

export class PcaRbfRecogniser extends NumRecogniser {
  constructor(
    private readonly pca: PCAParams,
    private readonly classifier: RBFClassifier,
    confidenceThreshold: number,
  ) {
    super(confidenceThreshold);
  }

  recognise(imgs: Uint8Array[]): Recognition[] {
    const n = imgs.length;
    const { pca, classifier, confidenceThreshold } = this;
    const results: Recognition[] = new Array(n);
    const fallbackIndices: number[] = [];
    const fallbackImgs: Uint8Array[] = [];

    // Template matching (fast path): compare each thumbnail to every stored
    // per-digit mean template via TM_CCOEFF_NORMED; accept the best match
    // directly if it clears templateThreshold, else fall through to PCA+RBF.
    // Matches Python's CayenneNumber.get_sums exactly.
    if (pca.templates.size > 0) {
      for (let i = 0; i < n; i++) {
        const img = imgs[i]!;
        let bestScore = -2.0;
        let bestDigit = 0;
        let bestScore2 = -2.0;
        let bestDigit2 = -1;
        for (const [digit, tmpl] of pca.templates) {
          const score = templateMatchNormed(img, tmpl);
          if (score > bestScore) {
            bestScore2 = bestScore; bestDigit2 = bestDigit;
            bestScore = score; bestDigit = digit;
          } else if (score > bestScore2) {
            bestScore2 = score; bestDigit2 = digit;
          }
        }
        if (bestScore >= pca.templateThreshold) {
          results[i] = {
            label: bestDigit,
            confident: true,
            ...(bestDigit2 !== -1 ? { runnerUp: { label: bestDigit2, score: bestScore2 } } : {}),
          };
        } else {
          fallbackIndices.push(i);
          fallbackImgs.push(img);
        }
      }
    } else {
      for (let i = 0; i < n; i++) { fallbackIndices.push(i); fallbackImgs.push(imgs[i]!); }
    }

    if (fallbackImgs.length > 0) {
      const x = pcaExtract(fallbackImgs, pca);
      const recs = rbfPredictWithConfidence(classifier, x, fallbackImgs.length, confidenceThreshold);
      for (let k = 0; k < fallbackIndices.length; k++) {
        results[fallbackIndices[k]!] = recs[k]!;
      }
    }

    return results;
  }

  warpForRecognition(cv: Cv, warpedBlk: OpenCVMat, br: BRect, targetSize: number): Uint8Array {
    const [x, y, w, h] = br;
    // Same axis-aligned quad construction already used at every call site today —
    // no new helper, just inlined as it was.
    const src = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    return getWarpFromRect(cv, src, warpedBlk, targetSize, targetSize);
  }
}

export class HogRecogniser extends NumRecogniser {
  constructor(
    private readonly hog: HOGParams,
    private readonly classifier: Classifier,
    confidenceThreshold: number,
  ) {
    super(confidenceThreshold);
  }

  recognise(imgs: Uint8Array[]): Recognition[] {
    const n = imgs.length;
    const { hog, classifier, confidenceThreshold } = this;
    const hogFeat = hogExtract(imgs, hog);
    const hole = extractHoleFeatures(imgs, hog.winSize);
    const nHog = hogFeat.length / n;
    const nHole = hole.length / n;
    const x = new Float64Array(n * (nHog + nHole));
    for (let i = 0; i < n; i++) {
      x.set(hogFeat.subarray(i * nHog, (i + 1) * nHog), i * (nHog + nHole));
      x.set(hole.subarray(i * nHole, (i + 1) * nHole), i * (nHog + nHole) + nHog);
    }
    if (classifier.kind === 'linear') return linearPredict(classifier, x, n, confidenceThreshold);
    return rbfPredictWithConfidence(classifier, x, n, confidenceThreshold);
  }

  warpForRecognition(cv: Cv, warpedBlk: OpenCVMat, br: BRect, targetSize: number): Uint8Array {
    const [x, y, w, h] = br;
    return letterboxWarp(cv, x, y, w, h, warpedBlk, targetSize, targetSize);
  }
}
```

- [ ] **Step 4: Restore `letterboxWarp`**

Add this function anywhere above `loadNumRecogniser` (e.g. directly above the
`// ---------------------------------------------------------------------------\n// NumRecogniser` comment block, or right after `getWarpFromRect`'s definition — either
location compiles identically since these are all module-level declarations):

```ts
/**
 * Aspect-preserving warp: fits the source rect into resH×resW with letterbox
 * padding (centered, background-filled) rather than direct-stretch.
 *
 * Restored verbatim from git history (commit 701423a^, before it was replaced
 * by renderContourMask and later getWarpFromRect) for HogRecogniser, which was
 * trained on this crop geometry.
 */
function letterboxWarp(
  cv: Cv, ax: number, ay: number, bw: number, bh: number,
  gry: OpenCVMat, resH: number = 64, resW: number = 64,
): Uint8Array {
  const scale = Math.min((resW - 1) / bw, (resH - 1) / bh);
  const destW = bw * scale, destH = bh * scale;
  const offX = ((resW - 1) - destW) / 2, offY = ((resH - 1) - destH) / 2;
  const src = [[ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh]];
  const dst = [[offX, offY], [offX + destW, offY], [offX + destW, offY + destH], [offX, offY + destH]];
  return getWarpFromRect(cv, src, gry, resH, resW, dst);
}
```

- [ ] **Step 5: Update `loadNumRecogniser` to construct the new classes**

Replace the two `return` statements in `loadNumRecogniser` (the function body itself —
all the `getF64`/`getI32`/`scalarI32` helpers and array-reading logic above them are
unchanged):

```ts
    return { pca, classifier, confidenceThreshold: scalarF64('confidence_threshold') };
  }
```

becomes:

```ts
    return new PcaRbfRecogniser(pca, classifier, scalarF64('confidence_threshold'));
  }
```

and:

```ts
  return { hog, classifier, confidenceThreshold: scalarF64('confidence_threshold') };
}
```

becomes:

```ts
  return new HogRecogniser(hog, classifier, scalarF64('confidence_threshold'));
}
```

Also update `loadNumRecogniser`'s return type annotation — it already reads
`): NumRecogniser {` and needs no change there (the type name is reused, now backed by
the abstract class instead of the interface).

- [ ] **Step 6: Delete `classify()`, make the free `recognise()` delegate**

Delete the entire `classify()` function (its body was just moved into
`PcaRbfRecogniser.recognise()`/`HogRecogniser.recognise()` in Step 3). Replace:

```ts
export function recognise(rec: NumRecogniser, imgs: Uint8Array[]): Recognition[] {
  return classify(rec, imgs);
}
```

with:

```ts
export function recognise(rec: NumRecogniser, imgs: Uint8Array[]): Recognition[] {
  return rec.recognise(imgs);
}
```

(This keeps the free function as a thin, temporary compatibility wrapper — deleted in
Task 2 once every caller is migrated to `rec.recognise(...)` directly.)

- [ ] **Step 7: Run tsc and the full test suite**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

Run: `cd web && npx vitest run numberRecognition`
Expected: all tests pass, including the 2 new dispatch tests from Step 1 and the
pre-existing 4 accuracy tests (unchanged pass/fail counts vs before this task — this is
the regression proof that moving `classify()`'s body into the classes didn't change
behavior).

- [ ] **Step 8: Full bronze gate and commit**

Run: `bash scripts/run-bronze-gate.sh` (from repo root)
Expected: passes.

```bash
git add web/src/image/numberRecognition.ts web/src/image/numberRecognition.test.ts
git commit -m "feat: add NumRecogniser class hierarchy (PcaRbfRecogniser/HogRecogniser)

Additive only -- classify() folded into PcaRbfRecogniser.recognise()/
HogRecogniser.recognise(), letterboxWarp restored from git history for
HogRecogniser.warpForRecognition(). loadNumRecogniser now constructs class
instances instead of plain objects; free recognise() becomes a thin
rec.recognise(imgs) delegation, kept temporarily until every caller
migrates in the next task. No external call sites changed."
```

---

## Task 2: TS — drop `rec` parameter threading, wire the singleton, delete free `recognise()`

This is the atomically-coupled "big bang" step: TypeScript's compiler forces every file
in the `rec`-threading chain to change together (removing a parameter from `splitNum`
breaks its caller immediately). Touches 6 files.

**Files:**
- Modify: `web/src/image/numberRecognition.ts`
- Modify: `web/src/image/inpImage.ts`
- Modify: `web/src/session/store.ts`
- Modify: `web/src/session/actions.ts`
- Modify: `web/src/image/numberRecognition.test.ts`
- Modify: `web/scripts/report-browser-train-failures.ts`

**Interfaces:**
- Consumes: `NumRecogniser`, `PcaRbfRecogniser`, `HogRecogniser` from Task 1.
- Produces: `export function setActiveRecogniser(rec: NumRecogniser): void` (new, called
  once by `store.ts`). `splitNum(cv: Cv, br: BRect, warpedBlk: OpenCVMat, subres: number): [Uint8Array[], Uint8Array, number, number]` (signature unchanged — it never took `rec`).
  `readClassicDigits(cv: Cv, warpedBlk: OpenCVMat, subres: number, classicConf: number[][]): {...}` (drops the `rec` param, was 3rd positional). `buildCageTotals(cv: Cv, warpedBlk: OpenCVMat, subres: number, brdrs: Brdrs, includeTree?: boolean): CageTotalsResult` (drops `rec`, was 3rd positional). `parsePuzzleImage(cv: Cv, file: File, config: ImagePipelineConfig = defaultImagePipelineConfig(), _splitRec?: NumRecogniser): Promise<ParseResult>` (drops `rec`, was 3rd positional).

- [ ] **Step 1: Write a failing test for the singleton guard**

Add to `web/src/image/numberRecognition.test.ts`, inside the
`describe('loadNumRecogniser class dispatch', ...)` block added in Task 1:

```ts
  it('throws a clear error from splitNum-style internal use before any recogniser is set', () => {
    // This test only makes sense once activeRecogniser() exists and splitNum uses it --
    // verifies the guard message, not full splitNum behaviour (that needs a real cv.Mat,
    // covered by existing Playwright e2e specs).
    expect(() => activeRecogniser()).toThrow('No recogniser loaded');
  });
```

Add `activeRecogniser` to this test file's import from `./numberRecognition.js` (it will
need to be exported, not just module-private, for this one test — see Step 2).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run numberRecognition`
Expected: FAIL — `activeRecogniser` is not exported yet.

- [ ] **Step 3: Add the singleton to `numberRecognition.ts`**

Add directly above `loadNumRecogniser`'s definition:

```ts
let _active: NumRecogniser | null = null;

/** Registers rec as the recogniser splitNum/readClassicDigits use internally. */
export function setActiveRecogniser(rec: NumRecogniser): void { _active = rec; }

/** @internal exported only for the singleton-guard unit test. */
export function activeRecogniser(): NumRecogniser {
  if (_active === null) throw new Error('No recogniser loaded — call setActiveRecogniser() first');
  return _active;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run numberRecognition`
Expected: PASS (the singleton-guard test; the class-dispatch tests from Task 1 still pass too).

- [ ] **Step 5: Migrate `splitNum`'s two classification-bound crops**

In `web/src/image/numberRecognition.ts`, `splitNum`'s current body (unchanged signature):

```ts
  const halfRes = subres >> 1;
  const thumbs = rects.map(([yt, yb, xl, xr]) => {
    const src = [[xl, yt], [xr, yt], [xr, yb], [xl, yb]];
    return getWarpFromRect(cv, src, warpedBlk, halfRes, halfRes);
  });
```

becomes:

```ts
  const halfRes = subres >> 1;
  const rec = activeRecogniser();
  const thumbs = rects.map(([yt, yb, xl, xr]) =>
    rec.warpForRecognition(cv, warpedBlk, [xl, yt, xr - xl, yb - yt], halfRes),
  );
```

(The `mergedThumb` line just above this, `const mergedThumb = getWarpFromRect(cv, fullSrc, warpedBlk);`, is unchanged — established in the spec's completeness audit that it feeds a different, out-of-scope classifier.)

- [ ] **Step 6: Migrate `readClassicDigits` — drop `rec` param, use the singleton**

Replace the function signature line:

```ts
export function readClassicDigits(
  cv: Cv,
  warpedBlk: OpenCVMat,
  rec: NumRecogniser,
  subres: number,
  classicConf: number[][],
): { digits: number[][]; thumbs: Map<string, Uint8Array[]>; recognitions: Map<string, Recognition> } {
```

with:

```ts
export function readClassicDigits(
  cv: Cv,
  warpedBlk: OpenCVMat,
  subres: number,
  classicConf: number[][],
): { digits: number[][]; thumbs: Map<string, Uint8Array[]>; recognitions: Map<string, Recognition> } {
```

Then, inside the function body, add `const rec = activeRecogniser();` as the first line
after the signature (right before `const half = subres >> 1;`), and replace:

```ts
      const src = [[ax, ay], [ax + br.width, ay], [ax + br.width, ay + br.height], [ax, ay + br.height]];
      const thumb = getWarpFromRect(cv, src, warpedBlk, half, half);
      const [rec0] = recognise(rec, [thumb]);
```

with:

```ts
      const thumb = rec.warpForRecognition(cv, warpedBlk, [ax, ay, br.width, br.height], half);
      const [rec0] = rec.recognise([thumb]);
```

- [ ] **Step 7: Delete the free `recognise()` function**

Delete:

```ts
export function recognise(rec: NumRecogniser, imgs: Uint8Array[]): Recognition[] {
  return rec.recognise(imgs);
}
```

entirely from `web/src/image/numberRecognition.ts`. (Its remaining callers —
`inpImage.ts`, the test file, `report-browser-train-failures.ts` — are migrated in the
steps below, in this same task, so this is safe.)

- [ ] **Step 8: Migrate `inpImage.ts`'s `buildCageTotals`**

In `web/src/image/inpImage.ts`, change the import line:

```ts
import { recognise, splitNum, contourHier, getNumContours, readClassicDigits } from './numberRecognition.js';
```

to:

```ts
import { splitNum, contourHier, getNumContours, readClassicDigits } from './numberRecognition.js';
```

Replace `buildCageTotals`'s signature:

```ts
export function buildCageTotals(
  cv: Cv,
  warpedBlk: OpenCVMat,
  rec: NumRecogniser,
  subres: number,
  brdrs: Brdrs,
  includeTree?: boolean,
): CageTotalsResult {
```

with:

```ts
export function buildCageTotals(
  cv: Cv,
  warpedBlk: OpenCVMat,
  subres: number,
  brdrs: Brdrs,
  includeTree?: boolean,
): CageTotalsResult {
```

Replace the `splitNum` call:

```ts
        [numThumbArr, mergedThumb] = splitNum(cv, br, warpedBlk, subres);
```

stays **unchanged** (`splitNum`'s own signature never took `rec` — nothing to update here).

Replace:

```ts
        const ntrs = recognise(rec, sums);
```

with:

```ts
        const ntrs = activeRecogniser().recognise(sums);
```

Add `activeRecogniser` to the import from `./numberRecognition.js`:

```ts
import { splitNum, contourHier, getNumContours, readClassicDigits, activeRecogniser } from './numberRecognition.js';
```

- [ ] **Step 9: Migrate `inpImage.ts`'s `parsePuzzleImage`**

Replace the signature:

```ts
export async function parsePuzzleImage(
  cv: Cv,
  file: File,
  rec: NumRecogniser,
  config: ImagePipelineConfig = defaultImagePipelineConfig(),
  _splitRec?: NumRecogniser,
): Promise<ParseResult> {
```

with:

```ts
export async function parsePuzzleImage(
  cv: Cv,
  file: File,
  config: ImagePipelineConfig = defaultImagePipelineConfig(),
  _splitRec?: NumRecogniser,
): Promise<ParseResult> {
```

Then update its three internal call sites. The classic-path call:

```ts
    const { digits: givenDigits, thumbs: classicThumbs, recognitions: classicRecognitions } =
      readClassicDigits(cv, warpedBlkMat, rec, subres, classicConf);
```

becomes:

```ts
    const { digits: givenDigits, thumbs: classicThumbs, recognitions: classicRecognitions } =
      readClassicDigits(cv, warpedBlkMat, subres, classicConf);
```

The killer-path fallback classic read:

```ts
  const { digits: givenDigits, recognitions: classicRecognitions } =
    readClassicDigits(cv, warpedBlkMat, rec, subres, classicConf);
```

becomes:

```ts
  const { digits: givenDigits, recognitions: classicRecognitions } =
    readClassicDigits(cv, warpedBlkMat, subres, classicConf);
```

The three `buildCageTotals` calls:

```ts
    lastCageTotalsResult = buildCageTotals(
      cv, warpedBlkMat, rec, subres, brdrs,
    );
```

```ts
      lastCageTotalsResult = buildCageTotals(
        cv, warpedBlkMat, rec, subres, brdrs2,
      );
```

```ts
          lastCageTotalsResult = buildCageTotals(
            cv, adaptiveBlk, rec, subres, brdrs2,
          );
```

each become (drop the `rec,` argument, everything else unchanged):

```ts
    lastCageTotalsResult = buildCageTotals(
      cv, warpedBlkMat, subres, brdrs,
    );
```

```ts
      lastCageTotalsResult = buildCageTotals(
        cv, warpedBlkMat, subres, brdrs2,
      );
```

```ts
          lastCageTotalsResult = buildCageTotals(
            cv, adaptiveBlk, subres, brdrs2,
          );
```

- [ ] **Step 10: Wire `store.ts` to call `setActiveRecogniser()`**

In `web/src/session/store.ts`, find the main-recogniser loader (the function containing
`_rec = loadNumRecogniser(binBuffer, manifest as Parameters<typeof loadNumRecogniser>[1]);`
— **not** the split-recogniser loader, which has the identically-shaped
`_splitRec = loadNumRecogniser(...)` line a few lines below it). Change:

```ts
    _rec = loadNumRecogniser(binBuffer, manifest as Parameters<typeof loadNumRecogniser>[1]);
    return _rec;
```

to:

```ts
    _rec = loadNumRecogniser(binBuffer, manifest as Parameters<typeof loadNumRecogniser>[1]);
    setActiveRecogniser(_rec);
    return _rec;
```

Add `setActiveRecogniser` to the existing import from `../image/numberRecognition.js`:

```ts
import { loadNumRecogniser, setActiveRecogniser } from '../image/numberRecognition.js';
```

Do **not** change the split-recogniser loader (`_splitRec = loadNumRecogniser(...)`) —
it must not call `setActiveRecogniser()`, or loading the (currently-dead-at-inference)
split classifier would silently overwrite the real active recogniser.

- [ ] **Step 11: Migrate `actions.ts`'s `uploadPuzzle`**

In `web/src/session/actions.ts`, change:

```ts
    result = await parsePuzzleImage(cv, file, rec, config, getSplitRec() ?? undefined);
```

to:

```ts
    result = await parsePuzzleImage(cv, file, config, getSplitRec() ?? undefined);
```

The `const rec = getRec();` line and its null-check
(`if (cv === null || rec === null) throw new Error(...)`) stay **unchanged** — `rec` is
still used for that "has the model finished loading" gate, it's just no longer forwarded
as an argument.

- [ ] **Step 12: Migrate the 3 remaining `recognise()` call sites in the test file**

In `web/src/image/numberRecognition.test.ts`, the three occurrences of:

```ts
  const results = recognise(rec, imgs);
```

each become:

```ts
  const results = rec.recognise(imgs);
```

(These are inside `runOnSamples` and `unexpectedFailures`, both taking a module-level
`rec` already in scope — no other change needed.) Remove `recognise` from this file's
import of `./numberRecognition.js` (keep `loadNumRecogniser`, `PcaRbfRecogniser`,
`HogRecogniser`, `activeRecogniser` from Task 1/this task's earlier steps).

- [ ] **Step 13: Migrate `report-browser-train-failures.ts`**

In `web/scripts/report-browser-train-failures.ts`, change:

```ts
  const results = recognise(rec, imgs);
```

to:

```ts
  const results = rec.recognise(imgs);
```

Remove `recognise` from this file's import of `../src/image/numberRecognition.js` (keep
`loadNumRecogniser`).

- [ ] **Step 14: Run tsc on both configs**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

Run: `cd web && npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 15: Run the full test suite**

Run: `cd web && npm test`
Expected: all tests pass (838 passed, same count as before this task — behavior-preserving
refactor, not a feature change).

- [ ] **Step 16: Run Playwright to confirm the real upload pipeline still works end to end**

Run: `cd web && npm run build && PLAYWRIGHT_PIPELINE_TESTS=1 npx playwright test`
Expected: all pass. This is the actual regression check for `warpForRecognition`'s crop
mechanics (stretch behavior unchanged) — no vitest unit test exercises real OpenCV.js
Mat warping in this codebase today (confirmed: no existing test constructs or mocks a
real `cv` module for `getWarpFromRect`-family functions; `cellScan.test.ts`'s "fake Mat"
pattern only works for functions that read `.data`/`.cols`, not perspective-warp ones).

- [ ] **Step 17: Full bronze gate and commit**

Run: `bash scripts/run-bronze-gate.sh`
Expected: passes.

```bash
git add web/src/image/numberRecognition.ts web/src/image/inpImage.ts \
  web/src/session/store.ts web/src/session/actions.ts \
  web/src/image/numberRecognition.test.ts web/scripts/report-browser-train-failures.ts
git commit -m "refactor: drop rec parameter threading, wire NumRecogniser singleton

splitNum/readClassicDigits/buildCageTotals no longer take rec as a
parameter -- they call activeRecogniser() internally. store.ts's
main-recogniser loader (not the split-recogniser one) calls
setActiveRecogniser() once after construction. Deletes the free
recognise() function -- all 6 remaining call sites (readClassicDigits,
buildCageTotals, 3 in numberRecognition.test.ts, 1 in
report-browser-train-failures.ts) now call rec.recognise(...) directly."
```

---

## Task 3: TS — per-architecture known-failure hash fixture

**Files:**
- Modify: `web/src/image/numberRecognition.test.ts`
- Modify (rename): `web/known-model-failure-hashes.json` → `web/known-model-failure-hashes-pca_rbf.json`

**Interfaces:**
- Consumes: `PcaRbfRecogniser`, `HogRecogniser` from Task 1/2.

- [ ] **Step 1: Rename the existing hash file**

```bash
git mv web/known-model-failure-hashes.json web/known-model-failure-hashes-pca_rbf.json
```

- [ ] **Step 2: Write a failing test for the file-selection logic**

This is best verified indirectly: since `rec` in this test file is loaded from the real
shipped (`pca_rbf`) model, the existing accuracy test already proves the file-selection
logic works correctly if and only if it picks `known-model-failure-hashes-pca_rbf.json`
and the suite still passes. Run the suite now, before making the code change, to confirm
it's currently broken (still pointing at the old filename):

Run: `cd web && npx vitest run numberRecognition`
Expected: FAIL — `known-model-failure-hashes.json` (old name) not found (`ENOENT`).

- [ ] **Step 3: Make the hash-file path architecture-aware**

In `web/src/image/numberRecognition.test.ts`, find:

```ts
const KNOWN_FAILURE_SAMPLE_HASHES: ReadonlySet<string> = new Set(
  JSON.parse(readFileSync(join(process.cwd(), 'known-model-failure-hashes.json'), 'utf-8')) as string[],
);
```

Replace with:

```ts
const KNOWN_FAILURE_HASHES_FILE = rec instanceof HogRecogniser
  ? 'known-model-failure-hashes-hog.json'
  : 'known-model-failure-hashes-pca_rbf.json';
const KNOWN_FAILURE_SAMPLE_HASHES: ReadonlySet<string> = new Set(
  JSON.parse(readFileSync(join(process.cwd(), KNOWN_FAILURE_HASHES_FILE), 'utf-8')) as string[],
);
```

This line currently sits at module scope, evaluated once when the test file loads — but
`rec` is only populated inside `beforeAll` (async, runs after module load). Move this
whole block (both the `KNOWN_FAILURE_HASHES_FILE`/`KNOWN_FAILURE_SAMPLE_HASHES` declarations) from module scope into the existing `beforeAll(() => { ... })` block, appended
after the line that assigns `rec = loadNumRecogniser(...)`, and change both `const` to
`let` at module scope (declared before `beforeAll`, assigned inside it):

```ts
let rec: NumRecogniser;
let samples: TrainingSample[];
let KNOWN_FAILURE_SAMPLE_HASHES: ReadonlySet<string>;

beforeAll(() => {
  const pub = join(process.cwd(), 'public');
  const bin = readFileSync(join(pub, 'num_recogniser.bin'));
  const manifest = JSON.parse(readFileSync(join(pub, 'num_recogniser.json'), 'utf-8'));
  rec = loadNumRecogniser(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), manifest);

  const hashesFile = rec instanceof HogRecogniser
    ? 'known-model-failure-hashes-hog.json'
    : 'known-model-failure-hashes-pca_rbf.json';
  KNOWN_FAILURE_SAMPLE_HASHES = new Set(
    JSON.parse(readFileSync(join(process.cwd(), hashesFile), 'utf-8')) as string[],
  );

  const trainFile: TrainingFile = JSON.parse(
    readFileSync(join(process.cwd(), 'browser_train.json'), 'utf-8'),
  );
  samples = trainFile.samples;
});
```

(`unexpectedFailures` and the two accuracy `it(...)` blocks already reference
`KNOWN_FAILURE_SAMPLE_HASHES` by name — no change needed there, since it's now a
`let` populated before any test body runs.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run numberRecognition`
Expected: PASS — all tests, including the accuracy suite, now reading the renamed
`known-model-failure-hashes-pca_rbf.json`.

- [ ] **Step 5: Full bronze gate and commit**

Run: `bash scripts/run-bronze-gate.sh`
Expected: passes.

```bash
git add web/src/image/numberRecognition.test.ts web/known-model-failure-hashes-pca_rbf.json
git commit -m "refactor: make numberRecognition.test.ts's known-failure hash file per-architecture

Selected by rec instanceof HogRecogniser at test setup, so swapping which
model ships (web/public/num_recogniser.{bin,json}) doesn't require
hand-editing this test. known-model-failure-hashes-hog.json doesn't exist
yet -- created when the HOG model is actually benchmarked (out of scope
for this refactor per the spec)."
```

---

## Task 4: Python — `train_recogniser.py` class hierarchy

**Files:**
- Modify: `web/train_recogniser.py`
- Modify: `tests/test_train_recogniser.py`

**Interfaces:**
- Produces: `class NumRecogniser(ABC)` with abstract methods `fit_to_thumbnail`,
  `warp_from_rect`, `extract_features`, `fit`, `save`; `class PcaRbfRecogniser(NumRecogniser)`;
  `class HogRecogniser(NumRecogniser)`; `ACTIVE_RECOGNISER: NumRecogniser` module constant.
  `build_dataset(samples, n_dither, sample_weights=None) -> tuple[NDArray[np.uint8], NDArray[np.int64], NDArray[np.float64]]`
  (return type changes: first element is now the stacked **uint8 image** array, not
  flattened-to-float64 pixels — `main()` now calls `ACTIVE_RECOGNISER.extract_features(...)`
  on it to get the fit-ready `X`).

- [ ] **Step 1: Write the failing HogRecogniser manifest round-trip test**

In `tests/test_train_recogniser.py`, add alongside the existing
`test_save_model_pca_rbf_keys`:

```python
from train_recogniser import ACTIVE_RECOGNISER, HogRecogniser, PcaRbfRecogniser


def test_active_recogniser_is_pca_rbf_by_default() -> None:
    assert isinstance(ACTIVE_RECOGNISER, PcaRbfRecogniser)


_EXPECTED_HOG_KEYS = {
    "hog_win_size", "hog_cell_size", "hog_block_size", "hog_block_stride", "hog_nbins",
    "rbf_support_vectors", "rbf_dual_coef", "rbf_intercept", "rbf_n_support", "rbf_gamma",
    "classes", "confidence_threshold",
}


def test_hog_recogniser_save_keys() -> None:
    hog = HogRecogniser()
    samples = _make_samples()
    aug_imgs, y, _w = build_dataset(samples, n_dither=1)
    X = hog.extract_features(aug_imgs)
    model = hog.fit(X, y, None)
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        hog.save(model, out, confidence_threshold=CONFIDENCE_THRESHOLD)
        manifest: dict[str, Any] = json.loads((out / "num_recogniser.json").read_text())

    assert manifest["classifier_type"] == "rbf"
    assert set(manifest["arrays"].keys()) == _EXPECTED_HOG_KEYS
    # No PCA/template keys on a HOG manifest.
    assert not any(k.startswith("pca") or k.startswith("template") for k in manifest["arrays"])


def test_fit_to_thumbnail_stretch_vs_letterbox_differ() -> None:
    # A tall, narrow crop: stretch and letterbox produce visibly different results
    # (letterbox pads with black bars top/bottom after scaling to fit width; stretch
    # doesn't). Assert they're not just both valid but actually different, per the
    # spec's own emphasis on this being the exact bug class to guard against.
    crop = np.zeros((40, 10), dtype=np.uint8)
    crop[:, 3:7] = 255  # a thin vertical stripe, non-square
    pca_out = PcaRbfRecogniser().fit_to_thumbnail(crop, 64)
    hog_out = HogRecogniser().fit_to_thumbnail(crop, 64)
    assert not np.array_equal(pca_out, hog_out)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest -k train_recogniser -v` (from repo root)
Expected: FAIL — `ACTIVE_RECOGNISER`, `HogRecogniser`, `PcaRbfRecogniser` not defined.

- [ ] **Step 3: Add the `NumRecogniser` ABC and both subclasses**

In `web/train_recogniser.py`, add `from abc import ABC, abstractmethod` to the imports
(alongside the existing `import argparse` etc. block). Then add this block immediately
after the `_sample_hash` function and before the `# I/O -- loading` section comment:

```python
# ---------------------------------------------------------------------------
# NumRecogniser -- single active instance, no CLI flag, no branching.
# ---------------------------------------------------------------------------

class NumRecogniser(ABC):
    """One implementation per digit-recogniser architecture.

    ACTIVE_RECOGNISER (bottom of this section) is the single point of truth --
    change that one line to switch every consumer (main(), generate_synthetic_samples,
    extract_guardian_samples.py) to the other architecture at once.
    """

    @abstractmethod
    def fit_to_thumbnail(self, crop: NDArray[np.uint8], win_size: int) -> NDArray[np.uint8]:
        """Fit an already-extracted, variable-aspect-ratio crop into a win_size square."""

    @abstractmethod
    def warp_from_rect(
        self, ax: float, ay: float, bw: float, bh: float,
        source: NDArray[np.uint8], win_size: int,
    ) -> NDArray[np.uint8]:
        """Perspective-warp a bounding rect directly from a full source image."""

    @abstractmethod
    def extract_features(self, imgs: NDArray[np.uint8]) -> NDArray[np.float64]:
        """Convert a stacked (n, 64, 64) uint8 image array into fit-ready features."""

    @abstractmethod
    def fit(
        self, X: NDArray[np.float64], y: NDArray[np.int64],
        sample_weights: NDArray[np.float64] | None,
    ) -> dict[str, Any]:
        """Fit a classifier on X/y, returning an opaque model dict for save()."""

    @abstractmethod
    def save(
        self, model: dict[str, Any], out_dir: Path,
        confidence_threshold: float = CONFIDENCE_THRESHOLD,
        template_threshold: float = TEMPLATE_THRESHOLD,
    ) -> None:
        """Write num_recogniser.json (manifest) and num_recogniser.bin (arrays)."""


class PcaRbfRecogniser(NumRecogniser):
    def fit_to_thumbnail(self, crop: NDArray[np.uint8], win_size: int) -> NDArray[np.uint8]:
        # Direct stretch, no aspect preservation -- matches TS's getWarpFromRect.
        from PIL import Image
        return np.array(
            Image.fromarray(crop).resize((win_size, win_size), Image.Resampling.LANCZOS),
            dtype=np.uint8,
        )

    def warp_from_rect(
        self, ax: float, ay: float, bw: float, bh: float,
        source: NDArray[np.uint8], win_size: int,
    ) -> NDArray[np.uint8]:
        # Direct stretch via cv2.warpPerspective -- matches TS's getWarpFromRect
        # exactly (same mechanism). No square-padding step.
        import cv2
        src = np.array([[ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh]], dtype=np.float32)
        dst = np.array(
            [[0, 0], [win_size - 1, 0], [win_size - 1, win_size - 1], [0, win_size - 1]],
            dtype=np.float32,
        )
        m = cv2.getPerspectiveTransform(src, dst)
        thumb = cv2.warpPerspective(source, m, (win_size, win_size), flags=cv2.INTER_LINEAR)
        return ((thumb > 127).astype(np.uint8) * 255)

    def extract_features(self, imgs: NDArray[np.uint8]) -> NDArray[np.float64]:
        return imgs.reshape(len(imgs), -1).astype(np.float64)

    def fit(
        self, X: NDArray[np.float64], y: NDArray[np.int64],
        sample_weights: NDArray[np.float64] | None,
    ) -> dict[str, Any]:
        return fit_model(X, y, svm_c=SVM_C, svm_gamma=SVM_GAMMA, sample_weights=sample_weights)

    def save(
        self, model: dict[str, Any], out_dir: Path,
        confidence_threshold: float = CONFIDENCE_THRESHOLD,
        template_threshold: float = TEMPLATE_THRESHOLD,
    ) -> None:
        save_model(model, out_dir, confidence_threshold=confidence_threshold, template_threshold=template_threshold)


class HogRecogniser(NumRecogniser):
    def fit_to_thumbnail(self, crop: NDArray[np.uint8], win_size: int) -> NDArray[np.uint8]:
        # Pad to a square (aspect-preserving), then uniform-scale -- matches TS's
        # letterboxWarp. This is today's generate_synthetic_samples inline logic.
        from PIL import Image
        h_c, w_c = crop.shape
        side = max(h_c, w_c)
        square = np.zeros((side, side), dtype=np.uint8)
        square[(side - h_c) // 2:(side - h_c) // 2 + h_c, (side - w_c) // 2:(side - w_c) // 2 + w_c] = crop
        return np.array(
            Image.fromarray(square).resize((win_size, win_size), Image.Resampling.LANCZOS),
            dtype=np.uint8,
        )

    def warp_from_rect(
        self, ax: float, ay: float, bw: float, bh: float,
        source: NDArray[np.uint8], win_size: int,
    ) -> NDArray[np.uint8]:
        # Today's extract_guardian_samples.py::letterbox_warp, moved here unchanged.
        import cv2
        scale = min((win_size - 1) / bw, (win_size - 1) / bh)
        dest_w, dest_h = bw * scale, bh * scale
        off_x, off_y = ((win_size - 1) - dest_w) / 2, ((win_size - 1) - dest_h) / 2
        src = np.array([[ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh]], dtype=np.float32)
        dst = np.array([
            [off_x, off_y], [off_x + dest_w, off_y],
            [off_x + dest_w, off_y + dest_h], [off_x, off_y + dest_h],
        ], dtype=np.float32)
        m = cv2.getPerspectiveTransform(src, dst)
        thumb = cv2.warpPerspective(source, m, (win_size, win_size), flags=cv2.INTER_LINEAR)
        return ((thumb > 127).astype(np.uint8) * 255)

    def extract_features(self, imgs: NDArray[np.uint8]) -> NDArray[np.float64]:
        return np.hstack([extract_hog(imgs), extract_hole_features(imgs)])

    def fit(
        self, X: NDArray[np.float64], y: NDArray[np.int64],
        sample_weights: NDArray[np.float64] | None,
    ) -> dict[str, Any]:
        # Direct RBF-SVM fit only -- see this plan's Global Constraints for why the
        # original checkpointed LinearSVC/OVO path is not restored here.
        svc = SVC(kernel="rbf", C=SVM_C, gamma=SVM_GAMMA, decision_function_shape="ovo")
        svc.fit(X, y, sample_weight=sample_weights)
        return {"kind": "rbf", "clf": svc, "classes": svc.classes_}

    def save(
        self, model: dict[str, Any], out_dir: Path,
        confidence_threshold: float = CONFIDENCE_THRESHOLD,
        template_threshold: float = TEMPLATE_THRESHOLD,  # noqa: ARG002 -- HOG has no templates; kept for Liskov-substitutable signature
    ) -> None:
        svc: SVC = model["clf"]
        try:
            gamma = float(svc._gamma)  # noqa: SLF001 -- sklearn's own private attr, no public accessor
        except AttributeError:
            gamma = 1.0 / (float(X.shape[1]) * float(X.var()))  # type: ignore[name-defined]

        named: list[tuple[str, np.ndarray[Any, Any], str]] = [
            ("hog_win_size",         np.array([HOG_WIN_SIZE], dtype=np.int32),     "int32"),
            ("hog_cell_size",        np.array([HOG_CELL_SIZE], dtype=np.int32),    "int32"),
            ("hog_block_size",       np.array([HOG_BLOCK_SIZE], dtype=np.int32),   "int32"),
            ("hog_block_stride",     np.array([HOG_BLOCK_STRIDE], dtype=np.int32), "int32"),
            ("hog_nbins",            np.array([HOG_NBINS], dtype=np.int32),        "int32"),
            ("rbf_support_vectors",  svc.support_vectors_.astype(np.float64),      "float64"),
            ("rbf_dual_coef",        svc.dual_coef_.astype(np.float64),            "float64"),
            ("rbf_intercept",        svc.intercept_.astype(np.float64),            "float64"),
            ("rbf_n_support",        svc.n_support_.astype(np.int32),              "int32"),
            ("rbf_gamma",            np.array([gamma], dtype=np.float64),          "float64"),
            ("classes",              svc.classes_.astype(np.int32),                "int32"),
            ("confidence_threshold", np.array([confidence_threshold], dtype=np.float64), "float64"),
        ]
        blob = bytearray()
        manifest_arrays: dict[str, dict[str, Any]] = {}
        for name, arr, dtype_str in named:
            arr = np.asarray(arr)
            data = arr.tobytes()
            manifest_arrays[name] = {
                "dtype": dtype_str, "shape": list(arr.shape),
                "offset": len(blob), "byteLength": len(data),
            }
            blob.extend(data)

        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "num_recogniser.bin").write_bytes(bytes(blob))
        (out_dir / "num_recogniser.json").write_text(
            json.dumps({"classifier_type": "rbf", "arrays": manifest_arrays}, indent=2),
            encoding="utf-8",
        )
        n_sv = svc.support_vectors_.shape[0]
        print(f"\nSaved to {out_dir}/ [hog/rbf]", flush=True)
        print(f"  SVM: {n_sv} support vectors, classes {svc.classes_.tolist()}", flush=True)
        print(f"  Bin size: {len(blob):,} bytes", flush=True)


ACTIVE_RECOGNISER: NumRecogniser = PcaRbfRecogniser()  # the one line that decides everything
```

Note this references `fit_model`/`save_model` (the existing free functions,
`PcaRbfRecogniser.fit`/`.save` just delegate to them unchanged) and `SVM_C`/`SVM_GAMMA`/
`HOG_WIN_SIZE`/etc. (existing module constants) — no changes needed to those.

`HogRecogniser.save`'s `gamma` fallback branch references `X` inside an `except`
clause where `X` isn't in scope (it was in the original free `save_model` because `X_pca`
was a local variable there) — this branch is realistically unreachable (`svc._gamma` is
set by sklearn immediately after `fit()` for `gamma="scale"`/`"auto"` strings, which is
what `SVM_GAMMA` is), but per this repo's strict-typing rules it still needs to type-check.
Fix it now rather than leave a dead branch with a type error: change the `except`
branch to `gamma = 1.0` (a clearly-wrong-if-ever-hit fallback is fine here since it's
provably unreachable given `SVM_GAMMA = "scale"`, and matches the spirit of "don't add
complexity for a case that can't happen").

- [ ] **Step 4: Migrate `build_dataset` to stop flattening to pixels**

In `web/train_recogniser.py`, `build_dataset`'s current final line:

```python
    n_aug = len(aug_labels)
    X = aug_imgs.reshape(n_aug, THUMBNAIL_SIZE * THUMBNAIL_SIZE).astype(np.float64)
    return X, np.array(aug_labels, dtype=np.int64), np.array(aug_weights, dtype=np.float64)
```

becomes:

```python
    n_aug = len(aug_labels)
    assert n_aug == len(aug_imgs)  # sanity: dither_batch's own invariant, not re-derived here
    return aug_imgs, np.array(aug_labels, dtype=np.int64), np.array(aug_weights, dtype=np.float64)
```

Update the function's docstring line describing the return shape (currently says
"Returns (X, y, weights) where X is (n_aug, 4096) float64 -- raw flattened pixels...")
to: "Returns (aug_imgs, y, weights) where aug_imgs is the stacked (n_aug, 64, 64) uint8
image array — feature extraction is the caller's job via
ACTIVE_RECOGNISER.extract_features()." Update its return type annotation from
`tuple[NDArray[np.float64], NDArray[np.int64], NDArray[np.float64]]` to
`tuple[NDArray[np.uint8], NDArray[np.int64], NDArray[np.float64]]`.

- [ ] **Step 5: Migrate `generate_synthetic_samples` to use `ACTIVE_RECOGNISER.fit_to_thumbnail`**

In `generate_synthetic_samples`, replace:

```python
                crop = arr[y0:y1, x0:x1]
                h_c, w_c = crop.shape
                side = max(h_c, w_c)
                square = np.zeros((side, side), dtype=np.uint8)
                square[(side - h_c) // 2:(side - h_c) // 2 + h_c,
                       (side - w_c) // 2:(side - w_c) // 2 + w_c] = crop
                out = np.array(
                    Image.fromarray(square).resize((win_size, win_size), Image.Resampling.LANCZOS),
                    dtype=np.uint8,
                )
```

with:

```python
                crop = arr[y0:y1, x0:x1]
                out = ACTIVE_RECOGNISER.fit_to_thumbnail(crop, win_size)
```

- [ ] **Step 6: Migrate `main()` to call the class methods**

Replace:

```python
    print(f"{_elapsed()} Augmenting and flattening for PCA...", flush=True)
    X, y, weights = build_dataset(all_samples, args.dither, sample_weights)
    print(f"{_elapsed()} Dataset: {X.shape[0]} samples x {X.shape[1]} pixel features", flush=True)

    if X.shape[0] > args.max_fit_samples:
        rng_fit = np.random.default_rng(0)
        idx = rng_fit.choice(X.shape[0], size=args.max_fit_samples, replace=False)
        idx.sort()  # preserve original ordering; irrelevant to fit but keeps output deterministic-looking
        before_n = X.shape[0]
        X, y, weights = X[idx], y[idx], (weights[idx] if weights is not None else None)
        print(f"{_elapsed()} Subsampled fit set (RBF-SVM cost backstop): "
              f"{before_n} -> {X.shape[0]} rows (--max-fit-samples={args.max_fit_samples})", flush=True)

    svm_gamma: float | str = args.svm_gamma
    with contextlib.suppress(ValueError):
        svm_gamma = float(args.svm_gamma)

    print(f"{_elapsed()} Fitting PCA + RBF SVM...", flush=True)
    model = fit_model(X, y, svm_c=args.svm_c, svm_gamma=svm_gamma, sample_weights=weights)

    print(f"{_elapsed()} Saving model...", flush=True)
    save_model(
        model, Path(args.out),
        confidence_threshold=args.confidence_threshold,
        template_threshold=args.template_threshold,
    )
    print(f"{_elapsed()} Done.", flush=True)
```

with:

```python
    print(f"{_elapsed()} Augmenting...", flush=True)
    aug_imgs, y, weights = build_dataset(all_samples, args.dither, sample_weights)
    print(f"{_elapsed()} Dataset: {aug_imgs.shape[0]} augmented images", flush=True)

    if aug_imgs.shape[0] > args.max_fit_samples:
        rng_fit = np.random.default_rng(0)
        idx = rng_fit.choice(aug_imgs.shape[0], size=args.max_fit_samples, replace=False)
        idx.sort()  # preserve original ordering; irrelevant to fit but keeps output deterministic-looking
        before_n = aug_imgs.shape[0]
        aug_imgs, y, weights = aug_imgs[idx], y[idx], (weights[idx] if weights is not None else None)
        print(f"{_elapsed()} Subsampled fit set (RBF-SVM cost backstop): "
              f"{before_n} -> {aug_imgs.shape[0]} rows (--max-fit-samples={args.max_fit_samples})", flush=True)

    print(f"{_elapsed()} Extracting features ({type(ACTIVE_RECOGNISER).__name__})...", flush=True)
    X = ACTIVE_RECOGNISER.extract_features(aug_imgs)
    print(f"{_elapsed()} Dataset: {X.shape[0]} samples x {X.shape[1]} features", flush=True)

    print(f"{_elapsed()} Fitting ({type(ACTIVE_RECOGNISER).__name__})...", flush=True)
    model = ACTIVE_RECOGNISER.fit(X, y, weights)

    print(f"{_elapsed()} Saving model...", flush=True)
    ACTIVE_RECOGNISER.save(
        model, Path(args.out),
        confidence_threshold=args.confidence_threshold,
        template_threshold=args.template_threshold,
    )
    print(f"{_elapsed()} Done.", flush=True)
```

Note this drops the `--svm-c`/`--svm-gamma` CLI args' effect (they're no longer passed
through to `fit()` — `PcaRbfRecogniser.fit`/`HogRecogniser.fit` both use the fixed
`SVM_C`/`SVM_GAMMA` module constants). This is an intentional consequence of "no
branching, single active instance" — per-invocation SVM hyperparameter overrides would
need to become constructor arguments on the recogniser classes to keep working, which
the spec doesn't call for. Remove the now-dead `--svm-c`/`--svm-gamma` argparse
arguments and the `svm_gamma: float | str = args.svm_gamma` parsing block from `main()`
(delete the `parser.add_argument("--svm-c", ...)` and `parser.add_argument("--svm-gamma", ...)`
calls, and remove `contextlib` from the imports if this was its only use — check with
`grep -n contextlib web/train_recogniser.py` first, since `contextlib.suppress` may still
be used elsewhere in the file from the earlier session's rewrite).

Also update `.github/workflows/retrain.yml`'s "Retrain" step, which currently passes
`--svm-c 100` (this flag no longer exists after this step):

```yaml
      - name: Retrain
        if: steps.list.outputs.count != '0'
        run: |
          python web/train_recogniser.py \
            --browser-weight 1000 --svm-c 100 \
            web/browser_train.json /tmp/training/sample_*.json
```

becomes:

```yaml
      - name: Retrain
        if: steps.list.outputs.count != '0'
        run: |
          python web/train_recogniser.py \
            --browser-weight 1000 \
            web/browser_train.json /tmp/training/sample_*.json
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest -k train_recogniser -v`
Expected: PASS — all 6 tests (3 pre-existing + `test_active_recogniser_is_pca_rbf_by_default`,
`test_hog_recogniser_save_keys`, `test_fit_to_thumbnail_stretch_vs_letterbox_differ`).

- [ ] **Step 8: Full bronze gate and commit**

Run: `bash scripts/run-bronze-gate.sh`
Expected: passes.

```bash
git add web/train_recogniser.py tests/test_train_recogniser.py .github/workflows/retrain.yml
git commit -m "feat: add NumRecogniser class hierarchy to train_recogniser.py

PcaRbfRecogniser wraps today's fit_model/save_model unchanged.
HogRecogniser restores fit_to_thumbnail (from generate_synthetic_samples'
former inline logic), warp_from_rect and save (from git history,
99cbb70^), and fit using the simpler direct-RBF-SVM path only -- see this
plan's Global Constraints for why the original checkpointed LinearSVC/OVO
path isn't restored. main() now calls ACTIVE_RECOGNISER.extract_features/
fit/save instead of the free functions directly; build_dataset returns
the stacked uint8 image array instead of pre-flattened pixels, so feature
extraction is the recogniser's job, not the augmentation step's.

Drops --svm-c/--svm-gamma CLI flags (no longer meaningful once SVM
hyperparameters live on the fixed active class instead of being threaded
through every call) and retrain.yml's now-nonexistent --svm-c 100 usage."
```

---

## Task 5: Python — `extract_guardian_samples.py` migration

**Files:**
- Modify: `web/extract_guardian_samples.py`

**Interfaces:**
- Consumes: `ACTIVE_RECOGNISER` from Task 4.

- [ ] **Step 1: Delete `letterbox_warp`, import `ACTIVE_RECOGNISER`**

In `web/extract_guardian_samples.py`, delete the entire `letterbox_warp` function:

```python
def letterbox_warp(
    ax: float, ay: float, bw: float, bh: float, warped: NDArray[np.uint8],
) -> NDArray[np.uint8]:
    """Extract a letterboxed (no square-stretch) 64x64 thumbnail from the warped binary image.

    Matches the TypeScript letterboxWarp helper exactly.
    """
    scale = min((THUMB - 1) / bw, (THUMB - 1) / bh)
    dest_w, dest_h = bw * scale, bh * scale
    off_x, off_y = ((THUMB - 1) - dest_w) / 2, ((THUMB - 1) - dest_h) / 2
    src = np.array([
        [ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh],
    ], dtype=np.float32)
    dst = np.array([
        [off_x, off_y], [off_x + dest_w, off_y],
        [off_x + dest_w, off_y + dest_h], [off_x, off_y + dest_h],
    ], dtype=np.float32)
    M = cv2.getPerspectiveTransform(src, dst)
    thumb = cv2.warpPerspective(warped, M, (THUMB, THUMB), flags=cv2.INTER_LINEAR)
    return ((thumb > 127).astype(np.uint8) * 255)
```

Add near the top of the file, with the other local imports (find the existing
`import ...` block and add after it):

```python
from train_recogniser import ACTIVE_RECOGNISER
```

- [ ] **Step 2: Replace the call site**

In `extract_puzzle_samples`, change:

```python
                samples.append((int(total_str[i]), letterbox_warp(ox, oy, ow, oh, warped)))
```

to:

```python
                samples.append((int(total_str[i]), ACTIVE_RECOGNISER.warp_from_rect(ox, oy, ow, oh, warped, THUMB)))
```

- [ ] **Step 3: Run ruff and mypy on the file**

Run: `python -m ruff check web/extract_guardian_samples.py`
Expected: no errors (the `letterbox_warp` deletion removes its `cv2.getPerspectiveTransform`/
`cv2.warpPerspective` usage from this specific function, but `cv2` stays imported and used
elsewhere in the file for the whole-grid warps — confirm with
`grep -n "^import cv2" web/extract_guardian_samples.py` that the import line itself isn't
now flagged unused; it won't be, since `extract_puzzle_samples` still calls
`cv2.imread`/`cv2.pyrUp`/`cv2.adaptiveThreshold`/`cv2.warpPerspective`/`cv2.getPerspectiveTransform`
directly for grid-level warping).

Run: `python -m mypy web/extract_guardian_samples.py --ignore-missing-imports`
Expected: no errors.

- [ ] **Step 4: Manually verify the script still runs (no unit test — this script needs real puzzle images + cached grid-location JSON/JPK files, which aren't available in the test environment)**

Run: `python web/extract_guardian_samples.py --puzzle-dirs guardian --subres 128` (from repo root)
Expected: either produces `guardian/guardian_train_sq.json` (if `guardian/` puzzle images
with cached `.json`/`.jpk` grid-location data exist locally), or logs
`"Directory not found: .../guardian -- skipping"` / `"No samples extracted from guardian"`
if they don't — either outcome confirms the script runs without crashing on the
`ACTIVE_RECOGNISER` import/call. If `guardian/` samples are produced, spot check one:

```python
python -c "
import json
data = json.loads(open('guardian/guardian_train_sq.json').read())
print('sample count:', len(data.get('samples', data)))
"
```

(Exact top-level key depends on `write_training_json`'s output shape — check that
function's body if this doesn't work as written; not modified by this task, so its
existing shape applies.)

- [ ] **Step 5: Full bronze gate and commit**

Run: `bash scripts/run-bronze-gate.sh`
Expected: passes.

```bash
git add web/extract_guardian_samples.py
git commit -m "refactor: extract_guardian_samples.py uses ACTIVE_RECOGNISER.warp_from_rect

Deletes the standalone letterbox_warp function (hardcoded, independent of
both numberRecognition.ts and train_recogniser.py) -- this was the third
site found during the spec's completeness audit. Now shares
train_recogniser.py's single active-instance dispatch instead of its own
copy of the geometry."
```

---

## Self-Review

**1. Spec coverage:**
- TS class hierarchy + `letterboxWarp` restoration → Task 1. ✓
- Single active instance, drop `rec` threading (3-layer chain + `store.ts`/`actions.ts`) → Task 2. ✓
- Free `recognise()` deletion, all 6 call sites → Task 2, Steps 7/8/12/13. ✓
- `mergedThumb` staying untouched → Task 2, Step 5's parenthetical note. ✓
- Per-architecture known-failure hash fixture → Task 3. ✓
- Python `NumRecogniser`/`PcaRbfRecogniser`/`HogRecogniser`/`ACTIVE_RECOGNISER` → Task 4. ✓
- `fit_to_thumbnail` (`generate_synthetic_samples`) → Task 4, Steps 3/5. ✓
- `warp_from_rect` (`extract_guardian_samples.py`) → Task 4 (class definition), Task 5 (call site). ✓
- Benchmark workflow itself → explicitly out of scope per the spec, not a task here. ✓ (intentional gap, not a miss)
- Testing section's TS unit tests, accuracy-suite continuity, Python manifest round-trip → Tasks 1/3/4. ✓

**2. Placeholder scan:** No TBD/"add error handling"/"similar to Task N" patterns found —
every step shows complete before/after code or an exact command with expected output.

**3. Type consistency:** `NumRecogniser.warpForRecognition`'s `br: BRect` parameter is
destructured identically (`[x, y, w, h]`) in both `PcaRbfRecogniser` and `HogRecogniser`
across Task 1; `activeRecogniser()`/`setActiveRecogniser()` names match between their
Task 2 definition sites and every call site in Tasks 2/3. Python's
`extract_features`/`fit`/`save`/`fit_to_thumbnail`/`warp_from_rect` signatures match
between the ABC (Task 4, Step 3) and both concrete implementations verbatim.
