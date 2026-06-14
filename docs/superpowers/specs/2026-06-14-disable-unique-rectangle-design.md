# Disable UniqueRectangle Rule — Design

**Goal:** Disable `UniqueRectangle`, the only rule whose proof depends on "the puzzle
has a unique solution" — a meta-assumption the rest of the rule set does not make.

**Approach:** Reuse the existing `DISABLED_RULES` filter
(`web/src/engine/rules/disabled-rules.ts`), already consulted by
`PuzzleState.rules()`, `buildEngine()`, and `getHints()`. Add `'UniqueRectangle'` to
the list.

## Changes

1. `web/src/engine/rules/disabled-rules.ts` — add `'UniqueRectangle'` to
   `DISABLED_RULES`.
2. `web/src/engine/rules/uniqueRectangle.test.ts` — gate the test suite on
   `DISABLED_RULES.includes('UniqueRectangle')` (e.g. `describe.skip` /
   conditional describe), matching the existing convention for disabled rules so
   the suite stays green without deleting coverage.
3. `docs/architecture.md` — add a short note near the "Disabled rules" section
   distinguishing `UniqueRectangle`'s entry (disabled because it assumes solution
   uniqueness) from the golden-violation-driven entries the section otherwise
   describes.

## Out of scope

No other rules. No UI changes beyond what the existing `DISABLED_RULES` filter
already does automatically (UniqueRectangle disappears from the config modal's
rule list).
