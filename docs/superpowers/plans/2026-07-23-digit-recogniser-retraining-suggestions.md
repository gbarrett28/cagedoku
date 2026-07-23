# Digit-Recogniser Retraining Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn real corpus-photo digit misreads (found via the classic-puzzle validity/solvability pipeline) into a reviewable, never-auto-applied stream of corrected `(crop, label)` training suggestions for the digit recogniser.

**Architecture:** Extend the existing classic-puzzle solve path with a cheap `hasDuplicateDigits` validity gate before any solve attempt; widen the classifier's output to expose its already-computed-but-discarded runner-up prediction; build a small pure-logic module that proposes runner-up corrections and classifies each as `proven_unique` (folklore rule-engine alone fully resolves the corrected grid — a sound uniqueness proof) or `feasible_only` (a *capping-aware* backtracking search finds at least one completion but does not prove uniqueness); persist every proposal to `corpus.db` with `status='pending'`; provide a review script that dumps crops as PNGs for a human to eyeball and mark `approved`/`rejected`; provide an export script that turns only `approved` rows into the existing browser-training-export JSON format `train_recogniser.py` already consumes. Nothing in this pipeline retrains a model automatically.

**Tech Stack:** TypeScript (Vitest), better-sqlite3 (`corpus.db`), the existing `killer_sudoku` Python training pipeline (`web/train_recogniser.py`) as the unchanged retraining consumer.

## Global Constraints

- **Never auto-retrain.** Every suggestion is persisted as `status='pending'` and only leaves that state via explicit human action in the review script.
- **Never treat "a solution exists" as proof a specific digit is correct.** Brute-force/backtracking search may only be used to prove *infeasibility* (no solution exists at all). Proving a specific correction is *the* correct one requires the folklore rule engine (`SolverEngine` + `defaultRules().filter(r => !r.killerOnly)`) fully resolving the grid on its own, with no backtracking.
- **Never attempt to solve a grid that fails the validity check.** `hasDuplicateDigits`/`findDuplicateCells` (`web/src/session/assertions.ts`, unchanged) must gate every solve attempt — production and retraining-pipeline alike. A grid that still has a row/col/box duplicate after a candidate correction is rejected before it ever reaches `engine.solve()` or a backtracker.
- **Scope: classic given-digits only.** Killer cage-total digit corrections are a natural follow-on but out of scope for this plan (YAGNI — no corpus evidence yet that cage-total misreads need the same treatment).
- Follow this repo's coordinate convention: all grids are `grid[row][col]`, cell tuples are `[row, col]`.
- Bronze gate (`bash scripts/run-bronze-gate.sh`) must pass before every commit; each task below ends with a commit.

---

### Task 1: Widen `Recognition` to expose the runner-up prediction

**Files:**
- Modify: `web/src/image/numberRecognition.ts:103-106` (interface), `:118-147` (`ovoVote`), `:350-406` (`classify`'s template-matching loop)
- Test: `web/src/image/numberRecognition.test.ts`

**Interfaces:**
- Produces: `Recognition` gains an optional `runnerUp?: { label: number; score: number }` field. `score` is *not* comparable across the template-matching path (a `TM_CCOEFF_NORMED` value, roughly -1..1) and the RBF path (a raw OvO vote count, integer 0..`nClasses-1`) — it's only meaningful as a within-prediction ranking signal, documented as such.

- [x] **Step 1: Write the failing test**

Add to `web/src/image/numberRecognition.test.ts` (after the existing `runOnSamples` helper, inside a new `describe` block):

```ts
describe('Recognition.runnerUp', () => {
  it('is present and distinct from the winning label whenever the classifier saw more than one class', () => {
    const imgs = samples.slice(0, 30).map(s => new Uint8Array(s.pixels));
    const results = recognise(rec, imgs);
    let sawRunnerUp = false;
    for (const r of results) {
      if (r.runnerUp === undefined) continue;
      sawRunnerUp = true;
      expect(r.runnerUp.label).not.toBe(r.label);
      expect(Number.isFinite(r.runnerUp.score)).toBe(true);
    }
    expect(sawRunnerUp).toBe(true);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run (from `web/`): `npx vitest run src/image/numberRecognition.test.ts -t "runnerUp"`
Expected: FAIL — `r.runnerUp` is always `undefined` (property doesn't exist yet).

- [x] **Step 3: Widen the `Recognition` interface**

In `web/src/image/numberRecognition.ts`, replace the interface at lines 103-106:

```ts
export interface Recognition {
  label: number;
  confident: boolean;
  /** Second-most-likely label and its raw score, present whenever the
   *  classifier considered more than one candidate class. `score` is only
   *  meaningful as a within-prediction ranking — its scale differs between
   *  the template-matching fast path (TM_CCOEFF_NORMED, roughly -1..1) and
   *  the RBF fallback path (an OvO vote count, integer 0..nClasses-1). */
  runnerUp?: { label: number; score: number };
}
```

- [x] **Step 4: Populate `runnerUp` in `ovoVote`**

Replace the result-building loop in `ovoVote` (lines 137-145):

```ts
  const result: Recognition[] = [];
  for (let s = 0; s < nSamples; s++) {
    let best = 0;
    for (let c = 1; c < nClasses; c++) {
      if (votes[s * nClasses + c]! > votes[s * nClasses + best]!) best = c;
    }
    let best2 = -1;
    for (let c = 0; c < nClasses; c++) {
      if (c === best) continue;
      if (best2 === -1 || votes[s * nClasses + c]! > votes[s * nClasses + best2]!) best2 = c;
    }
    // Normalise by (nClasses-1): max votes any class can receive in OVO, not total classifiers.
    const confident = votes[s * nClasses + best]! / (nClasses - 1) >= threshold;
    result.push({
      label: classes[best]!,
      confident,
      ...(best2 !== -1 ? { runnerUp: { label: classes[best2]!, score: votes[s * nClasses + best2]! } } : {}),
    });
  }
  return result;
```

- [x] **Step 5: Populate `runnerUp` in `classify`'s template-matching fast path**

Replace the template-matching loop in `classify` (lines 361-374):

```ts
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
    }
```

- [x] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/image/numberRecognition.test.ts`
Expected: PASS, all tests including the new one. Per-digit accuracy numbers printed by the existing accuracy test should be unchanged (this step only adds a field, never changes `label`/`confident`).

- [x] **Step 7: Commit**

```bash
git add web/src/image/numberRecognition.ts web/src/image/numberRecognition.test.ts
git commit -m "feat: expose classifier runner-up prediction in Recognition"
```

---

### Task 2: Thread `Recognition` (not just the final label) through the classic given-digit path

**Files:**
- Modify: `web/src/image/numberRecognition.ts:855-916` (`readClassicDigits`)
- Modify: `web/src/image/inpImage.ts:64-84` (`ParseResult` interface), `:238` and `:362` (call sites)
- Modify: `web/src/session/actions.ts:133-152` (`UploadResult` interface) and its construction site(s)
- Test: existing `web/src/image/numberRecognition.test.ts` / `web/src/image/inpImage.test.ts` coverage of `readClassicDigits`/`parsePuzzleImage` (extend, don't replace)

**Interfaces:**
- Consumes: `Recognition` from Task 1.
- Produces: `readClassicDigits` returns `{ digits: number[][]; thumbs: Map<string, Uint8Array[]>; recognitions: Map<string, Recognition> }` (one `Recognition` per populated cell — classic given-digits are always single-digit, unlike cage totals). `ParseResult.classicRecognitions?: ReadonlyMap<string, Recognition>` and `UploadResult.classicRecognitions?: ReadonlyMap<string, Recognition>` follow the same "Bitcheck harness only" pattern already used for `gray`/`graySize`/`detectedCageTotals` etc. — always populated when present (not gated behind `__reportContourTree`, since Task 8 needs it in normal corpus-evaluator runs, not just bitcheck dumps).

**Note on test coverage for this task:** `readClassicDigits` requires a live OpenCV.js WASM module (`cv.Mat`, `cv.findContours`, etc.) to run its contour-finding path. No existing test in this repo unit-tests `readClassicDigits`, `buildCageTotals`, or any other OpenCV-dependent function directly — `numberRecognition.test.ts` specifically avoids this by testing `recognise()` alone (it operates on already-cropped `Uint8Array` thumbnails, no `cv.Mat` needed). Setting up a WASM-backed unit-test environment is out of scope here (YAGNI — no other function in this codebase has one). This task is therefore verified two ways: (a) `npx tsc --noEmit`, which catches every call site that needs updating for the new return/field shapes, since TypeScript will error on any mismatched destructure or missing field; (b) a real end-to-end smoke test via the bitcheck harness in Step 6 below, the same tool this session used throughout to verify pipeline behavior against real corpus photos.

- [x] **Step 1: Change `readClassicDigits` to keep the full `Recognition`**

In `web/src/image/numberRecognition.ts`, replace lines 855-916:

```ts
export function readClassicDigits(
  cv: Cv,
  warpedBlk: OpenCVMat,
  rec: NumRecogniser,
  subres: number,
  classicConf: number[][],
): { digits: number[][]; thumbs: Map<string, Uint8Array[]>; recognitions: Map<string, Recognition> } {
  const half = subres >> 1;
  const margin = subres >> 2;
  const digits: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const thumbs = new Map<string, Uint8Array[]>();
  const recognitions = new Map<string, Recognition>();

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (classicConf[r]![c]! === 0) continue;

      const y0 = r * subres + margin;
      const x0 = c * subres + margin;
      const patch = warpedBlk.roi(new cv.Rect(x0, y0, half, half));

      const cnts = new cv.MatVector();
      const hier = new cv.Mat();
      cv.findContours(patch, cnts, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      patch.delete();
      hier.delete();

      if (cnts.size() === 0) {
        cnts.delete();
        continue;
      }

      let bestIdx = 0;
      let bestArea = 0;
      for (let i = 0; i < cnts.size(); i++) {
        const ci = cnts.get(i);
        const area = cv.contourArea(ci);
        ci.delete();
        if (area > bestArea) { bestArea = area; bestIdx = i; }
      }

      const cBest = cnts.get(bestIdx);
      const br = cv.boundingRect(cBest);
      cBest.delete();
      cnts.delete();

      if (br.width === 0 || br.height === 0) continue;

      const ax = x0 + br.x;
      const ay = y0 + br.y;
      const src = [[ax, ay], [ax + br.width, ay], [ax + br.width, ay + br.height], [ax, ay + br.height]];
      const thumb = getWarpFromRect(cv, src, warpedBlk, half, half);
      const [rec0] = recognise(rec, [thumb]);
      const d = rec0!.label;
      if (d > 0) {
        digits[r]![c] = d;
        thumbs.set(`${r},${c}`, [thumb]);
        recognitions.set(`${r},${c}`, rec0!);
      }
    }
  }

  return { digits, thumbs, recognitions };
}
```

- [x] **Step 2: Thread `recognitions` through `inpImage.ts`**

In `web/src/image/inpImage.ts`, add to the `ParseResult` interface (near the other "Bitcheck harness only" optional fields, e.g. after `regions?:`):

```ts
  /** Recognition (incl. runner-up) for each classic given-digit cell, keyed "row,col". */
  classicRecognitions?: ReadonlyMap<string, import('./numberRecognition.js').Recognition> | undefined;
```

At line 238, change the destructure and thread it into the classic-path return object:

```ts
    const { digits: givenDigits, thumbs: classicThumbs, recognitions: classicRecognitions } =
      readClassicDigits(cv, warpedBlkMat, rec, subres, classicConf);
```

...and add `classicRecognitions,` to the classic-path `return { ... }` object (the one starting `return { spec, specError, fallbackUsed: false, puzzleType: 'classic', ... }`).

At line 362, change the destructure similarly:

```ts
  const { digits: givenDigits, recognitions: classicRecognitions } =
    readClassicDigits(cv, warpedBlkMat, rec, subres, classicConf);
```

...and add `classicRecognitions,` to both `return { ... }` objects later in the killer path (the early-`spec===null` return and the final return), matching how `givenDigits` is already threaded through both.

- [x] **Step 3: Thread `classicRecognitions` through `session/actions.ts`'s `UploadResult`**

In `web/src/session/actions.ts`, add to the `UploadResult` interface (after `regions?:` at line 151):

```ts
  /** Recognition (incl. runner-up) for each classic given-digit cell, keyed "row,col". Present whenever ParseResult provides it. */
  classicRecognitions?: ReadonlyMap<string, import('../image/numberRecognition.js').Recognition> | undefined;
```

Find the construction of `UploadResult` from `ParseResult` in `uploadPuzzle` (the function that calls `parsePuzzleImage` and builds the returned `UploadResult`) and add `classicRecognitions: result.classicRecognitions,` alongside the existing `regions: result.regions ?? null,`-style assignments.

- [x] **Step 4: Type-check and run the full test suite to verify no regressions**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both pass; same test count as before Task 1 plus the new test from Task 1.

- [x] **Step 5: Real end-to-end smoke test via the bitcheck harness**

Build and run the app against a real classic-puzzle corpus image, following this session's established bitcheck workflow: `npm run build`, start `npx vite preview --port 4173`, then `npx vite-node scripts/bitcheck-dump.ts <path to a real classic .jpg> --out /tmp/check.json`. Confirm the dumped output's `cellThumbs` are unchanged from before this task (Task 2 only adds a parallel `recognitions` map, never changes `digits`/`thumbs`) and that no console error/warning appears about `classicRecognitions` being malformed. This is the same manual verification style used throughout this session's earlier investigation (no new tooling needed).

- [x] **Step 6: Commit**

```bash
git add web/src/image/numberRecognition.ts web/src/image/numberRecognition.test.ts web/src/image/inpImage.ts web/src/session/actions.ts
git commit -m "feat: thread classic given-digit Recognition (incl. runner-up) through the pipeline"
```

---

### Task 3: Gate `assessClassicSolvability` on `hasDuplicateDigits` before any solve attempt

**Files:**
- Modify: `web/src/engine/index.ts:109-118` (`assessClassicSolvability`), imports at top of file
- Test: `web/src/engine/index.test.ts`

**Interfaces:**
- Consumes: `hasDuplicateDigits` from `web/src/session/assertions.ts` (unchanged, already exported).
- Produces: `ClassicSolveAssessment`'s `notSolved` reason can now be the literal string `'duplicate given digits'`, distinct from `'no solution found'`.

- [x] **Step 1: Write the failing test**

Add to the existing `describe('assessClassicSolvability', ...)` block in `web/src/engine/index.test.ts`:

```ts
  it('reports a distinct reason for duplicate given digits without attempting to solve', () => {
    const grid = Array.from({ length: 9 }, () => Array<number>(9).fill(0));
    grid[0]![0] = 7;
    grid[0]![5] = 7; // duplicate 7 in row 0 — structurally invalid, must not reach the solver
    const result = assessClassicSolvability(grid);
    expect(result.bucket).toBe('notSolved');
    expect(result.bucket === 'notSolved' && result.reason).toBe('duplicate given digits');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/index.test.ts -t "duplicate given digits"`
Expected: FAIL — current code returns `reason: 'no solution found'` (from the backtracker), not `'duplicate given digits'`.

- [x] **Step 3: Add the import and the gate**

In `web/src/engine/index.ts`, add to the imports (after the existing `import { Cell, Elimination } from './types.js';`):

```ts
import { hasDuplicateDigits } from '../session/assertions.js';
```

Replace `assessClassicSolvability` (lines 109-118):

```ts
export function assessClassicSolvability(givenDigits: number[][]): ClassicSolveAssessment {
  if (hasDuplicateDigits(givenDigits)) {
    return { bucket: 'notSolved', reason: 'duplicate given digits' };
  }
  const board = new BoardState();
  const engine = new SolverEngine(board, defaultRules().filter(r => !r.killerOnly));
  seedGivenDigits(engine, board, givenDigits);
  engine.solve();
  if (!checkStalled(board)) return { bucket: 'clean' };
  const solution = mrvBacktrack(board);
  if (solution !== null) return { bucket: 'backtracked' };
  return { bucket: 'notSolved', reason: 'no solution found' };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/index.test.ts`
Expected: PASS, all tests including the existing "returns notSolved for a contradictory grid" test (still passes — that test's grid also has a row duplicate, so it now hits the new early-return path instead of the backtracker, and its assertions — `bucket === 'notSolved'` and a truthy `reason` — still hold).

- [x] **Step 5: Commit**

```bash
git add web/src/engine/index.ts web/src/engine/index.test.ts
git commit -m "fix: gate assessClassicSolvability on hasDuplicateDigits before any solve attempt"
```

---

### Task 4: Add a capping-aware backtracking check that can *prove* infeasibility

**Files:**
- Modify: `web/src/engine/backtracker.ts` (add new function; existing `mrvBacktrack`/`search` untouched)
- Modify: `web/src/engine/backtracker.test.ts` (already exists — add a new `describe` block, matching its existing `KillerBoardState`/`makeTrivialSpec`/direct-`candidates`-assignment style, not a hypothetical new file)

**Interfaces:**
- Produces: `mrvBacktrackProvenInfeasible(board: BoardState): boolean` — `true` only when the search space was fully exhausted (not capped by `MAX_BACKTRACK_NODES`) and no solution was found. `false` if a solution exists OR the search was capped (inconclusive either way).

- [x] **Step 1: Write the failing test**

Add to `web/src/engine/backtracker.test.ts`, reusing its existing `KillerBoardState`/`makeTrivialSpec`/`KNOWN_SOLUTION` imports (already at the top of the file) and adding `mrvBacktrackProvenInfeasible` to the existing `import { mrvBacktrack } from './backtracker.js';` line:

```ts
describe('mrvBacktrackProvenInfeasible', () => {
  it('returns false when a solution exists', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    // The trivial spec's own given solution is untouched -- always solvable.
    expect(mrvBacktrackProvenInfeasible(bs)).toBe(false);
  });

  it('returns true when no completion is possible', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    // Same contradiction pattern as the existing "returns null when a cell
    // has no candidates" test above: wipe all candidates from one cell.
    bs.candidates[0]![0]! = new Set();
    expect(mrvBacktrackProvenInfeasible(bs)).toBe(true);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/backtracker.test.ts -t "mrvBacktrackProvenInfeasible"`
Expected: FAIL — `mrvBacktrackProvenInfeasible` is not exported yet.

- [x] **Step 3: Add the function**

In `web/src/engine/backtracker.ts`, add after the existing `mrvBacktrack` function (which ends at line 76):

```ts
/**
 * Proves whether a board has *no* valid completion at all — never proves a
 * specific completion is correct or unique. Runs the same MRV search as
 * `mrvBacktrack`, but only trusts a null result as a genuine infeasibility
 * proof when the search finished without hitting `MAX_BACKTRACK_NODES` —
 * a capped search giving up is not evidence either way.
 */
export function mrvBacktrackProvenInfeasible(board: BoardState): boolean {
  const constraints = board.cageConstraints();
  const cageOf: number[][] = constraints?.cageOf ?? Array.from({length: 9}, () => new Array<number>(9).fill(0));
  const cageTotal: ReadonlyMap<number, number> = constraints?.cageTotal ?? new Map();
  const cageCells: ReadonlyMap<number, readonly Cell[]> = constraints?.cageCells ?? new Map();
  const extraPeers: readonly (readonly Cell[])[][] = Array.from({length: 9}, (_, r) =>
    Array.from({length: 9}, (__, c) => board.extraPeers(r, c)));

  const cands: Set<number>[][] = Array.from({length: 9}, (_, r) =>
    Array.from({length: 9}, (__, c) => new Set(board.cands(r, c))));

  const counter = { n: 0 };
  const solution = search(cands, cageOf, cageTotal, cageCells, extraPeers, counter);
  const capped = counter.n > MAX_BACKTRACK_NODES;
  return solution === null && !capped;
}
```

`search` and `MAX_BACKTRACK_NODES` are already module-scope in this file (used by `mrvBacktrack` above) — no new import needed.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/backtracker.test.ts`
Expected: PASS.

- [x] **Step 5: Run the full suite for regressions**

Run: `npx vitest run`
Expected: PASS, same behavior for every existing `mrvBacktrack` caller (untouched).

- [x] **Step 6: Commit**

```bash
git add web/src/engine/backtracker.ts web/src/engine/backtracker.test.ts
git commit -m "feat: add mrvBacktrackProvenInfeasible, a capping-aware infeasibility proof"
```

---

### Task 5: Extract a rules-only solve helper from `assessClassicSolvability`

**Files:**
- Modify: `web/src/engine/index.ts` (add `solveClassicByRulesOnly`, refactor `assessClassicSolvability` to use it)
- Test: `web/src/engine/index.test.ts`

**Interfaces:**
- Produces: `solveClassicByRulesOnly(givenDigits: number[][]): { board: BoardState; solvedByRulesAlone: boolean }`. Does **not** run `hasDuplicateDigits` or backtracking — callers that need the validity gate (like `assessClassicSolvability`) or a backtracking fallback (like Task 6's module) apply those themselves. `solvedByRulesAlone: true` is a sound uniqueness proof (every cell was logically forced).

- [ ] **Step 1: Write the failing test**

Add `makeClassicGivenDigits` to the existing `import { ... } from './fixtures.js';` at the top of `web/src/engine/index.test.ts`, then add:

```ts
describe('solveClassicByRulesOnly', () => {
  it('proves uniqueness (solvedByRulesAlone=true) for a puzzle the folklore rules fully resolve', () => {
    // makeClassicGivenDigits() (fixtures.ts) is KNOWN_SOLUTION with only cell
    // (0,0) blanked -- a single naked/hidden single, trivially rules-solvable.
    const result = solveClassicByRulesOnly(makeClassicGivenDigits());
    expect(result.solvedByRulesAlone).toBe(true);
  });

  it('reports solvedByRulesAlone=false when propagation stalls', () => {
    const empty = Array.from({ length: 9 }, () => Array<number>(9).fill(0));
    const result = solveClassicByRulesOnly(empty);
    expect(result.solvedByRulesAlone).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/index.test.ts -t "solveClassicByRulesOnly"`
Expected: FAIL — function not exported yet.

- [ ] **Step 3: Add the helper and refactor `assessClassicSolvability` to use it**

In `web/src/engine/index.ts`, add before `assessClassicSolvability`:

```ts
/**
 * Seeds given digits and runs the folklore rule engine (no killer-only rules,
 * no backtracking). `solvedByRulesAlone: true` is a sound proof that the
 * grid has a unique solution — every cell's value was logically forced.
 * Does not check `hasDuplicateDigits` — callers must gate on that themselves.
 */
export function solveClassicByRulesOnly(givenDigits: number[][]): { board: BoardState; solvedByRulesAlone: boolean } {
  const board = new BoardState();
  const engine = new SolverEngine(board, defaultRules().filter(r => !r.killerOnly));
  seedGivenDigits(engine, board, givenDigits);
  engine.solve();
  return { board, solvedByRulesAlone: !checkStalled(board) };
}
```

Replace `assessClassicSolvability` to reuse it:

```ts
export function assessClassicSolvability(givenDigits: number[][]): ClassicSolveAssessment {
  if (hasDuplicateDigits(givenDigits)) {
    return { bucket: 'notSolved', reason: 'duplicate given digits' };
  }
  const { board, solvedByRulesAlone } = solveClassicByRulesOnly(givenDigits);
  if (solvedByRulesAlone) return { bucket: 'clean' };
  const solution = mrvBacktrack(board);
  if (solution !== null) return { bucket: 'backtracked' };
  return { bucket: 'notSolved', reason: 'no solution found' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/index.test.ts`
Expected: PASS, all tests (including Task 3's new test and every pre-existing `assessClassicSolvability` test — behavior is unchanged, only internally refactored).

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/index.ts web/src/engine/index.test.ts
git commit -m "refactor: extract solveClassicByRulesOnly from assessClassicSolvability"
```

---

### Task 6: `retrainingSuggestions.ts` — the core auto-labeling module

**Files:**
- Create: `web/src/engine/retrainingSuggestions.ts`
- Create: `web/src/engine/retrainingSuggestions.test.ts`

**Interfaces:**
- Consumes: `hasDuplicateDigits`, `findDuplicateCells` (`../session/assertions.js`); `solveClassicByRulesOnly`, `mrvBacktrackProvenInfeasible` (`./index.js`, `./backtracker.js`); `Recognition` (`../image/numberRecognition.js`).
- Produces:
```ts
export interface RetrainingSuggestion {
  row: number;
  col: number;
  predictedLabel: number;
  suggestedLabel: number;
  confidenceTier: 'proven_unique' | 'feasible_only';
  crop: Uint8Array; // the exact 64x64 thumbnail the classifier saw
}

export function findRetrainingSuggestions(
  givenDigits: readonly (readonly number[])[],
  cellThumbs: ReadonlyMap<string, Uint8Array[]>,
  recognitions: ReadonlyMap<string, Recognition>,
): RetrainingSuggestion[]
```

- [ ] **Step 1: Write the failing test**

Create `web/src/engine/retrainingSuggestions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findRetrainingSuggestions } from './retrainingSuggestions.js';
import { KNOWN_SOLUTION } from './fixtures.js';
import type { Recognition } from '../image/numberRecognition.js';

function thumb(seed: number): Uint8Array {
  // Distinct-but-arbitrary 64x64 crop content; only identity/byte-equality
  // across the pipeline matters here, not visual content.
  return new Uint8Array(64 * 64).fill(seed);
}

describe('findRetrainingSuggestions', () => {
  it('proposes a proven_unique correction when the runner-up resolves the clash and the corrected grid solves by rules alone', () => {
    // KNOWN_SOLUTION (fixtures.ts) is a complete valid grid: column 0 is
    // [5,6,1,8,4,7,9,2,3]. Corrupt (0,0) from its true value 5 to 6, matching
    // row 1's column-0 given -- a genuine column-0 duplicate on 6, mirroring
    // this session's real classic_guardian/expert/killer_sudoku_274.jpg
    // finding (a misread cell clashing with a correctly-read one elsewhere in
    // the same column). The runner-up correctly names the true digit, 5.
    const givenDigits = KNOWN_SOLUTION.map(row => [...row]);
    givenDigits[0]![0] = 6;

    const cellThumbs = new Map<string, Uint8Array[]>([['0,0', [thumb(1)]]]);
    const recognitions = new Map<string, Recognition>([
      ['0,0', { label: 6, confident: true, runnerUp: { label: 5, score: 5 } }],
    ]);

    const suggestions = findRetrainingSuggestions(givenDigits, cellThumbs, recognitions);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      row: 0, col: 0, predictedLabel: 6, suggestedLabel: 5,
      confidenceTier: 'proven_unique',
    });
  });

  it('proposes nothing when there is no clash at all', () => {
    const cellThumbs = new Map<string, Uint8Array[]>();
    const recognitions = new Map<string, Recognition>();
    const givenDigits = Array.from({ length: 9 }, () => Array(9).fill(0));
    expect(findRetrainingSuggestions(givenDigits, cellThumbs, recognitions)).toEqual([]);
  });

  it('never proposes a correction for a cell with no runnerUp available', () => {
    const givenDigits = Array.from({ length: 9 }, () => Array(9).fill(0));
    givenDigits[0]![0] = 7;
    givenDigits[0]![5] = 7;
    const cellThumbs = new Map<string, Uint8Array[]>([
      ['0,0', [thumb(1)]], ['0,5', [thumb(2)]],
    ]);
    const recognitions = new Map<string, Recognition>([
      ['0,0', { label: 7, confident: true }], // no runnerUp
      ['0,5', { label: 7, confident: true }], // no runnerUp
    ]);
    expect(findRetrainingSuggestions(givenDigits, cellThumbs, recognitions)).toEqual([]);
  });
});
```

`KNOWN_SOLUTION` is already `export const KNOWN_SOLUTION: readonly (readonly number[])[]` in `web/src/engine/fixtures.ts` — no export change needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/retrainingSuggestions.test.ts`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement `retrainingSuggestions.ts`**

Create `web/src/engine/retrainingSuggestions.ts`:

```ts
/**
 * Detects likely digit-recognizer misreads in classic given-digit grids from
 * real corpus photos and proposes corrections for manual review.
 *
 * Never treats "a solution exists" as proof a correction is right: only a
 * folklore rule-engine solve that fully resolves the corrected grid on its
 * own (solveClassicByRulesOnly, no backtracking) counts as a uniqueness
 * proof (confidenceTier: 'proven_unique'). A capping-aware backtracking
 * search (mrvBacktrackProvenInfeasible) is used exclusively to rule out
 * corrections that make the puzzle outright infeasible — never to confirm
 * one. Every candidate is gated on hasDuplicateDigits before any solve is
 * attempted, and again after substitution before accepting a result.
 */
import { hasDuplicateDigits, findDuplicateCells } from '../session/assertions.js';
import { solveClassicByRulesOnly } from './index.js';
import { mrvBacktrackProvenInfeasible } from './backtracker.js';
import type { Recognition } from '../image/numberRecognition.js';

export interface RetrainingSuggestion {
  row: number;
  col: number;
  predictedLabel: number;
  suggestedLabel: number;
  confidenceTier: 'proven_unique' | 'feasible_only';
  crop: Uint8Array;
}

export function findRetrainingSuggestions(
  givenDigits: readonly (readonly number[])[],
  cellThumbs: ReadonlyMap<string, Uint8Array[]>,
  recognitions: ReadonlyMap<string, Recognition>,
): RetrainingSuggestion[] {
  if (!hasDuplicateDigits(givenDigits)) return [];

  const mutableGrid = givenDigits.map(row => [...row]);
  const clashingCells = findDuplicateCells(mutableGrid);
  const suggestions: RetrainingSuggestion[] = [];

  for (const key of clashingCells) {
    const [rowStr, colStr] = key.split(',');
    const row = Number(rowStr);
    const col = Number(colStr);
    const recognition = recognitions.get(key);
    if (recognition?.runnerUp === undefined) continue;

    const original = mutableGrid[row]![col]!;
    mutableGrid[row]![col] = recognition.runnerUp.label;

    if (hasDuplicateDigits(mutableGrid)) {
      // Substitution didn't clear every clash (multiple independent clashes,
      // or it introduced a new one) — reject without ever attempting a solve.
      mutableGrid[row]![col] = original;
      continue;
    }

    const { board, solvedByRulesAlone } = solveClassicByRulesOnly(mutableGrid);
    const thumbArr = cellThumbs.get(key);
    const crop = thumbArr?.[0];

    if (solvedByRulesAlone && crop !== undefined) {
      suggestions.push({
        row, col,
        predictedLabel: recognition.label,
        suggestedLabel: recognition.runnerUp.label,
        confidenceTier: 'proven_unique',
        crop,
      });
    } else if (crop !== undefined && !mrvBacktrackProvenInfeasible(board)) {
      // Not proven unique, but not proven infeasible either — a plausible
      // candidate for human review, flagged at lower confidence.
      suggestions.push({
        row, col,
        predictedLabel: recognition.label,
        suggestedLabel: recognition.runnerUp.label,
        confidenceTier: 'feasible_only',
        crop,
      });
    }
    // else: mrvBacktrackProvenInfeasible === true → this correction is wrong
    // (or insufficient); reject it, propose nothing for this cell.

    mutableGrid[row]![col] = original;
  }

  return suggestions;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/retrainingSuggestions.test.ts`
Expected: PASS, all three tests.

- [ ] **Step 5: Run the full suite for regressions**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/engine/retrainingSuggestions.ts web/src/engine/retrainingSuggestions.test.ts
git commit -m "feat: add findRetrainingSuggestions — proven-unique-only digit correction proposals"
```

---

### Task 7: `corpus.db` schema + insert helper + doc update

**Files:**
- Modify: `web/scripts/corpus-db.ts` (`openDb`, new `insertRetrainingSuggestion` function, new `RetrainingSuggestionRow` interface)
- Modify: `docs/corpus-db.md` (document the new table)
- Modify: `web/scripts/corpus-db.test.ts` (already exists — reuses its existing `tmpDb()` helper and `afterEach` cleanup; also update its `describe('openDb', ...)` "creates all three tables" test, which will otherwise regress to expecting the old table count)

**Interfaces:**
- Produces:
```ts
export interface RetrainingSuggestionRow {
  puzzleHash: string;
  gitHash: string;
  row: number;
  col: number;
  predictedLabel: number;
  suggestedLabel: number;
  confidenceTier: 'proven_unique' | 'feasible_only';
  cropPixels: number[]; // flattened 64x64, matches TrainingSample.pixels shape
}
export function insertRetrainingSuggestion(db: Database.Database, s: RetrainingSuggestionRow): void
```

- [ ] **Step 1: Write the failing tests**

Add `insertRetrainingSuggestion` to the existing `import { ... } from './corpus-db.js';` at the top of `web/scripts/corpus-db.test.ts`, then add a new `describe` block using the file's existing `tmpDb()` helper (defined at the top of the file, reused by every other `describe` block — do not redefine it):

```ts
describe('retraining_suggestions table', () => {
  it('creates the table and accepts a pending suggestion', () => {
    const db = tmpDb();
    insertPuzzle(db, 'hash123', '/path/to/img.jpg', 'guardian', 'classic');
    insertRetrainingSuggestion(db, {
      puzzleHash: 'hash123',
      gitHash: 'test-hash',
      row: 1, col: 0,
      predictedLabel: 7, suggestedLabel: 2,
      confidenceTier: 'proven_unique',
      cropPixels: new Array(64 * 64).fill(0),
    });
    const row = db.prepare('SELECT * FROM retraining_suggestions WHERE puzzle_hash = ?').get('hash123') as
      { status: string; predicted_label: number; suggested_label: number } | undefined;
    expect(row?.status).toBe('pending');
    expect(row?.predicted_label).toBe(7);
    expect(row?.suggested_label).toBe(2);
    db.close();
  });
});
```

Also update the existing `describe('openDb', ...)` block's `'creates all three tables'` test (it currently asserts exactly `['corpora', 'evaluations', 'puzzles']`, which this task's new table will break):

```ts
  it('creates all four tables', () => {
    const db = tmpDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
    ).map(r => r.name).filter(n => !n.startsWith('sqlite_'));
    expect(names).toEqual(['corpora', 'evaluations', 'puzzles', 'retraining_suggestions']);
    db.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/corpus-db.test.ts`
Expected: FAIL — both the new `retraining_suggestions table` describe block (table/function don't exist yet) and the updated `'creates all four tables'` test (still only 3 tables exist).

- [ ] **Step 3: Add the table to `openDb`**

In `web/scripts/corpus-db.ts`, add to the `CREATE TABLE IF NOT EXISTS` block inside `openDb` (after the `corpora` table):

```sql
    CREATE TABLE IF NOT EXISTS retraining_suggestions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      puzzle_hash       TEXT NOT NULL REFERENCES puzzles(content_hash),
      git_hash          TEXT NOT NULL,
      row               INTEGER NOT NULL,
      col               INTEGER NOT NULL,
      predicted_label   INTEGER NOT NULL,
      suggested_label   INTEGER NOT NULL,
      confidence_tier   TEXT NOT NULL,
      crop_pixels       TEXT NOT NULL, -- JSON array, flattened 64x64
      status            TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
```

- [ ] **Step 4: Add the interface and insert helper**

In `web/scripts/corpus-db.ts`, add near the other row interfaces:

```ts
export interface RetrainingSuggestionRow {
  puzzleHash: string;
  gitHash: string;
  row: number;
  col: number;
  predictedLabel: number;
  suggestedLabel: number;
  confidenceTier: 'proven_unique' | 'feasible_only';
  cropPixels: number[];
}

export function insertRetrainingSuggestion(db: Database.Database, s: RetrainingSuggestionRow): void {
  db.prepare(`
    INSERT INTO retraining_suggestions
      (puzzle_hash, git_hash, row, col, predicted_label, suggested_label, confidence_tier, crop_pixels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.puzzleHash, s.gitHash, s.row, s.col,
    s.predictedLabel, s.suggestedLabel, s.confidenceTier,
    JSON.stringify(s.cropPixels),
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run scripts/corpus-db.test.ts`
Expected: PASS.

- [ ] **Step 6: Document the new table**

In `docs/corpus-db.md`, add a new `### \`retraining_suggestions\`` section (after `### evaluations`'s subsections, before the `## Evaluator CLI options` section), following the existing table-documentation style:

```markdown
### `retraining_suggestions`

One row per proposed digit-recognizer correction, found via the classic
given-digit validity/solvability pipeline (`web/src/engine/retrainingSuggestions.ts`).
Never auto-applied — `status` starts `pending` and only changes via
`web/scripts/review-retraining-suggestions.ts`.

| Column | Type | Meaning |
|--------|------|---------|
| `id` | INTEGER PK | Auto-increment |
| `puzzle_hash` | TEXT | FK → `puzzles.content_hash` |
| `git_hash` | TEXT | Evaluation run that produced this suggestion |
| `row`, `col` | INTEGER | 0-indexed cell coordinates |
| `predicted_label` | INTEGER | The classifier's original (rejected) label |
| `suggested_label` | INTEGER | The runner-up label being proposed as the correction |
| `confidence_tier` | TEXT | `proven_unique` (folklore rules alone proved the corrected grid's uniqueness) or `feasible_only` (a solution exists but uniqueness wasn't proven — weaker evidence, review with more skepticism) |
| `crop_pixels` | TEXT | JSON array, flattened 64×64 uint8 — the exact thumbnail the classifier saw |
| `status` | TEXT | `pending` / `approved` / `rejected` — set only by manual review |
| `created_at` | TEXT | ISO datetime |
```

- [ ] **Step 7: Commit**

```bash
git add web/scripts/corpus-db.ts web/scripts/corpus-db.test.ts docs/corpus-db.md
git commit -m "feat: add retraining_suggestions table to corpus.db"
```

---

### Task 8: Wire suggestion-finding into the app and the corpus evaluator's outcome payload

**Files:**
- Modify: `web/src/main.ts` (classic-review reporting path, ~line 1455-1475 per this session's investigation — verify exact current line numbers with `Grep` for `debugStagePayload` before editing, since earlier tasks may have shifted them)
- Modify: `web/scripts/evaluate-corpus.ts:51-77` (`UploadOutcomeJson`)
- Test: extend `web/scripts/evaluate-corpus.test.ts` if it covers outcome-shape parsing; otherwise cover via Task 6/7's existing unit tests (this task is thin wiring, not new logic)

**Interfaces:**
- Consumes: `findRetrainingSuggestions` (Task 6), `RetrainingSuggestion` (Task 6).
- Produces: `UploadOutcomeJson.retrainingSuggestions?: readonly RetrainingSuggestion[]`.

- [ ] **Step 1: Locate the exact current reporting site**

Run: `Grep` for `assessClassicSolvability` in `web/src/main.ts` to find its current call site(s) (there were two in this session's investigation — the upload-time eager assessment and the `redrawGrid`-adjacent one after a manual digit edit). Confirm line numbers before editing.

- [ ] **Step 2: Compute and attach suggestions at the eager upload-time assessment**

At the call site where `main.ts` calls `assessClassicSolvability(state.givenDigits)` for the eager upload-time report (the one feeding `bucket`/`reason` into `__reportOutcome`), import `findRetrainingSuggestions` from `../engine/retrainingSuggestions.js`, and when `assessment.bucket !== 'clean'`, compute:

```ts
const retrainingSuggestions = state.givenDigits !== null && uploadResult.classicRecognitions !== undefined
  ? findRetrainingSuggestions(state.givenDigits, uploadResult.cellThumbs, uploadResult.classicRecognitions)
  : [];
```

Add `retrainingSuggestions,` to the `__reportOutcome?.({...})` call's object at that site (only when non-empty is fine too, but always including an empty array keeps the shape predictable for `evaluate-corpus.ts`).

- [ ] **Step 3: Extend `UploadOutcomeJson`**

In `web/scripts/evaluate-corpus.ts`, add to the `UploadOutcomeJson` interface (after `readonly allocBytes?: number;`):

```ts
  readonly retrainingSuggestions?: ReadonlyArray<{
    readonly row: number;
    readonly col: number;
    readonly predictedLabel: number;
    readonly suggestedLabel: number;
    readonly confidenceTier: 'proven_unique' | 'feasible_only';
    readonly crop: number[]; // JSON-serialised Uint8Array
  }>;
```

- [ ] **Step 4: Type-check and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both pass. No behavior change yet for `evaluate-corpus.ts`'s persistence (that's Task 9) — this task only makes the data available on the outcome object.

- [ ] **Step 5: Commit**

```bash
git add web/src/main.ts web/scripts/evaluate-corpus.ts
git commit -m "feat: attach retraining suggestions to the classic-review outcome payload"
```

---

### Task 9: Persist suggestions during corpus evaluation

**Files:**
- Modify: `web/scripts/evaluate-corpus.ts:145-346` (`runWorker`)

**Interfaces:**
- Consumes: `insertRetrainingSuggestion` (Task 7), `outcome.retrainingSuggestions` (Task 8).

- [ ] **Step 1: Write the failing test**

Given `runWorker` drives a real Playwright browser end-to-end, this is best covered by a targeted unit test of the persistence call in isolation rather than a full browser round-trip. Add `RetrainingSuggestionRow` to the existing `import { ... } from './corpus-db.js';` in `web/scripts/corpus-db.test.ts`, then add:

```ts
it('insertRetrainingSuggestion is safe to call multiple times for the same puzzle/cell (append, not upsert)', () => {
  const db = tmpDb();
  insertPuzzle(db, 'hashA', '/path/a.jpg', 'guardian', 'classic');
  const row: RetrainingSuggestionRow = {
    puzzleHash: 'hashA', gitHash: 'g1', row: 0, col: 0,
    predictedLabel: 7, suggestedLabel: 2,
    confidenceTier: 'proven_unique', cropPixels: [0],
  };
  insertRetrainingSuggestion(db, row);
  insertRetrainingSuggestion(db, row);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM retraining_suggestions').get() as { n: number }).n;
  expect(count).toBe(2); // by design: every run's findings are recorded, review script dedupes by judgement
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/corpus-db.test.ts -t "safe to call multiple times"`
Expected: PASS already (Task 7's `insertRetrainingSuggestion` has no uniqueness constraint) — this step documents the intended append-only behavior as a regression guard, not a new failing case.

- [ ] **Step 3: Wire persistence into `runWorker`**

In `web/scripts/evaluate-corpus.ts`, in `runWorker`, immediately after the existing `completeEvaluation(db, claim.id, status, bucket, reason, detectedType, Date.now() - startMs, specHash, extras);` line, add:

```ts
    for (const s of outcome?.retrainingSuggestions ?? []) {
      insertRetrainingSuggestion(db, {
        puzzleHash: claim.puzzle_hash,
        gitHash,
        row: s.row,
        col: s.col,
        predictedLabel: s.predictedLabel,
        suggestedLabel: s.suggestedLabel,
        confidenceTier: s.confidenceTier,
        cropPixels: s.crop,
      });
    }
```

Add `insertRetrainingSuggestion` to the existing `import { ... } from './corpus-db.js';` at the top of the file.

- [ ] **Step 4: Run the full suite for regressions**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/scripts/evaluate-corpus.ts
git commit -m "feat: persist retraining suggestions during corpus evaluation"
```

---

### Task 10: Manual-review script

**Files:**
- Create: `web/scripts/review-retraining-suggestions.ts`

**Interfaces:**
- Consumes: `corpus.db`'s `retraining_suggestions` table (Task 7).
- Produces: a CLI script — no new library interfaces (this is a thin operator tool).

- [ ] **Step 1: Write the failing test**

Create `web/scripts/review-retraining-suggestions.test.ts`, using the same temp-file `tmpDb()` + `afterEach` cleanup pattern already established in `web/scripts/corpus-db.test.ts` (a fresh local copy here, not a cross-test-file import):

```ts
import { afterEach, describe, it, expect } from 'vitest';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, insertPuzzle, insertRetrainingSuggestion } from './corpus-db.js';
import { dumpPendingSuggestions, setSuggestionStatus } from './review-retraining-suggestions.js';

let dbPath = '';
afterEach(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = dbPath + suffix;
    try { if (f && existsSync(f)) unlinkSync(f); } catch { /* ignore EBUSY on Windows */ }
  }
});
function tmpDb(): ReturnType<typeof openDb> {
  dbPath = path.join(os.tmpdir(), `review-test-${Date.now()}-${Math.random()}.db`);
  return openDb(dbPath);
}

describe('review-retraining-suggestions', () => {
  it('dumps a PNG per pending suggestion and a manifest listing them', () => {
    const db = tmpDb();
    insertPuzzle(db, 'hashA', '/path/a.jpg', 'guardian', 'classic');
    insertRetrainingSuggestion(db, {
      puzzleHash: 'hashA', gitHash: 'g1', row: 1, col: 0,
      predictedLabel: 7, suggestedLabel: 2,
      confidenceTier: 'proven_unique', cropPixels: new Array(64 * 64).fill(255),
    });
    const outDir = path.join(os.tmpdir(), `review-out-test-${Date.now()}`);
    const manifest = dumpPendingSuggestions(db, outDir);
    expect(manifest).toHaveLength(1);
    expect(existsSync(manifest[0]!.pngPath)).toBe(true);
    rmSync(outDir, { recursive: true, force: true });
    db.close();
  });

  it('setSuggestionStatus updates status and is idempotent', () => {
    const db = tmpDb();
    insertPuzzle(db, 'hashA', '/path/a.jpg', 'guardian', 'classic');
    insertRetrainingSuggestion(db, {
      puzzleHash: 'hashA', gitHash: 'g1', row: 1, col: 0,
      predictedLabel: 7, suggestedLabel: 2,
      confidenceTier: 'proven_unique', cropPixels: [0],
    });
    const id = (db.prepare('SELECT id FROM retraining_suggestions').get() as { id: number }).id;
    setSuggestionStatus(db, id, 'approved');
    const row = db.prepare('SELECT status FROM retraining_suggestions WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('approved');
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/review-retraining-suggestions.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement the script**

Create `web/scripts/review-retraining-suggestions.ts`:

```ts
#!/usr/bin/env vite-node
/**
 * Manual review tool for retraining_suggestions: dumps each pending
 * suggestion's crop as a PNG plus a manifest for a human to eyeball, then
 * lets the reviewer approve/reject by id. Never auto-approves anything.
 *
 * Usage:
 *   npx vite-node scripts/review-retraining-suggestions.ts --dump [--out DIR]
 *   npx vite-node scripts/review-retraining-suggestions.ts --approve 12 15 20
 *   npx vite-node scripts/review-retraining-suggestions.ts --reject 8
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { openDb } from './corpus-db.js';
import type Database from 'better-sqlite3';

export interface ManifestEntry {
  id: number;
  puzzlePath: string;
  row: number;
  col: number;
  predictedLabel: number;
  suggestedLabel: number;
  confidenceTier: string;
  pngPath: string;
}

export function dumpPendingSuggestions(db: Database.Database, outDir: string): ManifestEntry[] {
  fs.mkdirSync(outDir, { recursive: true });
  const rows = db.prepare(`
    SELECT rs.id, p.path AS puzzle_path, rs.row, rs.col, rs.predicted_label,
           rs.suggested_label, rs.confidence_tier, rs.crop_pixels
    FROM retraining_suggestions rs
    JOIN puzzles p ON p.content_hash = rs.puzzle_hash
    WHERE rs.status = 'pending'
    ORDER BY rs.confidence_tier DESC, rs.id
  `).all() as Array<{
    id: number; puzzle_path: string; row: number; col: number;
    predicted_label: number; suggested_label: number; confidence_tier: string; crop_pixels: string;
  }>;

  const manifest: ManifestEntry[] = [];
  for (const r of rows) {
    const pixels: number[] = JSON.parse(r.crop_pixels);
    const png = new PNG({ width: 64, height: 64, colorType: 0 });
    for (let i = 0; i < pixels.length; i++) png.data[i] = pixels[i]!;
    const pngPath = path.join(outDir, `${r.id}_pred${r.predicted_label}_suggest${r.suggested_label}.png`);
    fs.writeFileSync(pngPath, PNG.sync.write(png));
    manifest.push({
      id: r.id, puzzlePath: r.puzzle_path, row: r.row, col: r.col,
      predictedLabel: r.predicted_label, suggestedLabel: r.suggested_label,
      confidenceTier: r.confidence_tier, pngPath,
    });
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function setSuggestionStatus(db: Database.Database, id: number, status: 'approved' | 'rejected'): void {
  db.prepare('UPDATE retraining_suggestions SET status = ? WHERE id = ?').run(status, id);
}

function main(): void {
  const args = process.argv.slice(2);
  const db = openDb();
  if (args.includes('--dump')) {
    const outIdx = args.indexOf('--out');
    const outDir = outIdx >= 0 ? args[outIdx + 1]! : 'retraining-review';
    const manifest = dumpPendingSuggestions(db, outDir);
    console.log(`Dumped ${manifest.length} pending suggestions to ${outDir}/ (see manifest.json)`);
  } else if (args.includes('--approve') || args.includes('--reject')) {
    const status = args.includes('--approve') ? 'approved' : 'rejected';
    const flagIdx = args.indexOf(status === 'approved' ? '--approve' : '--reject');
    for (const idStr of args.slice(flagIdx + 1)) {
      const id = Number(idStr);
      if (!Number.isInteger(id)) break;
      setSuggestionStatus(db, id, status);
      console.log(`${id}: ${status}`);
    }
  } else {
    console.error('Usage: --dump [--out DIR] | --approve ID... | --reject ID...');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

Check whether `pngjs` is already a dependency (`grep pngjs web/package.json`); if not, add it: `npm install --save-dev pngjs @types/pngjs` (from `web/`) before this step compiles.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/review-retraining-suggestions.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite for regressions**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/scripts/review-retraining-suggestions.ts web/scripts/review-retraining-suggestions.test.ts web/package.json web/package-lock.json
git commit -m "feat: add manual review script for retraining suggestions"
```

---

### Task 11: Export approved suggestions to a `train_recogniser.py`-compatible file

**Files:**
- Create: `web/scripts/export-retraining-suggestions.ts`
- Create: `web/scripts/export-retraining-suggestions.test.ts`

**Interfaces:**
- Consumes: `retraining_suggestions` rows with `status='approved'` (Task 7/10).
- Produces: a JSON file matching `TrainingExport`'s shape (`web/src/image/trainingExport.ts`), directly loadable by `load_training_file` in `web/train_recogniser.py` — no changes to the Python training pipeline needed.

- [ ] **Step 1: Write the failing test**

Create `web/scripts/export-retraining-suggestions.test.ts`, again with a local `tmpDb()` helper matching `corpus-db.test.ts`'s established pattern:

```ts
import { afterEach, describe, it, expect } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, insertPuzzle, insertRetrainingSuggestion } from './corpus-db.js';
import { exportApprovedSuggestions } from './export-retraining-suggestions.js';

let dbPath = '';
afterEach(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = dbPath + suffix;
    try { if (f && existsSync(f)) unlinkSync(f); } catch { /* ignore EBUSY on Windows */ }
  }
});
function tmpDb(): ReturnType<typeof openDb> {
  dbPath = path.join(os.tmpdir(), `export-test-${Date.now()}-${Math.random()}.db`);
  return openDb(dbPath);
}

describe('exportApprovedSuggestions', () => {
  it('exports only approved rows, in TrainingExport-compatible shape', () => {
    const db = tmpDb();
    insertPuzzle(db, 'hashA', '/path/a.jpg', 'guardian', 'classic');
    insertRetrainingSuggestion(db, {
      puzzleHash: 'hashA', gitHash: 'g1', row: 1, col: 0,
      predictedLabel: 7, suggestedLabel: 2,
      confidenceTier: 'proven_unique', cropPixels: new Array(64 * 64).fill(9),
    });
    insertRetrainingSuggestion(db, {
      puzzleHash: 'hashA', gitHash: 'g1', row: 0, col: 6,
      predictedLabel: 7, suggestedLabel: 2,
      confidenceTier: 'proven_unique', cropPixels: new Array(64 * 64).fill(3),
    });
    const [id1] = db.prepare("SELECT id FROM retraining_suggestions ORDER BY id").all() as { id: number }[];

    const result = exportApprovedSuggestions(db); // 0 approved yet
    expect(result.samples).toHaveLength(0);

    db.prepare("UPDATE retraining_suggestions SET status = 'approved' WHERE id = ?").run(id1!.id);
    const result2 = exportApprovedSuggestions(db);
    expect(result2.samples).toHaveLength(1);
    expect(result2.samples[0]).toEqual({ digit: 2, pixels: new Array(64 * 64).fill(9) });
    expect(result2.thumbnailSize).toBe(64);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/export-retraining-suggestions.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement the export script**

Create `web/scripts/export-retraining-suggestions.ts`:

```ts
#!/usr/bin/env vite-node
/**
 * Converts corpus.db's approved retraining_suggestions rows into a
 * TrainingExport-compatible JSON file — the same shape
 * web/src/image/trainingExport.ts produces and web/train_recogniser.py's
 * load_training_file already consumes. Only status='approved' rows are
 * included; nothing here retrains a model or touches num_recogniser.npz.
 *
 * Usage:
 *   npx vite-node scripts/export-retraining-suggestions.ts --out corrections.json
 */
import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import { openDb } from './corpus-db.js';

export interface RetrainingExport {
  reportType: 'retraining-suggestions-export';
  exportedAt: string;
  thumbnailSize: number;
  sampleCount: number;
  samples: Array<{ digit: number; pixels: number[] }>;
}

export function exportApprovedSuggestions(db: Database.Database): RetrainingExport {
  const rows = db.prepare(`
    SELECT suggested_label, crop_pixels FROM retraining_suggestions WHERE status = 'approved'
  `).all() as Array<{ suggested_label: number; crop_pixels: string }>;

  const samples = rows.map(r => ({ digit: r.suggested_label, pixels: JSON.parse(r.crop_pixels) as number[] }));
  return {
    reportType: 'retraining-suggestions-export' as const,
    exportedAt: new Date().toISOString(),
    thumbnailSize: 64,
    sampleCount: samples.length,
    samples,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1]! : 'retraining-suggestions-export.json';
  const db = openDb();
  const result = exportApprovedSuggestions(db);
  fs.writeFileSync(outPath, JSON.stringify(result));
  console.log(`Wrote ${result.sampleCount} approved samples to ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/export-retraining-suggestions.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm Python-side compatibility**

Run a real export, then confirm `train_recogniser.py`'s own loader accepts it unmodified:

```bash
cd web
npx vite-node scripts/export-retraining-suggestions.ts --out /tmp/test-export.json
python3 -c "
from pathlib import Path
from train_recogniser import load_training_file
samples = load_training_file(Path('/tmp/test-export.json'))
print(f'loaded {len(samples)} samples')
"
```

Expected: loads without error; `len(samples)` matches the `sampleCount` printed by the export step. (`load_training_file` only reads `data["samples"]`, each with `digit`/`pixels` — this export's extra top-level fields, e.g. `reportType`, are ignored, not rejected.)

- [ ] **Step 6: Run the full suite for regressions**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/scripts/export-retraining-suggestions.ts web/scripts/export-retraining-suggestions.test.ts
git commit -m "feat: export approved retraining suggestions to a train_recogniser.py-compatible file"
```

---

## After All Tasks: Bronze Gate and Doc Sweep

- [ ] Run `bash scripts/run-bronze-gate.sh` from the repo root — must pass before the final commit of this plan's work.
- [ ] Update this plan file's checkboxes to reflect actual completion state (per `shipwright:quality-gates`'s bronze doc-hygiene rule) before considering the branch done.
- [ ] Confirm `docs/corpus-db.md` accurately describes the final `retraining_suggestions` schema (Task 7, Step 6) — re-check against the actual `CREATE TABLE` if any column changed during implementation.
