# Cage-Free BoardState — Sprint B: Widen Rule/Engine/Backtracker/Actions Contracts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution — see CLAUDE.md "Token Efficiency") to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every generic collaborator that currently assumes "the board has cages" a structurally-correct contract: killer-only rules narrow once via a shared `KillerOnlyRule` base class, `SolverEngine` gains a virtual `_onCellDetermined` hook so `KillerSolverEngine` can own linear-system propagation, and `candidatesFromBoard` asks `board instanceof KillerBoardState` instead of `state.puzzleType === 'classic'`.

**Architecture:** Four ordered moves, each independently testable and committed: (1) add `KillerRuleContext`/`KillerOnlyRule` to `rule.ts` — the one place the `instanceof KillerBoardState` narrow lives for all ten killer-only rules; (2) migrate all ten rules from `implements SolverRule` (against `RuleContext`) to `extends KillerOnlyRule` (against `KillerRuleContext`, with `applyKiller`/`asHintsKiller`); (3) add `KillerSolverEngine`/`SolverEngineOptions` to `solverEngine.ts`, replacing the `_linearSystemActive` flag with a virtual `_onCellDetermined` hook, and update `buildEngine` to construct `KillerSolverEngine` (board is still always `KillerBoardState` here — Sprint C flips that); (4) widen `candidatesFromBoard`'s `board` parameter to accept the cage-free `BoardState` and replace its `state.puzzleType === 'classic'` proxy test with the structural `board instanceof KillerBoardState` narrow.

**Tech Stack:** TypeScript, Vitest, serena MCP tools (mandatory for all `.ts` edits per CLAUDE.md).

---

## Before you start

This sprint assumes Sprint A (`docs/superpowers/plans/2026-06-07-cage-free-board-state-sprint-a-extract-superclass.md`) is complete and merged: `BoardState` is now the cage-free 27-unit superclass, `KillerBoardState extends BoardState` carries `spec`/`regions`/`cageSolns`/`linearSystem`, and `engine/index.ts` re-exports both names. Every consumer this sprint touches (`rule.ts`, the ten killer-only rules, `solverEngine.ts`, `session/engine.ts`, `session/actions.ts`) currently references `KillerBoardState` post-rename — that is correct and, for most of them, stays that way. This sprint widens **only** the four contracts named in the title.

Read `docs/superpowers/specs/2026-06-07-cage-free-board-state-for-classic.md` §2.1, §2.2, and §2.4 — they define the target shapes this sprint builds. §2.3 (`mrvBacktrack`) was Sprint A's job; §2.5 (`PuzzleState.isKiller`) and the construction flip are Sprint C's.

All commands below run from `C:\Users\geoff\PycharmProjects\killer_sudoku\web` unless stated otherwise. Use the **Bash** tool (not PowerShell) per the user's standing preference. Use **serena** MCP tools for all `.ts` reads/edits per CLAUDE.md's Agent Protocol.

---

### Task 1: `KillerRuleContext` + `KillerOnlyRule` base class in `rule.ts`

**Files:**
- Modify: `web/src/engine/rule.ts`
- Create: `web/src/engine/killerOnlyRule.test.ts`

This is the one place the `instanceof KillerBoardState` narrow lives for all ten killer-only rules — see spec §2.1.

- [ ] **Step 1: Add the `KillerRuleContext` interface and `KillerOnlyRule` abstract class**

Open `web/src/engine/rule.ts`. First widen its imports — `KillerOnlyRule.apply`/`asHints` need `KillerBoardState` (for the `instanceof` check) and `emptyResult` (for the non-killer short-circuit). Change line 11 and the existing `types.js` import (line 13):

```typescript
import type { BoardState } from './boardState.js';
import type { HintResult } from './hint.js';
import type { Cell, Elimination, RuleResult, Trigger, Unit, UnitKind } from './types.js';
```
→
```typescript
import { KillerBoardState } from './boardState.js';
import type { BoardState } from './boardState.js';
import type { HintResult } from './hint.js';
import { emptyResult } from './types.js';
import type { Cell, Elimination, RuleResult, Trigger, Unit, UnitKind } from './types.js';
```

(`KillerBoardState` and `emptyResult` are imported as values — `instanceof` and a function call both need the runtime binding, not just the type. `BoardState` stays a type-only import; `RuleContext` still only needs it structurally.)

Now append `KillerRuleContext` and `KillerOnlyRule` at the end of the file, directly after the closing `}` of `SolverRule` (currently line 57):

```typescript
/** Narrows `RuleContext.board` to `KillerBoardState` for killer-only rules —
 *  `ctx.board.linearSystem`/`regions`/`cageSolns`/`spec` are then directly
 *  typed, with no cast and no further narrow inside the rule body. */
export interface KillerRuleContext extends Omit<RuleContext, 'board'> {
  readonly board: KillerBoardState;
}

/**
 * Shared base for the ten rules that require killer cage constraints
 * (`deltaConstraint`, `linearElimination`, `sumPairConstraint`,
 * `cageCandidateFilter`, `cageConfinement`, `cageIntersection`, `mustContain`,
 * `mustContainOutie`, `solutionMapFilter`, `unitPartitionFilter`).
 *
 * Performs the `ctx.board instanceof KillerBoardState` narrow exactly once —
 * in `apply`/`asHints` — and hands subclasses a `KillerRuleContext` whose
 * `board` is directly typed as `KillerBoardState`. `killerOnly` is set here so
 * it is never repeated across the ten subclasses.
 *
 * `buildEngine` (via `PuzzleState.isKiller`) already filters `killerOnly`
 * rules out of the classic rule set, so the `instanceof` branch below is
 * unreachable in practice — but the type system still requires *some* narrow
 * to expose `KillerBoardState`'s members to `applyKiller`/`asHintsKiller`,
 * and this is the one place it lives (defense in depth).
 */
export abstract class KillerOnlyRule implements SolverRule {
  readonly killerOnly = true;

  apply(ctx: RuleContext): RuleResult {
    if (!(ctx.board instanceof KillerBoardState)) return emptyResult();
    return this.applyKiller({ ...ctx, board: ctx.board });
  }

  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[] {
    if (!(ctx.board instanceof KillerBoardState)) return [];
    return this.asHintsKiller({ ...ctx, board: ctx.board }, eliminations);
  }

  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly description: string;
  abstract readonly priority: number;
  abstract readonly triggers: ReadonlySet<Trigger>;
  abstract readonly unitKinds: ReadonlySet<UnitKind>;
  abstract applyKiller(ctx: KillerRuleContext): RuleResult;
  abstract asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[];
}
```

- [ ] **Step 2: Run the type checker to confirm `rule.ts` compiles**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `rule.ts` (errors in the ten not-yet-migrated rule files are expected at this point — ignore them until Task 2).

Actually — at this point nothing references `KillerOnlyRule` yet, and `rule.ts` has no other consumers of the new exports, so the only way to check `rule.ts` itself compiles cleanly is to read the diagnostics scoped to that file:

Run: `npx tsc --noEmit 2>&1 | grep "rule.ts"`
Expected: no output (empty — `rule.ts` compiles clean)

- [ ] **Step 3: Write `killerOnlyRule.test.ts` — the defense-in-depth narrow, exercised directly**

Create `web/src/engine/killerOnlyRule.test.ts`:

```typescript
/**
 * Tests for KillerOnlyRule — the shared `instanceof KillerBoardState` narrow
 * for all ten killer-only rules (spec: cage-free-board-state-for-classic §2.1).
 */

import { describe, expect, it } from 'vitest';
import { BoardState, KillerBoardState } from './boardState.js';
import { KillerOnlyRule } from './rule.js';
import type { KillerRuleContext, RuleContext } from './rule.js';
import type { HintResult } from './hint.js';
import { emptyResult, Trigger, UnitKind } from './types.js';
import type { Cell, Elimination, RuleResult } from './types.js';
import { makeTrivialSpec } from './fixtures.js';

class StubKillerRule extends KillerOnlyRule {
  readonly name = 'StubKillerRule';
  readonly displayName = 'Stub Killer Rule';
  readonly description = '';
  readonly priority = 1;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  applyKiller(_ctx: KillerRuleContext): RuleResult {
    return { ...emptyResult(), eliminations: [{ cell: [0, 0] as Cell, digit: 1 }] };
  }

  asHintsKiller(_ctx: KillerRuleContext, _eliminations: readonly Elimination[]): HintResult[] {
    return [{
      ruleName: this.name,
      displayName: this.displayName,
      explanation: 'stub',
      highlightCells: [],
      eliminations: [],
      placement: null,
      virtualCageSuggestion: null,
    }];
  }
}

function ctxFor(board: RuleContext['board']): RuleContext {
  return { unit: null, cell: null, board, hint: Trigger.GLOBAL, hintDigit: null };
}

describe('KillerOnlyRule — defense-in-depth narrow', () => {
  it('apply returns emptyResult() when ctx.board is a plain BoardState', () => {
    const rule = new StubKillerRule();
    expect(rule.apply(ctxFor(new BoardState()))).toEqual(emptyResult());
  });

  it('asHints returns [] when ctx.board is a plain BoardState', () => {
    const rule = new StubKillerRule();
    expect(rule.asHints(ctxFor(new BoardState()), [])).toEqual([]);
  });

  it('apply delegates to applyKiller when ctx.board is a KillerBoardState', () => {
    const rule = new StubKillerRule();
    const result = rule.apply(ctxFor(new KillerBoardState(makeTrivialSpec())));
    expect(result.eliminations).toEqual([{ cell: [0, 0], digit: 1 }]);
  });

  it('asHints delegates to asHintsKiller when ctx.board is a KillerBoardState', () => {
    const rule = new StubKillerRule();
    const hints = rule.asHints(ctxFor(new KillerBoardState(makeTrivialSpec())), []);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.ruleName).toBe('StubKillerRule');
  });
});
```

- [ ] **Step 4: Run the new test file**

Run: `npx vitest run src/engine/killerOnlyRule.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/engine/rule.ts src/engine/killerOnlyRule.test.ts
git commit -m "feat: add KillerRuleContext and KillerOnlyRule base class

Performs the ctx.board instanceof KillerBoardState narrow exactly once for
all ten killer-only rules, replacing ten separate ad-hoc narrows with one
shared, type-checked location."
```

---

### Task 2: Migrate the ten killer-only rules to `KillerOnlyRule`

**Files (all in `web/src/engine/rules/`):**
- Modify: `deltaConstraint.ts`, `linearElimination.ts`, `sumPairConstraint.ts`, `cageCandidateFilter.ts`, `cageConfinement.ts`, `cageIntersection.ts`, `mustContain.ts`, `mustContainOutie.ts`, `solutionMapFilter.ts`, `unitPartitionFilter.ts`

Every one of the ten rules currently has the identical shape: `export class <Name> {`, then `readonly name = '...'; readonly killerOnly = true; readonly displayName = '...';`, then `apply(ctx: RuleContext): RuleResult { ... }`, then `asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] { ... }` (one exception: `cageCandidateFilter.ts` already declares `eliminations: readonly Elimination[]`). The migration for each rule is: extend `KillerOnlyRule`, drop the now-inherited `killerOnly` field, rename `apply`→`applyKiller`/`asHints`→`asHintsKiller` and retype their `ctx` parameter as `KillerRuleContext` (bodies are untouched — `ctx.board` is now directly `KillerBoardState`). A handful of private helpers that read `KillerBoardState`-only members (`linearSystem`, `regions`, `cageSolns`, `spec`) need the same retype; helpers that only touch `board.cands`/`board.units`/`board.cellUnitIds` (inherited from the base `BoardState`) need no change — `KillerRuleContext`/`KillerBoardState` upcast to `RuleContext`/`BoardState` wherever those are still the declared parameter type.

No existing rule test file changes — `deltaConstraint.test.ts` (and the other nine `*.test.ts` siblings) build `ctx: RuleContext` with `board: KillerBoardState` (post-Sprint-A) and call `.apply(ctx)`/`.asHints(ctx, ...)` directly; `KillerOnlyRule.apply`/`asHints` are inherited and transparently delegate.

- [ ] **Step 1: Migrate `deltaConstraint.ts`**

`_elimsForPair` only touches `board.cands` (inherited from `BoardState`) — it keeps its `ctx: RuleContext` parameter type (a `KillerRuleContext` argument upcasts to it without complaint). `RuleContext` therefore stays imported alongside the two new names.

Edit the import (line 12):
```typescript
import type { RuleContext } from '../rule.js';
```
→
```typescript
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext, RuleContext } from '../rule.js';
```

Edit the class declaration and field block (lines 16-18):
```typescript
export class DeltaConstraint {
  readonly name = 'DeltaConstraint';
  readonly killerOnly = true;
  readonly displayName = 'Delta Constraint';
```
→
```typescript
export class DeltaConstraint extends KillerOnlyRule {
  readonly name = 'DeltaConstraint';
  readonly displayName = 'Delta Constraint';
```

Edit the `apply` signature (line 53):
```typescript
  apply(ctx: RuleContext): RuleResult {
```
→
```typescript
  applyKiller(ctx: KillerRuleContext): RuleResult {
```

Edit the `asHints` signature (line 69):
```typescript
  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
```
→
```typescript
  asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[] {
```

- [ ] **Step 2: Migrate `linearElimination.ts`**

`_t1PlacementHints` only touches `board.cands` — keeps `ctx: RuleContext`. `_t3VirtualCageHints` touches `ctx.board.regions`/`ctx.board.linearSystem` (`KillerBoardState`-only) — retype to `KillerRuleContext`. `RuleContext` stays imported for `_t1PlacementHints`.

Edit the import (line 13):
```typescript
import type { RuleContext } from '../rule.js';
```
→
```typescript
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext, RuleContext } from '../rule.js';
```

Edit the class declaration and field block (lines 17-19):
```typescript
export class LinearElimination {
  readonly name = 'LinearElimination';
  readonly killerOnly = true;
  readonly displayName = 'Linear Elimination';
```
→
```typescript
export class LinearElimination extends KillerOnlyRule {
  readonly name = 'LinearElimination';
  readonly displayName = 'Linear Elimination';
```

Edit the `apply` signature (line 42):
```typescript
  apply(ctx: RuleContext): RuleResult {
```
→
```typescript
  applyKiller(ctx: KillerRuleContext): RuleResult {
```

Edit the `asHints` signature (line 49):
```typescript
  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
```
→
```typescript
  asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[] {
```

Edit the `_t3VirtualCageHints` helper signature (line 84):
```typescript
  private _t3VirtualCageHints(ctx: RuleContext): HintResult[] {
```
→
```typescript
  private _t3VirtualCageHints(ctx: KillerRuleContext): HintResult[] {
```

- [ ] **Step 3: Migrate `sumPairConstraint.ts`**

No helpers reference `RuleContext` — drop the import entirely in favour of the two new names.

Edit the import (line 16):
```typescript
import type { RuleContext } from '../rule.js';
```
→
```typescript
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext } from '../rule.js';
```

Edit the class declaration and field block (lines 20-22):
```typescript
export class SumPairConstraint {
  readonly name = 'SumPairConstraint';
  readonly killerOnly = true;
  readonly displayName = 'Sum Pair Constraint';
```
→
```typescript
export class SumPairConstraint extends KillerOnlyRule {
  readonly name = 'SumPairConstraint';
  readonly displayName = 'Sum Pair Constraint';
```

Edit the `apply` signature (line 41):
```typescript
  apply(ctx: RuleContext): RuleResult {
```
→
```typescript
  applyKiller(ctx: KillerRuleContext): RuleResult {
```

Edit the `asHints` signature (line 63):
```typescript
  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
```
→
```typescript
  asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[] {
```

- [ ] **Step 4: Migrate `cageCandidateFilter.ts`**

No helpers reference `RuleContext` — drop the import. This is the one rule whose `asHints` already declares `eliminations: readonly Elimination[]`, so its signature edit only changes the method name and `ctx` type.

Edit the import (line 12):
```typescript
import type { RuleContext } from '../rule.js';
```
→
```typescript
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext } from '../rule.js';
```

Edit the class declaration and field block (lines 23-25):
```typescript
export class CageCandidateFilter {
  readonly name = 'CageCandidateFilter';
  readonly killerOnly = true;
  readonly displayName = 'Cage Candidate Filter';
```
→
```typescript
export class CageCandidateFilter extends KillerOnlyRule {
  readonly name = 'CageCandidateFilter';
  readonly displayName = 'Cage Candidate Filter';
```

Edit the `apply` signature (line 41):
```typescript
  apply(ctx: RuleContext): RuleResult {
```
→
```typescript
  applyKiller(ctx: KillerRuleContext): RuleResult {
```

Edit the `asHints` signature (line 58):
```typescript
  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[] {
```
→
```typescript
  asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[] {
```

- [ ] **Step 5: Migrate `cageConfinement.ts`**

`_findAllMatches`/`_search` both read `board.cageSolns` (`KillerBoardState`-only) and currently take `board: RuleContext['board']` (= `BoardState`). Retype both directly to `KillerBoardState` — this file does not yet import `boardState.js`, so add that import. `RuleContext` becomes unreferenced — drop it.

Edit the imports (lines 13-14):
```typescript
import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
```
→
```typescript
import type { KillerBoardState } from '../boardState.js';
import type { HintResult } from '../hint.js';
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext } from '../rule.js';
```

Edit the class declaration and field block (lines 33-35):
```typescript
export class CageConfinement {
  readonly name = 'CageConfinement';
  readonly killerOnly = true;
  readonly displayName = 'Cage Confinement';
```
→
```typescript
export class CageConfinement extends KillerOnlyRule {
  readonly name = 'CageConfinement';
  readonly displayName = 'Cage Confinement';
```

Edit the `_findAllMatches` helper signature (line 56):
```typescript
  private _findAllMatches(board: RuleContext['board']): _ConfinementMatch[] {
```
→
```typescript
  private _findAllMatches(board: KillerBoardState): _ConfinementMatch[] {
```

Edit the `_search` helper signature (line 66):
```typescript
  private _search(board: RuleContext['board'], kind: UnitKind, d: number): _ConfinementMatch[] {
```
→
```typescript
  private _search(board: KillerBoardState, kind: UnitKind, d: number): _ConfinementMatch[] {
```

Edit the `apply` signature (line 112):
```typescript
  apply(ctx: RuleContext): RuleResult {
```
→
```typescript
  applyKiller(ctx: KillerRuleContext): RuleResult {
```

Edit the `asHints` signature (line 124):
```typescript
  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
```
→
```typescript
  asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[] {
```

- [ ] **Step 6: Migrate `cageIntersection.ts`**

`_iterMatches` reads `board.cageSolns` — retype to `KillerRuleContext`. `RuleContext` becomes unreferenced — drop it.

Edit the import (line 12):
```typescript
import type { RuleContext } from '../rule.js';
```
→
```typescript
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext } from '../rule.js';
```

Edit the class declaration and field block (lines 23-25):
```typescript
export class CageIntersection {
  readonly name = 'CageIntersection';
  readonly killerOnly = true;
  readonly displayName = 'Cage Intersection';
```
→
```typescript
export class CageIntersection extends KillerOnlyRule {
  readonly name = 'CageIntersection';
  readonly displayName = 'Cage Intersection';
```

Edit the `_iterMatches` helper signature (line 44):
```typescript
  private _iterMatches(ctx: RuleContext): _Match[] {
```
→
```typescript
  private _iterMatches(ctx: KillerRuleContext): _Match[] {
```

Edit the `apply` signature (line 81):
```typescript
  apply(ctx: RuleContext): RuleResult {
```
→
```typescript
  applyKiller(ctx: KillerRuleContext): RuleResult {
```

Edit the `asHints` signature (line 93):
```typescript
  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
```
→
```typescript
  asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[] {
```

- [ ] **Step 7: Migrate `mustContain.ts`**

`_iterMatches` reads `board.cageSolns` — retype to `KillerRuleContext`. Its return-type annotation uses `typeof ctx.unit`, which is identical on `RuleContext`/`KillerRuleContext` (both expose `unit: Unit | null` via `Omit<RuleContext, 'board'>`), so the rest of the signature is untouched. `RuleContext` becomes unreferenced — drop it.

Edit the import (line 13):
```typescript
import type { RuleContext } from '../rule.js';
```
→
```typescript
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext } from '../rule.js';
```

Edit the class declaration and field block (lines 17-19):
```typescript
export class MustContain {
  readonly name = 'MustContain';
  readonly killerOnly = true;
  readonly displayName = 'Must Contain';
```
→
```typescript
export class MustContain extends KillerOnlyRule {
  readonly name = 'MustContain';
  readonly displayName = 'Must Contain';
```

Edit the `_iterMatches` helper signature (line 38):
```typescript
  private _iterMatches(ctx: RuleContext): Array<{unit: typeof ctx.unit; cageUnitId: number; overlap: Cell[]; confinedDigits: Set<number>; eliminations: Elimination[]}> {
```
→
```typescript
  private _iterMatches(ctx: KillerRuleContext): Array<{unit: typeof ctx.unit; cageUnitId: number; overlap: Cell[]; confinedDigits: Set<number>; eliminations: Elimination[]}> {
```

Edit the `apply` signature (line 80):
```typescript
  apply(ctx: RuleContext): RuleResult {
```
→
```typescript
  applyKiller(ctx: KillerRuleContext): RuleResult {
```

Edit the `asHints` signature (line 85):
```typescript
  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
```
→
```typescript
  asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[] {
```

- [ ] **Step 8: Migrate `mustContainOutie.ts`**

`_iterMatches` reads `board.cageSolns` — retype to `KillerRuleContext`. The module-level `findMatch` helper only touches `board.cands` and keeps its `board: RuleContext['board']` parameter (a `KillerBoardState` argument upcasts without complaint) — so `RuleContext` stays imported, and **no new `KillerBoardState` import is needed** (it is never named as a type in this file).

Edit the import (line 12):
```typescript
import type { RuleContext } from '../rule.js';
```
→
```typescript
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext, RuleContext } from '../rule.js';
```

Edit the class declaration and field block (lines 58-60):
```typescript
export class MustContainOutie {
  readonly name = 'MustContainOutie';
  readonly killerOnly = true;
  readonly displayName = 'Must Contain Outie';
```
→
```typescript
export class MustContainOutie extends KillerOnlyRule {
  readonly name = 'MustContainOutie';
  readonly displayName = 'Must Contain Outie';
```

Edit the `_iterMatches` helper signature (line 79):
```typescript
  private _iterMatches(ctx: RuleContext): _Match[] {
```
→
```typescript
  private _iterMatches(ctx: KillerRuleContext): _Match[] {
```

Edit the `apply` signature (line 119):
```typescript
  apply(ctx: RuleContext): RuleResult {
```
→
```typescript
  applyKiller(ctx: KillerRuleContext): RuleResult {
```

Edit the `asHints` signature (line 124):
```typescript
  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
```
→
```typescript
  asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[] {
```

- [ ] **Step 9: Migrate `solutionMapFilter.ts`**

No helpers reference `RuleContext` — drop the import.

Edit the import (line 13):
```typescript
import type { RuleContext } from '../rule.js';
```
→
```typescript
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext } from '../rule.js';
```

Edit the class declaration and field block (lines 39-41):
```typescript
export class SolutionMapFilter {
  readonly name = 'SolutionMapFilter';
  readonly killerOnly = true;
  readonly displayName = 'Solution Map Filter';
```
→
```typescript
export class SolutionMapFilter extends KillerOnlyRule {
  readonly name = 'SolutionMapFilter';
  readonly displayName = 'Solution Map Filter';
```

Edit the `apply` signature (line 59):
```typescript
  apply(ctx: RuleContext): RuleResult {
```
→
```typescript
  applyKiller(ctx: KillerRuleContext): RuleResult {
```

Edit the `asHints` signature (line 98):
```typescript
  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
```
→
```typescript
  asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[] {
```

- [ ] **Step 10: Migrate `unitPartitionFilter.ts`**

`_iterMatches` reads `board.cageSolns` and currently takes `board: RuleContext['board']`. Retype directly to `KillerBoardState` (this file does not yet import `boardState.js` — add it). `RuleContext` becomes unreferenced — drop it. (`CapHitError extends Error {}` at module scope is untouched.)

Edit the imports (lines 13-14):
```typescript
import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
```
→
```typescript
import type { KillerBoardState } from '../boardState.js';
import type { HintResult } from '../hint.js';
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext } from '../rule.js';
```

Edit the class declaration and field block (lines 133-135):
```typescript
export class UnitPartitionFilter {
  readonly name = 'UnitPartitionFilter';
  readonly killerOnly = true;
  readonly displayName = 'Unit Partition Filter';
```
→
```typescript
export class UnitPartitionFilter extends KillerOnlyRule {
  readonly name = 'UnitPartitionFilter';
  readonly displayName = 'Unit Partition Filter';
```

Edit the `_iterMatches` helper signature (line 153):
```typescript
  private _iterMatches(board: RuleContext['board']): _Match[] {
```
→
```typescript
  private _iterMatches(board: KillerBoardState): _Match[] {
```

Edit the `apply` signature (line 199):
```typescript
  apply(ctx: RuleContext): RuleResult {
```
→
```typescript
  applyKiller(ctx: KillerRuleContext): RuleResult {
```

Edit the `asHints` signature (line 206):
```typescript
  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
```
→
```typescript
  asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[] {
```

- [ ] **Step 11: Run the type checker**

Run: `npx tsc --noEmit`
Expected: no errors. (If any rule reports a missing `applyKiller`/`asHintsKiller` implementation, re-check that both the `apply`→`applyKiller` *and* `asHints`→`asHintsKiller` renames landed for that file — a half-migrated rule fails to satisfy `KillerOnlyRule`'s abstract members.)

- [ ] **Step 12: Run the full unit suite**

Run: `npx vitest run`
Expected: all tests pass — in particular `cageRules.test.ts`, `cageConfinement.test.ts`, `mustContain.test.ts`, `mustContainOutie.test.ts`, `linearElimination.test.ts`, `deltaConstraint.test.ts`, `sumPairConstraint.test.ts`, `solverEngine.test.ts` all green with zero source changes (per spec §7 — `KillerOnlyRule.apply`/`asHints` are inherited and transparent to the existing `ctx: RuleContext` call pattern).

- [ ] **Step 13: Commit**

```bash
git add src/engine/rules/deltaConstraint.ts src/engine/rules/linearElimination.ts \
  src/engine/rules/sumPairConstraint.ts src/engine/rules/cageCandidateFilter.ts \
  src/engine/rules/cageConfinement.ts src/engine/rules/cageIntersection.ts \
  src/engine/rules/mustContain.ts src/engine/rules/mustContainOutie.ts \
  src/engine/rules/solutionMapFilter.ts src/engine/rules/unitPartitionFilter.ts
git commit -m "refactor: migrate killer-only rules to KillerOnlyRule base class

Each of the ten killerOnly rules now extends KillerOnlyRule and implements
applyKiller/asHintsKiller against KillerRuleContext instead of implementing
SolverRule directly against RuleContext. ctx.board is now KillerBoardState
with no cast — the instanceof narrow lives in exactly one place."
```

---

### Task 3: `KillerSolverEngine` + `SolverEngineOptions` — virtual `_onCellDetermined` hook

**Files:**
- Modify: `web/src/engine/solverEngine.ts`
- Modify: `web/src/session/engine.ts`
- Test: `web/src/engine/solverEngine.test.ts`

`SolverEngine._routeEvents` currently gates its linear-system substitution block behind a `_linearSystemActive` boolean flag (set from a constructor option that is always passed `true` by `buildEngine`, see spec §2.2). This task replaces the flag with a protected virtual `_onCellDetermined` hook — a no-op on the base `SolverEngine`, overridden by a new `KillerSolverEngine` subclass that owns linear-system propagation. `buildEngine` then constructs `KillerSolverEngine` instead of `SolverEngine` (its `board` is still always a `KillerBoardState` at this point — Sprint C is what teaches `buildEngine` to build a plain `BoardState`/`SolverEngine` pair for classic puzzles).

- [ ] **Step 1: Add `KillerBoardState` to the `solverEngine.ts` imports**

Open `web/src/engine/solverEngine.ts`. Edit line 16:
```typescript
import { BoardState, CAGE_UNIT_OFFSET } from './boardState.js';
```
→
```typescript
import { BoardState, CAGE_UNIT_OFFSET, KillerBoardState } from './boardState.js';
```

- [ ] **Step 2: Add the `SolverEngineOptions` interface**

Edit the section header immediately above `export class SolverEngine` (lines 157-161):
```typescript
// ---------------------------------------------------------------------------
// SolverEngine
// ---------------------------------------------------------------------------

export class SolverEngine {
```
→
```typescript
// ---------------------------------------------------------------------------
// SolverEngine
// ---------------------------------------------------------------------------

/** Options shared by SolverEngine and KillerSolverEngine. */
export interface SolverEngineOptions {
  hintRules?: ReadonlySet<string>;
  /** When provided, each rule application is checked: no rule may eliminate
   *  the correct solution digit from a cell where it is still a candidate.
   *  When `onViolation` is also provided, violations call it and suppress the
   *  rule result instead of throwing. When `onViolation` is null, violations
   *  throw NoSolnError (backward-compatible). */
  goldenSolution?: readonly (readonly number[])[] | null;
  /** Called when a rule produces an elimination that contradicts the golden
   *  solution. The engine suppresses the entire rule result (no board mutation)
   *  and continues. Only has effect when `goldenSolution` is also set. */
  onViolation?: ((ruleName: string, offending: readonly Elimination[]) => void) | null;
}

export class SolverEngine {
```

- [ ] **Step 3: Delete the `_linearSystemActive` field**

Edit lines 173-175:
```typescript
  private readonly _hintRules: ReadonlySet<string>;
  private readonly _linearSystemActive: boolean;
  private readonly _goldenSolution: readonly (readonly number[])[] | null;
```
→
```typescript
  private readonly _hintRules: ReadonlySet<string>;
  private readonly _goldenSolution: readonly (readonly number[])[] | null;
```

- [ ] **Step 4: Replace the constructor's inline options type with `SolverEngineOptions`, and stop assigning `_linearSystemActive`**

Edit lines 183-208 (the constructor signature and its first five assignments):
```typescript
  constructor(
    board: BoardState,
    rules: SolverRule[],
    { linearSystemActive = true, hintRules = new Set<string>(), goldenSolution = null, onViolation = null }: {
      linearSystemActive?: boolean;
      hintRules?: ReadonlySet<string>;
      /** When provided, each rule application is checked: no rule may eliminate
       *  the correct solution digit from a cell where it is still a candidate.
       *  When `onViolation` is also provided, violations call it and suppress the
       *  rule result instead of throwing. When `onViolation` is null, violations
       *  throw NoSolnError (backward-compatible). */
      goldenSolution?: readonly (readonly number[])[] | null;
      /** Called when a rule produces an elimination that contradicts the golden
       *  solution. The engine suppresses the entire rule result (no board mutation)
       *  and continues. Only has effect when `goldenSolution` is also set. */
      onViolation?: ((ruleName: string, offending: readonly Elimination[]) => void) | null;
    } = {},
  ) {
    this.board = board;
    this.queue = new SolverQueue();
    this._ruleIndex = new Map(rules.map((r, i) => [r, i]));
    this.stats = new Map(rules.map(r => [r.name, makeRuleStats()]));
    this._hintRules = hintRules;
    this._linearSystemActive = linearSystemActive;
    this._goldenSolution = goldenSolution;
    this._onViolation = onViolation;
```
→
```typescript
  constructor(
    board: BoardState,
    rules: SolverRule[],
    { hintRules = new Set<string>(), goldenSolution = null, onViolation = null }: SolverEngineOptions = {},
  ) {
    this.board = board;
    this.queue = new SolverQueue();
    this._ruleIndex = new Map(rules.map((r, i) => [r, i]));
    this.stats = new Map(rules.map(r => [r.name, makeRuleStats()]));
    this._hintRules = hintRules;
    this._goldenSolution = goldenSolution;
    this._onViolation = onViolation;
```

- [ ] **Step 5: Add the virtual `_onCellDetermined` hook (no-op on the base class)**

Insert it directly after the constructor's closing brace, before `applyEliminations` (currently lines 216-218):
```typescript
    for (const rule of rules)
      for (const trigger of rule.triggers)
        this._triggerMap.get(trigger)!.push(rule);
  }

  applyEliminations(eliminations: readonly Elimination[]): void {
```
→
```typescript
    for (const rule of rules)
      for (const trigger of rule.triggers)
        this._triggerMap.get(trigger)!.push(rule);
  }

  /** Linear-system propagation for a just-determined cell. No-op on a board
   *  with no LinearSystem; KillerSolverEngine overrides it to substitute the
   *  cell into the cage-sum equations and narrow live virtual-cage constraints. */
  protected _onCellDetermined(_cell: Cell, _val: number): void {}

  applyEliminations(eliminations: readonly Elimination[]): void {
```

- [ ] **Step 6: Replace the `_linearSystemActive`-gated block in `_routeEvents` with a call to the hook**

Edit lines 238-260 (inside `_routeEvents`, the `CELL_DETERMINED` branch):
```typescript
      if (event.trigger === Trigger.CELL_DETERMINED) {
        const cell = event.payload as Cell;
        const val = event.hintDigit!;
        if (this._linearSystemActive) {
          const newElims = this.board.linearSystem.substituteCell(cell, val);
          if (newElims.length > 0) this.applyEliminations(newElims);
          const newConstraints = this.board.linearSystem.substituteLiveRows(cell, val);
          for (const [vcells, vtotal, distinct] of newConstraints) {
            const cellList = [...vcells];
            if (cellList.length === 1) {
              const [lr, lc] = cellList[0]!;
              for (let d = 1; d <= 9; d++) {
                if (d !== vtotal && this.board.cands(lr, lc).has(d))
                  this.applyEliminations([{ cell: cellList[0]!, digit: d }]);
              }
            } else if (distinct) {
              this.applyEliminations(filterSumConstraint(cellList as Cell[], vtotal, this.board.candidates));
            } else {
              this.applyEliminations(filterSumRange(cellList as Cell[], vtotal, this.board.candidates));
            }
          }
        }
        for (const rule of this._triggerMap.get(Trigger.CELL_DETERMINED) ?? [])
```
→
```typescript
      if (event.trigger === Trigger.CELL_DETERMINED) {
        const cell = event.payload as Cell;
        const val = event.hintDigit!;
        this._onCellDetermined(cell, val);
        for (const rule of this._triggerMap.get(Trigger.CELL_DETERMINED) ?? [])
```

- [ ] **Step 7: Append `KillerSolverEngine`, overriding the hook with the linear-system propagation that was just removed from the base class**

Append at the end of the file (after the `SolverEngine` class's closing `}`):
```typescript

// ---------------------------------------------------------------------------
// KillerSolverEngine — owns linear-system propagation on cell determination
// ---------------------------------------------------------------------------

export class KillerSolverEngine extends SolverEngine {
  override readonly board: KillerBoardState;

  constructor(board: KillerBoardState, rules: SolverRule[], opts: SolverEngineOptions = {}) {
    super(board, rules, opts);
    this.board = board;
  }

  protected override _onCellDetermined(cell: Cell, val: number): void {
    const newElims = this.board.linearSystem.substituteCell(cell, val);
    if (newElims.length > 0) this.applyEliminations(newElims);
    const newConstraints = this.board.linearSystem.substituteLiveRows(cell, val);
    for (const [vcells, vtotal, distinct] of newConstraints) {
      const cellList = [...vcells];
      if (cellList.length === 1) {
        const [lr, lc] = cellList[0]!;
        for (let d = 1; d <= 9; d++) {
          if (d !== vtotal && this.board.cands(lr, lc).has(d))
            this.applyEliminations([{ cell: cellList[0]!, digit: d }]);
        }
      } else if (distinct) {
        this.applyEliminations(filterSumConstraint(cellList as Cell[], vtotal, this.board.candidates));
      } else {
        this.applyEliminations(filterSumRange(cellList as Cell[], vtotal, this.board.candidates));
      }
    }
  }
}
```

- [ ] **Step 8: Update `buildEngine` to construct `KillerSolverEngine`**

Open `web/src/session/engine.ts`. `board` here is still always constructed as a (post-Sprint-A-renamed) `KillerBoardState` — Sprint C is what makes this conditional. Replacing `SolverEngine` with `KillerSolverEngine` is therefore a direct, type-safe substitution: `linearSystemActive` no longer exists as an option (Step 4 deleted it), and dispatch is now virtual.

Find the engine construction (around line 275):
```typescript
    const engine = new SolverEngine(board, activeRules, {
      linearSystemActive: true,
      hintRules,
      goldenSolution: activeGolden,
      onViolation,
    });
```
→
```typescript
    const engine = new KillerSolverEngine(board, activeRules, {
      hintRules,
      goldenSolution: activeGolden,
      onViolation,
    });
```

Now add `KillerSolverEngine` to this file's import of engine types. Currently (line 20) it reads:
```typescript
import { SolverEngine } from '../engine/solverEngine.js';
```
Widen it to:
```typescript
import { SolverEngine, KillerSolverEngine } from '../engine/solverEngine.js';
```
(`solverEngine.ts` is where Step 7 just defined `KillerSolverEngine` — the same module `SolverEngine` already comes from. This mirrors line 19's `BoardState`/`KillerBoardState` pair, which similarly both come from `boardState.ts`.)

- [ ] **Step 9: Run the type checker**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Add a `solverEngine.test.ts` case confirming the base engine never touches `LinearSystem`**

Open `web/src/engine/solverEngine.test.ts`. The new test below constructs a plain `new BoardState()` — but post-Sprint-A this file's import (line 14) reads `import { KillerBoardState } from './boardState.js';` (the rename's word-boundary sed rewrote the bare `BoardState` import to `KillerBoardState`). Restore the plain-`BoardState` import alongside it. Edit line 14:
```typescript
import { KillerBoardState } from './boardState.js';
```
→
```typescript
import { BoardState, KillerBoardState } from './boardState.js';
```

Then insert a new `describe` block directly after the `SolverEngine.applyEliminations` block (currently lines 74-83, ending `});`):
```typescript
describe('SolverEngine.applyEliminations', () => {
  it('is idempotent — eliminating a digit twice is a no-op', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, []);
    engine.applyEliminations([{ cell: [0, 0] as unknown as Elimination['cell'], digit: 5 }]);
    const before = new Set(bs.candidates[0]![0]!);
    engine.applyEliminations([{ cell: [0, 0] as unknown as Elimination['cell'], digit: 5 }]);
    expect(bs.candidates[0]![0]!).toEqual(before);
  });
});
```
→
```typescript
describe('SolverEngine.applyEliminations', () => {
  it('is idempotent — eliminating a digit twice is a no-op', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new SolverEngine(bs, []);
    engine.applyEliminations([{ cell: [0, 0] as unknown as Elimination['cell'], digit: 5 }]);
    const before = new Set(bs.candidates[0]![0]!);
    engine.applyEliminations([{ cell: [0, 0] as unknown as Elimination['cell'], digit: 5 }]);
    expect(bs.candidates[0]![0]!).toEqual(before);
  });
});

describe('SolverEngine — _onCellDetermined virtual hook', () => {
  it('base SolverEngine never touches LinearSystem when given a plain BoardState', () => {
    const plain = new BoardState();
    const engine = new SolverEngine(plain, []);
    // Eliminate 8 of (0,0)'s 9 candidates, leaving exactly one — this fires
    // CELL_DETERMINED, which _routeEvents forwards to _onCellDetermined. A plain
    // BoardState has no `linearSystem` property; if the hook were anything other
    // than the base no-op, this would throw a TypeError instead of completing.
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    expect(() => engine.applyEliminations(eliminations)).not.toThrow();
    expect(plain.cands(0, 0)).toEqual(new Set([9]));
  });
});
```

(The anchor block's `new KillerBoardState(makeTrivialSpec())` is Sprint A's already-landed rename — shown only as context for the insertion point. The new block's `new BoardState()` is the genuinely-new, no-arg, cage-free constructor this spec introduces.)

- [ ] **Step 11: Run the new test**

Run: `npx vitest run src/engine/solverEngine.test.ts`
Expected: all tests in the file pass, including the new `SolverEngine — _onCellDetermined virtual hook` case.

- [ ] **Step 12: Run the full unit suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 13: Commit**

```bash
git add src/engine/solverEngine.ts src/engine/solverEngine.test.ts src/session/engine.ts
git commit -m "refactor: replace _linearSystemActive flag with virtual _onCellDetermined hook

SolverEngine._onCellDetermined is now a no-op virtual hook; KillerSolverEngine
overrides it to own linear-system substitution and constraint narrowing.
buildEngine constructs KillerSolverEngine — board is still always
KillerBoardState here, so this is a direct type-safe substitution
(SolverEngineOptions has no linearSystemActive to pass)."
```

---

### Task 4: `candidatesFromBoard` — replace the `puzzleType` proxy test with `instanceof KillerBoardState`

**Files:**
- Modify: `web/src/session/actions.ts`
- Test: `web/src/session/actions.test.ts`

`candidatesFromBoard` (`actions.ts:635-744`) currently asks `state.puzzleType === 'classic'` to decide whether `board` carries cage display data — a proxy test that only works because, today, `board` always carries cage fields regardless of puzzle type (the dummy-spec fiction this whole refactor removes). Per spec §2.4, the correct question — *does this board carry cage data* — has a direct structural answer: `board instanceof KillerBoardState`.

Three places in the function read `KillerBoardState`-only members (`regions`, `cageSolns`, `spec`) — the per-cell `cells` builder, the `cages` builder (and its `nRealCages` count), and the `virtualCages` builder's `vcSolns` lookup (`board.cageSolns[nRealCages + i]`). All three need the narrow; the spec's §2.4 sketch shows only the first two because virtual cages are gated behind `isKiller` in the UI (`main.ts:718`, `'virtual-cage-btn').hidden = !isKiller`) and so are structurally always empty for classic — but the **type** system doesn't know that, so `vcSolns`'s lookup needs the same narrow to compile against a widened `board: BoardState` parameter.

- [ ] **Step 1: Widen the `BoardState`/`KillerBoardState` import**

Open `web/src/session/actions.ts`. Edit line 10:
```typescript
import { solve, BoardState, SolveResult } from '../engine/index.js';
```
→
```typescript
import { solve, BoardState, KillerBoardState, SolveResult } from '../engine/index.js';
```

- [ ] **Step 2: Replace `candidatesFromBoard`'s body with the `instanceof KillerBoardState`-narrowed version**

Replace the entire function (currently lines 635-744 — from the `function candidatesFromBoard` line through its closing `}`):
```typescript
function candidatesFromBoard(board: BoardState, state: PuzzleState): CandidatesResponse {
  // Per-cell user-removed lookup
  const removedByCell = new Map<string, Set<number>>();
  for (const [r, c, d] of userRemoved(state)) {
    const key = `${r},${c}`;
    const s = removedByCell.get(key) ?? new Set<number>();
    s.add(d);
    removedByCell.set(key, s);
  }

  // Build per-cell info
  const cells = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => {
      const cageIdx = board.regions[r]![c]!;
      const remaining = board.cageSolns[cageIdx]!;
      const removedHere = removedByCell.get(`${r},${c}`) ?? new Set<number>();
      // Classic mode: cage solutions are always empty (dummy spec) — use board
      // candidates directly so row/col/box eliminations are reflected.
      const cagePossible: Set<number> = remaining.length > 0
        ? new Set(remaining.flat())
        : new Set<number>();
      const solverCands = state.puzzleType === 'classic'
        ? new Set(board.cands(r, c))
        : new Set([...board.cands(r, c)].filter(d => cagePossible.has(d)));
      // Union in user-removed so they show for strikethrough even after SolutionMapFilter prunes
      for (const d of removedHere) solverCands.add(d);
      return {
        candidates: [...solverCands].sort((a, b) => a - b),
        userRemoved: [...removedHere].sort((a, b) => a - b),
      };
    }),
  );

  // Real cage info — allSolutions/autoImpossible/userEliminated match VirtualCageInfo shape.
  const nRealCages = Math.max(...board.regions.flat()) + 1;
  const cages = Array.from({ length: nRealCages }, (_, idx) => {
    const unit = board.units[27 + idx]!;
    // board.cageSolns[idx] has user-eliminated and engine-impossible both removed by buildEngine.
    const solns = board.cageSolns[idx]!;
    const cageState = state.cageStates[idx]!;
    let total = 0;
    for (const [r, c] of unit.cells) {
      const v = board.spec.cageTotals[r]![c]!;
      if (v) { total = v; break; }
    }
    const all = allCageSolutions(unit.cells.length, total);
    // solns elements are already order-normalised by the engine; s.join(',') is sufficient.
    const possibleKeys = new Set(solns.map(s => s.join(',')));
    // userEliminatedSolns are stored sorted by toggleSolution; join is sufficient.
    const userEliminatedKeys = new Set(cageState.userEliminatedSolns.map(s => s.join(',')));
    return {
      cageIdx: idx,
      label: cageState.label,
      cells: unit.cells.map(([r, c]) => [r, c] as [number, number]),
      total,
      solutions: solns.map(s => [...s].sort((a, b) => a - b)),
      allSolutions: all,
      autoImpossible: all.filter(s => !possibleKeys.has(s.join(',')) && !userEliminatedKeys.has(s.join(','))),
      userEliminated: all.filter(s => userEliminatedKeys.has(s.join(','))),
      mustContain: solns.length > 0 ? intersectAll(solns.map(s => new Set(s))) : [],
    };
  });

  // Virtual cage info — same SolutionCategorization shape as CageInfo.
  const diffSolnKey = (s: DiffSolution) => `${[...s.pos].join(',')}|${[...s.neg].join(',')}`;
  const virtualCages = state.virtualCages.map((vc, i) => {
    const isDiff = vc.negativeCells !== undefined && vc.negativeCells.length > 0;
    const key = virtualCageKeyFromCage(vc);
    if (isDiff) {
      const negCells = vc.negativeCells!;
      const negKeys = new Set(negCells.map(([r, c]) => `${r},${c}`));
      const posCount = vc.cells.length - negKeys.size;
      const negCount = negKeys.size;
      const allDiff = solDiffs(posCount, negCount, vc.total);
      const elimKeys = new Set((vc.eliminatedDiffSolns ?? []).map(diffSolnKey));
      const remaining = allDiff.filter(s => !elimKeys.has(diffSolnKey(s)));
      return {
        key,
        cells: vc.cells.map(([r, c]) => [r, c] as [number, number]),
        total: vc.total,
        solutions: [],
        allSolutions: [],
        autoImpossible: [],
        userEliminated: [],
        mustContain: [],
        negativeCells: negCells.map(([r, c]) => [r, c] as [number, number]),
        allDiffSolutions: allDiff,
        diffSolutions: remaining,
        eliminatedDiffSolns: (vc.eliminatedDiffSolns ?? []).slice(),
      };
    }
    const vcSolns = board.cageSolns[nRealCages + i] ?? [];
    const all = allCageSolutions(vc.cells.length, vc.total);
    const possibleKeys = new Set(vcSolns.map(solutionKey));
    // eliminatedSolns are stored sorted by toggleSolution; join is sufficient.
    const userEliminatedKeys = new Set(vc.eliminatedSolns.map(s => s.join(',')));
    return {
      key,
      cells: vc.cells.map(([r, c]) => [r, c] as [number, number]),
      total: vc.total,
      solutions: vcSolns.map(s => [...s].sort((a, b) => a - b)),
      allSolutions: all,
      autoImpossible: all.filter(s => !possibleKeys.has(s.join(',')) && !userEliminatedKeys.has(s.join(','))),
      userEliminated: all.filter(s => userEliminatedKeys.has(s.join(','))),
      mustContain: vcSolns.length > 0 ? intersectAll(vcSolns.map(s => new Set(s))) : [],
    };
  });

  return { cells, cages, virtualCages };
}
```
→
```typescript
function candidatesFromBoard(board: BoardState, state: PuzzleState): CandidatesResponse {
  // Per-cell user-removed lookup
  const removedByCell = new Map<string, Set<number>>();
  for (const [r, c, d] of userRemoved(state)) {
    const key = `${r},${c}`;
    const s = removedByCell.get(key) ?? new Set<number>();
    s.add(d);
    removedByCell.set(key, s);
  }

  // Build per-cell info
  const cells = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => {
      const removedHere = removedByCell.get(`${r},${c}`) ?? new Set<number>();
      const solverCands = board instanceof KillerBoardState
        ? (() => {
            const cageIdx = board.regions[r]![c]!;
            const remaining = board.cageSolns[cageIdx]!;
            const cagePossible = new Set(remaining.flat());
            return new Set([...board.cands(r, c)].filter(d => cagePossible.has(d)));
          })()
        : new Set(board.cands(r, c));
      // Union in user-removed so they show for strikethrough even after SolutionMapFilter prunes
      for (const d of removedHere) solverCands.add(d);
      return {
        candidates: [...solverCands].sort((a, b) => a - b),
        userRemoved: [...removedHere].sort((a, b) => a - b),
      };
    }),
  );

  // Real cage info — allSolutions/autoImpossible/userEliminated match VirtualCageInfo shape.
  // A plain BoardState carries no cage data; cages/nRealCages are empty/zero for it.
  const nRealCages = board instanceof KillerBoardState ? Math.max(...board.regions.flat()) + 1 : 0;
  const cages = board instanceof KillerBoardState
    ? Array.from({ length: nRealCages }, (_, idx) => {
        const unit = board.units[27 + idx]!;
        // board.cageSolns[idx] has user-eliminated and engine-impossible both removed by buildEngine.
        const solns = board.cageSolns[idx]!;
        const cageState = state.cageStates[idx]!;
        let total = 0;
        for (const [r, c] of unit.cells) {
          const v = board.spec.cageTotals[r]![c]!;
          if (v) { total = v; break; }
        }
        const all = allCageSolutions(unit.cells.length, total);
        // solns elements are already order-normalised by the engine; s.join(',') is sufficient.
        const possibleKeys = new Set(solns.map(s => s.join(',')));
        // userEliminatedSolns are stored sorted by toggleSolution; join is sufficient.
        const userEliminatedKeys = new Set(cageState.userEliminatedSolns.map(s => s.join(',')));
        return {
          cageIdx: idx,
          label: cageState.label,
          cells: unit.cells.map(([r, c]) => [r, c] as [number, number]),
          total,
          solutions: solns.map(s => [...s].sort((a, b) => a - b)),
          allSolutions: all,
          autoImpossible: all.filter(s => !possibleKeys.has(s.join(',')) && !userEliminatedKeys.has(s.join(','))),
          userEliminated: all.filter(s => userEliminatedKeys.has(s.join(','))),
          mustContain: solns.length > 0 ? intersectAll(solns.map(s => new Set(s))) : [],
        };
      })
    : [];

  // Virtual cage info — same SolutionCategorization shape as CageInfo.
  const diffSolnKey = (s: DiffSolution) => `${[...s.pos].join(',')}|${[...s.neg].join(',')}`;
  const virtualCages = state.virtualCages.map((vc, i) => {
    const isDiff = vc.negativeCells !== undefined && vc.negativeCells.length > 0;
    const key = virtualCageKeyFromCage(vc);
    if (isDiff) {
      const negCells = vc.negativeCells!;
      const negKeys = new Set(negCells.map(([r, c]) => `${r},${c}`));
      const posCount = vc.cells.length - negKeys.size;
      const negCount = negKeys.size;
      const allDiff = solDiffs(posCount, negCount, vc.total);
      const elimKeys = new Set((vc.eliminatedDiffSolns ?? []).map(diffSolnKey));
      const remaining = allDiff.filter(s => !elimKeys.has(diffSolnKey(s)));
      return {
        key,
        cells: vc.cells.map(([r, c]) => [r, c] as [number, number]),
        total: vc.total,
        solutions: [],
        allSolutions: [],
        autoImpossible: [],
        userEliminated: [],
        mustContain: [],
        negativeCells: negCells.map(([r, c]) => [r, c] as [number, number]),
        allDiffSolutions: allDiff,
        diffSolutions: remaining,
        eliminatedDiffSolns: (vc.eliminatedDiffSolns ?? []).slice(),
      };
    }
    // Virtual cages are killer-only (gated behind isKiller in main.ts's UI), so this
    // branch never observes a non-empty array for a plain BoardState — but the type
    // system needs the same instanceof narrow to read board.cageSolns at all.
    const vcSolns = board instanceof KillerBoardState ? (board.cageSolns[nRealCages + i] ?? []) : [];
    const all = allCageSolutions(vc.cells.length, vc.total);
    const possibleKeys = new Set(vcSolns.map(solutionKey));
    // eliminatedSolns are stored sorted by toggleSolution; join is sufficient.
    const userEliminatedKeys = new Set(vc.eliminatedSolns.map(s => s.join(',')));
    return {
      key,
      cells: vc.cells.map(([r, c]) => [r, c] as [number, number]),
      total: vc.total,
      solutions: vcSolns.map(s => [...s].sort((a, b) => a - b)),
      allSolutions: all,
      autoImpossible: all.filter(s => !possibleKeys.has(s.join(',')) && !userEliminatedKeys.has(s.join(','))),
      userEliminated: all.filter(s => userEliminatedKeys.has(s.join(','))),
      mustContain: vcSolns.length > 0 ? intersectAll(vcSolns.map(s => new Set(s))) : [],
    };
  });

  return { cells, cages, virtualCages };
}
```

- [ ] **Step 3: Run the type checker**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Add an `actions.test.ts` case confirming the narrow against a plain `BoardState`**

Open `web/src/session/actions.test.ts`. Insert a new `describe` block directly after the `computeCandidates — classic mode (#13)` block (currently lines 125-141, ending `});`):
```typescript
describe('computeCandidates — classic mode (#13)', () => {
  beforeEach(() => { makeClassicConfirmed(); });

  it('returns non-empty candidates for blank cells', () => {
    const data = computeCandidates();
    const anyNonEmpty = data.cells.some(row => row.some(cell => cell.candidates.length > 0));
    expect(anyNonEmpty, 'at least one cell should have candidates').toBe(true);
  });

  it('blank cell (0,0) has digit 5 as its only candidate', () => {
    // KNOWN_SOLUTION[0][0] = 5; makeClassicGivenDigits blanks that cell.
    // After NakedSingle peer-elimination propagation only digit 5 should remain.
    const data = computeCandidates();
    const cell = data.cells[0]![0]!;
    expect(cell.candidates).toEqual([5]);
  });
});
```
→
```typescript
describe('computeCandidates — classic mode (#13)', () => {
  beforeEach(() => { makeClassicConfirmed(); });

  it('returns non-empty candidates for blank cells', () => {
    const data = computeCandidates();
    const anyNonEmpty = data.cells.some(row => row.some(cell => cell.candidates.length > 0));
    expect(anyNonEmpty, 'at least one cell should have candidates').toBe(true);
  });

  it('blank cell (0,0) has digit 5 as its only candidate', () => {
    // KNOWN_SOLUTION[0][0] = 5; makeClassicGivenDigits blanks that cell.
    // After NakedSingle peer-elimination propagation only digit 5 should remain.
    const data = computeCandidates();
    const cell = data.cells[0]![0]!;
    expect(cell.candidates).toEqual([5]);
  });
});

describe('candidatesFromBoard — instanceof KillerBoardState narrow', () => {
  it('produces an empty cages array and solverCands === board.cands(r, c) for a plain BoardState', () => {
    const givenDigits = makeClassicGivenDigits();
    const state = makeClassicState(givenDigits);
    const board = new BoardState();
    const data = candidatesFromBoard(board, state);
    expect(data.cages).toEqual([]);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        expect(data.cells[r]![c]!.candidates).toEqual([...board.cands(r, c)].sort((a, b) => a - b));
      }
    }
  });
});
```

This requires two additions to the test file's imports — `BoardState` (for the direct construction) and `candidatesFromBoard` itself (currently module-private; exporting it is the minimal change that makes it independently testable, matching how `buildEngine` is already exported from `session/engine.ts` for its own tests). Use serena's `find_symbol`/`replace_symbol_body` to:
1. Add `export` to the `candidatesFromBoard` function declaration (`function candidatesFromBoard` → `export function candidatesFromBoard`).
2. Add `BoardState` to this test file's existing `'../engine/index.js'` import (it currently imports `solve`/other engine symbols — use serena's `search_for_pattern` to find the exact line and widen it in the same style as Task 4 Step 1's `actions.ts` edit).
3. Add `candidatesFromBoard` to this test file's existing `from './actions.js'` import list (alongside `computeCandidates`, line 37).

- [ ] **Step 5: Run the new test**

Run: `npx vitest run src/session/actions.test.ts`
Expected: all tests in the file pass, including the new `candidatesFromBoard — instanceof KillerBoardState narrow` case.

- [ ] **Step 6: Run the full unit suite and type-check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both pass — this is the bronze gate's `tsc`/`npm test` portion (run the full `bash scripts/run-bronze-gate.sh` before committing, per CLAUDE.md).

- [ ] **Step 7: Commit**

```bash
git add src/session/actions.ts src/session/actions.test.ts
git commit -m "refactor: replace puzzleType proxy test with instanceof KillerBoardState

candidatesFromBoard now asks the structural question — does this board carry
cage display data — instead of inferring it from state.puzzleType. This is
the correct question for both today's always-KillerBoardState construction
and Sprint C's classic-puzzle plain-BoardState construction."
```

---

## After all tasks

Run the full bronze gate before considering this sprint done:

```bash
bash scripts/run-bronze-gate.sh
```

Expected: `tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, and `npm test` all pass, producing the `.bronze-gate-ok` token.

Sprint C (`docs/superpowers/plans/2026-06-07-cage-free-board-state-sprint-c-flip-switch.md`) then flips `buildEngine`/`solveFromStall` to actually construct plain `BoardState`/`SolverEngine` for classic puzzles — exercising the `instanceof` branches this sprint added but could not yet reach.
