# Big Apple Sudoku — Sprint 3: OCR Detection Heuristic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Big Apple puzzles from OCR'd given digits via a solvability heuristic (classic-only stalls, classic+window completes), wire the detected candidate and golden-solution path through the session layer, and surface a dismissible banner on the OCR review screen.

**Architecture:** `detectBigApple(givenDigits)` runs the existing rule engine twice — once on a plain `BoardState`, once on a `BigAppleBoardState` (from Sprint 1) — with constraint propagation only (no backtracking), and concludes "Big Apple" only if the first stalls and the second completes. `buildCandidatesFromParseResult` calls it for classic-detected scans and, when positive, prepends a `createBigApple` (Sprint 2) candidate. `solveCurrentSpec`'s existing 2-way killer/classic dispatch becomes 3-way via a new `solveBigApple` sibling to `solve`. The OCR review screen gains a dismissible banner driven by a `detectedBigApple` flag threaded alongside the existing candidate-list/state plumbing.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- All 2-D grid arrays are row-major (`grid[row][col]`); cell tuples are `[row, col]`.
- No `any`; prefer the weakest parameter type and strongest return type.
- This sprint depends on Sprint 1 (`BigAppleBoardState` at `web/src/engine/bigAppleBoardState.ts`) and Sprint 2 (`PuzzleState.isBigApple`/`createBigApple` at `web/src/session/types.ts`) being complete.
- Detection only runs for classic-detected scans (`result.puzzleType === 'classic'`). Killer-detected scans never get a Big Apple suggestion — their `classicCandidate` comes from a less-reliable digit pass (see the existing comment at `web/src/session/actions.ts:524-526`), and a real Big Apple photo never has cage borders.
- Detection uses constraint propagation only, never backtracking — brute-force search would solve a valid classic puzzle regardless of windows, making it useless as a discriminator.

---

## File Structure

| File | Responsibility |
|---|---|
| `web/src/engine/fixtures.ts` | Add `BIG_APPLE_SOLUTION` and `makeBigAppleGivenDigits()` — a deadly-rectangle fixture that classic rules cannot resolve but classic+window rules can. |
| `web/src/engine/index.ts` | Add `detectBigApple(givenDigits): boolean` and `solveBigApple(givenDigits?): SolveResult`. |
| `web/src/engine/index.test.ts` | Unit tests for both. |
| `web/src/session/actions.ts` | `buildCandidatesFromParseResult` returns `{ candidates, detectedBigApple }`; `buildStateFromParseResult`, `UploadResult`, `uploadPuzzle`, `loadSpecDirect`, `loadClassicDirect` thread `detectedBigApple` through; `solveCurrentSpec` gains a Big Apple branch. |
| `web/src/session/actions.test.ts` | Update existing `buildCandidatesFromParseResult` tests for the new return shape; add detection-positive tests. |
| `web/index.html` | New `#bigapple-banner` element on the OCR review screen. |
| `web/src/main.ts` | `applyUploadResult` gains a `detectedBigApple` parameter that shows/hides the banner; `handleProcess` threads it through the three classic-path call sites; a dismiss handler hides the banner. |

---

## Task 1: `detectBigApple` heuristic + fixture

**Files:**
- Modify: `web/src/engine/fixtures.ts`
- Modify: `web/src/engine/index.ts`
- Test: `web/src/engine/index.test.ts`

**Interfaces:**
- Consumes: `BoardState`, `SolverEngine`, `defaultRules` (all already imported in `index.ts`), `BigAppleBoardState` (new import from `./bigAppleBoardState.js`), the module-private `seedGivenDigits`, `checkStalled` (both already in `index.ts`).
- Produces: `export function detectBigApple(givenDigits: number[][]): boolean` — consumed by Task 3's `buildCandidatesFromParseResult`. `export const BIG_APPLE_SOLUTION: readonly (readonly number[])[]` and `export function makeBigAppleGivenDigits(): number[][]` in `fixtures.ts` — consumed by this task's tests and Task 2's tests.

The fixture is a "deadly rectangle" (Unique Rectangle): cells `(3,3)=2`, `(3,4)=7`, `(7,3)=7`, `(7,4)=2` are blanked from an otherwise-complete valid Big Apple grid. Swapping `2↔7` across those 4 cells produces a second grid that is also fully valid under plain row/column/box rules (the swap only permutes values within the same 2 rows and same 2 columns, so no row/column/box ever sees a duplicate) — so no classic-only technique (naked/hidden single, pair, triple, pointing pairs, etc.) can resolve it without assuming a unique solution; classic-only propagation provably stalls. Under classic+window rules, the swap fails: `(3,3)` is the only blank cell in the top-left window (rows 1–3, cols 1–3), so it resolves immediately to `2` (the value the swap would have placed there is invalid because the window's other 8 cells already account for every digit except `2`); symmetrically `(7,3)` resolves to `7` in the bottom-left window. With those two cells fixed, row 3's only remaining blank `(3,4)` resolves to `7` by ordinary naked single, and row 7's `(7,4)` resolves to `2`.

- [x] **Step 1: Write the failing tests**

Append to `web/src/engine/fixtures.ts` (after `makeClassicPartialGivenDigits`, before the `Lower-level helpers` section comment at line 136):

```ts
/**
 * A valid Big Apple sudoku solution (classic rules + 4 offset windows at
 * rows/cols [1..3] and [5..7], 0-based).
 */
export const BIG_APPLE_SOLUTION: readonly (readonly number[])[] = [
  [4, 8, 3, 9, 5, 7, 2, 6, 1],
  [9, 1, 5, 3, 6, 2, 7, 4, 8],
  [2, 6, 7, 8, 4, 1, 9, 5, 3],
  [1, 9, 4, 2, 7, 3, 6, 8, 5],
  [6, 5, 2, 4, 9, 8, 3, 1, 7],
  [7, 3, 8, 6, 1, 5, 4, 2, 9],
  [3, 2, 9, 5, 8, 6, 1, 7, 4],
  [5, 4, 1, 7, 2, 9, 8, 3, 6],
  [8, 7, 6, 1, 3, 4, 5, 9, 2],
];

/**
 * BIG_APPLE_SOLUTION with a deadly rectangle blanked at (3,3),(3,4),(7,3),(7,4)
 * (values 2 and 7). Classic-only constraint propagation cannot resolve this —
 * swapping 2↔7 across all 4 cells produces an equally valid classic grid — but
 * the Big Apple windows can: (3,3) is the only blank in the top-left window
 * and (7,3) is the only blank in the bottom-left window, so both resolve
 * immediately, cascading to ordinary row naked singles at (3,4) and (7,4).
 * Used as the positive case for detectBigApple's classic-stalls/window-completes
 * heuristic.
 */
export function makeBigAppleGivenDigits(): number[][] {
  const grid = BIG_APPLE_SOLUTION.map(row => [...row]);
  grid[3]![3] = 0;
  grid[3]![4] = 0;
  grid[7]![3] = 0;
  grid[7]![4] = 0;
  return grid;
}
```

Append to `web/src/engine/index.test.ts` (new `describe` block at the end of the file):

```ts
import { detectBigApple } from './index.js';
import { makeClassicGivenDigits, makeBigAppleGivenDigits } from './fixtures.js';

describe('detectBigApple', () => {
  it('returns false for an all-blank grid (both passes stall identically)', () => {
    const blank = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    expect(detectBigApple(blank)).toBe(false);
  });

  it('returns false when classic rules alone already solve the grid', () => {
    expect(detectBigApple(makeClassicGivenDigits())).toBe(false);
  });

  it('returns true for a deadly-rectangle grid that only windows can resolve', () => {
    expect(detectBigApple(makeBigAppleGivenDigits())).toBe(true);
  });
});
```

Add the two new imports (`describe`, `it`, `expect` are already imported at the top of `index.test.ts`; only the two function imports above are new) alongside the existing `import { solveFromStall, solveFromCandidates } from './index.js';` and `import { makeTrivialSpec } from './fixtures.js';` lines — combine into the existing import statements rather than duplicating them:

```ts
import { solveFromStall, solveFromCandidates, detectBigApple } from './index.js';
import { makeTrivialSpec, makeClassicGivenDigits, makeBigAppleGivenDigits } from './fixtures.js';
```

(Remove the standalone `import { detectBigApple } from './index.js';` and `import { makeClassicGivenDigits, makeBigAppleGivenDigits } from './fixtures.js';` lines shown above the `describe` block — they were shown separately only to make the new symbols explicit; merge them into the file's existing import lines instead of adding duplicate imports.)

- [x] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/engine/index.test.ts -t detectBigApple`
Expected: FAIL — `detectBigApple is not exported by './index.js'` (or a TypeScript error if compiled first).

- [x] **Step 3: Write minimal implementation**

In `web/src/engine/index.ts`, add the import (after the existing `import { BoardState, KillerBoardState } from './boardState.js';` line):

```ts
import { BigAppleBoardState } from './bigAppleBoardState.js';
```

Add the function after `seedGivenDigits` (after line 42, before the `SolveResult` interface):

```ts
/**
 * Heuristic Big Apple detector: runs classic-only constraint propagation; if
 * it stalls before every cell is solved, retries with the 4 extra window
 * units (BigAppleBoardState). Concludes "Big Apple" only if the window retry
 * completes the grid. Backtracking is deliberately excluded from both passes
 * — brute-force search would solve a valid classic puzzle regardless of
 * windows, making it useless as a discriminator.
 */
export function detectBigApple(givenDigits: number[][]): boolean {
  const classicBoard = new BoardState();
  const classicEngine = new SolverEngine(classicBoard, defaultRules().filter(r => !r.killerOnly));
  seedGivenDigits(classicEngine, classicBoard, givenDigits);
  classicEngine.solve();
  if (!checkStalled(classicBoard)) return false;

  const windowBoard = new BigAppleBoardState();
  const windowEngine = new SolverEngine(windowBoard, defaultRules().filter(r => !r.killerOnly));
  seedGivenDigits(windowEngine, windowBoard, givenDigits);
  windowEngine.solve();
  return !checkStalled(windowBoard);
}
```

`checkStalled` is defined further down in the file (line 54) — since this is a same-file function declaration, hoisting makes it available regardless of declaration order, but for readability move `detectBigApple` below `checkStalled`'s definition instead: insert it immediately after `checkStalled` (after line 58) rather than after `seedGivenDigits`.

- [x] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/engine/index.test.ts -t detectBigApple`
Expected: PASS (all 3 new tests).

- [x] **Step 5: Commit**

```bash
git add web/src/engine/fixtures.ts web/src/engine/index.ts web/src/engine/index.test.ts
git commit -m "feat: add detectBigApple solvability heuristic and deadly-rectangle fixture"
```

---

## Task 2: `solveBigApple` + `solveCurrentSpec` 3-way dispatch

**Files:**
- Modify: `web/src/engine/index.ts`
- Modify: `web/src/session/actions.ts`
- Test: `web/src/engine/index.test.ts`
- Test: `web/src/session/actions.test.ts`

**Interfaces:**
- Consumes: `BigAppleBoardState` (Task 1's import), `SolverEngine`, `defaultRules`, `seedGivenDigits`, `runWithBacktrack`, `checkStalled` (all already in `index.ts`), `PuzzleState.isBigApple` (Sprint 2).
- Produces: `export function solveBigApple(givenDigits?: number[][]): SolveResult` — consumed by `solveCurrentSpec` in this task, and available for future direct use. `solveCurrentSpec()`'s behaviour for Big Apple states changes from "always builds a `KillerBoardState`, ignoring windows" to "dispatches to `solveBigApple` when `PuzzleState.isBigApple(state)`".

This closes a real bug: `solveCurrentSpec()` (used by `confirmPuzzle`'s caller in `main.ts` to compute the golden solution at confirm time) currently has no knowledge of Big Apple at all — it always falls into the classic/killer 2-way branch, which builds a plain `KillerBoardState` with classic-only rules, silently ignoring the 4 window constraints for a confirmed Big Apple puzzle. Without this fix, a Big Apple puzzle could confirm with a golden solution that violates its own windows.

- [x] **Step 1: Write the failing tests**

Append to `web/src/engine/index.test.ts`:

```ts
import { solveBigApple } from './index.js';

describe('solveBigApple', () => {
  it('fully solves the deadly-rectangle fixture using windows, no backtracking', () => {
    const result = solveBigApple(makeBigAppleGivenDigits());
    expect(result.usedBacktracking).toBe(false);
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        expect([...result.board.cands(r, c)]).toEqual([BIG_APPLE_SOLUTION[r]![c]!]);
  });

  it('falls back to backtracking when given no digits at all', () => {
    const result = solveBigApple();
    expect(result.usedBacktracking).toBe(true);
  });
});
```

(Merge the `solveBigApple` import into the existing `import { solveFromStall, solveFromCandidates, detectBigApple } from './index.js';` line from Task 1, and add `BIG_APPLE_SOLUTION` to the existing `import { makeTrivialSpec, makeClassicGivenDigits, makeBigAppleGivenDigits } from './fixtures.js';` line — do not add a second, duplicate import line.)

Add to `web/src/session/actions.test.ts`, in the existing `describe('solveCurrentSpec', ...)` block (find it via `grep -n "describe('solveCurrentSpec'" web/src/session/actions.test.ts` if its exact line number has shifted):

```ts
  it('dispatches to solveBigApple for a Big Apple state', () => {
    const givenDigits = makeBigAppleGivenDigits();
    const state = PuzzleState.createBigApple(givenDigits, [], null);
    setState(state);
    const result = solveCurrentSpec();
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        expect([...result.board.cands(r, c)]).toEqual([BIG_APPLE_SOLUTION[r]![c]!]);
  });
```

This requires `makeBigAppleGivenDigits` and `BIG_APPLE_SOLUTION` imported from `'../engine/fixtures.js'` in `actions.test.ts` (add to its existing fixtures import line if one exists, else add a new import line), and confirms the exact `setState`/`solveCurrentSpec` call pattern used by the file's other `solveCurrentSpec` tests (match their existing style — read a neighbouring test in the same `describe` block before writing this one).

- [x] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/engine/index.test.ts -t solveBigApple && npx vitest run src/session/actions.test.ts -t "dispatches to solveBigApple"`
Expected: FAIL — `solveBigApple is not exported` for the first; the second fails with a wrong/missing-windows result once `solveBigApple` exists but `solveCurrentSpec` hasn't been updated yet (run it after Step 3's `index.ts` half is done but before the `actions.ts` half, or just expect both to fail at once now).

- [x] **Step 3: Write minimal implementation**

In `web/src/engine/index.ts`, add `solveBigApple` immediately after `solve` (after line 94):

```ts
/**
 * Run the full solver engine on a Big Apple puzzle (classic rules + the 4
 * extra window units). Falls back to MRV backtracking if the rule engine
 * stalls, mirroring solve()'s contract.
 */
export function solveBigApple(givenDigits?: number[][]): SolveResult {
  const board = new BigAppleBoardState();
  const engine = new SolverEngine(board, defaultRules().filter(r => !r.killerOnly));

  if (givenDigits) seedGivenDigits(engine, board, givenDigits);

  engine.solve();

  return runWithBacktrack(board, checkStalled(board));
}
```

In `web/src/session/actions.ts`, modify `solveCurrentSpec` (currently lines 517-529):

```ts
export function solveCurrentSpec(): SolveResult {
  const state = requireState();
  if (state.goldenSolution !== null) throw new Error('Already confirmed');
  if (PuzzleState.isBigApple(state)) {
    return solveBigApple(state.givenDigits ?? undefined);
  }
  const spec = PuzzleState.isKiller(state)
    ? cageStatesToSpec(state.cageStates, state.specData)
    : classicSyntheticSpec();
  // givenDigits are only meaningful for classic puzzles (pre-filled cells).
  // For killer puzzles, readClassicDigits can produce false-positive detections
  // (e.g. a cage total digit near the cell centre). Passing them to solve()
  // would incorrectly force those cells, potentially producing invalid solutions.
  const givenDigits = PuzzleState.isKiller(state) ? undefined : (state.givenDigits ?? undefined);
  return solve(spec, givenDigits);
}
```

Update the `solve` import at the top of `actions.ts` (currently `import { solve, BoardState, KillerBoardState, intersectAll, SolveResult } from '../engine/index.js';`) to also import `solveBigApple`:

```ts
import { solve, solveBigApple, BoardState, KillerBoardState, intersectAll, SolveResult } from '../engine/index.js';
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/engine/index.test.ts -t solveBigApple && npx vitest run src/session/actions.test.ts -t "dispatches to solveBigApple"`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/engine/index.ts web/src/engine/index.test.ts web/src/session/actions.ts web/src/session/actions.test.ts
git commit -m "feat: add solveBigApple and dispatch it from solveCurrentSpec"
```

---

## Task 3: `buildCandidatesFromParseResult` detection wiring

**Files:**
- Modify: `web/src/session/actions.ts`
- Test: `web/src/session/actions.test.ts`

**Interfaces:**
- Consumes: `detectBigApple` (Task 1), `PuzzleState.createBigApple` (Sprint 2), `ParseResult` (`web/src/image/inpImage.ts`, unchanged).
- Produces: `buildCandidatesFromParseResult(...)` now returns `{ candidates: readonly PuzzleState[]; detectedBigApple: boolean }` instead of `readonly PuzzleState[]` directly — every call site must update. Consumed by Task 4's `buildStateFromParseResult`.

- [x] **Step 1: Write the failing tests**

In `web/src/session/actions.test.ts`, update the 5 existing tests in the `describe('buildCandidatesFromParseResult', ...)` block (current lines 949-1005) to destructure the new shape — change every:

```ts
const candidates = buildCandidatesFromParseResult(result, spec, ['nakedSingle'], null, null);
```

to:

```ts
const { candidates } = buildCandidatesFromParseResult(result, spec, ['nakedSingle'], null, null);
```

(and the one occurrence with `[]` instead of `['nakedSingle']`, and the one using a `for...of` over the return value directly — change `for (const candidate of buildCandidatesFromParseResult(result, spec, [], null, null))` to `for (const candidate of buildCandidatesFromParseResult(result, spec, [], null, null).candidates)`). No assertion values change — `blankGivenDigits` is all zeros, so `detectBigApple` is guaranteed to return `false` for every existing test (zero givens ⇒ both the classic and window passes stall identically, since no cell ever reaches a single candidate), leaving every existing assertion valid.

Add new tests at the end of the `describe` block, before its closing `});`:

```ts
  it('detects Big Apple from a classic-type scan and prepends a Big Apple candidate', () => {
    const result = { ...makeParseResult('classic'), givenDigits: makeBigAppleGivenDigits() };
    const { candidates, detectedBigApple } = buildCandidatesFromParseResult(result, spec, ['nakedSingle'], null, null);

    expect(detectedBigApple).toBe(true);
    expect(candidates).toHaveLength(2);
    expect(PuzzleState.isBigApple(candidates[0]!)).toBe(true);
    expect(PuzzleState.isBigApple(candidates[1]!)).toBe(false);
  });

  it('does not detect Big Apple from a killer-type scan, even with the same digits', () => {
    const result = { ...makeParseResult('killer'), givenDigits: makeBigAppleGivenDigits() };
    const { candidates, detectedBigApple } = buildCandidatesFromParseResult(result, spec, ['nakedSingle'], null, null);

    expect(detectedBigApple).toBe(false);
    expect(candidates.some(c => PuzzleState.isBigApple(c))).toBe(false);
  });

  it('reports detectedBigApple: false for an ordinary classic scan', () => {
    const result = makeParseResult('classic');
    const { detectedBigApple } = buildCandidatesFromParseResult(result, spec, ['nakedSingle'], null, null);

    expect(detectedBigApple).toBe(false);
  });
```

Add `makeBigAppleGivenDigits` to the file's existing fixtures import line (find it via `grep -n "from '../engine/fixtures.js'" web/src/session/actions.test.ts`).

- [x] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/session/actions.test.ts -t buildCandidatesFromParseResult`
Expected: FAIL — destructuring `{ candidates }` from an array yields `undefined`, so the existing tests fail on `candidates.toHaveLength` etc.; the 3 new tests fail because `detectedBigApple` is `undefined`.

- [x] **Step 3: Write minimal implementation**

In `web/src/session/actions.ts`, replace `buildCandidatesFromParseResult` (currently lines 315-329):

```ts
/**
 * Builds the OCR-review candidate list for a parsed puzzle image, per spec
 * section 1: a Killer-detected scan offers both a Killer candidate (primary,
 * the first element) and a Classic candidate built from the same
 * readClassicDigits pass; a Classic-detected scan offers a Classic candidate,
 * plus — when the solvability heuristic concludes Big Apple — a Big Apple
 * candidate prepended as the primary element.
 *
 * Detection only runs for Classic-detected scans: a Killer scan's Classic
 * candidate comes from a less-reliable digit pass (see solveCurrentSpec's
 * comment on false-positive digit detection near cage-total text), and a
 * real Big Apple photo never has cage borders.
 */
export function buildCandidatesFromParseResult(
  result: ParseResult,
  spec: PuzzleSpec,
  alwaysApplyRules: readonly string[],
  originalImageUrl: string | null,
  warpedImageUrl: string | null,
): { candidates: readonly PuzzleState[]; detectedBigApple: boolean } {
  const classicCandidate = PuzzleState.createClassic(result.givenDigits, alwaysApplyRules, originalImageUrl);

  if (result.puzzleType === 'killer') {
    const killerCandidate = PuzzleState.createKiller(
      specToData(spec), specToCageStates(spec), alwaysApplyRules, originalImageUrl, warpedImageUrl,
    );
    return { candidates: [killerCandidate, classicCandidate], detectedBigApple: false };
  }

  const detectedBigApple = result.givenDigits !== null && detectBigApple(result.givenDigits);
  if (!detectedBigApple) return { candidates: [classicCandidate], detectedBigApple: false };

  const bigAppleCandidate = PuzzleState.createBigApple(result.givenDigits, alwaysApplyRules, originalImageUrl);
  return { candidates: [bigAppleCandidate, classicCandidate], detectedBigApple: true };
}
```

Update the `detectBigApple` import — add it to the existing `import { solve, solveBigApple, BoardState, KillerBoardState, intersectAll, SolveResult } from '../engine/index.js';` line:

```ts
import { solve, solveBigApple, detectBigApple, BoardState, KillerBoardState, intersectAll, SolveResult } from '../engine/index.js';
```

This file does not yet call `buildCandidatesFromParseResult` anywhere except `buildStateFromParseResult` (line 372) — that call site is fixed in Task 4, so leave it as-is for now; Task 4's own failing test will catch the now-broken call.

- [x] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/session/actions.test.ts -t buildCandidatesFromParseResult`
Expected: PASS (all 8 tests — 5 updated, 3 new). `npx tsc --noEmit` will report an error at `buildStateFromParseResult`'s call site until Task 4 is done — that's expected at this point.

- [x] **Step 5: Commit**

Deviation: not committed in isolation — the bronze gate requires `tsc --noEmit`
to pass before every commit, and Task 3 alone leaves `buildStateFromParseResult`'s
call site broken (as Step 4 above notes). Combined into a single commit together
with Task 4 (commit `ba52c46`, "feat: detect Big Apple in OCR pipeline and thread
it through to UploadResult"), once both tasks' changes left the tree green.

---

## Task 4: Thread `detectedBigApple` through the upload pipeline

**Files:**
- Modify: `web/src/session/actions.ts`
- Test: `web/src/session/actions.test.ts`

**Interfaces:**
- Consumes: `buildCandidatesFromParseResult`'s new return shape (Task 3).
- Produces: `UploadResult` gains `detectedBigApple: boolean`; `buildStateFromParseResult`'s resolved type gains `detectedBigApple: boolean`; `uploadPuzzle`, `loadSpecDirect`, `loadClassicDirect` all return it. Consumed by Task 5's `main.ts` changes.

- [x] **Step 1: Write the failing test**

Add to `web/src/session/actions.test.ts`, in the existing `describe('uploadPuzzle', ...)` or equivalent block covering the upload pipeline (search via `grep -n "uploadPuzzle\|loadClassicDirect\|loadSpecDirect" web/src/session/actions.test.ts` for the exact existing test structure and mocking pattern used for `uploadPuzzle`, since it depends on `parsePuzzleImage`/`getCV`/`getRec` mocks already set up elsewhere in the file):

```ts
  it('loadClassicDirect reports detectedBigApple: false', () => {
    const result = loadClassicDirect(makeClassicGivenDigits());
    expect(result.detectedBigApple).toBe(false);
  });

  it('loadSpecDirect reports detectedBigApple: false', () => {
    const result = loadSpecDirect(makeTwoCellCageSpec());
    expect(result.detectedBigApple).toBe(false);
  });
```

(Use whichever fixture functions are already imported in the file for `loadSpecDirect`'s spec argument — match the existing test's spec fixture if `loadSpecDirect` is already tested elsewhere in the file, rather than introducing a new one.)

- [x] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/session/actions.test.ts -t "reports detectedBigApple"`
Expected: FAIL — `result.detectedBigApple` is `undefined`, `expect(undefined).toBe(false)` fails.

- [x] **Step 3: Write minimal implementation**

In `web/src/session/actions.ts`:

Update `UploadResult` (currently lines 134-140):

```ts
export interface UploadResult {
  state: PuzzleState;
  warpedImageUrl: string | null;
  warning: string | null;
  cellThumbs: ReadonlyMap<string, Uint8Array[]>;
  mergedThumbs: ReadonlyMap<string, Uint8Array>;
  detectedBigApple: boolean;
}
```

Update `loadSpecDirect`'s return (currently line 152):

```ts
  return { state, warpedImageUrl: null, warning: null, cellThumbs: new Map(), mergedThumbs: new Map(), detectedBigApple: false };
```

Update `loadClassicDirect`'s return (currently lines 166-172):

```ts
  return {
    state,
    warpedImageUrl: null,
    warning: 'Review the detected digits and press Confirm & Solve',
    cellThumbs: new Map(),
    mergedThumbs: new Map(),
    detectedBigApple: false,
  };
```

Update `buildStateFromParseResult`'s signature and body (currently lines 331-375):

```ts
async function buildStateFromParseResult(
  result: ParseResult,
  originalImageUrl: string | null,
): Promise<{ state: PuzzleState; warpedImageUrl: string | null; warning: string | null; detectedBigApple: boolean }> {
```

(body unchanged down to the final two lines, which become:)

```ts
  const { candidates, detectedBigApple } = buildCandidatesFromParseResult(result, spec, [...settings.alwaysApplyRules], originalImageUrl, warpedImageUrl);
  setStateCandidates(candidates);
  return { state: candidates[0]!, warpedImageUrl, warning, detectedBigApple };
```

Update `uploadPuzzle`'s body (currently lines 202-204):

```ts
  const originalImageUrl = await fileToDisplayUrl(file);
  const { state, warpedImageUrl, warning, detectedBigApple } = await buildStateFromParseResult(result, originalImageUrl);
  return { state, warpedImageUrl, warning, cellThumbs: result.cellThumbs, mergedThumbs: result.mergedThumbs, detectedBigApple };
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/session/actions.test.ts`
Expected: PASS (full file — confirms no other call site broke). Then run `cd web && npx tsc --noEmit` to confirm the Task 3 compile error is gone.

- [x] **Step 5: Commit**

See Task 3 Step 5 — committed together as `ba52c46`.

---

## Task 5: Dismissible banner UI

**Files:**
- Modify: `web/index.html`
- Modify: `web/src/main.ts`

**Interfaces:**
- Consumes: `UploadResult.detectedBigApple` (Task 4), `applyUploadResult`'s existing signature (`web/src/main.ts:1151`).
- Produces: `applyUploadResult` gains a 4th parameter `detectedBigApple: boolean = false`. No new exports — this task is UI wiring only, verified by manual/E2E inspection rather than a unit test (the existing project convention: DOM-visibility wiring in `main.ts` is covered by Playwright `app.spec.ts`/`flow.spec.ts`, not Vitest).

This task has no isolated unit-testable surface (DOM wiring), so it follows the project's existing pattern for this kind of change (e.g. the install banner at `main.ts:952-959`): implement directly, then verify via the Silver Gate's Playwright run plus a manual check, rather than writing a new Vitest test.

**Note for Sprint 4:** the design spec's §6 also calls for the banner to auto-hide once the user changes the puzzle-type dropdown away from Big Apple. That behaviour cannot be implemented here — the dropdown has no `bigapple` option yet (Sprint 4 adds it, along with the change handler at `main.ts` ~line 2163). This sprint's manual dismiss button is the interim mechanism; Sprint 4's plan must add `el('bigapple-banner').hidden = true;` to that change handler whenever the selected type changes away from `'bigapple'`.

- [x] **Step 1: Add the banner markup**

In `web/index.html`, insert between `#classic-edit-hint` (ends at line 160) and `<div class="form-actions" id="review-actions">` (line 162):

```html
    <p id="bigapple-banner" class="hint-text" hidden>
      This looks like it might be a Big Apple puzzle (classic sudoku plus 4 shaded
      "window" regions). Select it from the Type dropdown if so.
      <button id="bigapple-banner-dismiss-btn" class="btn-secondary btn-icon" aria-label="Dismiss" type="button">✕</button>
    </p>
```

- [x] **Step 2: Wire visibility into `applyUploadResult`**

In `web/src/main.ts`, change `applyUploadResult`'s signature (currently line 1151):

```ts
function applyUploadResult(
  state: PuzzleState,
  warpedImageUrl: string | null,
  warning: string | null,
  detectedBigApple = false,
): void {
```

Add inside the body, immediately after the existing `setStatus(warning ? `Warning: ${warning}` : '');` line (currently line 1175, the last line before the closing `}`):

```ts
  el<HTMLElement>('bigapple-banner').hidden = !detectedBigApple;
```

- [x] **Step 3: Add the dismiss handler**

In `web/src/main.ts`, add alongside the other one-time `init()`-time `addEventListener` wiring (next to the install-banner wiring at lines 2136-2145, mirroring `install-dismiss-btn`'s pattern exactly — a direct click handler with no separate named function, since `bigapple-banner` has no persisted dismissal state unlike the install banner's `localStorage` flag):

```ts
  el<HTMLButtonElement>('bigapple-banner-dismiss-btn').addEventListener('click', () => {
    el<HTMLElement>('bigapple-banner').hidden = true;
  });
```

- [x] **Step 4: Thread `detectedBigApple` through `handleProcess`**

In `web/src/main.ts`, update the destructuring at the top of `handleProcess` (currently line 1254):

```ts
    const { state, warpedImageUrl, warning, cellThumbs, mergedThumbs, detectedBigApple } = await uploadPuzzle(f);
```

Pass it at the 3 classic-path `applyUploadResult` call sites only (the killer-path call site at line 1318 is intentionally left unchanged — Big Apple is never suggested for killer-detected scans per this sprint's Global Constraints):

- Line 1344 (classic duplicates path): `applyUploadResult(state, warpedImageUrl, null, detectedBigApple);`
- Line 1396 (classic solver-incomplete path): `applyUploadResult(state, warpedImageUrl, null, detectedBigApple);`
- Line 1407 (general fallback path): `applyUploadResult(state, warpedImageUrl, warning ?? 'Review the detected digits and press Confirm & Solve', detectedBigApple);`

- [x] **Step 5: Manual verification**

Deviation: full interactive browser verification was not possible in this
session — the Playwright MCP browser could not launch (`Chromium distribution
'chrome' is not found at /opt/google/chrome/chrome`, and the MCP tool exposes
no option to point at the bundled `/opt/pw-browsers/chromium-1194` binary
instead). Verified by code inspection instead: confirmed `#bigapple-banner`
starts `hidden` in `web/index.html`, that `applyUploadResult` is the sole
place that flips `.hidden` based on `detectedBigApple`, and that the dismiss
handler sets `.hidden = true` unconditionally with no interaction with any
other control (dropdown, status text, etc.). `tsc --noEmit` and the full
Vitest suite (775 passed) confirm no regressions. Defer to the Silver Gate's
Playwright suite (`npx playwright test`, `npx playwright test --config
playwright.dev.config.ts`) for real interactive regression coverage before
merging — those suites already exercise `applyUploadResult`'s other
visibility toggles and will catch a malformed selector or missing element.

- [x] **Step 6: Commit**

```bash
git add web/index.html web/src/main.ts
git commit -m "feat: add dismissible Big Apple detection banner to OCR review screen"
```

---

## Sprint 3 Completion Check

Run from `web/`:

```bash
npx tsc --noEmit
npx vitest run src/engine/ src/session/
```

Both must pass before moving to Sprint 4 (`docs/superpowers/plans/2026-06-20-big-apple-sudoku-4-dropdown-rendering.md`).
