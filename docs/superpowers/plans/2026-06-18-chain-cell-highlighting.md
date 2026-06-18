# Chain-Cell Highlighting — Implementation Plan

## Problem

Bug reports #157 (XY-Wing) and #156 (W-Wing) both show a hint that marks a
candidate digit with a blue square on a cell that mathematically cannot hold
that digit. Root cause (confirmed against rule source and the exact
`HintResult` JSON embedded in each bug report): the renderer
(`drawHintDigitMarkers` in `web/src/main.ts`) draws blue squares using a
single global `patternDigits` list applied uniformly to every cell in
`highlightCells`. The six "chain" rules (XY-Wing, XYZ-Wing, W-Wing,
Two-String Kite, Skyscraper, Simple Colouring) have structurally distinct
cells that each carry different digits, but today only convey that via a
2-colour `colourGroups` wash with no per-cell digit information attached.

## Fix

Add a `ChainCell` type carrying a cell, the digit(s) that matter *for that
cell*, and an optional colour wash. Add `chainCells?: readonly ChainCell[]`
to `HintResult`. Migrate the renderer to draw per-cell digit squares from
`chainCells` when present. Migrate all six rules to populate `chainCells`
instead of `colourGroups`, then remove `colourGroups` entirely.

```ts
export interface ChainCell {
  readonly cell: Cell;
  readonly digits: readonly number[];
  readonly colour?: CellColour;
}
```

## Sprints

### Sprint 1 — Core infra + renderer (additive, non-breaking)

- [x] `web/src/engine/hint.ts`: add `ChainCell` interface; add
      `readonly chainCells?: readonly ChainCell[];` to `HintResult`. Keep
      `colourGroups?` untouched for now (still used by all 6 rules).
- [x] `web/src/session/types.ts`: mirror `ChainCell` and add `chainCells?`
      to `HintItem`.
- [x] `web/src/session/actions.ts`: map `h.chainCells` through into the
      `HintItem` construction (same pattern as the existing `colourGroups`
      spread).
- [x] `web/src/main.ts`:
  - Add `hintChainCells` module-level state alongside `hintColourGroups`;
    set/clear it in `showHintModal()`, `clearHintHighlight()`, and the
    session-reset block. (The `AnimationPlayer` step-replay block never
    used `colourGroups` either — it replays auto-mutation `RuleStep`s,
    not rule `HintResult`s — so it needs no change.)
  - `drawUnderlays()`: paint `chainCells` colour washes (cells with a
    `colour` set) in the same layer slot currently used for
    `colourGroups` (before the orange/yellow washes).
  - `drawHintDigitMarkers()`: when a `highlightCells` cell has a matching
    `chainCells` entry, draw squares for that entry's own `digits` (still
    guarded by the live candidate set, still skipping placed cells).
    Cells in `highlightCells` with no matching `chainCells` entry keep
    falling back to the existing global `patternDigits` logic — this
    keeps all not-yet-migrated rules working unchanged.
- [x] Write/extend a unit test exercising the new per-cell digit
      resolution logic: `web/src/engine/hint.test.ts` covers
      `findChainCell(hint, cell)` — returns the matching `ChainCell` entry
      or `null`. `main.ts`'s inline lookup mirrors this same algorithm but
      isn't separately unit-tested (DOM/canvas-bound, no existing
      precedent for unit-testing `main.ts` logic in this codebase).
- [x] `bash scripts/run-bronze-gate.sh` passes.
- [x] Commit: `feat: add ChainCell infra for per-cell hint digit highlighting`.

### Sprint 2 — Migrate XY-Wing and XYZ-Wing (fixes #157)

- [x] `xyWing.test.ts`: updated assertions for `chainCells` — pivot entry
      `{digits: [x,y]}` (no colour, stays orange via `highlightCells`),
      pincer A `{cell: A, digits: [x,z], colour: 'blue'}`, pincer B
      `{cell: B, digits: [y,z], colour: 'green'}`.
- [x] `xyWing.ts`: populate `chainCells` in `asHints()`; removed
      `colourGroups`.
- [x] `xyzWing.test.ts` / `xyzWing.ts`: same treatment — pivot keeps its
      3 digits, pincer A `{digits:[px,pz], colour:'blue'}`, pincer B
      `{digits:[py,pz], colour:'green'}`.
- [x] Renderer refinement (uncovered while migrating): pincer cells are
      deliberately *not* in `highlightCells` (to keep the orange wash from
      overwriting their blue/green chain wash), so `drawHintDigitMarkers`
      in `web/src/main.ts` now draws squares for the union of
      `highlightCells` and `chainCells` cells, not just `highlightCells`.
- [x] `bash scripts/run-bronze-gate.sh` passes.
- [x] Commit: `fix: per-cell digit highlighting for XY-Wing and XYZ-Wing (#157)`.

### Sprint 3 — Migrate W-Wing (fixes #156)

- [ ] `wWing.test.ts`: rewrite the colourGroups-disjointness test to
      instead assert `chainCells` contains all 4 structural cells with
      correct digits: X and Y (the strong-link endpoints) get
      `digits: [p]`; A and B (the bivalue wings) get `digits: [p, q]`;
      colours preserved (X,Y → one colour pairing consistent with current
      A/Y-blue, X/B-green grouping — re-derive from the rule's own
      strong-link/wing semantics, not the old grouping, since the old
      grouping was already not digit-aware). Watch tests fail.
- [ ] `wWing.ts`: populate `chainCells`; remove `colourGroups`.
- [ ] `bash scripts/run-bronze-gate.sh` passes.
- [ ] Commit: `fix: per-cell digit highlighting for W-Wing (#156)`.

### Sprint 4 — Migrate Two-String Kite, Skyscraper, Simple Colouring

- [ ] `twoStringKite.test.ts` / `.ts`: row knot, col knot, row end, col
      end each get a `chainCells` entry with their own relevant digit(s);
      remove `colourGroups`.
- [ ] `skyscraper.test.ts` / `.ts`: roof/base cells (row and column
      variants) get `chainCells` entries with the shared digit; remove
      `colourGroups`.
- [ ] `simpleColouring.test.ts` / `.ts`: wrap case (`bad`/`good` cell
      sets) and trap case (`c0`/`c1` sets) each get `chainCells` entries
      tagged with the coloured digit; remove `colourGroups`.
- [ ] `bash scripts/run-bronze-gate.sh` passes.
- [ ] Commit: `fix: per-cell digit highlighting for Two-String Kite, Skyscraper, Simple Colouring`.

### Sprint 5 — Cleanup and doc updates (Silver-gate-adjacent)

- [ ] Remove `ColourGroup`/`colourGroups` entirely from `hint.ts`,
      `types.ts`, `actions.ts`, `main.ts` (no remaining consumers after
      Sprint 4).
- [ ] Remove the legacy global-`patternDigits`-on-every-`highlightCells`-cell
      fallback path in `drawHintDigitMarkers()` if no rule still relies on
      it for chain-style multi-cell patterns (verify: `patternDigits` is
      still legitimately used by non-chain rules for single-purpose
      highlight sets — keep that path, only the colourGroups-driven
      multi-colour-without-digits path goes away).
- [ ] Full check: `tsc --noEmit`, `npm test -- --reporter=verbose`,
      `npx playwright test`, `npx playwright test --config
      playwright.dev.config.ts` (this is the Silver gate, appropriate
      here since this sprint finalizes the feature before any eventual
      merge).
- [ ] Visual verification: `cd web && npm run dev -- --port 5175`, use
      Playwright MCP to trigger an XY-Wing and a W-Wing hint and confirm
      squares/washes render correctly with no regressions.
- [ ] Update `docs/architecture.md` (current `colourGroups`/`ColourGroup`
      references) to describe `ChainCell`/`chainCells` instead.
- [ ] Update `docs/ui.md` (current "Hint chain colour groups" references)
      to describe the new per-cell model.
- [ ] Delete this plan file once every checkbox above is ticked.
