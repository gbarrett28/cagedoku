# Big Apple Sudoku

> Read this before touching Big Apple detection, the `BigAppleBoardState`
> engine class, or any UI branch conditioned on `PuzzleState.isBigApple`.

Big Apple Sudoku is classic sudoku plus 4 extra offset 3×3 "window" regions,
each of which must also contain digits 1–9 exactly once.

| Window | Rows (1-based) | Cols (1-based) |
|---|---|---|
| Top-left | 2–4 | 2–4 |
| Bottom-left | 6–8 | 2–4 |
| Top-right | 2–4 | 6–8 |
| Bottom-right | 6–8 | 6–8 |

0-based: rows/cols `[1..3]` and `[5..7]` crossed with `[1..3]` and `[5..7]`.

---

## Detection

There is no visual/OCR cue distinguishing a Big Apple puzzle image from a
classic one — both show large centred givens, no cage borders. Detection is
solvability-based: `detectBigApple` (`web/src/engine/index.ts`) runs the rule
engine with classic-only rules (constraint propagation, no backtracking); if
it stalls before every cell is solved, it retries with classic + window rules
(`BigAppleBoardState`); if that retry completes the grid, the image is
treated as Big Apple.

This only runs for classic-*detected* OCR scans (`result.puzzleType ===
'classic'`) — never for killer-detected scans, whose `classicCandidate` comes
from a less-reliable digit pass (see `solveCurrentSpec`'s comment on
false-positive digit detection near cage-total text), and because a real Big
Apple photo never has cage borders to begin with.

`buildCandidatesFromParseResult` (`web/src/session/actions.ts`) prepends a
`PuzzleState.createBigApple(...)` candidate when detection fires, making it
the default `activeCandidate`, and reports `detectedBigApple: boolean`
alongside the candidate list. The OCR review screen shows a dismissible
banner (`#bigapple-banner` in `web/index.html`) when this flag is set; the
banner also auto-hides as soon as the user changes the puzzle-type dropdown.

## Manual override

The puzzle-type dropdown (`#puzzle-type-select`) always offers a "Big Apple"
option, selectable regardless of what detection concluded. Selecting it
synthesizes a `BigApplePuzzleState` from the current given digits via
`PuzzleState.createBigApple`, exactly mirroring the existing Classic branch's
on-the-fly synthesis — no cage/spec data is involved.

## Engine

`BigAppleBoardState extends BoardState` (`web/src/engine/bigAppleBoardState.ts`)
registers the 4 window cell-sets as `UnitKind.BOX` units via the protected
`_addUnit` method, after the standard 27 row/col/box units. Reusing
`UnitKind.BOX` means every rule gating on `unitKinds.has(UnitKind.BOX)` —
`NakedPair`/`Triple`/`Quad`, `HiddenSingle`/`Pair`/`Triple`/`Quad`,
`PointingPairs`, `WWing` — automatically covers the windows with no per-rule
changes. `extraPeers(r, c)` returns the cell's 8 window-mates so
`mrvBacktrack`'s forward-checking respects window constraints during
backtracking.

`solveBigApple(givenDigits?)` (`web/src/engine/index.ts`) is the Big Apple
sibling of `solve()`, used by `solveCurrentSpec` (`web/src/session/actions.ts`)
to compute the golden solution at confirm time whenever
`PuzzleState.isBigApple(state)`.

Reusing `UnitKind.BOX` for windows means hint explanations naming "within
box (r,c)" would be ambiguous for window units, since a window's first cell
never aligns to a standard box's top-left corner. `unitLabel`
(`web/src/engine/rules/_labels.ts`) checks each `BOX`-kind unit's first cell
against the 4 known window corners before falling back to the `box (r,c)`
label, producing "top-left window" / "bottom-left window" / "top-right
window" / "bottom-right window" in rule explanations instead.

**Known coverage gap:** `LockedCandidates`' box-line reduction
(`web/src/engine/rules/lockedCandidates.ts`) computes box unit ids
geometrically (`board.boxUnitId(br*3, bc*3)`) rather than by iterating
`board.units` by kind, so it does not extend to window units. Windows still
get full coverage from every other `UnitKind.BOX`-aware rule; this is an
accepted, documented gap, not a blocker.

## Rendering

Window cells get a light background tint (`drawWindowTint`, `web/src/main.ts`)
gated on `PuzzleState.isBigApple(state)` — a plain `fillRect` per window cell
with no border math, since window units need no boundary lines. Standard
3×3 box lines render unconditionally, same as for classic and killer.

## Out of scope

- No combined killer + Big Apple variant — the three puzzle types remain
  mutually exclusive.
- Orientation correction, already deferred for classic, remains deferred.
