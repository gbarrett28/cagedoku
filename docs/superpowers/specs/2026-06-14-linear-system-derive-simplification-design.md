# LinearSystem virtual-cage derivation simplification

## Context

`LinearSystem._deriveNonburbVirtualCages` derives additional ("virtual") cages
beyond the puzzle's real cages by combining row/column/box/cage sum equations
(e.g. "this row sums to 45, this cage inside it sums to 14, so the remaining 6
cells sum to 31"). Internally it represents each candidate group as a
`DeriveEq { cells: Set<string>; total: number; solns: number[][] }` and calls
`_reduceDerive` to repeatedly subtract one equation's cell-set from another
when it is a subset, producing smaller derived groups.

`_reduceDerive` also tracks `solns` (lists of possible digit-sets) alongside
each equation, recombining them via a cross-product-like filter on every
reduction step. A property-based fuzzer
(`web/scripts/fuzz-cage-rules.ts`, built while debugging why
`CageCandidateFilter`/`SolutionMapFilter` sometimes eliminate digits matching
the golden solution) found that for cage layouts with cages larger than 2
cells, this `solns` cross-product multiplies across reduction passes and grows
without bound (OOM).

## Goal

Eliminate the `solns`-tracking blow-up by restricting the derivation to
single-step "group minus contained sub-group" arithmetic — the kind of
deduction a human solver does with pencil and paper — and computing each final
group's solution set once, directly, rather than via iterative cross-cage
combination tracking.

It is acceptable for the new algorithm to derive a smaller set of virtual
cages than today, dropping cases that only existed due to multi-cage joint
solution-combination narrowing (not a pencil-and-paper technique).

## Design

### `DeriveEq` shape change

```ts
interface DeriveEq {
  cells: Set<string>;
  total: number;
}
```

The `solns: number[][]` field is removed entirely.

### `_reduceDerive`

Unchanged in structure (subset-based fixpoint reduction over `cells`/`total`):

```ts
if (ei.cells.isSubsetOf(ej.cells)) {
  ej.cells = ej.cells.difference(ei.cells);
  ej.total -= ei.total;
  reduced = true;
}
```

All `solns`-manipulation code (the `eiSets`/`newSolns` block) is deleted.

### Setup (`_deriveNonburbVirtualCages`)

All `solSums(...)` calls used to seed/derive `eqs[i].solns` are removed:

- `nineSolns`/`cloneSolns()` for the 27 row/col/box base equations — deleted.
- `solSums(cells.length, 0, total)` in the cage-equation seeding — deleted.
- `solSums(cells.length, 0, sm)` inside `pushDerived` — deleted; `pushDerived`
  pushes `eqs.push({ cells: fcvr, total: sm })` and
  `virtualCages.push({ cells, total: sm, distinct: true, precomputedSolns: null })`
  (was already `null`, unchanged).
- The loop at lines 481–490 that seeds `eqs` from `this.virtualCages` — drops
  the `solns: solSums(...)` field, keeping only `{ cells: fc, total: vtotal }`.

### Final emission (replaces current lines 492–511)

For each surviving `eq` with `eq.cells.size > 0`:

1. `cells = [...eq.cells].map(keyToCell)`, `distinct = isBurb(cells)`.
2. If `distinct`:
   `virtualCages.push({ cells, total: eq.total, distinct: true, precomputedSolns: null })`.
3. If not `distinct`:
   - Compute `solns = solSums(cells.length, 0, eq.total)` once
     (`cells.length <= 9` always, so this is a single cheap combinatorial
     call).
   - If `solns.length === 0`, skip (infeasible derivation).
   - Compute `must = solns.reduce(...)` (intersection across all `solns`
     entries) as today.
   - If `must` is empty, skip.
   - Else `virtualCages.push({ cells, total: eq.total, distinct: false, precomputedSolns: null })`.

`precomputedSolns: null` means `KillerBoardState`'s constructor computes
`solSums(cells.length, 0, total)` itself when building `cageSolns` for this
virtual cage — identical to the value this design would otherwise precompute,
so no information is lost relative to what's stored. (The *difference* from
today is that this value is no longer narrowed by cross-equation
joint-combination filtering — see Safety tradeoff below.)

The `seen`/`seenSw` dedup-by-cell-set-key logic is preserved unchanged.

## Safety tradeoff

Today's `precomputedSolns` for derived cages are narrowed by iterative
cross-equation combination filtering — e.g. "given the 3-cell cage inside this
row can only be {1,2,4}, {1,3,4} or {2,3,5}, the remaining 6 cells can only be
one of these 3 complementary sets" rather than "any 6-digit subset of 1-9
summing to 31". The new design always uses the latter (unnarrowed) form.

This is a **superset** of the previously-narrowed solution set, so:

- It cannot cause a *new* incorrect elimination — `CageCandidateFilter` /
  `SolutionMapFilter` can only eliminate digits absent from the (now larger)
  union of possible solutions, which is strictly more permissive.
- It may derive fewer virtual cages overall (the `must`-digit check for
  non-distinct groups is less likely to find a common digit across an
  unnarrowed solution set), and any virtual cages that *are* derived may give
  the solver slightly less pruning power than before.

Both effects move in the direction of fewer/weaker eliminations, which is the
correct direction for fixing golden-solution violations.

## Testing / verification

1. Existing unit tests in `web/src/engine/linearSystem.test.ts` and any tests
   in `boardState.test.ts` / rule tests that assert specific derived
   `virtualCages` (count, cells, or `precomputedSolns` values) are expected to
   need updates — per the project's Test Specification Integrity rule, any
   such changes will be reviewed individually: confirmed as an intended
   consequence of this design (not papered over), with the test updated to
   reflect the new, smaller/unnarrowed derivation.
2. Run the full bronze gate (`tsc` x2 + `npm test`) to confirm no regressions
   beyond the expected, reviewed test updates.
3. Re-run `web/scripts/fuzz-cage-rules.ts` with `MAX_CAGE_SIZE` raised (e.g. to
   4 or 5) to confirm:
   - No OOM / unbounded growth for larger cages.
   - Whether `CageCandidateFilter`/`SolutionMapFilter` golden-solution
     violations persist, are reduced, or disappear — informing the next step
     of the root-cause investigation.

## Out of scope

- Re-enabling `CageCandidateFilter`/`SolutionMapFilter` in
  `disabled-rules.ts` (depends on fuzzer results after this change).
- Any change to `_addEqunsLine`/`_addEqunsBox` coverage-window logic, or to
  the main constructor RREF (rows/cols/boxes/cages, delta pairs, sum pairs) —
  unaffected by this design.
- A general Frac-based RREF over the derived-equation set (Option C,
  rejected): not needed since the existing subset-based reduction already
  performs the relevant pencil-and-paper subtraction step once `solns`
  tracking is removed.
