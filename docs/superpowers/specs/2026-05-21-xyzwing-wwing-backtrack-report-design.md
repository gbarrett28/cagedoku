# XYZWing, W-Wing, and Backtracking Bug Report — Design

## Context

`solve()` in `engine/index.ts` falls back to `mrvBacktrack` when rules alone
cannot solve a puzzle. Issue #103 confirmed `usedBacktracking: true` for a
classic sudoku that the hint system then could not progress. The rule set is
confirmed inadequate: XYZWing and W-Wing are the most likely missing techniques.

---

## Part 1 — Auto-bug report when backtracking is used

### Problem

When `usedBacktracking = true` after `confirmPuzzle`, the current code only
calls `uploadPuzzleSpec` (training data). No bug is filed. The inadequate rule
set goes unnoticed.

### Design

In `handleConfirm()` and the auto-confirm path inside `handleProcess()`, when
`usedBacktracking = true`, additionally call `showAssertionModal` with a new
`AssertionViolation`:

```
name: 'BacktrackingRequired'
description: 'The rule engine could not solve this puzzle without backtracking.
  This means the rule set is missing at least one logical technique needed to
  solve this puzzle type. Please report so we can identify and implement the
  missing rule.'
puzzleSpecJson: <current spec>
solutionJson: null   (no user grid yet)
actionLog: ''
```

The modal uses the existing "Report Bug" / "Dismiss" flow — no new UI needed.
The user can dismiss and continue playing normally; the puzzle is still fully
solvable via hints + Reveal.

**Files:** `web/src/main.ts` — two call sites (auto-confirm and manual confirm).

---

## Part 2 — XYZWing rule

### Technique

Pivot cell P has exactly **3** candidates {x, y, z}. Pincer A is bivalue {x, z}
and sees P. Pincer B is bivalue {y, z} and sees P. Because z must land in P,
A, or B, any cell that sees **all three** of P, A, B cannot contain z.

Differs from XYWing: the pivot has 3 candidates (not 2), so eliminations are
restricted to cells seeing the pivot as well as both pincers.

### Implementation

**File:** `web/src/engine/rules/xyzWing.ts`

```
name:        'XYZWing'
priority:    19
triggers:    {GLOBAL}
unitKinds:   {} (empty — global scan)
```

**`apply(ctx)`**:
1. Collect all trivalue cells as potential pivots P = {x, y, z} (x < y < z).
2. Collect all bivalue cells.
3. For each pivot P and each permutation of roles (x, y, z):
   - Find pincers A = {x, z} and B = {y, z} that both see P.
   - For each such (P, A, B): collect cells — other than P, A, B — that see
     all three and still have z as a candidate. These are the eliminations.
4. Deduplicate eliminations before returning.

**`asHints(ctx, eliminations)`**: explain which pivot and pincers form the
wing, which digit is eliminated, and from which cells.

**Test file:** `web/src/engine/rules/xyzWing.test.ts`  
Construct a board where a trivalue pivot and two bivalue pincers form an
XYZWing; assert that `apply()` returns the expected elimination and
`asHints()` returns at least one hint with a non-empty explanation.

---

## Part 3 — W-Wing rule

### Technique

Two bivalue cells A = {p, q} and B = {p, q} share the same two candidates but
do not see each other. A **strong link** on p exists in some unit U: p has
exactly two candidate cells X and Y in U. If A sees X and B sees Y (or A sees
Y and B sees X), then either A = q or B = q must hold — so q can be eliminated
from any cell that sees **both** A and B.

### Implementation

**File:** `web/src/engine/rules/wWing.ts`

```
name:        'WWing'
priority:    20
triggers:    {COUNT_HIT_TWO}
unitKinds:   {ROW, COL, BOX}
```

Using `COUNT_HIT_TWO` is more specific than `GLOBAL`: the rule fires only when
a digit's count in a ROW/COL/BOX unit drops to exactly 2 — i.e., when a new
strong link is created — rather than on every board change.

**`apply(ctx)`**:
1. `p = ctx.hintDigit` (digit whose count just hit 2 in `ctx.unit`).
2. Find cells X, Y in `ctx.unit.cells` that have p as a candidate (the strong link).
3. For each other digit q (1–9, q ≠ p):
   - Find all bivalue cells anywhere on the board with candidates {p, q}.
   - For each ordered pair (A, B) of such cells where A does not see B:
     - If (A sees X and B sees Y) or (A sees Y and B sees X):
       - Collect cells — other than A and B — that see both A and B and still
         have q as a candidate. These are the eliminations.
4. Deduplicate and return.

**`asHints(ctx, eliminations)`**: name the strong-link unit, which digit p, the
two strong-link cells X/Y, the two bivalue cells A/B, and the eliminated digit q.

**Test file:** `web/src/engine/rules/wWing.test.ts`  
Construct a board where two {p,q} bivalue cells are connected via a strong link;
assert correct elimination from `apply()` and non-empty hint from `asHints()`.

---

## File summary

| Action | File |
|---|---|
| Modify | `web/src/main.ts` (2 call sites — auto-confirm + manual confirm) |
| Create | `web/src/engine/rules/xyzWing.ts` |
| Create | `web/src/engine/rules/xyzWing.test.ts` |
| Create | `web/src/engine/rules/wWing.ts` |
| Create | `web/src/engine/rules/wWing.test.ts` |
| Modify | `web/src/engine/rules/index.ts` (register both rules) |

---

## Out of scope

- Changing `solve()` — backtracking stays as the fallback; we are only filling
  the hint gap.
- UI changes to the hint display — both new rules use the existing hint modal.
- Forcing-chain / AIC techniques — scope for a future iteration.
