# Puzzle State Redesign — Remaining Work

**Date:** 2026-06-06 (trimmed 2026-06-12)
**Branch:** claude/branch-state-review-lev0gg
**Motivation:** The execution loop has accumulated bugs caused by a mutable animation side-channel (`autoRemovedCandidates`) that diverges from the canonical turn history, three divergent code paths producing different board states, and `puzzleType` discriminants scattered through `actions.ts`. This redesign removes the root causes.

---

## Status

**Shipped and incorporated into `docs/architecture.md`:**
- **§1 State Model** — `PuzzleState`/`KillerPuzzleState` type hierarchy, `isKiller`
  type guard, `userRemovedCandidates`, removal of `autoRemovedCandidates` and the
  `puzzleType` discriminant. See "Board State Hierarchy" in `docs/architecture.md`.
- **§2 `RuleMutation` type hierarchy** — `web/src/session/ruleMutation.ts`. See
  "Rule Mutations and Rule Steps" in `docs/architecture.md`.
- **§3 `buildEngine()` contract** — `ruleSteps`, `validationContext`, and the
  `skipValidation` option all shipped. See "Rule Mutations and Rule Steps" in
  `docs/architecture.md`. **`baseBoard` resolved as not needed:** the pre-solve
  board is already obtainable via `buildEngine(state, { skipSolve: true }).board`,
  which `AnimationPlayer.boardAtCursor` already uses for the cursor-0 frame (see
  "Animation Player" in `docs/architecture.md`). Adding a `baseBoard` field to
  `buildEngine`'s return would duplicate this at no benefit, so it is dropped from
  the redesign. `recordTurn` now passes `{ skipValidation: true }` and schedules
  validation itself against `finalState`.
- **§4 Animation Player** — `web/src/session/animationPlayer.ts`, standalone and
  fully tested, no `main.ts` wiring yet. See "Animation Player" in
  `docs/architecture.md`.
- **`ApplyHintAction.mutations`** — migrated from
  `eliminations: readonly [number, number, number][]` to `readonly RuleMutation[]`.
  `UserAction.apply`'s `'applyHint'` case now folds each mutation via `.apply()`,
  generalizing it to any `RuleMutation` kind (not just eliminations).
  `UserAction.updateRemovedList` and `findFirstElimTurnIdx` (`actions.ts`) updated
  to read `eliminateCandidate`-typed mutations from `action.mutations`.

**Deferred, low priority (from original §1):** making `main.ts`'s `currentState`
itself a `readonly PuzzleState[]` (currently it remains `PuzzleState | null`,
tracking the active/selected candidate — `getStateCandidates()` is queried directly
where the full list is needed). The functional goal of dual-candidate OCR review is
met without this; revisit only if a concrete need arises.

**Remaining work (this document):**
- §5 Execution Path — replaces the three divergent auto-apply code paths with a
  single shape built on `ruleSteps` + `AnimationPlayer`. Both prerequisites
  (`skipValidation` and `ApplyHintAction.mutations`) are now shipped.
- §6 `namespace PuzzleState` public API
- §7 Serialization
- §8 Out of scope (unchanged)

---

## 5. Execution Path

Every user action follows a single shape. The three current divergent paths (`applyAutoPlacements`, `applyNextAutoPlacement`, `getNextAutoApplyStep`) are deleted.

```
userAction(action):
  state                                     = requireState()
  baseState                                 = UserAction.apply(action, state)
  { board, ruleSteps,
    validationContext }                     = buildEngine(baseState, { skipValidation: true })

  if violation && rewindState === null:
    rewindState = state

  pushSnapshot(state)                       // rolling window

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
  state      = requireState()
  action     = ApplyHintAction { mutations: remaining ruleSteps' mutations }
  newState   = UserAction.apply(action, state)          // folds each mutation via .apply()
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

> **Status:** shipped — `isKiller` is already the `state is KillerPuzzleState` type guard (`session/types.ts`), consulted by `buildEngine` to decide which board/engine/rule-list bundle to construct. No remaining work for the predicate itself.

`isKiller` is used only inside the namespace. External callers never call it — they call a method that encapsulates the dispatch.

### Factory

```typescript
namespace PuzzleState {
  export function createClassic(givenDigits, alwaysApplyRules, ...): PuzzleState
  export function createKiller(specData, cageStates, alwaysApplyRules, ...): KillerPuzzleState
}
```

> **Status:** shipped — `PuzzleState.createClassic`/`createKiller` already exist and are used by fresh-state construction.

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

Each operation handles `UserAction.apply + buildEngine + recordTurn` internally. The UI constructs no `UserAction` objects. **Not yet shipped** — `actions.ts` still exposes separate functions rather than this unified namespace; this is part of the §5 execution-path migration.

### Rules iterator (used by `buildEngine` internally)

```typescript
namespace PuzzleState {
  export function* rules(state: PuzzleState): Iterable<SolverRule>
}
```

Classic yields non-`killerOnly` rules only. Killer yields all rules. `buildEngine()` iterates this — it never holds a rule list or calls a filter itself.

> **Status:** shipped — `buildEngine()` already filters via `isKiller`-driven construction (see "Board State Hierarchy" in `docs/architecture.md`). The `rules()` iterator wrapper itself is not yet a named export; remaining work is cosmetic (extracting the existing filter logic behind this iterator).

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
- **OCR pipeline symmetry** — the classic OCR path (`inpImage.ts:213-232`) never attempts cage-border/total detection, so a misdetected-as-classic image can never offer a real Killer candidate (the reverse direction works today, since the killer path also runs `readClassicDigits`). Closing this gap would require running cage detection unconditionally — real pipeline scope, deferred alongside the broader "make the OCR review screen fully editable" idea.
- **Hybrid-from-OCR candidate construction** — OCR-driven candidate construction always builds Killer candidates with `givenDigits: null` (§1), even when digit artefacts were detected (which can be false positives on a Killer image). Building a hybrid candidate from OCR requires a digit-correction UI for the Killer review screen first — deferred.
