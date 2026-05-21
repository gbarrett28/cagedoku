# Skyscraper Rule — Design

## Technique

Digit d appears in exactly 2 cells in row R1: (R1, Ca) and (R1, Cb).
Digit d appears in exactly 2 cells in row R2: (R2, Cc) and (R2, Cd).
Exactly one column is shared: e.g. Ca == Cc (the **base column**).
The two non-shared cells are the **roof**: (R1, Cb) and (R2, Cd).

Because d must land in one of the two base cells, it must also land in one of
the two roof cells. Any cell that sees **both** roof cells cannot contain d.

The column-based variant is identical with rows and columns transposed.

## Implementation

**File:** `web/src/engine/rules/skyscraper.ts`

```
name:       'Skyscraper'
priority:   21
triggers:   {GLOBAL}
unitKinds:  {} (empty — full board scan)
```

**`apply(ctx)`**

1. For each digit d (1–9):
   a. Collect all rows where d has exactly 2 candidate cells →
      list of `(rowIdx, [colA, colB])`.
   b. For each pair of such rows (R1, R2):
      - Find how many columns are shared between their two-cell sets.
      - If exactly one column is shared (the base), identify the two roof cells.
      - Collect cells — other than the four pattern cells — that see both
        roof cells and still have d as a candidate.
   c. Repeat steps a–b for columns (swap row ↔ col throughout).
2. Deduplicate and return all eliminations.

**`asHints(ctx, eliminations)`**

Explain: which two rows (or cols) form the pattern, which digit, which base
column, which roof cells, and from which cells d is eliminated.

## File summary

| Action | File |
|---|---|
| Create | `web/src/engine/rules/skyscraper.ts` |
| Create | `web/src/engine/rules/skyscraper.test.ts` |
| Modify | `web/src/engine/rules/index.ts` (register at priority 21) |
