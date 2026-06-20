# Big Apple Sudoku — Sprint 2: Session/State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Big Apple puzzles a first-class `PuzzleState` subtype, wire it through serialization and `buildEngine`, and prove persistence round-trips correctly — all the session-layer plumbing needed before any UI or detection code can use it.

**Architecture:** `BigApplePuzzleState extends PuzzleState` mirrors `KillerPuzzleState`'s pattern exactly: a structural discriminant field (`bigApple: true`) instead of a boolean flag on the shared base type, a type guard (`isBigApple`), and a factory (`createBigApple`) that delegates to `createClassic`. `buildEngine`'s existing 2-way `isKiller` ternary becomes 3-way by inserting a `BigAppleBoardState` branch (from Sprint 1) between the killer and plain-classic branches. `SerializedPuzzleState` becomes a 3-way union with a `kind: 'bigapple'` tag.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- All 2-D grid arrays are row-major (`grid[row][col]`); cell tuples are `[row, col]`.
- No `any`; prefer the weakest parameter type and strongest return type.
- Use the namespace-merging / structural-discriminant pattern already established by `KillerPuzzleState`/`isKiller` — no boolean flags on the shared `PuzzleState` base type.
- This sprint depends on Sprint 1 (`docs/superpowers/plans/2026-06-20-big-apple-sudoku-1-engine-core.md`) being complete: `BigAppleBoardState` must already exist at `web/src/engine/bigAppleBoardState.ts` before Task 3 below.

---

## File Structure

| File | Responsibility |
|---|---|
| `web/src/session/types.ts` | Add `BigApplePuzzleState`, `PuzzleState.isBigApple`, `PuzzleState.createBigApple`; widen `SerializedPuzzleState` and `serialize`/`deserialize`. |
| `web/src/session/types.test.ts` | Unit tests for the above. |
| `web/src/session/engine.ts` | Add the `isBigApple` branch to `buildEngine`'s board/engine construction ternary. |
| `web/src/session/engine.test.ts` | Test asserting `buildEngine` builds a `BigAppleBoardState` + plain `SolverEngine` for Big Apple states. |
| `web/src/session/persistence.test.ts` (new) | Round-trip test: `saveSession`/`loadSession` preserves a Big Apple state. |

No other files are touched in this sprint. The OCR-detection heuristic (Sprint 3) and the dropdown/rendering UI (Sprint 4) are out of scope here.

---

## Task 1: `BigApplePuzzleState`, `isBigApple`, `createBigApple`

**Files:**
- Modify: `web/src/session/types.ts`
- Test: `web/src/session/types.test.ts`

**Interfaces:**
- Consumes: `PuzzleState` interface, `PuzzleState.createClassic` (both already in `types.ts`).
- Produces: `BigApplePuzzleState` interface, `PuzzleState.isBigApple(state: PuzzleState): state is BigApplePuzzleState`, `PuzzleState.createBigApple(givenDigits: number[][] | null, alwaysApplyRules: readonly string[], originalImageUrl: string | null): BigApplePuzzleState`. Sprint 3 and Sprint 4 call `createBigApple` and `isBigApple` directly.

- [x] **Step 1: Write the failing tests**

Append to `web/src/session/types.test.ts` (after the existing `describe('PuzzleState.isKiller', ...)` block, i.e. after line 46):

```ts
describe('PuzzleState.createBigApple', () => {
  it('builds a BigApplePuzzleState with the bigApple marker set and no cage data', () => {
    const state = PuzzleState.createBigApple([[1, 0, 0, 0, 0, 0, 0, 0, 0]], ['nakedSingle'], null);
    expect(state.bigApple).toBe(true);
    expect(state.userGrid).toEqual(Array.from({ length: 9 }, () => new Array<number>(9).fill(0)));
    expect(state.goldenSolution).toBeNull();
    expect(state.givenDigits).toEqual([[1, 0, 0, 0, 0, 0, 0, 0, 0]]);
    expect(state.alwaysApplyRules).toEqual(['nakedSingle']);
    expect(PuzzleState.isKiller(state)).toBe(false);
  });
});

describe('PuzzleState.isBigApple', () => {
  it('narrows to BigApplePuzzleState only when the bigApple marker is present', () => {
    const classic = PuzzleState.createClassic(null, [], null);
    const killer = PuzzleState.createKiller(specData, cageStates, [], null, null);
    const bigApple = PuzzleState.createBigApple(null, [], null);
    expect(PuzzleState.isBigApple(classic)).toBe(false);
    expect(PuzzleState.isBigApple(killer)).toBe(false);
    expect(PuzzleState.isBigApple(bigApple)).toBe(true);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/session/types.test.ts`
Expected: FAIL — `PuzzleState.createBigApple is not a function` (or a TypeScript compile error if run through `tsc` first; vitest will report it as a runtime `TypeError`).

- [x] **Step 3: Write minimal implementation**

In `web/src/session/types.ts`, add the interface immediately after `KillerPuzzleState` (after line 303, before the `SerializedPuzzleState` type at line 310):

```ts
export interface BigApplePuzzleState extends PuzzleState {
  /** Structural discriminant — always `true`. Mirrors `KillerPuzzleState`'s `specData`-presence pattern. */
  readonly bigApple: true;
}
```

Inside `export namespace PuzzleState { ... }`, add `isBigApple` immediately after `isKiller` (after line 357):

```ts
  /** Type guard: true for BigApplePuzzleState (has the bigApple marker). */
  export function isBigApple(state: PuzzleState): state is BigApplePuzzleState {
    return 'bigApple' in state;
  }
```

Add `createBigApple` immediately after `createClassic` (after line 569, before `createKiller`):

```ts
  /** Builds a fresh Big Apple PuzzleState for the OCR review phase (blank grid, no golden solution). */
  export function createBigApple(
    givenDigits: number[][] | null,
    alwaysApplyRules: readonly string[],
    originalImageUrl: string | null,
  ): BigApplePuzzleState {
    return { ...createClassic(givenDigits, alwaysApplyRules, originalImageUrl), bigApple: true };
  }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/session/types.test.ts`
Expected: PASS (all tests in the file, including the two new ones).

- [x] **Step 5: Commit**

```bash
git add web/src/session/types.ts web/src/session/types.test.ts
git commit -m "feat: add BigApplePuzzleState, isBigApple, createBigApple"
```

---

## Task 2: 3-way `SerializedPuzzleState`, `serialize()`, `deserialize()`

**Files:**
- Modify: `web/src/session/types.ts`
- Test: `web/src/session/types.test.ts`

**Interfaces:**
- Consumes: `BigApplePuzzleState`, `PuzzleState.isBigApple`, `PuzzleState.createBigApple` (Task 1).
- Produces: widened `SerializedPuzzleState` union (3-way), `serialize()`/`deserialize()` handling `kind: 'bigapple'`. Sprint 3's detection-result plumbing and any future bug-report tooling rely on `serialize`/`deserialize` round-tripping all three kinds.

- [x] **Step 1: Write the failing tests**

Append to `web/src/session/types.test.ts`:

```ts
describe('PuzzleState.serialize / deserialize — bigapple', () => {
  it('round-trips a BigApplePuzzleState with kind "bigapple"', () => {
    const state = PuzzleState.createBigApple([[1, 0, 0, 0, 0, 0, 0, 0, 0]], ['nakedSingle'], null);
    const serialized = PuzzleState.serialize(state);
    expect(serialized.kind).toBe('bigapple');
    expect(serialized.version).toBe(1);

    const restored = PuzzleState.deserialize(serialized);
    expect(PuzzleState.isBigApple(restored)).toBe(true);
    expect(restored).toEqual(state);
  });

  it('rejects a "bigapple" payload with a malformed userGrid', () => {
    const state = PuzzleState.createBigApple(null, [], null);
    const serialized = { ...PuzzleState.serialize(state), userGrid: 'not-a-grid' };
    expect(() => PuzzleState.deserialize(serialized)).toThrow(/userGrid/);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/session/types.test.ts`
Expected: FAIL — `serialized.kind` is `'classic'` (not `'bigapple'`), so the first assertion fails. (The malformed-grid test passes already since the existing `is9x9NumberGrid` check runs before the `kind` switch — that's fine, it's asserting current correct behaviour continues to hold once `kind` is `'bigapple'`.)

- [x] **Step 3: Write minimal implementation**

In `web/src/session/types.ts`, widen `SerializedPuzzleState` (replace lines 310-312):

```ts
export type SerializedPuzzleState =
  | (PuzzleState & { readonly kind: 'classic'; readonly version: 1 })
  | (KillerPuzzleState & { readonly kind: 'killer'; readonly version: 1 })
  | (BigApplePuzzleState & { readonly kind: 'bigapple'; readonly version: 1 });
```

Update `serialize()` (replace the body at lines 464-468) to check `isBigApple` before falling through to classic:

```ts
  export function serialize(state: PuzzleState): SerializedPuzzleState {
    if (isKiller(state)) return { kind: 'killer', version: 1, ...state };
    if (isBigApple(state)) return { kind: 'bigapple', version: 1, ...state };
    return { kind: 'classic', version: 1, ...state };
  }
```

Update `deserialize()`'s `kind` validation (replace lines 483-485):

```ts
    if (v['kind'] !== 'classic' && v['kind'] !== 'killer' && v['kind'] !== 'bigapple') {
      throw new Error(`PuzzleState.deserialize: unrecognised kind ${JSON.stringify(v['kind'])}`);
    }
```

Update the dispatch after `base` is built (replace line 521, `if (v['kind'] === 'classic') return base;`):

```ts
    if (v['kind'] === 'classic') return base;
    if (v['kind'] === 'bigapple') return { ...base, bigApple: true };
```

(The remainder of the function — the `killerState` construction — is unchanged; it only runs when `v['kind'] === 'killer'`, which is the only path left after the two early returns above.)

- [x] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/session/types.test.ts`
Expected: PASS (all tests, including the two new ones).

- [x] **Step 5: Commit**

```bash
git add web/src/session/types.ts web/src/session/types.test.ts
git commit -m "feat: add bigapple kind to SerializedPuzzleState serialize/deserialize"
```

---

## Task 3: `buildEngine` 3-way dispatch

**Files:**
- Modify: `web/src/session/engine.ts`
- Test: `web/src/session/engine.test.ts`

**Interfaces:**
- Consumes: `BigAppleBoardState` (Sprint 1, `web/src/engine/bigAppleBoardState.ts`), `PuzzleState.isBigApple` (Task 1).
- Produces: `buildEngine` returns a `{ board: BigAppleBoardState, engine: SolverEngine }` pair for Big Apple states. No signature change — `buildEngine`'s parameter and return types are unchanged.

This task also makes an explicit, documented decision to **leave the `onViolation` closure's bug-report `puzzleType` tagging as 2-way** (`isKiller(state) ? 'killer' : 'classic'`, at `engine.ts:234`). Widening it would require changing the shared wire-format type `PuzzleRuleReport.puzzleType: 'killer' | 'classic'` in `shared/src/report.ts`, plus its `RuleBugReport.is()` validator and `RuleBugFixture.puzzleType` — a cross-package change to a shared telemetry format that is out of scope for this sprint. Big Apple states will report as `'classic'` in bug-report telemetry; this is a labelling inaccuracy only (the report still carries the full serialized state, so the engine-side cause is still diagnosable from `state`), not a gameplay or correctness issue. Documented here as an accepted gap, same status as Sprint 1's `LockedCandidates` box-line gap.

- [x] **Step 1: Write the failing test**

Add to `web/src/session/engine.test.ts`, immediately after the existing `'constructs a plain BoardState and SolverEngine (not Killer variants) for classic puzzles'` test (after line 504):

```ts
  it('constructs a BigAppleBoardState and plain SolverEngine (not Killer variants) for Big Apple puzzles', () => {
    const base = makeState();
    const state = PuzzleState.createBigApple(null, base.alwaysApplyRules, null);
    const { board, engine } = buildEngine(state);
    expect(board).toBeInstanceOf(BigAppleBoardState);
    expect(board).not.toBeInstanceOf(KillerBoardState);
    expect(engine).toBeInstanceOf(SolverEngine);
    expect(engine).not.toBeInstanceOf(KillerSolverEngine);
  });
```

Add the import at the top of `web/src/session/engine.test.ts` (alongside the existing `import { BoardState, KillerBoardState } from '../engine/boardState.js';` at line 25):

```ts
import { BigAppleBoardState } from '../engine/bigAppleBoardState.js';
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session/engine.test.ts -t "BigAppleBoardState and plain SolverEngine"`
Expected: FAIL — the constructed `board` is a plain `BoardState`, not a `BigAppleBoardState` (the `toBeInstanceOf(BigAppleBoardState)` assertion fails because `buildEngine` currently has no Big Apple branch).

- [x] **Step 3: Write minimal implementation**

In `web/src/session/engine.ts`, add the import (alongside the existing import at line 19):

```ts
import { BigAppleBoardState } from '../engine/bigAppleBoardState.js';
```

Replace the ternary at lines 240-279 (the `const { board, engine }: { ... } = PuzzleState.isKiller(state) ? ... : ...;` block) with a 3-way version — insert a new branch between the existing killer branch and the existing plain-classic branch:

```ts
  const { board, engine }: { board: BoardState; engine: SolverEngine } = PuzzleState.isKiller(state)
    ? (() => {
        if (!PuzzleState.isKiller(state)) throw new Error('unreachable');
        const killerSpec = dataToSpec(state.specData);
        const board = new KillerBoardState(killerSpec, { includeVirtualCages: false });

        // Apply user-eliminated cage solutions for real cages before any rules run.
        for (let i = 0; i < state.cageStates.length; i++) {
          const eliminated = state.cageStates[i]!.userEliminatedSolns;
          if (eliminated.length === 0) continue;
          const elimKeys = new Set(eliminated.map(solutionKey));
          const solns = board.cageSolns[i]!;
          solns.splice(0, Infinity, ...solns.filter(s => !elimKeys.has(solutionKey(s))));
        }

        // Re-add virtual cages — use state.virtualCages directly so that
        // eliminatedSolns set by eliminateVirtualCageSolution are applied.
        for (const vc of state.virtualCages) {
          board.addVirtualCage(vc.cells, vc.total, vc.eliminatedSolns, {
            ...(vc.negativeCells !== undefined && { negativeCells: vc.negativeCells }),
            ...(vc.eliminatedDiffSolns !== undefined && { eliminatedDiffSolns: vc.eliminatedDiffSolns }),
          });
        }

        const engine = new KillerSolverEngine(board, activeRules, {
          hintRules,
          goldenSolution: activeGolden,
          onViolation,
        });
        return { board, engine };
      })()
    : PuzzleState.isBigApple(state)
      ? (() => {
          const board = new BigAppleBoardState();
          const engine = new SolverEngine(board, activeRules, {
            hintRules,
            goldenSolution: activeGolden,
            onViolation,
          });
          return { board, engine };
        })()
      : (() => {
          const board = new BoardState();
          const engine = new SolverEngine(board, activeRules, {
            hintRules,
            goldenSolution: activeGolden,
            onViolation,
          });
          return { board, engine };
        })();
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/session/engine.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [x] **Step 5: Commit**

```bash
git add web/src/session/engine.ts web/src/session/engine.test.ts
git commit -m "feat: dispatch BigAppleBoardState in buildEngine for Big Apple puzzles"
```

---

## Task 4: Persistence round-trip test

**Files:**
- Create: `web/src/session/persistence.test.ts`

**Interfaces:**
- Consumes: `saveSession(state: PuzzleState, cellColours: Map<string, 'blue' | 'green'>): void` and `loadSession(): { state: PuzzleState; cellColours: Map<string, 'blue' | 'green'> } | null` (both already exported from `web/src/session/persistence.ts`, unchanged in this sprint), `PuzzleState.createBigApple` (Task 1).
- Produces: nothing new — this task is test-only, confirming `saveSession`/`loadSession` already correctly round-trip a Big Apple state via the existing `strippedClassic` branch (`PuzzleState.isKiller(state) ? strippedKiller : strippedClassic` at `persistence.ts:31` — Big Apple states are not killer, so they take the `strippedClassic` path, which only strips `originalImageUrl`, the correct behaviour since Big Apple has no `warpedImageUrl` field to strip).

This file does not exist yet — `persistence.ts` currently has no tests at all. This task adds the file with one focused test; it does not attempt full coverage of `saveSession`/`loadSession`'s classic/killer behaviour, since that is pre-existing, untested-but-unchanged code outside this sprint's scope.

`loadSession()` only returns a session when `payload.state.goldenSolution !== null` (`persistence.ts:53`), so the test must use a "confirmed" Big Apple state (non-null `goldenSolution`), not the blank OCR-review state `createBigApple` returns by default.

- [x] **Step 1: Write the failing test**

Create `web/src/session/persistence.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { saveSession, loadSession, clearPersistedSession } from './persistence.js';
import { PuzzleState } from './types.js';

afterEach(() => {
  clearPersistedSession();
});

describe('saveSession / loadSession — Big Apple', () => {
  it('round-trips a confirmed BigApplePuzzleState, stripping originalImageUrl', () => {
    const givenDigits = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    givenDigits[0]![0] = 5;
    const base = PuzzleState.createBigApple(givenDigits, ['nakedSingle'], 'data:image/png;base64,xyz');
    const confirmed: PuzzleState = {
      ...base,
      userGrid: givenDigits,
      goldenSolution: Array.from({ length: 9 }, () => new Array<number>(9).fill(1)),
    };

    saveSession(confirmed, new Map([['0,0', 'blue']]));
    const loaded = loadSession();

    expect(loaded).not.toBeNull();
    expect(PuzzleState.isBigApple(loaded!.state)).toBe(true);
    expect(loaded!.state.originalImageUrl).toBeNull();
    expect(loaded!.state.userGrid).toEqual(givenDigits);
    expect(loaded!.state.goldenSolution).toEqual(confirmed.goldenSolution);
    expect(loaded!.cellColours.get('0,0')).toBe('blue');
  });
});
```

- [x] **Step 2: Run the test**

Run: `cd web && npx vitest run src/session/persistence.test.ts`
Expected: PASS immediately. Unlike the other tasks in this sprint, this one requires no implementation change: `persistence.ts`'s `isKiller(state) ? strippedKiller : strippedClassic` branch (line 31) already takes the `strippedClassic` path for any non-killer state, including Big Apple, and that path already does the right thing (only strips `originalImageUrl`, since Big Apple has no `warpedImageUrl`). This task exists purely to add regression coverage for that fact.

If it fails, investigate `persistence.ts`'s branch at line 31 before changing anything — do not modify `persistence.ts` without first determining why the existing logic is insufficient.

- [x] **Step 3: Commit**

```bash
git add web/src/session/persistence.test.ts
git commit -m "test: cover Big Apple state round-trip through saveSession/loadSession"
```

---

## Sprint 2 Completion Check

Run from `web/`:

```bash
npx tsc --noEmit
npx vitest run src/session/
```

Both must pass before moving to Sprint 3 (`docs/superpowers/plans/2026-06-20-big-apple-sudoku-3-ocr-detection.md`).
