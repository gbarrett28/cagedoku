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
  /** Blank (all-zero) grid before /confirm — see "OCR-review representation" below. */
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

**Hybrid killer** (killer with pre-given digits) is represented as `KillerPuzzleState` with `givenDigits !== null` — no new type needed. OCR-driven candidate construction (below) never produces one: until a digit-correction UI exists for the Killer review screen, false-positive digit detections on a Killer scan would become uncorrectable givens. Hybrid killers remain constructible via direct API calls (e.g. fixture loading) — only the OCR path is restricted (see §8).

**Future variants** (Big Apple, etc.) extend `PuzzleState` with their own constraint fields. Each adds a type guard to `namespace PuzzleState`. Existing callers are unaffected.

### OCR-review representation: `readonly PuzzleState[]`

The pre-confirm OCR-review phase is **not** represented by a single `PuzzleState`/`KillerPuzzleState` — "we don't really have a puzzle until OCR is confirmed." Session state holds **`currentState: readonly PuzzleState[]`**, replacing the old `PuzzleState | null` and eliminating the `null` ground state entirely:

- **Pre-confirm**, the list holds every *constructible candidate* — each a real `PuzzleState`/`KillerPuzzleState` built with a blank all-zero `userGrid` and `goldenSolution: null`. Constructibility is gated on OCR's own type verdict (`detectPuzzleType`), not on extraction success:
  - **Killer candidate**: offered whenever OCR concluded `'killer'` — using the extracted spec, or the existing blank/draftable-grid fallback (`actions.ts:336-344`) when extraction failed. Always built with `givenDigits: null` (see Hybrid killer note above). Never offered when OCR concluded `'classic'`, since no cage signal was ever sought (a known pipeline asymmetry — see §8).
  - **Classic candidate**: (almost) always offered, built from `givenDigits` (possibly all-zero) via `PuzzleState.createClassic(...)` with **no cage data at all**, consistent with `KillerPuzzleState extends PuzzleState`. The synthetic 9-row-cage placeholder that `loadClassicDirect` and the OCR classic path currently synthesize purely to satisfy the old flat type is deleted outright.
  - The two candidate types never share editable data — cage fields matter only to Killer, `givenDigits` only to Classic — so editing one candidate never invalidates or affects the other.
- **Post-confirm**, the list holds exactly **`[confirmedState]`**. `confirmPuzzle` is the pivot: it takes the active candidate and the solved board, and *replaces the whole list* with the singleton confirmed state — same extraction mechanics as today (golden solution, `userGrid` prefilled from `givenDigits` for Classic, `applyAutoPlacements`).

**The "confirmed" signal moves from `userGrid` to `goldenSolution`.** Because `userGrid` is now always a real grid (never `null`), "has this session been confirmed?" becomes `state.goldenSolution !== null` — an existing field that is already `null` until `confirmPuzzle` populates it, so the invariant holds with no data-model change. The ~30 call sites across `main.ts`/`actions.ts`/`engine.ts` currently branching on `userGrid === null`/`!== null` split in two: phase-gating checks (`solveCurrentSpec`'s "Already confirmed", `applyDraftLayout`'s "Cannot edit layout after confirming", `revertToOcr`, etc.) switch to `goldenSolution`; plain data-access checks simply drop their now-unnecessary null guard.

**Two accessors replace the single nullable `requireState`:**
- **`requireState()`** is strictly post-confirm — asserts `currentState.length === 1` and returns the singleton. Every existing post-confirm operation (`placeDigit`, hints, undo, etc.) keeps calling it unchanged.
- **A new active-candidate lookup** (e.g. `activeCandidate(candidates, selectedType)`) is strictly pre-confirm — a plain filter, not an assertion — returning the list member matching the puzzle-type dropdown's current selection. `patchCage`, `applyDraftLayout`, `solveCurrentSpec`, and the dropdown-change handler use this instead of `requireState`. "Several candidates, pick the selected one" is the *normal* pre-confirm state, not an edge case to guard against.

**Editing mutates the active candidate directly** — `patchCage`/`applyDraftLayout` update the active Killer candidate's `specData`/`cageStates` in place (the same mechanics as today, just scoped to one list member instead of "the" state); digit correction updates the active Classic candidate's `givenDigits`. No projection step, no rebuild, no shared "artefacts" type — each candidate already *is* the data it needs.

**`revertToOcr`/"Edit OCR"** (`actions.ts:589`, `main.ts:177`'s `lastOcrState`) snapshots and restores the candidate list directly: `lastOcrState: PuzzleState | null` becomes `lastOcrCandidates: readonly PuzzleState[]`, and `revertToOcr(candidates)` replaces `currentState` wholesale — restoring both the available dropdown options and the prior selection.

> **Status (Sprint 1c — ✅ shipped):** `web/src/session/store.ts` now backs the session with `_candidates: readonly PuzzleState[]` (`getStateCandidates`/`setStateCandidates`), replacing `_state: PuzzleState | null`. `getState`/`setState` remain as post-confirm convenience accessors over the singleton candidate, and `requireState()` reads from the candidate list with a non-empty assertion. This is purely an internal data-structure change — OCR still produces exactly one candidate, so `currentState.length` is always 0 or 1 today.
>
> **Status (synthetic 9-row-cage placeholder — ✅ already shipped):** `loadClassicDirect` and the OCR classic path in `buildStateFromParseResult` already build Classic candidates via `PuzzleState.createClassic(...)` with no cage data — the synthetic placeholder described above no longer exists.
>
> **Remaining work, scoped into two further sprints:**
> - **Sprint 1d — ✅ shipped:** `buildCandidatesFromParseResult` (`web/src/session/actions.ts`) builds `[killerCandidate, classicCandidate]` when OCR detects `'killer'` (Killer first, preserving today's default) and `[classicCandidate]` when OCR detects `'classic'`, stored via `setStateCandidates`. The Classic candidate uses `result.givenDigits` (already extracted on the killer path via `readClassicDigits`). No UI change — `getState()` returns `_candidates[0]`, identical to the prior single-candidate behaviour.
> - **Sprint 1e — ✅ shipped:** `activeCandidate(candidates, selectedType)` (`web/src/session/actions.ts`) is a plain filter returning the candidate matching the dropdown's selection, or `undefined` if none was built. The puzzle-type dropdown handler in `main.ts` now tries `activeCandidate` first — if found, it reorders the candidate list so the selected candidate is first (preserving the other candidate's edits) instead of discarding it; only when no real candidate of that type exists does it fall back to the old `createKiller`/`createClassic` reconstruction. `patchCage` and `applyDraftLayout` now call a new internal `replaceCandidate(prev, updated)` helper instead of `setState`, so editing the active Killer candidate's cage layout no longer drops the sibling Classic candidate from the list. `revertToOcr(candidates: readonly PuzzleState[])` replaces `lastOcrState: PuzzleState | null` with `lastOcrCandidates: readonly PuzzleState[]` in `main.ts`, restoring the full candidate list (both interpretations) via `setStateCandidates` when "Edit OCR" is pressed.
>
> **Deferred (low priority):** making `main.ts`'s `currentState` itself a `readonly PuzzleState[]` (currently it remains `PuzzleState | null`, tracking the active/selected candidate — `getStateCandidates()` is queried directly where the full list is needed). The functional goal of dual-candidate OCR review is met without this; revisit only if a concrete need arises.

### Removed: `autoRemovedCandidates` — ✅ already shipped (`bb78a43`)

`autoRemovedCandidates` is removed from `PuzzleState` entirely. It was a mutable side-channel accumulating rule-generated eliminations during step-by-step animation. Its removal is the primary correctness fix.

### Added: `userRemovedCandidates` — ✅ already shipped (`bb78a43`)

User-eliminated candidates are now an explicit field on `PuzzleState`, maintained directly by `UserAction.apply()` alongside `userGrid` and `virtualCages`. Previously this was derived by replaying `turns` — an implicit O(n) dependency that made `buildEngine()` history-dependent.

> **Status:** landed on `master` as a standalone precursor commit (`bb78a43: feat: replace autoRemovedCandidates with userRemovedCandidates on PuzzleState`) before this redesign's implementation branch was created. No remaining work here — `userRemovedCandidates` already exists on the flat `PuzzleState` and is exercised throughout `actions.ts`/`engine.ts`. It carries forward unchanged onto the base `PuzzleState` in the new hierarchy (§1 type hierarchy below).

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

> **Status (Sprint 2a — ✅ shipped):** `RuleMutation` and the four concrete mutation
> types (`PlaceDigitMutation`, `EliminateCandidateMutation`, `AddVirtualCageMutation`,
> `EliminateCageSolutionMutation`) are implemented in `web/src/session/ruleMutation.ts`,
> exactly as specified below, with full unit test coverage including JSON-round-trip
> `revive()` tests. This is purely additive — nothing in `engine.ts`, `actions.ts`, or
> `main.ts` references these types yet; integration begins in Sprint 2b
> (`buildEngine()` contract: `baseBoard`, `ruleSteps`, `validationContext`).

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
userAction(action):
  state                                     = requireState()
  baseState                                 = UserAction.apply(action, state)
  { board, baseBoard, ruleSteps,
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

> **Status:** the predicate itself already shipped (`3706012: feat: add PuzzleState.isKiller as the canonical killer/classic predicate`) — but as a plain `boolean` (`state.puzzleType !== 'classic'`), since `KillerPuzzleState` doesn't exist yet to narrow to. Remaining work: once `KillerPuzzleState` exists (§1), widen `isKiller`'s return type to the `state is KillerPuzzleState` type guard shown above and remove the now-redundant `puzzleType` discriminant it currently reads.

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
- **OCR pipeline symmetry** — the classic OCR path (`inpImage.ts:213-232`) never attempts cage-border/total detection, so a misdetected-as-classic image can never offer a real Killer candidate (the reverse direction works today, since the killer path also runs `readClassicDigits`). Closing this gap would require running cage detection unconditionally — real pipeline scope, deferred alongside the broader "make the OCR review screen fully editable" idea.
- **Hybrid-from-OCR candidate construction** — OCR-driven candidate construction always builds Killer candidates with `givenDigits: null` (§1), even when digit artefacts were detected (which can be false positives on a Killer image). Building a hybrid candidate from OCR requires a digit-correction UI for the Killer review screen first — deferred.
