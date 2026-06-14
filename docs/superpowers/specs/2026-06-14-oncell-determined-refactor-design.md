# `_onCellDetermined` Refactor — Design Spec

## Background

`KillerSolverEngine._onCellDetermined` (solverEngine.ts:415-433) is called from
`_routeEvents` whenever a cell's candidate set drops to a single value. It
currently:

1. Calls `linearSystem.substituteCell(cell, val)`, which consumes the cell's
   entries in `_pairsByCell`/`_sumPairsByCell` (delta pairs and sum pairs) and
   directly computes "force the partner cell to one digit" eliminations.
2. Calls `linearSystem.substituteLiveRows(cell, val)`, which performs live
   Gaussian-elimination substitution on `_liveRows`/`_liveRhs`/`_liveByCell`
   and returns new `[cells, total, distinct]` constraints. For each:
   - single-cell constraints force a placement directly
   - multi-cell `distinct` constraints run `filterSumConstraint` (backtracking
     over `solSums`)
   - multi-cell non-distinct constraints run `filterSumRange`

All of these eliminations are applied via `applyEliminations` directly from
`_onCellDetermined`, **outside the main `solve()` loop**. This bypasses:

- the `onViolation` golden-solution check (lines 332-378 of `solve()`)
- per-rule attribution (`appliedMutations` records no rule name for these)
- the user-facing rule-toggle / hint-visibility mechanism

This conflates two distinct responsibilities: (a) keeping `LinearSystem`'s
internal state (pairs, live rows) consistent as cells get determined, and (b)
computing and applying board eliminations. (b) should go through the normal
rule queue.

## Goals

- `_onCellDetermined` becomes (almost) pure bookkeeping: it updates
  `LinearSystem`'s internal state for the determined cell, but does not
  directly apply eliminations to the board.
- Eliminations previously computed inline are instead produced by existing
  rules (`DeltaConstraint`, `SumPairConstraint`) or a new small rule
  (`DerivedVirtualCage`), via the normal queue — golden-checked, attributed,
  and subject to user rule-toggles.
- Add an eager golden-validity check on `substituteLiveRows`'s single-cell
  forced-value outputs, as defense-in-depth, at the point they're computed.
- Non-distinct multi-cell constraints (`filterSumRange` case) are dropped —
  no rule currently consumes non-distinct cages, and per the
  human-plausibility principle guiding the parallel linear-system-derive
  simplification work, this is an acceptable bounded loss of automatic
  deductions (never a soundness issue).

## Design

### 1. Remove `substituteCell` entirely

The delta/sum pairs in `_pairsByCell`/`_sumPairsByCell` represent permanent
algebraic relations (`p − q = δ`, `a + b = T`) that remain true for the whole
puzzle — there is nothing to "consume" when one side becomes determined.

`DeltaConstraint` and `SumPairConstraint` both trigger on `Trigger.COUNT_DECREASED`
for the determined cell's units. `removeCandidate` emits `COUNT_DECREASED` for
every unit containing the cell *before* it emits `CELL_DETERMINED` (boardState.ts:140-164),
so by the time `_routeEvents` processes the `CELL_DETERMINED` event and calls
`_onCellDetermined`, the `COUNT_DECREASED`-triggered queue items for
`DeltaConstraint`/`SumPairConstraint` have already been enqueued for the
cell's units.

When those queue items run, `board.cands(determinedCell)` has size 1, so
`pairsForCell`/`sumPairsForCell` (if the pair entries are still present)
yield exactly the "force partner to one digit" eliminations that
`substituteCell` used to compute manually — now golden-checked and
attributed to `DeltaConstraint`/`SumPairConstraint`.

**Changes:**
- Delete `LinearSystem.substituteCell` (linearSystem.ts:250-291) and its
  call site (solverEngine.ts:417-418).
- Delete the corresponding spy-based test in `solverEngine.test.ts`
  (the "delegates to LinearSystem.substituteCell" assertion).
- Update `SumPairConstraint`'s stale comment/guard description
  ("CELL_DETERMINED is handled by LinearSystem.substituteCell") to explain
  that `COUNT_DECREASED` on the cell's units now covers this case — the
  `ctx.hint === Trigger.CELL_DETERMINED` guard itself stays (the
  `CELL_DETERMINED`-triggered queue item for the same cell would be
  redundant with the `COUNT_DECREASED`-triggered ones).

`_pairsByCell`/`_sumPairsByCell`/`deltaPairs`/`sumPairs` are otherwise
untouched — once both cells of a pair are determined, `_elimsForPair` and the
sum-pair loop become harmless no-ops (single-candidate sets only).

### 2. `substituteLiveRows` stays — bookkeeping only

`_onCellDetermined` still calls `linearSystem.substituteLiveRows(cell, val)`
unconditionally — the live-row reduction (`_liveRows`/`_liveRhs`/`_liveByCell`)
is genuine state required for correctness of *future* substitutions.

Its return value (`Array<readonly [readonly Cell[], number, boolean]>`) is
processed as follows, for each `[cells, total, distinct]`:

- **`distinct === false`**: dropped entirely. No rule consumes non-distinct
  cages (`CageCandidateFilter`, `SolutionMapFilter`, `hiddenSingle`,
  `peerEliminations` etc. all skip `!unit.distinctDigits`), and deriving a
  consumer for this case is out of scope.

- **`distinct === true`** (covers both the single-cell case,
  `cells.length === 1`, and multi-cell burb/derived constraints):
  1. **Eager golden-check** (single-cell case only): if
     `cells.length === 1` and `this._goldenSolution !== null` and
     `total !== this._goldenSolution[r][c]`, report immediately via
     `_onViolation(...)` (or throw `NoSolnError` if `_onViolation` is null,
     matching the existing pattern in `solve()`) — before queuing anything.
     This catches a corrupted derivation at its earliest possible point.
  2. **Dedup against existing units**: compute the cell-set key for `cells`
     (sorted `cellKey` list, same scheme as `substituteLiveRows`'s internal
     `vkey`/`seen`) and compare against the cell-set of every
     `board.units[*]`. If a unit already covers exactly this cell-set, skip —
     it's already represented (as a real cage or a previously-added virtual
     cage).
  3. Otherwise, push `{ cells, total }` onto `linearSystem.pendingVirtualCages`
     (a new public mutable array field on `LinearSystem`, typed as
     `VirtualCageAddition[]` from `types.ts`, initialized to `[]`).

### 2a. Visibility: expose a golden-check helper to subclasses

`_goldenSolution` and `_onViolation` are currently `private` on `SolverEngine`
(solverEngine.ts:188-189), but the eager check in §2 runs in
`KillerSolverEngine._onCellDetermined` (a subclass). Add a `protected` helper
on `SolverEngine`:

```ts
/** Reports (or throws, if no onViolation handler) when a forced/eliminated
 *  digit at (r, c) contradicts the golden solution. No-op if there is no
 *  golden solution or the digit matches it. */
protected _checkAgainstGolden(ruleName: string, cell: Cell, digit: number): void {
  if (this._goldenSolution === null) return;
  const gold = this._goldenSolution[cell[0]]?.[cell[1]];
  if (gold === undefined || digit === gold) return;
  if (this._onViolation !== null) {
    this._onViolation(ruleName, [{ cell, digit: gold }]);
  } else {
    throw new NoSolnError(
      `${ruleName}: derived value ${digit} for r${cell[0] + 1}c${cell[1] + 1} contradicts golden solution ${gold}`,
    );
  }
}
```

`_onCellDetermined` calls `this._checkAgainstGolden('DerivedVirtualCage', cell, total)`
for each single-cell `distinct === true` constraint, before the dedup/push
step in §2.3.

### 3. New rule: `DerivedVirtualCage`

New file `web/src/engine/rules/derivedVirtualCage.ts`:

```ts
export class DerivedVirtualCage extends KillerOnlyRule {
  readonly name = 'DerivedVirtualCage';
  readonly displayName = 'Derived Virtual Cage';
  readonly description = `...`; // proof: pendingVirtualCages entries are
    // linear combinations of existing equations (produced by
    // LinearSystem.substituteLiveRows's live-row reduction), so any valid
    // solution satisfies them — adding them as cages is sound.
  readonly priority = 1;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  applyKiller(ctx: KillerRuleContext): RuleResult {
    const pending = ctx.board.linearSystem.pendingVirtualCages;
    if (pending.length === 0) return emptyResult();
    return { ...emptyResult(), virtualCageAdditions: [pending[0]!] };
  }

  asHintsKiller(_ctx: KillerRuleContext, _eliminations: readonly Elimination[]): HintResult[] {
    const pending = _ctx.board.linearSystem.pendingVirtualCages;
    return pending.map(({ cells, total }) => {
      const cellLabels = cells.map(cell => cellLabel(cell)).join(' + ');
      return {
        ruleName: this.name,
        displayName: `Virtual cage: ${cells.length} cells = ${total}`,
        explanation: `The cage-sum equations imply ${cellLabels} = ${total}. Adding this as a virtual cage will help narrow candidates.`,
        highlightCells: cells,
        eliminations: [],
        placement: null,
        virtualCageSuggestion: [cells, total],
      };
    });
  }
}
```

- Pure: only reads `pendingVirtualCages`, never mutates it.
- `applyKiller` returns **at most one** `virtualCageAddition` per call —
  satisfies "only adds one virtual cage at a time." Because it's
  `GLOBAL`-triggered (re-run every pass), the next entry is picked up on a
  subsequent pass after `solve()` consumes the first.
- `asHintsKiller` surfaces **every** entry currently in `pendingVirtualCages`
  as a T3-style "add virtual cage" suggestion (same shape as
  `LinearElimination._t3VirtualCageHints`), independent of how many
  `applyKiller` has auto-applied so far — giving the user visibility into all
  pending derivations, not just the one about to be auto-applied.
- Registered in `web/src/engine/rules/index.ts` alongside the other killer
  rules.

### 4. `solve()` — actually apply `virtualCageAdditions`, golden-checked

Currently (solverEngine.ts:388-395), `result.virtualCageAdditions` is only
recorded into `appliedVirtualCages`/`appliedMutations`; nothing calls
`board.addVirtualCage`.

The golden-consistency check in `solve()` (lines 332-378) currently covers
only `result.eliminations`: it scans for eliminations that would remove the
golden digit from its cell and, if found, reports via `_onViolation`/throws
and suppresses the whole result. `virtualCageAdditions` get no such check —
this is the gap the user flagged. **There is no efficiency exemption for
"sound by construction" derivations: the consistency invariant is checked
after every rule application, with no exceptions.** Extend the same
golden-check pass to cover `virtualCageAdditions` alongside `eliminations`:

```ts
// Alongside the existing eliminations golden-check, before applying anything:
for (const vca of result.virtualCageAdditions) {
  if (this._goldenSolution !== null) {
    const goldSum = vca.cells.reduce(
      (sum, [r, c]) => sum + this._goldenSolution![r]![c]!, 0);
    if (goldSum !== vca.total) {
      // Same violation path as an offending elimination: report/throw and
      // suppress this rule's result entirely.
      if (this._onViolation !== null) {
        this._onViolation(item.rule.name, /* offending detail */ ...);
      } else {
        throw new NoSolnError(
          `${item.rule.name}: virtual cage ${vca.cells.map(cellLabel).join('+')} = ${vca.total} ` +
          `contradicts golden solution (sums to ${goldSum})`,
        );
      }
      continue; // suppress this rule's result, as for eliminations
    }
  }
}

// ... existing eliminations application ...

for (const vca of result.virtualCageAdditions) {
  this.board.addVirtualCage(vca.cells, vca.total, []);
  this.board.linearSystem.pendingVirtualCages.shift();

  // Seed COUNT_DECREASED/SOLUTION_PRUNED for the new unit, mirroring
  // _seedInitialState, so cage rules evaluate it within this pass.
  const newUnitId = this.board.units.length - 1;
  for (const trigger of [Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED]) {
    for (const rule of this._triggerMap.get(trigger) ?? []) {
      if (rule.unitKinds.size === 0 || rule.unitKinds.has(UnitKind.CAGE))
        this.queue.enqueueUnit(rule.priority, rule, this._ruleIndex.get(rule)!,
          newUnitId, -1, trigger, null);
    }
  }

  this.appliedVirtualCages.push(vca);
  this.appliedMutations.push({ ruleName: item.rule.name, type: 'virtual_cage_added',
    cells: vca.cells, total: vca.total });
}
```

Note: `linearSystem.pendingVirtualCages.shift()` removes the entry that
`DerivedVirtualCage` returned (always the front entry, by construction).

This makes the golden-check uniform: `eliminations` are checked against the
golden digit per-cell, `virtualCageAdditions` are checked by summing the
golden digits over `vca.cells` and comparing to `vca.total` — both are
instances of "does this rule's output remain consistent with the golden
solution," checked identically after every rule application, before
anything is applied to the board. The eager single-cell check in §2a
(`_checkAgainstGolden`, called from `_onCellDetermined` at the point
`substituteLiveRows`'s result is computed) remains as an *additional*,
earlier layer of defense-in-depth — it does not replace this check.

### 5. Cleanup — dead code removal

- `filterSumConstraint` (solverEngine.ts:87-126) and `filterSumRange`
  (solverEngine.ts:58-76): both become unused once `substituteLiveRows`
  results route through `DerivedVirtualCage` → `addVirtualCage` →
  `CageCandidateFilter`/`SolutionMapFilter` (distinct case) or are dropped
  (non-distinct case). Remove both functions and their now-stale doc comments.
- `LinearSystem.substituteCell` (linearSystem.ts:250-291): removed per §1.
- Verify via `find_referencing_symbols` that nothing else references
  `substituteCell`, `filterSumConstraint`, or `filterSumRange` before removal.

### 6. Extract `checkPuzzleInvariant`, then add Check 0 (killer-only) for user-added virtual cages

`addVirtualCage` (session/actions.ts:971) lets the user manually enter a
virtual cage (cells + total, optionally a diff cage via `negativeCells`),
recorded as an `addVirtualCage` turn via `PuzzleStateOps.addVirtualCage` →
`recordTurn`. If the user mistypes or misreads the total from the puzzle
image, the cage constraint contradicts `state.goldenSolution` from the
start — but today this surfaces only indirectly, several turns later, once
`CageCandidateFilter`/`SolutionMapFilter` eliminations on the bogus cage
cascade into a wrong placement or a bad candidate elimination (Checks 1-3
in `getHints()`, lines 1131-1152).

#### 6a. Extract the inconsistency-detection block into `checkPuzzleInvariant`

`getHints()`'s inconsistency-detection block (lines 1126-1152) is currently
inline: ~25 lines of `PuzzleState`-derived logic mixed into a session-layer
function, with no way for a future puzzle type (or a future invariant check)
to extend it without editing `getHints()` directly. Extract it into a
standalone, puzzle-state-derived function — following the existing
convention of `findLastConsistentTurnIdx` (engine.ts:564), which is a plain
exported function taking `PuzzleState` and branching internally on
`PuzzleState.isKiller()` (the pattern already used by `PuzzleState.availableRules`
etc. in types.ts, e.g. line 374).

New file location: `web/src/session/engine.ts`, alongside
`findLastConsistentTurnIdx`. New type and function:

```ts
export interface PuzzleInvariantViolation {
  readonly rewindTurnIdx: number | null;
  readonly missingCell: { r: number; c: number; gold: number } | null;
}

/**
 * Checks `state` against `state.goldenSolution` for any of the known
 * inconsistency patterns (wrong placement, wrong candidate elimination,
 * killer-only: wrong user-added virtual cage total). Returns the first
 * violation found, or null if the state is consistent. Puzzle-type-specific
 * checks (e.g. Check 0, killer-only) are gated internally via
 * `PuzzleState.isKiller`.
 */
export function checkPuzzleInvariant(state: PuzzleState): PuzzleInvariantViolation | null {
  const gs = state.goldenSolution;
  if (gs === null) return null;

  // Check 0 (killer-only): a user-added virtual cage's total contradicts
  // goldenSolution — catches the root cause directly, before it cascades
  // into Checks 1-3 below.
  if (PuzzleState.isKiller(state)) {
    const wrongCageIdx = findWrongVirtualCageTurnIdx(state);
    if (wrongCageIdx !== null) return { rewindTurnIdx: wrongCageIdx, missingCell: null };
  }

  // Check 1 & 3: wrong digit anywhere in userGrid
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const placed = state.userGrid[r]![c]!;
      const gold = gs[r]![c]!;
      if (placed !== 0 && gold !== 0 && placed !== gold) {
        return { rewindTurnIdx: findLastConsistentTurnIdx(state), missingCell: null };
      }
    }
  }

  // Check 2: correct golden candidate explicitly eliminated by user
  const missingCell = findMissingGoldenCandidate(state);
  if (missingCell !== null) {
    return {
      rewindTurnIdx: findFirstElimTurnIdx(state, missingCell.r, missingCell.c, missingCell.gold),
      missingCell,
    };
  }

  return null;
}
```

`findFirstElimTurnIdx` (currently a local function in actions.ts:1068) and
`findMissingGoldenCandidate` (currently local in actions.ts:1096) move to
engine.ts as plain exported functions — they're pure `PuzzleState`-derived
helpers with the same shape as `findLastConsistentTurnIdx`, just not
previously needed outside `getHints()`.

`getHints()` (actions.ts:1126-1152) becomes:

```ts
const violation = checkPuzzleInvariant(state);
let inconsistent = violation !== null;
let rewindTurnIdx = violation?.rewindTurnIdx ?? null;
let missingCell = violation?.missingCell ?? null;
```

Lines 1154-1199 (the `if (inconsistent)` block: missingCell alt-solution
check, Case A/B Rewind dispatch) are **unchanged** — they already consume
`inconsistent`/`rewindTurnIdx`/`missingCell` as plain values, independent of
how they were computed.

#### 6b. Check 0: user-added virtual cage golden-sum check

For each `vc` in `userVirtualCages(state)`, compute the golden sum:
- standard cage: `goldSum = Σ gs[r][c]` over `vc.cells`
- diff cage: `goldSum = Σ gs[r][c]` over `vc.cells \ vc.negativeCells`,
  minus `Σ gs[r][c]` over `vc.negativeCells`

If `goldSum !== vc.total` for any `vc`, the cage's user-entered total
contradicts the golden solution. New helper in engine.ts, alongside
`findLastConsistentTurnIdx`/`findFirstElimTurnIdx`/`findMissingGoldenCandidate`:

```ts
/**
 * Returns the turn index of the earliest addVirtualCage action whose cage
 * total contradicts goldenSolution, or null if all current virtual cages
 * are consistent.
 */
function findWrongVirtualCageTurnIdx(state: PuzzleState): number | null {
  const gs = state.goldenSolution;
  if (gs === null) return null;
  for (let i = 0; i < state.turns.length; i++) {
    const a = state.turns[i]!.action;
    if (a.type !== 'addVirtualCage') continue;
    const { cells, total, negativeCells } = a.cage;
    const negKeys = new Set((negativeCells ?? []).map(([r, c]) => `${r},${c}`));
    let goldSum = 0;
    for (const [r, c] of cells) {
      goldSum += negKeys.has(`${r},${c}`) ? -gs[r]![c]! : gs[r]![c]!;
    }
    if (goldSum !== total) return i;
  }
  return null;
}
```

`missingCell` stays `null` for Check 0, so the existing `if (inconsistent)`
block (lines 1154-1199) requires **no new branching**: it skips the
`missingCell !== null` branch, finds `rewindTurnIdx !== null` (always true —
an `addVirtualCage` action is always a recorded turn), and falls into the
existing Case A alt-solution check before offering `makeRewindHint(idx)` —
identical handling to Check 1. The existing generic "A mistake has been
detected. Rewinding will undo all moves back to the last correct state."
message is accurate for this case too; no new hint copy needed.

## Testing

- `solverEngine.test.ts`: remove/replace the `substituteCell` spy test;
  add a test that a `CELL_DETERMINED` event with an existing delta/sum pair
  produces the expected elimination via `DeltaConstraint`/`SumPairConstraint`
  (golden-checked, attributed).
- New `derivedVirtualCage.test.ts`: rule returns `emptyResult()` when
  `pendingVirtualCages` is empty; returns exactly one `virtualCageAddition`
  when non-empty, regardless of queue length.
- `solverEngine.test.ts`: test that `solve()` calls `addVirtualCage` and
  shifts `pendingVirtualCages` when a rule returns `virtualCageAdditions`,
  and that the new unit is evaluated within the same pass (e.g.
  `CageCandidateFilter` fires for it before `solve()` returns).
- `solverEngine.test.ts`: test the §4 golden-check — a `virtualCageAddition`
  whose `vca.cells` golden digits don't sum to `vca.total` triggers
  `_onViolation`/throws and is not passed to `addVirtualCage`, mirroring the
  existing `eliminations` golden-check test.
- `linearSystem.test.ts`: test the eager golden-check path — a
  `substituteLiveRows` single-cell result that contradicts
  `goldenSolution` triggers `_onViolation`/throws before any queuing.
- New `engine.test.ts` tests for §6a — `checkPuzzleInvariant`: returns `null`
  for a consistent state; returns the existing Checks 1-3 results unchanged
  for the corresponding fixtures (regression — same `rewindTurnIdx`/
  `missingCell` as before extraction, just via the new function); for a
  classic (non-killer) state, Check 0 is skipped entirely (no
  `findWrongVirtualCageTurnIdx` call/effect).
- New `engine.test.ts` tests for §6b — `findWrongVirtualCageTurnIdx`: returns
  `null` when all virtual cages are consistent, and the correct turn index
  for the earliest inconsistent one (including the diff-cage case).
- `actions.test.ts`: new test for §6 — `addVirtualCage` with a total that
  doesn't match the golden-solution sum over its cells, followed by
  `getHints()`, returns a `Rewind` hint (`rewindToTurnIdx` equal to that
  turn's index).
- Existing fixture-based regression tests (`__fixtures__/index.ts`) should
  continue to pass — this refactor should not change *which* eliminations are
  ultimately produced for `distinct === true` derivations (just *how*/*where*
  they're produced and checked); only the dropped `distinct === false` case
  changes observable behavior (fewer automatic eliminations in that rare
  case).

## Out of scope

- The stale `SolutionMapFilter-r2-2026-05-29T07-06-49-234Z` fixture and the
  `docs/silver-gate-background-hygiene` merge remain separate, pre-existing
  pending items not addressed by this spec.
- The parallel `_deriveNonburbVirtualCages`/`_reduceDerive` simplification
  (linear-system-derive-simplification spec) is independent of this work —
  both touch `LinearSystem` but in different methods (`_deriveNonburbVirtualCages`
  vs `substituteCell`/`substituteLiveRows`).
