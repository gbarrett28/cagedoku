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

## 2. `buildEngine()` Contract

```typescript
function buildEngine(state: PuzzleState): {
  board: BoardState;
  engine: SolverEngine;
  ruleSteps: RuleStep[];
}
```

`buildEngine()` is a pure function. Given the same `PuzzleState`, it always returns the same result. It reads: `specData`, `cageStates`, `userGrid`, `userRemovedCandidates`, `virtualCages`, `alwaysApplyRules`, `goldenSolution`, `fixtureStalledCandidates`. It does not read `turns`.

`ruleSteps` is the ordered transcript produced by `engine.solve()` — the sequence of rule firings that reached the fixed point, with proper chaining (later rules see earlier rules' eliminations because `solve()` iterates internally to fixed point). Callers that only need the board ignore it.

---

## 3. Animation Player

The animation player is pure UI state — nothing on `PuzzleState`.

```typescript
interface AnimationPlayer {
  readonly ruleSteps: RuleStep[];
  readonly cursor: number;    // 0 = before any steps
  readonly playing: boolean;
}
```

The displayed candidate grid at cursor position N is computed on the fly from the `buildEngine()` result minus eliminations from `ruleSteps[0..cursor-1]`. No state mutations occur during playback.

### 5-button VCR control

| Button | Effect |
|---|---|
| `«` | `cursor = 0` — cancel, no commit |
| `<` | `cursor = max(0, cursor - 1)` |
| `\|\|` | toggle `playing` |
| `>` | `cursor = min(ruleSteps.length, cursor + 1)` |
| `»` | commit all steps as `ApplyHintAction`, close player |

Auto-play advances one step per tick, pausing at each rule boundary so the user sees one complete rule application before the next begins. Reaching the end stops playback without committing — the user must press `»` to confirm.

`«` at cursor 0 closes the player with no state changes.

---

## 4. Execution Path

Every user action follows a single shape. The three current divergent paths (`applyAutoPlacements`, `applyNextAutoPlacement`, `getNextAutoApplyStep`) are deleted.

```
userAction(action, currentState):
  newState                     = UserAction.apply(action, currentState)
  { board, engine, ruleSteps } = buildEngine(newState)

  if violation && rewindState === null:
    rewindState = currentState

  finalState = recordTurn(newState, action, ruleSteps)
  pushSnapshot(currentState)        // rolling window

  if ruleSteps produce placements or eliminations:
    open animation player with ruleSteps   // or apply instantly per settings
  else:
    render(board)
```

`buildEngine()` is called exactly once per user action. The only remaining branch is **instant vs animated**, driven by user preference, not by which code path was called.

### Animation commit path

```
user presses »:
  action     = ApplyHintAction { eliminations: all from ruleSteps }
  newState   = UserAction.apply(action, currentState)
  { board }  = buildEngine(newState)
  finalState = recordTurn(newState, action, [])
  render(board)
```

`getHints()` simplifies from up to 3 `buildEngine()` calls (for inconsistency detection) to one, since violation state is returned directly from `buildEngine()`.

---

## 5. `namespace PuzzleState` — Public API

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

## 6. Serialization

`PuzzleState` is serialized to R2 for bug reports. Old bug reports must remain loadable indefinitely.

### Methods

```typescript
namespace PuzzleState {
  export function serialize(state: PuzzleState): SerializedPuzzleState
  export function deserialize(data: unknown): PuzzleState  // validates, migrates, constructs
}
```

### Wire format

The serialized format adds an explicit `kind: 'classic' | 'killer'` tag so the deserializer knows which constructor to call. This tag is absent from the runtime type — it exists only in the wire format.

```typescript
interface SerializedPuzzleState {
  readonly kind: 'classic' | 'killer';
  readonly version: number;           // bumped when format changes
  // ... all PuzzleState fields
}
```

### Migration from old format

Old bug reports contain `autoRemovedCandidates` (now removed) and no `userRemovedCandidates`. The deserializer detects old format by `version` number (or absence of `userRemovedCandidates`) and reconstructs `userRemovedCandidates` by replaying `turns` through `UserAction.updateRemovedList`. `autoRemovedCandidates` is discarded.

Old format also has `puzzleType: 'classic' | 'killer'` instead of `kind`. The deserializer accepts both field names.

Migration is transparent to callers — `deserialize` always returns a valid current-format `PuzzleState`.

---

## 7. Out of Scope

The following are deferred and not part of this redesign:

- **Big Apple puzzle type** — the extension point exists (`PuzzleState` is the base, new types extend it) but the implementation is deferred
- **Performance monitoring** — `RuleStats` already exists; surfacing it in a report is separate work
- **Unified digit recogniser** — orthogonal to this refactor; continues independently on `feature/unified-digit-recogniser`
- **LinearSystem API changes** — `LinearSystem` is constructed inside `buildEngine()` only when `PuzzleState.isKiller(state)` is true. The `linearSystemActive` flag on `SolverEngine` is removed. The classic code path never constructs or references a `LinearSystem`. The `LinearSystem` internals are otherwise unchanged.
- **Rule refactoring** — rules keep their current structure; only the `killerOnly` filtering moves into `PuzzleState.rules()`
