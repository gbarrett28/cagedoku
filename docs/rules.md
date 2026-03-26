# Solver Rules

Each rule is listed with its logical specification and the hint text it produces.
This table is populated as rules are designed and their hints implemented.

Rules marked **always-apply** run automatically on every board change.
Rules marked **hint-only** are never applied automatically; they surface as hints for the player to act on.

---

## CageCandidateFilter

**Status:** always-apply (planned — currently applied only as a display-time filter)

**Spec:**
For each cage, the candidates of every cell in that cage must be a subset of
the union of the cage's remaining solutions. Any candidate digit that does not
appear in any valid solution for the cage is impossible and is eliminated.

Example: a 3-cell cage has only the solution {6, 8, 9}. Every cell in that cage
must therefore have candidates drawn from {6, 8, 9}; digits 1–5 and 7 are
eliminated from all three cells.

**Hint:** *(not yet implemented — this rule is always-apply and produces no hint)*

---

## MustContainOutie

**Status:** hint-only

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
