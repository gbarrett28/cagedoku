# Solver Rules

Each rule is listed with its logical specification and the hint text it produces.
This table is populated as rules are designed and their hints implemented.

Every rule can be toggled between always-apply and hint-only. When always-apply,
the rule fires automatically on every board change. When hint-only, it surfaces
as a hint for the player to act on. Either way, every rule must have a hint.

---

## CageCandidateFilter

**Spec:**
For each cage, the candidates of every cell in that cage must be a subset of
the union of the cage's remaining solutions. Any candidate digit that does not
appear in any valid solution for the cage is impossible and is eliminated.

Example: a 3-cell cage has only the solution {6, 8, 9}. Every cell in that cage
must have candidates drawn from {6, 8, 9}; digits 1–5 and 7 are eliminated from
all three cells.

**Hint template:**
> Cell *X* is in cage [*cells*] (total *T*). Digit *D* does not appear in any
> valid solution for this cage, so it cannot be placed there. Eliminating *D*
> from *X*.

---

## MustContainOutie

**Spec:**
A cage must contain certain digits in every one of its solutions (its
"must-contain" set). When all but one cell of the cage lie inside a single
row, column, or box (the "inside cells"), and exactly one external cell in
that unit has all its candidates within the cage's must-contain set, then
whichever digit the external cell holds is blocked from every inside cell by
unit-uniqueness. The cage still needs that digit, so it must land on the one
cage cell that is outside the unit (the "outie"). The outie's candidates are
therefore restricted to the candidates of the external cell.

Example: cage {r1c6, r1c7, r1c8, r2c8} must contain {6, 7, 8, 9}. Cells
r1c6, r1c7, r1c8 are all in row 1; r2c8 is the outie. Cell r1c3 (outside the
cage, also in row 1) has candidates {6, 8, 9} — all within {6, 7, 8, 9}.
Whichever of {6, 8, 9} r1c3 holds, row uniqueness blocks it from r1c6, r1c7,
r1c8. The cage must therefore place that digit at r2c8. So r2c8's candidates
are restricted to {6, 8, 9}, eliminating 7.

**Hint template:**
> Cage [*cells*] must contain {*must*}. Cell *X* has candidates {*x_cands*} —
> all digits are in the cage's must-contain set. Since *X* is in *unit* along
> with cage cells *inside_cells*, whichever digit *X* holds is blocked from
> those cells by *unit* uniqueness. The cage must therefore place that digit at
> the outie *outie* (the only cage cell outside *unit*). So *outie*'s
> candidates are restricted to {*x_cands*}, eliminating *removed*.

---

## CageConfinement(n)

**Spec:**

Let n ≥ 1.  Find n distinct cages C₁, …, Cₙ and n distinct units U₁, …, Uₙ
of the same type (all rows, all columns, or all boxes) such that for some digit d:

1. d is essential (must-contain) for every cage Cᵢ.
2. Every cell in ⋃ Cᵢ that still has d as a candidate lies within ⋃ Uⱼ.
3. At least one cell in (⋃ Uⱼ) \ (⋃ Cᵢ) has d as a candidate
   (otherwise there is nothing to eliminate).

Then d can be eliminated from every cell in (⋃ Uⱼ) \ (⋃ Cᵢ).

**Reasoning:**  Since U₁, …, Uₙ are distinct units of the same type they are
pairwise disjoint.  Each unit must contain exactly one copy of d, so ⋃ Uⱼ
contains exactly n copies of d.  Each cage Cᵢ must contain one copy of d
(condition 1), and every possible placement for that copy is inside ⋃ Uⱼ
(condition 2).  By pigeonhole the n cages consume all n available copies of d
in the n units; no cell outside the cages but inside the units can hold d.

**n = 1 example:**  After MustContainOutie restricts r2c8 to {6, 8, 9}, digit 7
has candidates only at r1c6, r1c7, r1c8 within cage r1c6 — all in row 1.
Since 7 is essential to that cage and all its placements are in row 1, 7 is
eliminated from every other cell in row 1 outside the cage.

**n = 2 example:**  Digits {6, 8, 9} are essential to both cage r1c3 and cage
r1c6; all cells of both cages lie in rows 1 and 2.  Rows 1 and 2 jointly
contain exactly two copies of each of {6, 8, 9}, and both cages need one copy
each.  Therefore {6, 8, 9} are eliminated from rows 1 and 2 outside these two
cages.

**Complexity:**  For a fixed digit and unit type the search is O(Cₙ × Uₙ)
where Cₙ = C(|cages|, n) and Uₙ = C(27, n) (9 rows + 9 cols + 9 boxes).
n = 1 is cheap; n = 2 is tractable; n ≥ 3 is expensive and hard for humans to
follow — the implementation should therefore expose n as a configuration
parameter and default to n ≤ 2.

**Hint template (n = 1):**
> Digit *d* is essential to cage [*cells*] and can only be placed in *unit*
> cells of that cage (*confined_cells*).  Since *unit* must contain exactly
> one *d*, it must land in the cage.  Eliminating *d* from *removed_cells*.

**Hint template (n = 2):**
> Digit *d* is essential to cages [*C₁_cells*] and [*C₂_cells*].  Every
> possible placement of *d* in either cage lies within *unit₁* or *unit₂*.
> Those two *unit_type*s contain exactly two copies of *d*, both of which are
> claimed by these cages.  Eliminating *d* from *removed_cells* in
> *unit₁* and *unit₂*.
