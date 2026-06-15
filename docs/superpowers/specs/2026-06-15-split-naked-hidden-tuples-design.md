# Split NakedHiddenTriple/NakedHiddenQuad into Independent Rules — Design

## Context

`NakedHiddenTriple` (priority 8) and `NakedHiddenQuad` (priority 9) each combine
two logically independent solving patterns into one `SolverRule` class:

- **Naked Triple/Quad**: N cells in a unit whose candidate union is exactly N
  digits → eliminate those digits from the rest of the unit.
- **Hidden Triple/Quad**: N digits each confined to the same N cells in a unit →
  eliminate all other candidates from those N cells.

These patterns are not a composition of one another (a worked counter-example:
a row with cells `{1,2}`, `{2,3}`, `{1,3}` where 1/2/3 also appear elsewhere in
the row triggers Naked Triple but not Hidden Triple — no pairwise Naked/Hidden
Pair fires either). Each is independently fundamental and deserves its own rule
class, its own priority, and its own focused description — matching the existing
`NakedPair`/`HiddenPair` split (priorities 6/7).

## Goal

Split the two combined rule files into four single-purpose rule classes, with no
change to solving behaviour or hint output.

## New Rule Files

All four mirror the existing `NakedPair`/`HiddenPair` structure (same imports,
`_helpers.combinations`, `_labels.cellLabel`/`unitLabel`, `UnitKind.ROW/COL/BOX`,
`Trigger.COUNT_DECREASED`).

| File | Class | `name` | `displayName` | priority | Source |
|---|---|---|---|---|---|
| `web/src/engine/rules/nakedTriple.ts` | `NakedTriple` | `'NakedTriple'` | `'Naked Triple'` | 8 | naked branch of old `nakedHiddenTriple.ts` |
| `web/src/engine/rules/hiddenTriple.ts` | `HiddenTriple` | `'HiddenTriple'` | `'Hidden Triple'` | 9 | hidden branch of old `nakedHiddenTriple.ts` |
| `web/src/engine/rules/nakedQuad.ts` | `NakedQuad` | `'NakedQuad'` | `'Naked Quad'` | 10 | naked branch of old `nakedHiddenQuad.ts` |
| `web/src/engine/rules/hiddenQuad.ts` | `HiddenQuad` | `'HiddenQuad'` | `'Hidden Quad'` | 11 | hidden branch of old `nakedHiddenQuad.ts` |

Each `apply()`/`asHints()` is lifted verbatim from the corresponding branch of the
old combined file — including the `secondaryHighlightCells`/`patternDigits` fields
already present on the Hidden Triple/Quad branches (added in the prior
`hidden-tuple-secondary-highlight` work). No logic changes.

### `description` text

Each new rule's `description` covers only its own pattern + guards, split out of
the combined description text. Example for `NakedTriple`:

```
Naked Triple — pigeonhole elimination at N=3 in a unit.

If three cells in a unit have a candidate union of exactly {d1, d2, d3}, those
three cells must collectively hold d1, d2, d3. By pigeonhole, no other cell in
the unit can hold any of these three digits → eliminate {d1,d2,d3} from all
other unit cells.

Guards:
  union.size === 3   union of candidates across the 3 cells must be exactly 3 digits
  each(cell).size ≥ 2   every cell in the triple must have ≥ 2 candidates (singletons
    indicate an unresolved NakedSingle)
  ctx.unit !== null   rule requires a unit context
```

And analogously for `HiddenTriple`, `NakedQuad`, `HiddenQuad`, each retaining only
the guards relevant to that branch.

## Test Files

Split `nakedHiddenTriple.test.ts` → `nakedTriple.test.ts` + `hiddenTriple.test.ts`,
and `nakedHiddenQuad.test.ts` → `nakedQuad.test.ts` + `hiddenQuad.test.ts`, by which
branch each existing test exercises. Each new test file imports only its own rule
class; `ruleName`/`displayName` assertions update to the new class's values
(e.g. `'NakedTriple'`/`'Naked Triple'` instead of `'NakedHiddenTriple'`/`'Naked Triple'`).

The `makeCtx` helper and `makeTrivialSpec` fixture usage are unchanged — copied as-is
into each new test file.

## Priority Renumbering

Inserting 4 rules where 2 existed adds 2 new priority slots. Every rule from
`PointingPairs` (currently 9) onward shifts by **+3**:

| Rule | Old | New |
|---|---|---|
| PointingPairs | 9 | 12 |
| LockedCandidates | 11 | 14 |
| CageConfinement | 12 | 15 |
| UnitPartitionFilter | 12 | 15 |
| XWing | 13 | 16 |
| Swordfish | 14 | 17 |
| Jellyfish | 15 | 18 |
| XYWing | 16 | 19 |
| UniqueRectangle | 17 | 20 |
| SimpleColouring | 18 | 21 |
| XYZWing | 19 | 22 |
| WWing | 20 | 23 |
| Skyscraper | 21 | 24 |
| TwoStringKite | 22 | 25 |

Each affected file's `readonly priority = N` is updated to its new value.

## Engine Behaviour

`solverEngine.ts` drains rules in ascending-priority order from a priority queue
per trigger. With `NakedTriple=8 < HiddenTriple=9` (and `NakedQuad=10 < HiddenQuad=11`),
a naked pattern on a unit is processed before a hidden pattern is considered for
that same unit — preserving the old combined rule's "naked branch returns early"
behaviour without any special-casing.

## Other Files to Update

- **`web/src/engine/rules/index.ts`**: priority comment table, imports, exports,
  `defaultRules()` registration — remove `NakedHiddenTriple`/`NakedHiddenQuad`,
  add `NakedTriple`, `HiddenTriple`, `NakedQuad`, `HiddenQuad` (in priority order),
  apply the +3 shift to the 14 rules listed above.
- **`web/src/engine/rules/index.test.ts`**: update the expected rule-name list
  (replace `'NakedHiddenTriple'`, `'NakedHiddenQuad'` with the 4 new names).
- **`web/scripts/repro-bugs.ts`**: update imports/usages of `NakedHiddenQuad`
  (line 129, `Hidden Quad` repro) and `NakedHiddenTriple` (line 178, rule list)
  to use `HiddenQuad`/`NakedTriple`+`HiddenTriple` as appropriate.
- **`docs/architecture.md`** (~line 853-858): the `secondaryHighlightCells`
  paragraph currently reads "...and the Hidden Triple/Quad branches of
  NakedHiddenTriple/NakedHiddenQuad" — update to "...HiddenTriple and HiddenQuad".
  Also update the rule-priority documentation references if any exist beyond
  `rules/index.ts`'s own comment block.

## Files Deleted

- `web/src/engine/rules/nakedHiddenTriple.ts`
- `web/src/engine/rules/nakedHiddenTriple.test.ts`
- `web/src/engine/rules/nakedHiddenQuad.ts`
- `web/src/engine/rules/nakedHiddenQuad.test.ts`

## Out of Scope

- No change to solving behaviour, hint content, eliminations, or UI rendering.
- No change to `secondaryHighlightCells`/`patternDigits` logic itself (already
  shipped in `hidden-tuple-secondary-highlight`).
- `ruleMutation.ts` / session-layer rule-name handling (`LINEAR_RULE_NAMES`,
  `isRuleDisabledForSession`, etc.) reference rule names generically by string and
  require no changes — none of them special-case `NakedHiddenTriple`/`NakedHiddenQuad`.
