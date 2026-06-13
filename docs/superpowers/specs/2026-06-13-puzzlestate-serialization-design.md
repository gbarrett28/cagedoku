# `PuzzleState.serialize` / `PuzzleState.deserialize` Design

**Date:** 2026-06-13
**Branch:** feature/puzzlestate-serialization

## Goal

Implement §7 Serialization from `docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md`:
add `PuzzleState.serialize(state)` and `PuzzleState.deserialize(data)`, and use
them to give bug reports a complete, reproducible snapshot of `PuzzleState`
(replacing the current ad-hoc partial `puzzleSpec` object in `main.ts`'s
feedback handler), plus a dev-only hook to load a reported state back into the
app for debugging.

## Context

`PuzzleState`/`KillerPuzzleState` (`web/src/session/types.ts`) are already
plain JSON-serializable data — numbers, strings, arrays, and plain objects
(discriminated unions via the namespace-merging pattern, no `Set`/`Map`/class
instances). `serialize` is therefore close to identity plus a wire-format tag;
`deserialize` validates that tag and the gross shape of the top-level fields.

The current `handleFeedbackSubmit` (`main.ts:1615-1621`) builds a hand-rolled
`puzzleSpec` object with only `puzzleType`, `regions`, `cageTotals`,
`userGrid`, `givenDigits` — it cannot reconstruct `turns`,
`userRemovedCandidates`, `virtualCages`, `cageStates`, or `goldenSolution`, so
a reported bug's exact state can't be reproduced today.

## Wire format and types

Added to `web/src/session/types.ts`:

```typescript
export interface SerializedPuzzleState {
  readonly kind: 'classic' | 'killer';
  readonly version: 1;
  // ...all PuzzleState (classic) or KillerPuzzleState (killer) fields, spread in
}
```

`kind`/`version` exist only in the wire format — `PuzzleState`/`KillerPuzzleState`
themselves remain untagged (dispatch via `isKiller`'s `'specData' in state`
structural check, as today).

## `PuzzleState.serialize(state): SerializedPuzzleState`

```typescript
export function serialize(state: PuzzleState): SerializedPuzzleState {
  return { kind: isKiller(state) ? 'killer' : 'classic', version: 1, ...state };
}
```

A faithful, total snapshot of `state` — includes `originalImageUrl` /
`warpedImageUrl` as-is. Callers that need a smaller payload (e.g. the feedback
handler, to avoid embedding large data URLs in a GitHub issue body) strip
those fields from their own copy before calling `serialize`, or after — this
is the caller's transport concern, not `serialize`'s.

## `PuzzleState.deserialize(data: unknown): PuzzleState`

- Throws immediately (`Error` with a descriptive message) if `data` is not an
  object, or `kind` is not `'classic' | 'killer'`, or `version !== 1`. No
  migration path: pre-redesign reports (and any future format change) simply
  fail `deserialize`.
- Validates gross shape of top-level fields at the same rigor as the existing
  `shared/src/reports/*.ts` `is()` functions (presence + array dimensions +
  primitive element types), **not** recursive validation of every
  `UserAction`/`RuleMutation`/`AutoMutation` union variant — that would
  duplicate the type system for what is fundamentally a dev debugging tool. A
  malformed `turns` entry surfaces as a runtime error inside `buildEngine`,
  which is an acceptable failure mode here.
- Fields validated:
  - `userGrid`: 9×9 number array
  - `turns`: array (element shape not deep-checked)
  - `alwaysApplyRules`: string array
  - `goldenSolution`: 9×9 number array or `null`
  - `givenDigits`: 9×9 number array or `null`
  - `originalImageUrl`: string or `null`
  - `userRemovedCandidates`: array of 3-element number tuples
  - killer only: `specData.regions`/`specData.cageTotals` (9×9 number
    arrays), `cageStates` (array), `virtualCages` (array), `warpedImageUrl`
    (string or `null`)
- On success, strips `kind`/`version` and returns the remaining fields as
  `PuzzleState` (classic) or `KillerPuzzleState` (killer).

### Extensibility

The `kind` dispatch inside `serialize`/`deserialize` is the *only* place that
knows about puzzle-type variants. Adding a future puzzle type (e.g. "Big
Apple", out of scope per §8) means adding one branch here — `main.ts`, the
feedback handler, and all other call sites are unaffected, since they only
ever call `PuzzleState.serialize`/`deserialize`. This mirrors how bug-report
reasons are independently extensible via `shared/src/reports/`'s
`parseAnyReport`/per-type namespaces, which this design does not touch.

## `main.ts` changes

### Feedback handler (`handleFeedbackSubmit`, ~line 1615)

Replace the ad-hoc `puzzleSpec` construction:

```typescript
const puzzleSpec = currentState !== null
  ? { ...PuzzleState.serialize(currentState), originalImageUrl: null,
      ...(PuzzleState.isKiller(currentState) ? { warpedImageUrl: null } : {}) }
  : null;
```

`FeedbackReport.puzzleSpec` remains typed `unknown` (`shared/src/reports/FeedbackReport.ts`,
unchanged) — it's opaque JSON embedded in the GitHub issue body via
`JSON.stringify`.

### Replay hook

Add a dev-only `window.__loadSerializedState(data: unknown)`, gated by
`import.meta.env.DEV` (same dead-code-elimination pattern as the existing
`window.__testLoad`, `web/src/main.ts:~2608`):

```typescript
(window as unknown as Record<string, unknown>)['__loadSerializedState'] = (data: unknown) => {
  const state = PuzzleState.deserialize(data);
  renderPlayingMode(state);
  void fetchCandidates();
};
```

Usage: a developer triaging a reported bug copies the JSON from the issue's
"Puzzle spec" details block and runs
`__loadSerializedState(<pasted JSON>)` in the browser console (dev build) to
reproduce the exact reported state — full turn history, removed candidates,
virtual cages, golden solution, etc.

## Testing

New `describe('PuzzleState.serialize')` / `describe('PuzzleState.deserialize')`
blocks in `engine.test.ts`:

- Round-trip: `deserialize(serialize(state))` produces an equivalent state, for
  both a classic fixture and a killer fixture (including one with non-empty
  `turns`/`userRemovedCandidates`/`virtualCages`).
- `serialize` output has `kind`/`version` set correctly for each puzzle type.
- `deserialize` throws on: missing `kind`, unrecognised `kind`, wrong
  `version`, missing/malformed `userGrid`, missing `specData` for `kind:
  'killer'`.

New test(s) in `main.test.ts` (or wherever `handleFeedbackSubmit` is currently
tested) verifying the feedback payload's `puzzleSpec` has `originalImageUrl`/
`warpedImageUrl` nulled out and round-trips through `PuzzleState.deserialize`
for the non-image fields.

## Docs

- Add a `### PuzzleState.serialize(state) / PuzzleState.deserialize(data)`
  subsection to `docs/architecture.md`.
- Update `docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md`: mark §7
  shipped, leaving only §8 Out of Scope as remaining (unchanged, deferred).
