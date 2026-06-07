# Puzzle State Redesign

**Date:** 2026-06-06  
**Branch:** feature/puzzle-state-redesign (to be created)  
**Motivation:** The execution loop has accumulated bugs caused by a mutable animation side-channel (`autoRemovedCandidates`) that diverges from the canonical turn history, three divergent code paths producing different board states, and `puzzleType` discriminants scattered through `actions.ts`. This redesign removes the root causes.

---

## 1. State Model

### Type hierarchy

`PuzzleState` is the base type and is equivalent to a Classic sudoku puzzle. `KillerPuzzleState` extends it with cage structure. There is no `puzzleType` discriminant field — the type system carries this information.

```typescript
interface PuzzleState {
  readonly userGrid: number[][];
  readonly userRemovedCandidates: readonly [number, number, number][];
  readonly turns: readonly Turn[];
  readonly alwaysApplyRules: readonly string[];
  readonly goldenSolution: number[][] | null;
  readonly originalImageUrl: string | null;
  readonly givenDigits: number[][] | null;   // null = pure killer; non-null = classic or hybrid
}

interface KillerPuzzleState extends PuzzleState {
  readonly specData: PuzzleSpecData;
  readonly cageStates: readonly CageState[];
  readonly virtualCages: readonly VirtualCage[];
  readonly warpedImageUrl: string | null;
  readonly fixtureStalledCandidates?: readonly number[][][] | null;
}
```

**Hybrid killer** (killer with pre-given digits) is represented as `KillerPuzzleState` with `givenDigits !== null` — no new type needed.

**Future variants** (Big Apple, etc.) extend `PuzzleState` with their own constraint fields. Each adds a type guard to `namespace PuzzleState`. Existing callers are unaffected.

### Removed: `autoRemovedCandidates`

`autoRemovedCandidates` is removed from `PuzzleState` entirely. It was a mutable side-channel accumulating rule-generated eliminations during step-by-step animation. Its removal is the primary correctness fix.

### Added: `userRemovedCandidates`

User-eliminated candidates are now an explicit field on `PuzzleState`, maintained directly by `UserAction.apply()` alongside `userGrid` and `virtualCages`. Previously this was derived by replaying `turns` — an implicit O(n) dependency that made `buildEngine()` history-dependent.

### `turns` is history only

`turns` is an append-only action log for display and undo. `buildEngine()` does not read it. The invariant: `PuzzleState` is fully self-contained at every snapshot.

### Undo strategy (three tiers)

| Tier | Mechanism | Cost |
|---|---|---|
| Recent undo | Rolling window of last N `PuzzleState` snapshots | O(1) |
| Deep undo | Forward replay of `UserAction.apply()` from initial state | O(n) cheap — no `buildEngine()` |
| Inconsistency rewind | Lazy `rewindState` bookmark | O(1) |

**Inconsistency rewind:** `rewindState: PuzzleState | null` is session state (not on `PuzzleState`). It is `null` until the first violation. On first violation, `rewindState` is assigned the top of the rolling window (the state before the bad action). It is never updated again until the user rewinds. On rewind, state is restored and `rewindState` is reset to `null`.

---

## 2. `RuleMutation` Type Hierarchy

Rule effects are broader than eliminations — a rule firing can place a digit, eliminate a candidate, add a virtual cage, or eliminate a cage solution. Each is an open interface carrying its own `apply`, so dispatch lives on the value itself rather than in an external switch:

```typescript
interface RuleMutation {
  readonly type: string;
  apply(state: PuzzleState): PuzzleState;
}

interface PlaceDigitMutation extends RuleMutation {
  readonly type: 'placeDigit';
  readonly row: number; readonly col: number; readonly digit: number;
}
interface EliminateCandidateMutation extends RuleMutation {
  readonly type: 'eliminateCandidate';
  readonly row: number; readonly col: number; readonly digit: number;
}
interface AddVirtualCageMutation extends RuleMutation {
  readonly type: 'addVirtualCage';
  readonly cage: VirtualCage;
}
interface EliminateCageSolutionMutation extends RuleMutation {
  readonly type: 'eliminateCageSolution';
  readonly cageId: string; readonly solution: readonly number[];
}
```

TypeScript statically verifies each concrete type satisfies `RuleMutation` — a factory that omits `apply` is a compile error. A discriminated union would additionally buy exhaustiveness *at dispatch sites*, but since `apply` lives on the mutation itself, no external dispatch site needs to be exhaustive — callers just write `mutation.apply(state)`.

A companion namespace provides factories and one `revive` — the single switch-on-`type` in the system, isolated to the deserialization boundary. (`RuleMutation` objects carry an `apply` function that `JSON.stringify` drops; `ApplyHintAction.mutations`, persisted in `Turn`/`localStorage`, must be revived from the surviving `type` + data fields after a JSON round-trip.)

```typescript
namespace RuleMutation {
  export function placeDigit(row, col, digit): PlaceDigitMutation { ... }
  export function eliminateCandidate(row, col, digit): EliminateCandidateMutation { ... }
  export function addVirtualCage(cage): AddVirtualCageMutation { ... }
  export function eliminateCageSolution(cageId, solution): EliminateCageSolutionMutation { ... }
  export function revive(data: { type: string }): RuleMutation { /* type-keyed reconstruction, isolated here only */ }
}
```

---

## 3. `buildEngine()` Contract

```typescript
function buildEngine(
  state: PuzzleState,
  opts?: { includeHints?: boolean; skipSolve?: boolean; skipValidation?: boolean },
): {
  board: BoardState;
  baseBoard: BoardState;
  engine: SolverEngine;
  ruleSteps: readonly RuleStep[];
  validationContext: { rules: readonly SolverRule[]; golden: readonly (readonly number[])[]; spec: PuzzleSpec } | null;
}
```

`buildEngine()` is a pure function. Given the same `PuzzleState`, it always returns the same result. It reads: `specData`, `cageStates`, `userGrid`, `userRemovedCandidates`, `virtualCages`, `alwaysApplyRules`, `goldenSolution`, `fixtureStalledCandidates`. It does not read `turns`.

- **`baseBoard`** — the board built from `specData` + `userGrid` + `userRemovedCandidates`, *before* any always-apply rules run. `AnimationPlayer` replay starts here.
- **`board`** — the board after always-apply rules run to fixpoint (today's sole returned board).
- **`ruleSteps`** — the ordered transcript reaching `board` from `baseBoard`, computed in a single `engine.solve()` pass: consecutive same-rule mutations (placements, eliminations, virtual-cage additions, cage-solution eliminations — each wrapped as a `RuleMutation`) are grouped into one `RuleStep`.

```typescript
interface RuleStep {
  readonly ruleName: string;
  readonly displayName: string;
  readonly highlightCells: readonly Cell[];
  readonly mutations: readonly RuleMutation[];
}
```

- **`validationContext`** — `null` unless a golden solution is present and the board is not user-corrupted (the existing gate on the background trigger-miss check). When non-null it carries `{ rules, golden, spec }` so the one external caller that schedules validation explicitly (§5) doesn't re-derive rule filtering / `isUserCorrupted` / `dataToSpec`.
- **`skipValidation`** — suppresses the automatic `scheduleTriggerValidation` call even though a full solve still runs. Used only by the caller in §5 that needs to validate against a *different* (later) state than the one passed in.

`getNextAutoApplyStep` and `applyAutoApplyStep` are deleted: today each step rebuilds the engine from scratch (an O(n) re-solve across an n-step animation) and filters out mutations already reflected via `preCands` snapshots, to avoid re-emitting steps already folded into `userRemovedCandidates`. Computing `ruleSteps` once, in one pass, from a clean `baseState` removes the need for both the re-solving and the redundancy filter.

---

## 4. Animation Player

The animation player is pure UI state — nothing on `PuzzleState`, never serialized.

```typescript
interface AnimationPlayer {
  readonly baseState: PuzzleState;   // state right after the user's action, before any rule steps
  readonly ruleSteps: readonly RuleStep[];
  readonly cursor: number;            // 0..ruleSteps.length — steps fully applied so far
  readonly playing: boolean;
}

namespace AnimationPlayer {
  export function stateAtCursor(player: AnimationPlayer): PuzzleState {
    let state = player.baseState;
    for (let i = 0; i < player.cursor; i++)
      for (const mutation of player.ruleSteps[i]!.mutations) state = mutation.apply(state);
    return state;
  }
  export function boardAtCursor(player: AnimationPlayer): CandidatesResponse {
    return computeAnimationCandidates(stateAtCursor(player));   // existing lightweight derivation, unchanged
  }
  export function currentStep(player: AnimationPlayer): RuleStep | null {
    return player.ruleSteps[player.cursor] ?? null;
  }
}
```

`RuleMutation.apply` operates on `PuzzleState`, not `Board` — so the player folds mutations over plain data and re-derives a board for rendering on demand via the existing `computeAnimationCandidates` helper. This is exactly the model today's loop already uses (`applyAutoApplyStep` + `computeAnimationCandidates`), restructured around a precomputed step list instead of incremental re-solving — scrubbing is just changing `cursor` and re-rendering, no replay loop, no timers when paused.

### 5-button VCR control

| Button | Effect |
|---|---|
| `«` | If `cursor > 0`: `{ cursor: 0, playing: false }`. If `cursor === 0`: close the player, no commit. |
| `‹` | `{ cursor: max(0, cursor - 1), playing: false }` |
| `▶`/`⏸` | toggle `playing` |
| `›` | `{ cursor: min(ruleSteps.length, cursor + 1), playing: false }` |
| `»` | fold remaining `ruleSteps[cursor..length)` mutations into one `ApplyHintAction`, dispatch, close player |

**Any direct cursor manipulation forces `playing: false`** — only the play/pause button sets `playing: true`. Scrubbing implies the user wants manual control, so any timer-driven auto-advance stops; this is a single uniform guard rather than special-cased per button. Auto-play advances one step per tick; reaching the end stops playback without committing — the user must press `»` to confirm.

---

## 5. Execution Path

Every user action follows a single shape. The three current divergent paths (`applyAutoPlacements`, `applyNextAutoPlacement`, `getNextAutoApplyStep`) are deleted.

```
userAction(action, currentState):
  baseState                                 = UserAction.apply(action, currentState)
  { board, baseBoard, ruleSteps,
    validationContext }                     = buildEngine(baseState, { skipValidation: true })

  if violation && rewindState === null:
    rewindState = currentState

  pushSnapshot(currentState)                // rolling window

  if ruleSteps.length === 0:
    finalState = recordTurn(baseState, action, [])
    render(board)
  else:
    if validationContext !== null:
      finalState = ruleSteps.flatMap(s => s.mutations).reduce((s, m) => m.apply(s), baseState)
      scheduleTriggerValidation(board, validationContext.rules, validationContext.golden, finalState, validationContext.spec)

    open animation player { baseState, ruleSteps, cursor: 0, playing: true }   // or apply instantly per settings
```

`buildEngine()` runs its full solve exactly once per user action. The only remaining branch is **instant vs animated**, driven by user preference, not by which code path was called. (The player's `boardAtCursor` makes additional `buildEngine(state, { skipSolve: true })` calls while scrubbing — these never run a full solve and never trigger validation; see "Background validation timing" below.)

### Animation commit path

```
user presses »:
  action     = ApplyHintAction { mutations: remaining ruleSteps' mutations }
  newState   = UserAction.apply(action, currentState)   // folds each mutation via .apply()
  { board }  = buildEngine(newState)
  finalState = recordTurn(newState, action, [])
  render(board)
```

`ApplyHintAction.mutations: readonly RuleMutation[]` replaces the old `eliminations: readonly [number, number, number][]`. Storing the actual mutation objects (revived from JSON via `RuleMutation.revive` on load) means undo/redo and `rebuildUserGrid` replay exactly what happened — placements, eliminations, virtual cages, cage-solution eliminations — uniformly via `.apply()`, regardless of kind.

### Background validation timing

The brute-force trigger-miss check (`scheduleTriggerValidation`/`runTriggerValidation`, gated on `golden !== null && !userCorrupted`) needs to run only once per turn, against the fully-deduced (fixpoint) board. `buildEngine(baseState)`'s `board` *is* that fixpoint board — re-solving from `finalState` would be a no-op pass producing the identical board, since the rules already ran to completion. So:

- `buildEngine(baseState, { skipValidation: true })` suppresses the automatic schedule and returns `validationContext`, the inputs it would have used.
- The execution path immediately folds all `ruleSteps` mutations to compute `finalState`, then calls `scheduleTriggerValidation(board, ...)` directly — reusing the already-solved `board` (no second solve), with `finalState` supplying `puzzleType` for report metadata (invariant between `baseState` and `finalState`).
- This schedules the check exactly once per turn, immediately — i.e. concurrently with the animation, not after the user finishes watching it.
- `AnimationPlayer.boardAtCursor` → `computeAnimationCandidates` → `buildEngine(state, { skipSolve: true })` never sets `_solveCompleted`, so scrubbing/rendering never re-triggers validation — mirroring how today's `getNextAutoApplyStep`/`computeAnimationCandidates` (`skipSolve: true`) avoid spamming the validator per animation frame.
- `runTriggerValidation` additionally early-returns when `!hasConsent()`: the brute-force `findTriggerMisses` comparison is otherwise pure waste, since its only output (the reports) is dropped at the upload gate regardless of whether the computation ran.

`getHints()` simplifies from up to 3 `buildEngine()` calls (for inconsistency detection) to one, since violation state is returned directly from `buildEngine()`.

---

## 6. `namespace PuzzleState` — Public API

`namespace PuzzleState` is the sole API surface. `UserAction` types, `puzzleType` checks, and rule lists are implementation details hidden inside it.

### Type guards (internal dispatch only)

```typescript
namespace PuzzleState {
  export function isKiller(state: PuzzleState): state is KillerPuzzleState
}
```

`isKiller` is used only inside the namespace. External callers never call it — they call a method that encapsulates the dispatch.

### Factory

```typescript
namespace PuzzleState {
  export function createClassic(givenDigits, alwaysApplyRules, ...): PuzzleState
  export function createKiller(specData, cageStates, alwaysApplyRules, ...): KillerPuzzleState
}
```

### Operations (public — each returns `SessionResult`)

```typescript
type SessionResult = {
  state: PuzzleState;
  board: BoardState;
  ruleSteps: RuleStep[];
}

namespace PuzzleState {
  export function placeDigit(state, row, col, digit): SessionResult
  export function removeDigit(state, row, col): SessionResult
  export function eliminateCandidate(state, row, col, digit): SessionResult
  export function restoreCandidate(state, row, col, digit): SessionResult
  export function resetCellCandidates(state, row, col): SessionResult
  export function addVirtualCage(state, cage): SessionResult     // asserts KillerPuzzleState
  export function removeVirtualCage(state, key): SessionResult   // asserts KillerPuzzleState
  export function applyHint(state, eliminations): SessionResult
  export function undo(state): SessionResult
}
```

Each operation handles `UserAction.apply + buildEngine + recordTurn` internally. The UI constructs no `UserAction` objects.

### Rules iterator (used by `buildEngine` internally)

```typescript
namespace PuzzleState {
  export function* rules(state: PuzzleState): Iterable<SolverRule>
}
```

Classic yields non-`killerOnly` rules only. Killer yields all rules. `buildEngine()` iterates this — it never holds a rule list or calls a filter itself.

### Display methods

```typescript
namespace PuzzleState {
  export function candidateDisplay(state, board, hint?): readonly CellRender[][]
  export function cageBoundaries(state): readonly BorderSegment[]
  export function cageLabels(state): readonly CageLabelRender[]
  export function cageDisplay(state, board): readonly CageRender[]
  export function virtualCageDisplay(state, board): readonly VirtualCageRender[]
  export function availableCommands(state): ReadonlySet<Command>
}
```

Classic returns `[]` / empty from `cageBoundaries`, `cageLabels`, `cageDisplay`, `virtualCageDisplay`. The UI shows the cage panel when `cageDisplay(...).length > 0`. No puzzle-type checks anywhere in rendering code.

`availableCommands` gates both puzzle-type availability (virtual cages only for killer) and state availability (undo only when turns exist).

### Render data types

All display methods return plain data — visual properties, no semantic labels:

```typescript
interface CandidateRender {
  readonly digit: number;
  readonly visible: boolean;
  readonly strikethrough: boolean;
  readonly colour: RenderColour;
}

interface CellRender {
  readonly placed: { digit: number; colour: RenderColour; locked: boolean } | null;
  readonly candidates: readonly CandidateRender[];
}

interface CageSolutionRender {
  readonly digits: readonly number[];
  readonly visible: boolean;
  readonly strikethrough: boolean;
  readonly colour: RenderColour;
}

interface CageRender {
  readonly label: string;
  readonly total: number;
  readonly cells: readonly [number, number][];
  readonly solutions: readonly CageSolutionRender[];
  readonly mustContain: readonly number[];
}
```

The display layer calls these six methods and paints. It has no other contact with puzzle state and no knowledge of puzzle types.

---

## 7. Serialization

`PuzzleState` is serialized to R2 for bug reports. Old (pre-redesign) reports are not migrated: `deserialize` only recognises the current wire format and throws on anything else. A report that fails to load can simply be deleted from R2 — there is no requirement to keep old reports loadable indefinitely.

### Methods

```typescript
namespace PuzzleState {
  export function serialize(state: PuzzleState): SerializedPuzzleState
  export function deserialize(data: unknown): PuzzleState  // validates and constructs; throws on unrecognised format
}
```

### Wire format

The serialized format adds an explicit `kind: 'classic' | 'killer'` tag so the deserializer knows which constructor to call. This tag is absent from the runtime type — it exists only in the wire format.

```typescript
interface SerializedPuzzleState {
  readonly kind: 'classic' | 'killer';
  readonly version: number;           // bumped when format changes; deserialize rejects any other value
  // ... all PuzzleState fields
}
```

`deserialize` checks `kind` and `version` up front and throws immediately if either is missing or unrecognised — no migration path, no dual field-name handling (`puzzleType` vs `kind`), no reconstruction of `userRemovedCandidates` from `turns`, no special handling of the old `autoRemovedCandidates` field. Pre-redesign reports simply fail `deserialize` and can be deleted on sight.

---

## 8. Out of Scope

The following are deferred and not part of this redesign:

- **Big Apple puzzle type** — the extension point exists (`PuzzleState` is the base, new types extend it) but the implementation is deferred
- **Performance monitoring** — `RuleStats` already exists; surfacing it in a report is separate work
- **Unified digit recogniser** — orthogonal to this refactor; continues independently on `feature/unified-digit-recogniser`
- **LinearSystem API changes** — `LinearSystem` is constructed inside `buildEngine()` only when `PuzzleState.isKiller(state)` is true. The `linearSystemActive` flag on `SolverEngine` is removed. The classic code path never constructs or references a `LinearSystem`. The `LinearSystem` internals are otherwise unchanged.
- **Rule refactoring** — rules keep their current structure; only the `killerOnly` filtering moves into `PuzzleState.rules()`
