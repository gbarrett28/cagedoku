# Big Apple Sudoku — Design

## Summary

Add Big Apple Sudoku as a third puzzle variant alongside classic and killer.
Big Apple is classic sudoku plus 4 extra offset 3×3 "window" regions, each of
which must also contain digits 1–9 exactly once. The windows (1-based,
inclusive) are:

| Window | Rows | Cols |
|---|---|---|
| Top-left | 2–4 | 2–4 |
| Bottom-left | 6–8 | 2–4 |
| Top-right | 2–4 | 6–8 |
| Bottom-right | 6–8 | 6–8 |

0-based: rows/cols `[1..3]` and `[5..7]` crossed with `[1..3]` and `[5..7]`.

There is no visual/OCR cue that distinguishes a Big Apple puzzle image from a
classic one (both show large centred givens, no cage borders). Detection is
therefore:

1. **Solvability-based auto-suggestion** — run the rule engine with classic
   rules only; if it stalls before completion, retry with classic + window
   rules; if the retry reaches a complete, contradiction-free grid, treat the
   image as Big Apple and pre-select that option with a dismissible banner.
2. **Manual override** — a first-class, always-present "Big Apple" entry in
   the OCR-review puzzle-type dropdown, selectable regardless of what
   detection concluded.

## Why not a flag on `PuzzleState`

`KillerPuzzleState extends PuzzleState` already establishes the pattern for a
puzzle-type-specific subtype with its own structural discriminant
(`'specData' in state`) rather than a boolean field on the shared base type
(see `docs/architecture.md`'s Board State Hierarchy / Rule Contract
sections). `BigApplePuzzleState` follows the same pattern: it is a subtype
that derives from classic's shape (no spec/cage data — unlike killer) plus a
single marker field used purely as the structural discriminant.

## Detailed design

### 1. State (`web/src/session/types.ts`)

```ts
export interface BigApplePuzzleState extends PuzzleState {
  readonly bigApple: true;
}
```

```ts
export namespace PuzzleState {
  export function isBigApple(state: PuzzleState): state is BigApplePuzzleState {
    return 'bigApple' in state;
  }

  export function createBigApple(
    givenDigits: number[][] | null,
    alwaysApplyRules: readonly string[],
    originalImageUrl: string | null,
  ): BigApplePuzzleState {
    return { ...createClassic(givenDigits, alwaysApplyRules, originalImageUrl), bigApple: true };
  }
}
```

`rules()` needs no new filtering branch: Big Apple runs the same
`!r.killerOnly` rule set classic already uses. Window coverage comes from
reusing `UnitKind.BOX` for the window units (see §2), not from new rules.

Every other 2-way dispatch site that currently branches on `isKiller(state)`
alone and silently treats "not killer" as "classic" needs inspection — most
(`candidateDisplay`, `availableCommands`, `cageBoundaries`, `cageLabels`)
already do the right thing for Big Apple by falling through the same path as
classic, since Big Apple shares classic's `givenDigits`/no-cage shape. The one
dispatch site that needs an explicit third branch is `buildEngine` (§3),
because board *construction* differs (extra units must be registered).

### 2. Board engine (`web/src/engine/`)

New `BigAppleBoardState extends BoardState` (own file,
`web/src/engine/bigAppleBoardState.ts`), mirroring `KillerBoardState`'s
constructor pattern: after the base row/col/box units are registered, the
constructor calls the protected `_addUnit()` method 4 times, once per window,
with `kind: UnitKind.BOX` and the window's 9 cells. No cage-specific overrides
(`cageConstraints()`, `removeCandidate()`) are needed — the base
`BoardState.removeCandidate()` already propagates eliminations to all
registered units regardless of kind, since it iterates `_cellUnitIds`.

Reusing `UnitKind.BOX` (rather than introducing `UnitKind.WINDOW`) means every
rule that already gates on `unitKinds.has(UnitKind.BOX)` — NakedPair/Triple/
Quad, HiddenSingle/Pair/Triple/Quad, PointingPairs, WWing — automatically
covers the windows with no per-rule changes.

**Landmine fix — `unitKindFromId`** (`web/src/engine/solverEngine.ts`): this
function currently hardcodes numeric id ranges (`<9` ROW, `<18` COL, `<27`
BOX, else CAGE) to classify a unit id for work-queue/trigger routing. Window
units get ids ≥27 in their own board instance, which this logic would
misclassify as CAGE. Fix: look up `board.units[unitId].kind` directly instead
of inferring from the numeric range.

**Landmine fix — `unitLabel`** (`web/src/engine/rules/_labels.ts`): the BOX
case computes a label via `(cells[0][0]/3|0)+1` arithmetic that assumes
standard 0/3/6-aligned box boundaries. For a window unit (non-aligned cells)
this produces a wrong or colliding label. Fix: before falling into the
standard arithmetic, check whether the unit's cell set matches one of the 4
known window cell-sets; if so, label it `"top-left window"` /
`"bottom-left window"` / `"top-right window"` / `"bottom-right window"`
instead.

**Landmine fix — backtracker** (`web/src/engine/backtracker.ts`): `PEERS` is
a statically precomputed row/col/box-only lookup table, fully independent of
`BoardState.units`. Registering window units on the board does *not* make
`mrvBacktrack`'s forward-checking respect them. Fix: add a new virtual method
`BoardState.extraPeers(r: number, c: number): readonly Cell[]` (default `[]`
on the base class), overridden by `BigAppleBoardState` to return the other 8
cells of that cell's window. `assign()` in `backtracker.ts` unions
`board.extraPeers(r, c)` with the static `PEERS[r][c]` lookup at the point of
elimination — mirroring how `cageConstraints()` is already threaded into
`cageValid()`/`assign()`/`search()` for killer cage validity. `mrvBacktrack`
takes `board: BoardState` already, so it can call `board.extraPeers(r, c)`
directly without an `instanceof` check.

**Accepted gap — `LockedCandidates`** (`web/src/engine/rules/
lockedCandidates.ts`): its box-line reduction pattern computes box unit ids
geometrically via `board.boxUnitId(br*3, bc*3)`, not by iterating
`board.units` by kind. This will not extend to window units. Documented as a
known coverage gap, not a blocker — windows still get full coverage from
every other BOX-aware rule.

### 3. Board/engine construction dispatch (`web/src/session/engine.ts`)

`buildEngine`'s ternary (currently 2-way: `isKiller(state) ? killer-board
construction : new BoardState()`) becomes 3-way:

```ts
const { board, engine } = PuzzleState.isKiller(state)
  ? /* existing killer branch, unchanged */
  : PuzzleState.isBigApple(state)
    ? (() => {
        const board = new BigAppleBoardState();
        const engine = new SolverEngine(board, activeRules, { hintRules, goldenSolution: activeGolden, onViolation });
        return { board, engine };
      })()
    : (() => {
        const board = new BoardState();
        const engine = new SolverEngine(board, activeRules, { hintRules, goldenSolution: activeGolden, onViolation });
        return { board, engine };
      })();
```

Big Apple uses the same plain `SolverEngine` as classic (no killer-specific
hint/solution-map machinery needed) — only the board class differs.

### 4. Serialization (`web/src/session/types.ts`)

```ts
export type SerializedPuzzleState =
  | (PuzzleState & { readonly kind: 'classic'; readonly version: 1 })
  | (KillerPuzzleState & { readonly kind: 'killer'; readonly version: 1 })
  | (BigApplePuzzleState & { readonly kind: 'bigapple'; readonly version: 1 });
```

`serialize()` gains a third branch (`isBigApple(state) → kind: 'bigapple'`,
checked before the classic fallthrough since `isKiller` is checked first and
the three are mutually exclusive). `deserialize()` gains a matching
`case 'bigapple':` branch reconstructing via `createBigApple` plus restoring
the persisted fields.

### 5. Detection (`web/src/session/actions.ts`)

`buildCandidatesFromParseResult()` runs the solvability heuristic described
in the Summary (classic-only stall → classic+window solve) using the same
`buildEngine`/rule-engine machinery already used for puzzle solving
elsewhere in this file. When the heuristic concludes Big Apple:
- prepend a `createBigApple(...)` candidate to the returned candidate list
  (so it becomes the `activeCandidate` default), and
- return a `detectedBigApple: boolean` alongside the candidate list (or
  thread it the same way `result.puzzleType` already flows into the OCR
  review screen) so the caller can show the dismissible banner.

This mirrors the existing killer/classic detection-result threading; no new
plumbing pattern is introduced.

`activeCandidate()`'s signature widens:

```ts
export function activeCandidate(
  candidates: readonly PuzzleState[],
  selectedType: 'killer' | 'classic' | 'bigapple',
): PuzzleState | undefined {
  const kindOf = (c: PuzzleState): 'killer' | 'classic' | 'bigapple' =>
    PuzzleState.isKiller(c) ? 'killer' : PuzzleState.isBigApple(c) ? 'bigapple' : 'classic';
  return candidates.find(c => kindOf(c) === selectedType);
}
```

### 6. OCR dropdown UI

- `web/index.html` (~line 165): add `<option value="bigapple">Big Apple</option>`
  to `#puzzle-type-select`, alongside the existing `killer`/`classic` options.
- `web/src/main.ts`'s change handler (~line 2163): widen the `type` cast to
  `'killer' | 'classic' | 'bigapple'`; add a third `else if (type ===
  'bigapple')` branch that calls `PuzzleState.createBigApple(givenDigits,
  state.alwaysApplyRules, state.originalImageUrl)` when `activeCandidate`
  finds no existing match — mirroring the existing classic branch's
  on-the-fly synthesis (no synthetic spec construction needed, since Big
  Apple carries no cage data).
- The detection banner (from §5) renders on the OCR review screen alongside
  the existing review status message, dismissible, and only shown when
  `detectedBigApple` is true and the user hasn't already changed the
  dropdown selection away from it.

### 7. Rendering

Window cells get a shaded background tint in the canvas renderer (a new,
simple draw call analogous in spirit to the existing cage-border/cage-total
drawing functions but with no border math — just a `fillRect` per window
cell, gated on `PuzzleState.isBigApple(state)`). Standard 3×3 box lines
continue to render unconditionally, same as today for classic.

## Out of scope / explicitly deferred

- `LockedCandidates`' box-line reduction does not cover window units (§2,
  accepted gap).
- No combined killer+Big Apple variant — the three puzzle types remain
  mutually exclusive.
- Orientation correction, already deferred for classic, remains deferred.

## Sprints

1. **Engine core** — `BigAppleBoardState`, `BoardState.extraPeers()` +
   backtracker integration, `unitKindFromId` fix, window unit labels, unit
   tests for all of the above.
2. **Session/state** — `BigApplePuzzleState`, `isBigApple`, `createBigApple`,
   serialize/deserialize, `buildEngine` 3-way dispatch, persistence
   round-trip test.
3. **OCR detection heuristic** — solvability-based auto-suggestion logic in
   `buildCandidatesFromParseResult`, banner UI.
4. **Dropdown UI + rendering** — `index.html` option, `main.ts` change
   handler, `activeCandidate` widening, window-tint rendering, doc updates
   (`docs/architecture.md`, `docs/classic-sudoku.md` or a new
   `docs/big-apple-sudoku.md`).
