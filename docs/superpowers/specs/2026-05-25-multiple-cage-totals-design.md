# Multiple Cage Totals Validation — Design

**Date:** 2026-05-25

## Problem

Some committed stall fixtures were created by an older scraper before `validateCageLayout` enforced the `region_reassigned` check. Their `spec.cageTotals` contains two non-zero values for the same cage region — a structural OCR error where the digit scanner read a total from an adjacent cage and placed it inside the current cage's connected component. These fixtures are not genuine rule gaps and produce meaningless focused fixtures.

Additionally, while `validateCageLayout` now blocks this at parse time for new browser uploads, the error message that reaches the user when it slips through (via `solveAndValidateSpec`) is a generic solver-failure message. A structural check run before the solver gives a more specific, actionable warning.

## Design

### New exported function: `hasMultipleCageTotals` in `validation.ts`

```ts
export function hasMultipleCageTotals(spec: PuzzleSpec): string | null
```

Walks the 9×9 grid. Builds a map from region ID to the first cage-head cell seen for that region. As soon as it finds a second non-zero `cageTotals` entry for the same region, returns a human-readable error string identifying both head cells and their totals. Returns null if every cage has exactly one total.

Complexity: O(81) — no solver, essentially free to run as a pre-check.

Lives in `validation.ts` — the canonical home of cage-layout integrity checks, already imported by both `actions.ts` (via `buildStateFromParseResult`) and usable from `focus-stall-fixtures.ts`.

### Call site 1 — stall fixture filter (`web/scripts/focus-stall-fixtures.ts`)

Added alongside the existing `hasUnitConflict` skip, before the solver is invoked:

```ts
const multiTotalError = hasMultipleCageTotals(fixture.spec);
if (multiTotalError !== null) {
  console.log(`  ${fixture.name}: SKIPPED (multiple cage totals — ${multiTotalError})`);
  continue;
}
```

Prevents the solver from running on structurally corrupt fixtures and avoids generating focused fixtures from them.

### Call site 2 — upload pre-check (`web/src/session/actions.ts`)

Inside `buildStateFromParseResult`, called **before** `solveAndValidateSpec` when `result.spec !== null`:

```ts
const structuralError = hasMultipleCageTotals(spec);
const validityError = structuralError ?? solveAndValidateSpec(spec);
if (validityError !== null) {
  const msg = `Puzzle appears to have invalid cage totals — an OCR digit may be wrong (${validityError}). Check the totals carefully before confirming.`;
  warning = warning ? msg + ' ' + warning : msg;
}
```

When `structuralError` is non-null the solver is skipped entirely. The user sees the specific structural message rather than the generic solver-failure message.

## Tests

One new `describe` block in `web/src/session/actions.test.ts`:

- `hasMultipleCageTotals(makeTrivialSpec())` → null (every cell is its own single-cell cage, one total each)
- `hasMultipleCageTotals(corruptedSpec)` → non-null string — constructed by taking `makeTrivialSpec()` and producing a patched spec where `regions[1][0]` is set to the same ID as `regions[0][0]` AND `cageTotals[1][0]` is set to a non-zero value, simulating two declared totals in one region. Because `makeTrivialSpec()` goes through `validateCageLayout` (which would reject such a spec), the corrupted fixture is built by spreading the returned spec and overriding `regions` and `cageTotals` arrays directly.

Since `hasMultipleCageTotals` is exported from `validation.ts` but `actions.test.ts` already imports helpers from across the engine, it is imported there alongside the existing helper imports for consistency with established test patterns.

## Files changed

| File | Change |
|------|--------|
| `web/src/image/validation.ts` | Add exported `hasMultipleCageTotals(spec: PuzzleSpec): string \| null` |
| `web/src/session/actions.ts` | Import `hasMultipleCageTotals`; replace single `solveAndValidateSpec` call with structural-then-solver two-step |
| `web/src/session/actions.test.ts` | New `describe('hasMultipleCageTotals', ...)` block |
| `web/scripts/focus-stall-fixtures.ts` | Import `hasMultipleCageTotals`; add third skip guard after `hasUnitConflict` |

## What is not changing

- `validateCageLayout` is not modified — it already catches `region_reassigned` for new uploads at parse time. The new function is a complementary offline/pre-solve check, not a replacement.
- The error message format in `buildStateFromParseResult` is unchanged — the same warning string template is reused; only the source of the error description changes (structural vs solver).
