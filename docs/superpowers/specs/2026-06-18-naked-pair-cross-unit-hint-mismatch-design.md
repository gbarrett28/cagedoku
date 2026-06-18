# NakedPair cross-unit hint mismatch (issue #151)

## Bug

`NakedPair.apply()` is invoked with `ctx.unit === null` on `Trigger.GLOBAL` and
scans every ROW/COL/BOX unit, accumulating eliminations from **every** naked
pair it finds into one flat `eliminations` array. `NakedPair.asHints()`
receives that same flat array but only describes the **first** pair it finds
(by re-running `_findPairInCells` over `_activeUnits` and returning on the
first hit). The result: a hint that says "cells A,B in row 1 have only
{4,6}" but whose attached `eliminations` also contains an unrelated pair's
eliminations (e.g. {2,5} eliminated from row 2), which the displayed
explanation never mentions.

Sibling rules (`NakedTriple`, `HiddenPair`) never hit this because they have
no `GLOBAL` trigger and always run with a single, specific `ctx.unit` — one
unit in, one set of eliminations out, one hint out.

Confirmed by a reproduction test (`nakedPair.test.ts`, "root-cause repro
(issue #151)") that currently passes against the buggy behaviour.

## Fix

Replace the implicit "first pair wins" logic with an explicit per-pair model:

1. **`_distinctPairs(ctx)`** — scan `_activeUnits(ctx)`, find the pair in each
   unit's cells, and group results by the pair's two cells (not by unit). A
   pair that happens to satisfy two units at once (e.g. a row-pair that is
   also a box-pair) collapses into **one** entry holding both units — this is
   the "merge into one hint" behaviour the user approved over emitting
   duplicate hints for the same two cells.
2. **Peer cells for a distinct pair** = the union of all cells from every unit
   in that pair's unit list, minus the pair's own two cells, deduplicated.
3. **`apply()`** — for each distinct pair, push eliminations only for that
   pair's peer cells (replaces the old per-unit double loop; functionally
   equivalent for non-overlapping units, and removes duplicate eliminations
   when a pair spans two units).
4. **`asHints()`** — for each distinct pair, compute the same peer-cell set
   and filter the passed-in `eliminations` array down to entries whose cell
   is in that peer set and whose digit is one of the pair's two digits. Build
   one `HintResult` per distinct pair: `highlightCells: [c1, c2]`,
   `secondaryHighlightCells`: peer cells, `eliminations`: the filtered
   subset, and an explanation listing all units the pair spans (joined with
   "and"). Returns an array of 0..N hints instead of always 0 or 1.

This fits the existing engine contract without changes elsewhere:
`solverEngine.ts` already does `pendingHints.push(...rule.asHints(...))` and
runs `dedupHints()` over the combined list, which already drops hints whose
eliminations were already claimed by an earlier hint. Returning multiple
`NakedPair` hints per invocation is therefore safe.

## Tests

- Flip the existing "root-cause repro (issue #151)" test to assert the fixed
  behaviour: two hints are returned, each describing its own pair, each
  hint's `eliminations` containing only that pair's own eliminations.
- Add a new test for the "merge into one hint" path: a pair that is
  simultaneously a row-pair and a box-pair must produce exactly one hint
  whose explanation mentions both units and whose peer cells/eliminations
  are the union across both units.
- Existing tests (GLOBAL single-pair, COUNT_HIT_TWO single-pair, near-miss,
  no-match, highlightCells-exclusivity) are expected to keep passing
  unchanged since they all involve exactly one pair.

## Out of scope

No changes to `NakedTriple`, `HiddenPair`, or `solverEngine.ts`.
