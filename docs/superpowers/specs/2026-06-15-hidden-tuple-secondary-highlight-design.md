# Hidden-tuple secondary highlight (issue #153)

## Problem

Bug report #153: for the Hidden Single hint, the extra highlighted cells alongside
the target cell don't make sense to the user. The current code highlights
`[sole, ...peerCells]` where `peerCells` are cells in *other* units that happen to
also lose candidate `d` as a side effect of the placement — unrelated to "why is `d`
unique to this cell".

The reporter's suggestion: highlight the **target cell(s)** with the standard
orange/yellow treatment (as now), and highlight **all other cells in the unit** in
which the digit/tuple is unique with a **pale blue** wash — giving visual context for
"this is the unit the deduction is about".

The user additionally asked to extend this to the other "Hidden" rules: HiddenPair,
and the Hidden Triple / Hidden Quad branches of NakedHiddenTriple / NakedHiddenQuad.

## Design

### New field: `HintResult.secondaryHighlightCells`

Add `readonly secondaryHighlightCells?: readonly Cell[]` to `HintResult`
(`web/src/engine/hint.ts`), documented as: cells rendered with a pale-blue wash to
give unit context, distinct from `highlightCells` (orange/yellow) and `colourGroups`
(chain colouring blue/green).

Mirror as `readonly secondaryHighlightCells?: readonly [number, number][]` on
`HintItem` (`web/src/session/types.ts`), mapped through in
`web/src/session/actions.ts` the same way `patternDigits` is (spread-if-present).

### Rendering (`web/src/main.ts`)

- New module state `hintSecondaryHighlightCells: Set<string>`, set/cleared alongside
  `hintHighlightCells` in `showHintModal` / `clearHintHighlight` / the animation loop.
- Drawn in `drawHighlights` (or wherever the highlight fills happen) **before** the
  existing orange `highlightKeys` and yellow `hintElimCells` fills, using a pale blue
  fill: `rgba(96, 165, 240, 0.18)`. Order matters so orange/yellow take visual
  precedence on any cell that appears in both sets (shouldn't normally overlap, but
  keep it safe).

### Rule changes

For each rule below, `highlightCells` keeps only the "pattern" cells (the cells the
deduction is actually about); `secondaryHighlightCells` becomes
`ctx.unit.cells` minus whatever is already in `highlightCells`.

- **HiddenSingle** (`hiddenSingle.ts`): `highlightCells: [sole]` (was
  `[sole, ...peerCells]`). `peerCells` computation and the `peerNote` explanation
  text are unchanged — they describe knock-on eliminations in prose only, no longer
  highlighted. `secondaryHighlightCells: unit.cells` minus `sole`.
- **HiddenPair** (`hiddenPair.ts`): `highlightCells` unchanged (`pairCells`,
  which already equals the elimination cells). `secondaryHighlightCells: unit.cells`
  minus `pairCells`.
- **NakedHiddenTriple** (`nakedHiddenTriple.ts`), Hidden Triple branch only:
  `highlightCells` unchanged (`tripleCells`). `secondaryHighlightCells: unit.cells`
  minus `tripleCells`. Naked Triple branch is unchanged (out of scope — eliminations
  already span the unit).
- **NakedHiddenQuad** (`nakedHiddenQuad.ts`), Hidden Quad branch only: same pattern
  as Hidden Triple, using `quadCells`.

### Testing

- `hiddenSingle.test.ts`: update existing assertions on `highlightCells` to expect
  just `[sole]`, add new assertions for `secondaryHighlightCells` covering the rest
  of the unit.
- `hiddenPair.test.ts`, `nakedHiddenTriple.test.ts`, `nakedHiddenQuad.test.ts`: add
  `secondaryHighlightCells` assertions for the relevant (hidden) branch(es).
- No new test file needed for `main.ts` rendering — covered visually, not unit
  tested (consistent with how `colourGroups` rendering is handled).

## Out of scope

- Naked Pair / Naked Triple / Naked Quad rules.
- Any rule other than the four listed above.
- Changing `peerNote` text or `peerCells` computation in HiddenSingle.
