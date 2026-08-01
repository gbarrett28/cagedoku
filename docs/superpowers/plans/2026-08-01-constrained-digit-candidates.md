# Constrained Digit Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict which digit labels the recogniser can output per crop, using structural
constraints (cage-size total range for cage totals, `1-9` for given digits) known before
classification runs, instead of relying solely on post-hoc spec validation.

**Architecture:** Thread an optional `allowedLabels` parameter through the existing
`recognise()` call chain. Template match skips disallowed digits' templates (both the
best-match and margin/runner-up search). The RBF fallback restricts the classifier itself
to the allowed classes — fewer kernel evaluations, fewer pairwise comparisons — rather than
computing the full unrestricted result and filtering the winner afterward.

**Tech Stack:** TypeScript (Vitest for unit tests), existing `web/` pipeline.

## Global Constraints

- Single source of truth: no logic duplicated between `validation.ts` and
  `numberRecognition.ts`/`inpImage.ts` — `cageSumRange` and the new `computeCageSizes`
  are each defined once and reused.
- `HogRecogniser` requires **no code changes**: TypeScript's method-parameter bivariance
  lets it satisfy the widened `NumRecogniser.recognise()` abstract signature (which adds
  an *optional* second parameter) without declaring that parameter at all — confirmed
  during design; do not add unused-parameter boilerplate to `HogRecogniser`.
- Any restriction set that ends up empty (a symptom of upstream border/geometry detection
  being wrong, not something that can happen from a correctly-computed range) must be
  treated as "unrestricted", never as "impossible" — this is a required safety fallback,
  not optional polish.
- Follow this project's serena-first rule for all `.ts` file reads/edits.
- Run `bash scripts/run-bronze-gate.sh` before every commit on this branch (feature
  branch — bronze gate suffices; silver gate is only required when merging to `master`).

---

### Task 1: `computeCageSizes` — extract and export from validation.ts

**Files:**
- Modify: `web/src/image/validation.ts`
- Test: `web/src/image/validation.test.ts`

**Interfaces:**
- Produces: `export function computeCageSizes(borderX: boolean[][], borderY: boolean[][]): number[][]`
  — a `(9×9)` grid, `sizes[row][col]` = the cage's member-cell count for the cage
  containing `(row, col)`. Consumed by Task 8.

- [ ] **Step 1: Write the failing test**

Add to `web/src/image/validation.test.ts` (the file already imports `cageSumRange` and
has helper functions `allWallsBorderX`/`allWallsBorderY` and `trivialCageTotals` — reuse
them; check their exact signatures with serena before writing this test if unsure):

```ts
describe('computeCageSizes', () => {
  it('gives every cell size 1 when every wall is present (all singleton cages)', () => {
    // allWallsBorderX/Y (already defined in this file) return all-true, i.e.
    // every wall present -- every cell is its own cage.
    const sizes = computeCageSizes(allWallsBorderX(), allWallsBorderY());
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        expect(sizes[r]![c]).toBe(1);
      }
    }
  });

  it('gives every cell the same size when there are no internal walls (one big cage)', () => {
    const openBorderX: boolean[][] = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(false));
    const openBorderY: boolean[][] = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false));
    const sizes = computeCageSizes(openBorderX, openBorderY);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        expect(sizes[r]![c]).toBe(81);
      }
    }
  });

  it('matches the cage size validateCageLayout computes internally', () => {
    // A 2-cell cage at (0,0)-(0,1): open the vertical wall between them.
    const borderX: boolean[][] = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(true));
    const borderY: boolean[][] = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(true));
    borderY[0]![0] = false; // open the wall between col 0 and col 1, row 0
    const sizes = computeCageSizes(borderX, borderY);
    expect(sizes[0]![0]).toBe(2);
    expect(sizes[0]![1]).toBe(2);
    expect(sizes[1]![0]).toBe(1);
  });
});
```

Add the import at the top of the test file: `computeCageSizes` alongside whatever's
already imported from `./validation.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/image/validation.test.ts`
Expected: FAIL — `computeCageSizes` is not exported (compile error).

- [ ] **Step 3: Implement `computeCageSizes`**

In `web/src/image/validation.ts`, add (near `buildUnionFind`, after it):

```ts
/**
 * (9×9) grid of cage sizes (member-cell count), one per cell, derived from
 * cage-wall borders via union-find. Shared by validateCageLayout (range
 * checking) and buildCageTotals (candidate-digit restriction) so cage-size
 * computation has exactly one implementation.
 */
export function computeCageSizes(borderX: boolean[][], borderY: boolean[][]): number[][] {
  const { find, members } = buildUnionFind(borderX, borderY);
  const sizes: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      sizes[r]![c] = members.get(find(cellKey([r, c])))!.size;
    }
  }
  return sizes;
}
```

`buildUnionFind` stays module-private (unexported) — only `computeCageSizes` and
`validateCageLayout` need it, both already in this file.

- [ ] **Step 4: Refactor `validateCageLayout` to use it**

Replace the `const n = component.size;` line inside `validateCageLayout`'s loop with a
call to the new shared helper, computed once at the top of the function:

```ts
export function validateCageLayout(
  cageTotals: number[][],
  borderX: boolean[][],
  borderY: boolean[][],
): PuzzleSpec {
  const { find, members } = buildUnionFind(borderX, borderY);
  const cageSizes = computeCageSizes(borderX, borderY);
  const brdrs = buildBrdrs(borderX, borderY);
  // ... unchanged down to:
        reg += 1;
        const n = cageSizes[row]![col]!;
        const [lo, hi] = cageSumRange(n);
  // ... rest unchanged
```

(`validateCageLayout` still needs its own `buildUnionFind` call for region assignment —
running union-find twice here is fine at this scale (81 cells); what matters is that the
*cage-size computation* has one implementation, not that union-find runs exactly once.)

- [ ] **Step 5: Run tests to verify pass**

Run: `cd web && npx vitest run src/image/validation.test.ts`
Expected: PASS — new tests pass, and every pre-existing test in this file still passes
unchanged (the refactor is behavior-preserving; `n` is numerically identical either way).

- [ ] **Step 6: Commit**

```bash
git add web/src/image/validation.ts web/src/image/validation.test.ts
git commit -m "refactor: extract computeCageSizes from validateCageLayout"
```

---

### Task 2: `allowedDigitsForPosition` — pure candidate-set function

**Files:**
- Modify: `web/src/image/numberRecognition.ts`
- Test: `web/src/image/numberRecognition.test.ts`

**Interfaces:**
- Consumes: `cageSumRange(n: number): [number, number]` from `../engine/types.js`
  (already imported in `validation.ts`; add the same import to `numberRecognition.ts`).
- Produces: `export function allowedDigitsForPosition(cageSize: number, digitIndex: number, digitCount: number): ReadonlySet<number>`.
  Consumed by Task 8.

- [ ] **Step 1: Write the failing test**

Add to `web/src/image/numberRecognition.test.ts`:

```ts
describe('allowedDigitsForPosition', () => {
  it('single-digit total: cage size 2 (range [3,17]) restricts to 3-9', () => {
    const allowed = allowedDigitsForPosition(2, 0, 1);
    expect([...allowed].sort()).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it('two-digit total, tens position: cage size 2 (range [3,17]) restricts to {1}', () => {
    // Only 10-17 are 2-digit totals in [3,17]; tens digit is always 1.
    const allowed = allowedDigitsForPosition(2, 0, 2);
    expect([...allowed]).toEqual([1]);
  });

  it('two-digit total, units position: cage size 2 restricts to 0-7', () => {
    // 10..17 -> units digits 0,1,2,3,4,5,6,7
    const allowed = allowedDigitsForPosition(2, 1, 2);
    expect([...allowed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('cage size 9 must total exactly 45: tens={4}, units={5}', () => {
    expect([...allowedDigitsForPosition(9, 0, 2)]).toEqual([4]);
    expect([...allowedDigitsForPosition(9, 1, 2)]).toEqual([5]);
  });

  it('falls back to unrestricted (0-9) when digitCount matches no valid total', () => {
    // Cage size 1's range is [1,9] -- no 2-digit total is possible, so a
    // (wrongly) detected digitCount=2 must not produce an impossible-to-satisfy
    // empty restriction.
    const allowed = allowedDigitsForPosition(1, 0, 2);
    expect([...allowed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/image/numberRecognition.test.ts -t allowedDigitsForPosition`
Expected: FAIL — not defined.

- [ ] **Step 3: Implement**

Add `cageSumRange` to the import block near the top of `numberRecognition.ts` (it
currently imports from `./opencv.js`, `./holeFeatures.js`, `./aspectFeatures.js` — add
`import { cageSumRange } from '../engine/types.js';`).

Add the function near `TemplateMatch`/`normalizedCrossCorrelation` (or any clearly-visible
top-level spot before its first use):

```ts
/**
 * Which digit(s) can structurally appear at `digitIndex` of a `digitCount`-digit
 * cage total, given the cage's size. Enumerates every valid total in
 * cageSumRange(cageSize) with exactly digitCount digits and collects the digit
 * at that position. Falls back to unrestricted (0-9) if no valid total has
 * exactly digitCount digits -- a symptom of upstream detection being wrong,
 * which must degrade to "no restriction", never to an impossible-to-satisfy
 * empty set.
 */
export function allowedDigitsForPosition(
  cageSize: number, digitIndex: number, digitCount: number,
): ReadonlySet<number> {
  const [lo, hi] = cageSumRange(cageSize);
  const allowed = new Set<number>();
  for (let total = lo; total <= hi; total++) {
    const s = String(total);
    if (s.length !== digitCount) continue;
    allowed.add(Number(s[digitIndex]));
  }
  if (allowed.size === 0) {
    for (let d = 0; d <= 9; d++) allowed.add(d);
  }
  return allowed;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd web && npx vitest run src/image/numberRecognition.test.ts -t allowedDigitsForPosition`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/image/numberRecognition.ts web/src/image/numberRecognition.test.ts
git commit -m "feat: add allowedDigitsForPosition candidate-set function"
```

---

### Task 3: Widen `NumRecogniser`/`PcaRecogniser` signature; restrict template match

**Files:**
- Modify: `web/src/image/numberRecognition.ts`
- Test: `web/src/image/numberRecognition.test.ts`

**Interfaces:**
- Produces: `NumRecogniser.recognise(imgs, allowedLabels?: (ReadonlySet<number> | undefined)[]): Recognition[]`
  — the widened abstract signature. `PcaRecogniser` implements real restriction in its
  template-match stage this task; RBF-fallback restriction is Tasks 4-5.
- `HogRecogniser`: **no changes** (see Global Constraints).

- [ ] **Step 1: Write the failing test**

Add to `web/src/image/numberRecognition.test.ts`. This uses real samples from
`corpus_train.json` (already loaded as `samples` in this test file's `beforeAll`) so the
test exercises the actual deployed templates, not synthetic data:

```ts
describe('PcaRecogniser template-match candidate restriction', () => {
  it('restricting to a set that excludes the true digit changes the winner to something within the set', () => {
    if (!(rec instanceof PcaRecogniser)) return; // this suite is PCA-model-specific
    // Find a sample the unrestricted recogniser gets right and whose template
    // score alone (not RBF) resolves it, so restricting away its true label
    // forces a different, verifiably-in-restriction-set answer.
    const zeroSample = samples.find(s => s.digit === 0);
    if (!zeroSample) throw new Error('expected at least one digit-0 sample in corpus_train.json');
    const img = new Uint8Array(canonicalPixels(zeroSample));

    const unrestricted = rec.recognise([img]);
    expect(unrestricted[0]!.label).toBe(0);

    const restricted = rec.recognise([img], [new Set([1, 2, 3])]);
    expect(restricted[0]!.label).not.toBe(0);
    expect([1, 2, 3]).toContain(restricted[0]!.label);
  });

  it('an undefined entry in allowedLabels leaves that crop unrestricted', () => {
    if (!(rec instanceof PcaRecogniser)) return;
    const zeroSample = samples.find(s => s.digit === 0)!;
    const img = new Uint8Array(canonicalPixels(zeroSample));
    const result = rec.recognise([img], [undefined]);
    expect(result[0]!.label).toBe(0);
  });

  it('recognise() is deterministic when allowedLabels is omitted', () => {
    const zeroSample = samples.find(s => s.digit === 0)!;
    const img = new Uint8Array(canonicalPixels(zeroSample));
    const withParam = rec.recognise([img]);
    const withoutParam = rec.recognise([img]);
    expect(withParam).toEqual(withoutParam);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/image/numberRecognition.test.ts -t "candidate restriction"`
Expected: FAIL — `recognise` doesn't accept a second argument's restriction yet (or
compiles but ignores it, so the "changes the winner" assertion fails).

- [ ] **Step 3: Widen the abstract signature**

In `NumRecogniser`:

```ts
export abstract class NumRecogniser {
  constructor(readonly confidenceThreshold: number) {}
  abstract readonly warpStrategy: WarpStrategy;
  abstract recognise(imgs: Uint8Array[], allowedLabels?: (ReadonlySet<number> | undefined)[]): Recognition[];

  warpForRecognition(cv: Cv, crop: RawDigitCrop, targetSize: number): Uint8Array {
    return warpRawDigitCrop(cv, crop, this.warpStrategy, targetSize);
  }
}
```

Do not touch `HogRecogniser` — confirm after this step that `npx tsc --noEmit` has no
complaint about `HogRecogniser.recognise(imgs: Uint8Array[])` (it shouldn't; method
parameter bivariance permits the narrower override).

- [ ] **Step 4: Implement template-match restriction in `PcaRecogniser.recognise`**

Replace the per-crop template loop:

```ts
recognise(imgs: Uint8Array[], allowedLabels?: (ReadonlySet<number> | undefined)[]): Recognition[] {
  const n = imgs.length;
  const nFeatures = this.templates.nFeatures;
  const x = new Float64Array(n * nFeatures);
  for (let i = 0; i < n; i++) {
    for (let f = 0; f < nFeatures; f++) x[i * nFeatures + f] = imgs[i]![f]!;
  }

  const results: Recognition[] = [];
  const rbfNeeded: number[] = [];
  const scores = new Float64Array(this.templates.nTemplates);
  for (let i = 0; i < n; i++) {
    const allowed = allowedLabels?.[i];
    const xi = x.subarray(i * nFeatures, (i + 1) * nFeatures);
    let best = -1, bestScore = -Infinity;
    for (let t = 0; t < this.templates.nTemplates; t++) {
      if (allowed !== undefined && !allowed.has(this.templates.templateLabels[t]!)) continue;
      const score = normalizedCrossCorrelation(xi, this.templates.templatePixels, t * nFeatures, nFeatures);
      scores[t] = score;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    if (best === -1) {
      // Every template excluded -- shouldn't happen given
      // allowedDigitsForPosition's own empty-set fallback, but stay safe by
      // deferring to the (unrestricted) RBF fallback rather than crashing.
      results.push({ label: -1, confident: false });
      rbfNeeded.push(i);
      continue;
    }
    const bestLabel = this.templates.templateLabels[best]!;
    let runnerUpScore = -Infinity;
    for (let t = 0; t < this.templates.nTemplates; t++) {
      if (this.templates.templateLabels[t] === bestLabel) continue;
      if (allowed !== undefined && !allowed.has(this.templates.templateLabels[t]!)) continue;
      if (scores[t]! > runnerUpScore) runnerUpScore = scores[t]!;
    }
    if (bestScore >= this.templateThreshold && bestScore - runnerUpScore >= this.templateMargin) {
      results.push({ label: bestLabel, confident: true });
    } else {
      results.push({ label: -1, confident: false }); // placeholder, replaced below
      rbfNeeded.push(i);
    }
  }

  if (rbfNeeded.length > 0) {
    const xRbf = new Float64Array(rbfNeeded.length * nFeatures);
    for (let k = 0; k < rbfNeeded.length; k++) {
      xRbf.set(x.subarray(rbfNeeded[k]! * nFeatures, (rbfNeeded[k]! + 1) * nFeatures), k * nFeatures);
    }
    const projected = classMeanProject(xRbf, rbfNeeded.length, this.classMean);
    const rbfResults = rbfPredictWithConfidence(this.classifier, projected, rbfNeeded.length, this.confidenceThreshold);
    for (let k = 0; k < rbfNeeded.length; k++) {
      results[rbfNeeded[k]!] = rbfResults[k]!;
    }
  }

  return results;
}
```

(The RBF-fallback block is unchanged in this task — still fully batched, unrestricted.
Task 5 rewires it to pass restrictions through.)

- [ ] **Step 5: Run tests to verify pass**

Run: `cd web && npx vitest run src/image/numberRecognition.test.ts`
Expected: PASS, including the full pre-existing suite (regression guard).

- [ ] **Step 6: Commit**

```bash
git add web/src/image/numberRecognition.ts web/src/image/numberRecognition.test.ts
git commit -m "feat: restrict PcaRecogniser template-match to allowed labels"
```

---

### Task 4: Restrict `ovoVote`/`rbfPredictWithConfidence` to allowed classes

**Files:**
- Modify: `web/src/image/numberRecognition.ts`
- Test: `web/src/image/numberRecognition.test.ts`

**Interfaces:**
- `ovoVote` and `rbfPredictWithConfidence` are module-private. Export them with an
  `/** @internal exported for unit tests only. */` comment (matching this file's existing
  convention for `activeRecogniser`) so this task's tests can exercise them directly,
  without needing Task 5's PcaRecogniser wiring to be in place first.
- Produces: `rbfPredictWithConfidence(clf, x, nSamples, threshold, allowedLabels?: ReadonlySet<number>): Recognition[]`.
  Consumed by Task 5 (via `PcaRecogniser`) — `HogRecogniser`'s existing call site
  (`rbfPredictWithConfidence(classifier, x, n, confidenceThreshold)`, no 5th argument)
  is unaffected.

- [ ] **Step 1: Write the failing test**

Add to `web/src/image/numberRecognition.test.ts`. This needs a real `RBFClassifier`.
`PcaRecogniser.classifier` is a private field, so extract it via a cast in this
describe block's own `beforeAll` (the outer `rec` from the file's top-level `beforeAll`
is already a loaded `PcaRecogniser`; reuse it rather than loading the model a second
time):

```ts
describe('ovoVote / rbfPredictWithConfidence candidate restriction', () => {
  let classifier: RBFClassifier;

  beforeAll(() => {
    if (!(rec instanceof PcaRecogniser)) throw new Error('expected PCA model in public/');
    classifier = (rec as unknown as { classifier: RBFClassifier }).classifier;
  });

  it('restricting to a singleton class returns it directly with full confidence, no vote computation needed', () => {
    const nFeatures = classifier.nFeatures;
    const x = new Float64Array(nFeatures); // arbitrary all-zero input -- singleton shortcut shouldn't even look at it
    const result = rbfPredictWithConfidence(classifier, x, 1, 0.5, new Set([7]));
    expect(result[0]!.label).toBe(7);
    expect(result[0]!.confident).toBe(true);
  });

  it('an empty allowed set (defensive case) is treated as unrestricted', () => {
    const nFeatures = classifier.nFeatures;
    const x = new Float64Array(nFeatures);
    const restricted = rbfPredictWithConfidence(classifier, x, 1, 0.5, new Set());
    const unrestricted = rbfPredictWithConfidence(classifier, x, 1, 0.5);
    expect(restricted[0]!.label).toBe(unrestricted[0]!.label);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/image/numberRecognition.test.ts -t "ovoVote"`
Expected: FAIL — `rbfPredictWithConfidence`/`ovoVote` not exported, or don't accept a
5th/6th argument yet.

- [ ] **Step 3: Implement restricted `ovoVote`**

Replace `ovoVote` (drop the already-unused `_nClassifiers` parameter while touching this
signature, and change the pair callback to pass real class indices `i, j` instead of a
linear `clfIdx` the caller had to reconstruct — this removes indirection on both sides):

```ts
/** @internal exported for unit tests only. */
export function ovoVote(
  nSamples: number,
  nClasses: number,
  scoreForPair: (s: number, i: number, j: number) => number,
  classes: Int32Array,
  threshold: number,
  allowedClassIndices?: ReadonlySet<number>,
): Recognition[] {
  const votes = new Int32Array(nSamples * nClasses);
  for (let i = 0; i < nClasses; i++) {
    if (allowedClassIndices !== undefined && !allowedClassIndices.has(i)) continue;
    for (let j = i + 1; j < nClasses; j++) {
      if (allowedClassIndices !== undefined && !allowedClassIndices.has(j)) continue;
      for (let s = 0; s < nSamples; s++) {
        if (scoreForPair(s, i, j) > 0) votes[s * nClasses + i]!++;
        else votes[s * nClasses + j]!++;
      }
    }
  }
  const maxVotes = allowedClassIndices !== undefined ? allowedClassIndices.size - 1 : nClasses - 1;
  const result: Recognition[] = [];
  for (let s = 0; s < nSamples; s++) {
    let best = -1;
    for (let c = 0; c < nClasses; c++) {
      if (allowedClassIndices !== undefined && !allowedClassIndices.has(c)) continue;
      if (best === -1 || votes[s * nClasses + c]! > votes[s * nClasses + best]!) best = c;
    }
    let best2 = -1;
    for (let c = 0; c < nClasses; c++) {
      if (c === best) continue;
      if (allowedClassIndices !== undefined && !allowedClassIndices.has(c)) continue;
      if (best2 === -1 || votes[s * nClasses + c]! > votes[s * nClasses + best2]!) best2 = c;
    }
    const confident = maxVotes > 0 && votes[s * nClasses + best]! / maxVotes >= threshold;
    result.push({
      label: classes[best]!,
      confident,
      ...(best2 !== -1 ? { runnerUp: { label: classes[best2]!, score: votes[s * nClasses + best2]! } } : {}),
    });
  }
  return result;
}
```

- [ ] **Step 4: Implement restricted `rbfPredictWithConfidence`**

```ts
/** @internal exported for unit tests only. */
export function rbfPredictWithConfidence(
  clf: RBFClassifier, x: Float64Array, nSamples: number, threshold: number,
  allowedLabels?: ReadonlySet<number>,
): Recognition[] {
  const { supportVectors, dualCoef, intercept, nSupport, gamma, classes, nClasses, nSv, nFeatures } = clf;

  let allowedIdx: Set<number> | undefined;
  if (allowedLabels !== undefined) {
    allowedIdx = new Set<number>();
    for (let c = 0; c < nClasses; c++) {
      if (allowedLabels.has(classes[c]!)) allowedIdx.add(c);
    }
    if (allowedIdx.size === 0) allowedIdx = undefined; // empty restriction -> unrestricted
  }

  if (allowedIdx !== undefined && allowedIdx.size === 1) {
    const [only] = allowedIdx;
    const label = classes[only!]!;
    return Array.from({ length: nSamples }, () => ({ label, confident: true }));
  }

  const svEnd = new Int32Array(nClasses);
  svEnd[0] = nSupport[0]!;
  for (let c = 1; c < nClasses; c++) svEnd[c] = svEnd[c - 1]! + nSupport[c]!;
  const svStart = new Int32Array(nClasses);
  for (let c = 1; c < nClasses; c++) svStart[c] = svEnd[c - 1]!;

  const k = new Float64Array(nSamples * nSv);
  for (let i = 0; i < nSamples; i++) {
    const xi = x.subarray(i * nFeatures, (i + 1) * nFeatures);
    let xsq = 0;
    for (let f = 0; f < nFeatures; f++) xsq += xi[f]! * xi[f]!;
    for (let c = 0; c < nClasses; c++) {
      if (allowedIdx !== undefined && !allowedIdx.has(c)) continue;
      for (let j = svStart[c]!; j < svEnd[c]!; j++) {
        const sv = supportVectors.subarray(j * nFeatures, (j + 1) * nFeatures);
        let svsq = 0, dot = 0;
        for (let f = 0; f < nFeatures; f++) { svsq += sv[f]! * sv[f]!; dot += xi[f]! * sv[f]!; }
        k[i * nSv + j] = Math.exp(-gamma * (xsq + svsq - 2 * dot));
      }
    }
  }

  return ovoVote(nSamples, nClasses,
    (s, i, j) => {
      const si = svStart[i]!, ei = svEnd[i]!;
      const sj = svStart[j]!, ej = svEnd[j]!;
      // dualCoef/intercept are laid out by the model's fixed training-time
      // pairwise order (i<j over ALL classes) regardless of any runtime
      // restriction -- reconstruct that serial index for this (i,j) pair.
      let idx = 0;
      outer: for (let a = 0; a < nClasses; a++) {
        for (let b = a + 1; b < nClasses; b++) {
          if (a === i && b === j) break outer;
          idx++;
        }
      }
      let dec = intercept[idx]!;
      for (let sv = si; sv < ei; sv++) dec += dualCoef[(j - 1) * nSv + sv]! * k[s * nSv + sv]!;
      for (let sv = sj; sv < ej; sv++) dec += dualCoef[i * nSv + sv]! * k[s * nSv + sv]!;
      return dec;
    },
    classes, threshold, allowedIdx,
  );
}
```

- [ ] **Step 5: Update the one existing caller**

`HogRecogniser.recognise()`'s call `rbfPredictWithConfidence(classifier, x, n, confidenceThreshold)`
needs no change — the new 5th parameter is optional.

- [ ] **Step 6: Run tests to verify pass**

Run: `cd web && npx vitest run src/image/numberRecognition.test.ts`
Expected: PASS, full suite including pre-existing tests (the unrestricted path — 4th
argument omitted or `undefined` — must produce byte-identical results to before; this is
covered by the existing "achieves at least total - knownFailures.size accuracy" test
which exercises `rbfPredictWithConfidence` unrestricted at scale via `HogRecogniser`/
`PcaRecogniser`'s normal fallback path).

- [ ] **Step 7: Commit**

```bash
git add web/src/image/numberRecognition.ts web/src/image/numberRecognition.test.ts
git commit -m "feat: restrict RBF fallback to allowed classes in ovoVote/rbfPredictWithConfidence"
```

---

### Task 5: Wire restricted RBF calls into `PcaRecogniser.recognise`

**Files:**
- Modify: `web/src/image/numberRecognition.ts`
- Test: `web/src/image/numberRecognition.test.ts`

**Interfaces:**
- Consumes: `rbfPredictWithConfidence(..., allowedLabels?)` from Task 4.
- Completes: `PcaRecogniser.recognise()`'s restriction support end-to-end (template match
  from Task 3, RBF fallback from this task).

- [ ] **Step 1: Write the failing test**

Add to `web/src/image/numberRecognition.test.ts`, in the
`describe('PcaRecogniser template-match candidate restriction')` block from Task 3 (or a
new adjacent block):

```ts
it('a crop that needs RBF fallback also respects the restriction end-to-end', () => {
  if (!(rec instanceof PcaRecogniser)) return;
  // Pick a sample and restrict away its true label with a narrow margin that
  // still forces template match to defer (score just below threshold/margin
  // is hard to engineer directly; instead restrict to a set that excludes the
  // digit template match would otherwise confidently pick, forcing rbfNeeded).
  const nineSample = samples.find(s => s.digit === 9)!;
  const img = new Uint8Array(canonicalPixels(nineSample));
  const restricted = rec.recognise([img], [new Set([0, 1, 2])]);
  expect([0, 1, 2]).toContain(restricted[0]!.label);
});

it('a batch with mixed restricted/unrestricted crops resolves each independently', () => {
  if (!(rec instanceof PcaRecogniser)) return;
  const zero = samples.find(s => s.digit === 0)!;
  const one = samples.find(s => s.digit === 1)!;
  const imgs = [new Uint8Array(canonicalPixels(zero)), new Uint8Array(canonicalPixels(one))];
  const results = rec.recognise(imgs, [new Set([5, 6, 7]), undefined]);
  expect([5, 6, 7]).toContain(results[0]!.label);
  expect(results[1]!.label).toBe(1); // unrestricted crop unaffected
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/image/numberRecognition.test.ts -t "end-to-end"`
Expected: FAIL — the RBF-fallback branch still ignores `allowedLabels` (Task 3 only
wired the template-match stage).

- [ ] **Step 3: Implement**

Replace the RBF-fallback block in `PcaRecogniser.recognise` (everything after the
per-crop template loop from Task 3):

```ts
  if (rbfNeeded.length > 0) {
    const anyRestricted = rbfNeeded.some(i => allowedLabels?.[i] !== undefined);
    if (!anyRestricted) {
      // Unrestricted: keep the original fully-batched fast path unchanged.
      const xRbf = new Float64Array(rbfNeeded.length * nFeatures);
      for (let k = 0; k < rbfNeeded.length; k++) {
        xRbf.set(x.subarray(rbfNeeded[k]! * nFeatures, (rbfNeeded[k]! + 1) * nFeatures), k * nFeatures);
      }
      const projected = classMeanProject(xRbf, rbfNeeded.length, this.classMean);
      const rbfResults = rbfPredictWithConfidence(this.classifier, projected, rbfNeeded.length, this.confidenceThreshold);
      for (let k = 0; k < rbfNeeded.length; k++) {
        results[rbfNeeded[k]!] = rbfResults[k]!;
      }
    } else {
      // At least one crop in this batch carries a restriction: classify each
      // rbfNeeded crop individually so it gets its own reduced classifier
      // (ovoVote/rbfPredictWithConfidence only accept one restriction per
      // call). RBF-fallback batches in this codebase are always small (0-2
      // crops per cell), so this loses no meaningful batching efficiency.
      for (const i of rbfNeeded) {
        const xi = x.subarray(i * nFeatures, (i + 1) * nFeatures);
        const projected = classMeanProject(xi, 1, this.classMean);
        const [rbfResult] = rbfPredictWithConfidence(
          this.classifier, projected, 1, this.confidenceThreshold, allowedLabels?.[i],
        );
        results[i] = rbfResult!;
      }
    }
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd web && npx vitest run src/image/numberRecognition.test.ts`
Expected: PASS, full suite.

- [ ] **Step 5: Commit**

```bash
git add web/src/image/numberRecognition.ts web/src/image/numberRecognition.test.ts
git commit -m "feat: wire restricted RBF fallback into PcaRecogniser.recognise"
```

---

### Task 6: Restrict given digits to 1-9 in `readClassicDigits`

**Files:**
- Modify: `web/src/image/numberRecognition.ts`

**Interfaces:**
- Consumes: the now-restriction-aware `recognise()` from Tasks 3-5.

- [ ] **Step 1: Implement**

Near the top of `numberRecognition.ts` (module scope, computed once rather than
reallocated per cell):

```ts
const GIVEN_DIGIT_ALLOWED_LABELS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
```

In `readClassicDigits`, change:

```ts
const thumb = rec.warpForRecognition(cv, sourceCrop, half);
const [rec0] = rec.recognise([thumb], [GIVEN_DIGIT_ALLOWED_LABELS]);
```

- [ ] **Step 2: Verify**

`readClassicDigits` needs a real OpenCV Mat and is Playwright-tested, not
vitest-unit-tested (see the existing comment in `numberRecognition.test.ts` next to
`activeRecogniser()`'s guard test). Verification for this step is:
1. `cd web && npx tsc --noEmit` — compiles.
2. `cd web && npx vitest run src/image/numberRecognition.test.ts` — full suite still
   passes (no regression in anything vitest can reach).
3. Full Playwright suite and full-corpus evaluation in Task 8 cover the real behavior
   change end-to-end.

- [ ] **Step 3: Commit**

```bash
git add web/src/image/numberRecognition.ts
git commit -m "feat: restrict given-digit recognition to 1-9"
```

---

### Task 7: Wire cage-size-restricted candidates into `buildCageTotals`/`parsePuzzleImage`

**Files:**
- Modify: `web/src/image/inpImage.ts`

**Interfaces:**
- Consumes: `computeCageSizes` (Task 1, from `./validation.js`), `allowedDigitsForPosition`
  (Task 2, from `./numberRecognition.js`), restriction-aware `recognise()` (Tasks 3-5).

- [ ] **Step 1: Add imports**

In `web/src/image/inpImage.ts`:
- Extend the existing `import { validateCageLayout, buildLenientCageLayout } from './validation.js';`
  to `import { validateCageLayout, buildLenientCageLayout, computeCageSizes } from './validation.js';`
- Extend the existing `import { splitNum, contourHier, getNumContours, readClassicDigits, activeRecogniser } from './numberRecognition.js';`
  to add `allowedDigitsForPosition`.

- [ ] **Step 2: Update `buildCageTotals`'s signature and cell loop**

```ts
export function buildCageTotals(
  cv: Cv,
  warpedBlk: OpenCVMat,
  subres: number,
  brdrs: Brdrs,
  cageSizes: number[][],
): CageTotalsResult {
  // ... unchanged down to the cell loop ...
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const sums = numPixels[row]![col]!;
      if (sums !== null) {
        const crops = sourceCrops[row]![col] ?? null;
        const cageSize = cageSizes[row]![col]!;
        const allowedLabels = sums.map((_, digitIndex) =>
          allowedDigitsForPosition(cageSize, digitIndex, sums.length));
        const ntrs = activeRecogniser().recognise(sums, allowedLabels);
        // ... rest of the loop body unchanged (key, misalignment check, etc.) ...
```

- [ ] **Step 3: Update the three call sites in `parsePuzzleImage`**

Call site 1 (initial border estimate):

```ts
const brdrs = buildBrdrs(initialBorderX, initialBorderY);
const cageSizes = computeCageSizes(initialBorderX, initialBorderY);
lastCageTotalsResult = buildCageTotals(
  cv, warpedBlkMat, subres, brdrs, cageSizes,
);
```

Call site 2 (best-border retry) and call site 3 (adaptive-threshold fallback, reusing the
same borders as call site 2 — compute `cageSizes2` once, pass to both):

```ts
const brdrs2 = buildBrdrs(bestBorderX, bestBorderY);
const cageSizes2 = computeCageSizes(bestBorderX, bestBorderY);
lastCageTotalsResult = buildCageTotals(
  cv, warpedBlkMat, subres, brdrs2, cageSizes2,
);
// ... (totalSum check, unchanged) ...
      lastCageTotalsResult = buildCageTotals(
        cv, adaptiveBlk, subres, brdrs2, cageSizes2,
      );
```

- [ ] **Step 4: Verify**

`buildCageTotals`/`parsePuzzleImage` need real OpenCV and are Playwright/corpus-eval
tested, not vitest-unit-tested (`inpImage.test.ts` only covers pure-JS pieces like
`connectivityScore`, per its own comments). Verification for this task:
1. `cd web && npx tsc --noEmit` — compiles.
2. `cd web && npx vitest run` — full suite passes (nothing here is vitest-reachable, so
   this just confirms no accidental breakage elsewhere).
3. Task 9's Playwright suite and full-corpus evaluation are the real verification.

- [ ] **Step 5: Commit**

```bash
git add web/src/image/inpImage.ts
git commit -m "feat: restrict cage-total digit candidates by cage size and digit position"
```

---

### Task 8: Full validation and ship

**Files:** none (build, evaluate, gate, commit only)

- [ ] **Step 1: Bronze gate**

```bash
bash scripts/run-bronze-gate.sh
```
Expected: all TypeScript/test checks pass (this also re-runs the full existing
`numberRecognition.test.ts` suite, including the untouched accuracy tests — confirms no
regression in the unrestricted path).

- [ ] **Step 2: Rebuild the production bundle**

```bash
cd web && npm run build
```

- [ ] **Step 3: Run the full corpus evaluation**

Confirm (or start) a preview server on port 4173, then:

```bash
cd web && npx vite-node --script scripts/evaluate-corpus.ts \
  --base-url http://localhost:4173 --db-path ../corpus.db \
  --git-hash constrained-candidates-full --workers 4
```

- [ ] **Step 4: Compare against the current baseline**

Query `corpus.db` (`evaluations` table) comparing `git_hash='constrained-candidates-full'`
against `git_hash='pca-tau074-margin04-full'` (99.87% clean, the currently-deployed
baseline from this session's earlier work): same methodology as that comparison --
overall clean rate, and a per-puzzle diff for any `clean -> not-clean` regressions
(`bucket` transitions), following the exact pattern used earlier this session (see
git history around commit `26160f8` for the query shape). Zero regressions is the bar
to clear before proceeding; any regression found must be root-caused (likely via
`cell_reads` diffing against the baseline `git_hash`, same technique as before) before
shipping.

- [ ] **Step 5: If clean, run the silver gate then merge to master**

This branch merges into `master`, which requires a silver-gate token (not just bronze)
per this project's `scripts/hooks/pre-commit`. The gate must run *before* the merge — it
creates a one-time token that the merge (as the commit that follows) consumes:

```bash
git checkout master
git pull
bash scripts/run-silver-gate.sh
git merge feature/constrained-digit-candidates
```

- [ ] **Step 6: Push and verify deploy**

```bash
git push origin master
gh run list --workflow="Deploy to GitHub Pages" --limit 3
```

- [ ] **Step 7: Delete the feature branch**

```bash
git branch -d feature/constrained-digit-candidates
```
