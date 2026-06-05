# OO engine refactor: rules + UserAction

Goal: apply the namespace-merging pattern to close the two remaining
discriminated-union gaps in the engine and session layer.

## Deliverable

- `SolverRule` interface gains `killerOnly: boolean` — all 28 rule classes
  declare it; `CLASSIC_EXCLUDED_RULES` deleted
- `sync-rule-fixtures.js` derives `RULE_NAMES` from `defaultRules()` via
  vite-node; no hardcoded list
- `UserAction` variants become named interfaces with namespace static methods;
  `applyAction`, `userRemoved`, `userVirtualCages`, `rebuildUserGrid` replaced
  by `UserAction.apply`, `UserAction.updateRemovedList`, `UserAction.applyToGrid`;
  `assertNeverAction` enforces exhaustiveness

## Why these three together

All three address the same class of bug — external metadata that can drift from
the type it describes — and all three touch the same files (engine, session, rules).
Doing them in one branch keeps the diff coherent.

---

## Sprint 1 — `killerOnly` on `SolverRule` + sync script fix

### Steps

- [ ] 1. Add `readonly killerOnly: boolean` to `SolverRule` interface (`web/src/engine/rule.ts`)
- [ ] 2. Add `readonly killerOnly = false` to every non-killer rule class (NakedSingle,
         HiddenSingle, NakedPair, HiddenPair, NakedHiddenTriple, NakedHiddenQuad,
         PointingPairs, LockedCandidates, XWing, Swordfish, Jellyfish, XYWing,
         UniqueRectangle, SimpleColouring, XYZWing, WWing, Skyscraper, TwoStringKite)
- [ ] 3. Add `readonly killerOnly = true` to every killer-only rule class
         (CageCandidateFilter, CageIntersection, SolutionMapFilter, MustContain,
         MustContainOutie, DeltaConstraint, SumPairConstraint, CageConfinement,
         UnitPartitionFilter, LinearElimination)
- [ ] 4. Replace `CLASSIC_EXCLUDED_RULES` filter in `web/src/session/engine.ts`
         with `r => !r.killerOnly`
- [ ] 5. Replace `CLASSIC_EXCLUDED_RULES` filter in `web/src/session/actions.ts`
         (hintableRules computation) with `r => !r.killerOnly`
- [ ] 6. Delete `CLASSIC_EXCLUDED_RULES` from `web/src/engine/rules/disabled-rules.ts`
- [ ] 7. Rewrite `web/scripts/sync-rule-fixtures.js` as `sync-rule-fixtures.ts`,
         run via `npx vite-node`:
         — derive `RULE_NAMES` from `defaultRules().map(r => r.name)`
         — use `fixtureToTypeScript()` from shared
         — keep the regex-based disabled-rules update from Sprint 2
- [ ] 8. Update any CI / package.json scripts that call the old `.js` script
- [ ] 9. Bronze gate

---

## Sprint 2 — `UserAction` namespace refactor

### Design

Each variant becomes a named interface + namespace. The union-level
`UserAction` namespace provides dispatchers with `assertNeverAction`:

```typescript
// session/types.ts (or session/actions/index.ts if extracted)

export interface PlaceDigitAction {
  readonly type: 'placeDigit';
  readonly row: number; readonly col: number; readonly digit: number;
  readonly source: 'given' | 'user';
}
export namespace PlaceDigitAction {
  export function apply(a: PlaceDigitAction, state: PuzzleState): PuzzleState { ... }
  export function applyToGrid(a: PlaceDigitAction, grid: number[][]): void { grid[a.row]![a.col] = a.digit; }
  export function updateRemovedList(_a: PlaceDigitAction, _list: RemovedList): void { /* no-op */ }
}
// ... one block per variant ...

export type UserAction =
  | PlaceDigitAction | RemoveDigitAction | EliminateCandidateAction
  | RestoreCandidateAction | ResetCellCandidatesAction
  | AddVirtualCageAction | RemoveVirtualCageAction | ApplyHintAction;

export namespace UserAction {
  export function apply(action: UserAction, state: PuzzleState): PuzzleState {
    switch (action.type) { ... default: assertNeverAction(action); }
  }
  export function applyToGrid(action: UserAction, grid: number[][]): void { ... }
  export function updateRemovedList(action: UserAction, list: RemovedList): void { ... }
  export function applyToCages(action: UserAction, cages: Map<string, VirtualCage>): void { ... }
}

type RemovedList = [number, number, number][];
function assertNeverAction(action: never): never {
  throw new Error(`Unhandled action type: ${(action as UserAction).type}`);
}
```

### Steps

- [ ] 10. Define named variant interfaces + namespaces in `web/src/session/types.ts`
          — PlaceDigitAction, RemoveDigitAction, EliminateCandidateAction,
            RestoreCandidateAction, ResetCellCandidatesAction,
            AddVirtualCageAction, RemoveVirtualCageAction, ApplyHintAction
          — each namespace: apply(), applyToGrid(), updateRemovedList(), applyToCages()
          — UserAction union + UserAction namespace with all four dispatchers
          — assertNeverAction() exhaustiveness guard
- [ ] 11. Replace `applyAction()` in `engine.ts` with `UserAction.apply(action, state)`
- [ ] 12. Replace `userRemoved()` loop in `engine.ts` with `UserAction.updateRemovedList()`
- [ ] 13. Replace `userVirtualCages()` loop in `engine.ts` with `UserAction.applyToCages()`
- [ ] 14. Replace `rebuildUserGrid()` loop in `engine.ts` with `UserAction.applyToGrid()`
- [ ] 15. Update any remaining ad-hoc `action.type ===` guards in `actions.ts` and
          `main.ts` that are checking specific variants — keep as type narrowing
          (these are not dispatch, they are guarded reads of specific fields)
- [ ] 16. Bronze gate
- [ ] 17. Silver gate + push
