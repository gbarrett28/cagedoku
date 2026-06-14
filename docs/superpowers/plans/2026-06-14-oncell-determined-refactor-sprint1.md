# `_onCellDetermined` Refactor — Sprint 1 (LinearSystem/SolverEngine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `KillerSolverEngine._onCellDetermined` pure bookkeeping (drop `substituteCell`,
route `substituteLiveRows` results through a new `DerivedVirtualCage` rule and
`solve()`'s normal golden-checked apply path), and remove the now-dead
`filterSumConstraint`/`filterSumRange` helpers.

**Architecture:** `LinearSystem` gains a `pendingVirtualCages` queue. `_onCellDetermined`
calls `substituteLiveRows`, eager-golden-checks single-cell results via a new
`protected _checkAgainstGolden` helper on `SolverEngine`, dedups against existing
units, and pushes the rest onto `pendingVirtualCages`. A new `DerivedVirtualCage`
rule (GLOBAL trigger) drains one entry per pass via `RuleResult.virtualCageAdditions`,
which `solve()` now golden-checks and applies via `board.addVirtualCage`.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: `SolverEngine._checkAgainstGolden` helper

**Files:**
- Modify: `web/src/engine/solverEngine.ts:185-194` (visibility + new method)
- Test: `web/src/engine/solverEngine.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `web/src/engine/solverEngine.test.ts`, after the `KillerSolverEngine —
_onCellDetermined override` describe block (around line 113):

```ts
describe('SolverEngine._checkAgainstGolden', () => {
  class TestEngine extends KillerSolverEngine {
    checkGolden(ruleName: string, cell: Cell, digit: number): void {
      this._checkAgainstGolden(ruleName, cell, digit);
    }
  }

  it('does nothing when no goldenSolution is set', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new TestEngine(bs, []);
    expect(() => engine.checkGolden('Test', [0, 0] as Cell, 999)).not.toThrow();
  });

  it('does nothing when the digit matches the golden solution', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new TestEngine(bs, [], { goldenSolution: KNOWN_SOLUTION });
    const gold = KNOWN_SOLUTION[0]![0]!;
    expect(() => engine.checkGolden('Test', [0, 0] as Cell, gold)).not.toThrow();
  });

  it('throws when the digit contradicts golden and no onViolation is set', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const engine = new TestEngine(bs, [], { goldenSolution: KNOWN_SOLUTION });
    const gold = KNOWN_SOLUTION[0]![0]!;
    const wrong = gold === 1 ? 2 : 1;
    expect(() => engine.checkGolden('Test', [0, 0] as Cell, wrong)).toThrow();
  });

  it('calls onViolation instead of throwing when provided', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const violations: string[] = [];
    const engine = new TestEngine(bs, [], {
      goldenSolution: KNOWN_SOLUTION,
      onViolation: (name) => violations.push(name),
    });
    const gold = KNOWN_SOLUTION[0]![0]!;
    const wrong = gold === 1 ? 2 : 1;
    expect(() => engine.checkGolden('Test', [0, 0] as Cell, wrong)).not.toThrow();
    expect(violations).toEqual(['Test']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/engine/solverEngine.test.ts -t _checkAgainstGolden`
Expected: FAIL — `Property '_checkAgainstGolden' is private and only accessible within class 'SolverEngine'` (TS error) or `not a function`.

- [ ] **Step 3: Make `_goldenSolution`/`_onViolation` protected and add `_checkAgainstGolden`**

In `web/src/engine/solverEngine.ts`, change lines 188-189 from:

```ts
  private readonly _goldenSolution: readonly (readonly number[])[] | null;
  private readonly _onViolation: ((ruleName: string, offending: readonly Elimination[]) => void) | null;
```

to:

```ts
  protected readonly _goldenSolution: readonly (readonly number[])[] | null;
  protected readonly _onViolation: ((ruleName: string, offending: readonly Elimination[]) => void) | null;
```

Then add a new method directly after the `_onCellDetermined` declaration (after line 220,
`protected _onCellDetermined(_cell: Cell, _val: number): void {}`):

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/engine/solverEngine.test.ts -t _checkAgainstGolden`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/user/cagedoku
bash scripts/run-bronze-gate.sh
git add web/src/engine/solverEngine.ts web/src/engine/solverEngine.test.ts
git commit -m "feat: add protected _checkAgainstGolden helper to SolverEngine"
```

---

### Task 2: `pendingVirtualCages` field + remove `substituteCell`

**Files:**
- Modify: `web/src/engine/linearSystem.ts:17` (import), `:94` (field), `:251-293` (delete method)
- Modify: `web/src/engine/solverEngine.ts:417-418` (call site)
- Modify: `web/src/engine/solverEngine.test.ts:99-113` (replace spy test)

- [ ] **Step 1: Update the existing `_onCellDetermined` spy test**

In `web/src/engine/solverEngine.test.ts`, replace the `KillerSolverEngine —
_onCellDetermined override` describe block (lines 99-113):

```ts
describe('KillerSolverEngine — _onCellDetermined override', () => {
  it('delegates to LinearSystem.substituteCell and substituteLiveRows on cell determination', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const engine = new KillerSolverEngine(board, []);
    const substituteCellSpy = vi.spyOn(board.linearSystem, 'substituteCell');
    const substituteLiveRowsSpy = vi.spyOn(board.linearSystem, 'substituteLiveRows');
    // Eliminate 8 of (0,0)'s 9 candidates, leaving exactly digit 9 — this fires
    // CELL_DETERMINED for cell [0,0] with value 9, which the override forwards
    // to both LinearSystem methods with that exact (cell, value) pair.
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    engine.applyEliminations(eliminations);
    expect(substituteCellSpy).toHaveBeenCalledWith([0, 0], 9);
    expect(substituteLiveRowsSpy).toHaveBeenCalledWith([0, 0], 9);
  });
});
```

with:

```ts
describe('KillerSolverEngine — _onCellDetermined override', () => {
  it('delegates to LinearSystem.substituteLiveRows on cell determination', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const engine = new KillerSolverEngine(board, []);
    const substituteLiveRowsSpy = vi.spyOn(board.linearSystem, 'substituteLiveRows');
    // Eliminate 8 of (0,0)'s 9 candidates, leaving exactly digit 9 — this fires
    // CELL_DETERMINED for cell [0,0] with value 9, which the override forwards
    // to LinearSystem.substituteLiveRows with that exact (cell, value) pair.
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    engine.applyEliminations(eliminations);
    expect(substituteLiveRowsSpy).toHaveBeenCalledWith([0, 0], 9);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/engine/solverEngine.test.ts -t "delegates to LinearSystem.substituteLiveRows"`
Expected: FAIL — `board.linearSystem.substituteCell is not a function` does NOT occur yet
(substituteCell still exists), but the spy assertion for `substituteCellSpy` is gone so
this specific test should actually PASS already. This step instead confirms the test
compiles and passes against the *current* code (sanity check before removing `substituteCell`).
Expected: PASS.

- [ ] **Step 3: Add `pendingVirtualCages` field to `LinearSystem`**

In `web/src/engine/linearSystem.ts`, change line 17 from:

```ts
import type { Cell, Elimination } from './types.js';
```

to:

```ts
import type { Cell, Elimination, VirtualCageAddition } from './types.js';
```

Then add the field after `virtualCages: VirtualCage[] = [];` (line 94):

```ts
  virtualCages: VirtualCage[] = [];

  /** Cell-sets + totals derived by substituteLiveRows, awaiting application via
   *  the DerivedVirtualCage rule. Consumed (shift()'d) by SolverEngine.solve(). */
  pendingVirtualCages: VirtualCageAddition[] = [];
```

- [ ] **Step 4: Delete `LinearSystem.substituteCell`**

In `web/src/engine/linearSystem.ts`, delete the entire `substituteCell` method
(lines 251-293, including the blank line before `substituteLiveRows`):

```ts
  substituteCell(cell: Cell, value: number): Elimination[] {
    const ck = cellKey(cell);
    const eliminations: Elimination[] = [];

    for (const pair of this._pairsByCell.get(ck) ?? []) {
      const [p, q, delta] = pair;
      const pk = cellKey(p);
      const idx = this.deltaPairs.indexOf(pair);
      if (idx >= 0) this.deltaPairs.splice(idx, 1);
      const other = pk === ck ? q : p;
      const otherKey = cellKey(other);
      const otherPairs = this._pairsByCell.get(otherKey);
      if (otherPairs) { const oi = otherPairs.indexOf(pair); if (oi >= 0) otherPairs.splice(oi, 1); }
      const otherVal = pk === ck ? value - delta : value + delta;
      if (otherVal >= 1 && otherVal <= 9) {
        for (let d = 1; d <= 9; d++) {
          if (d !== otherVal) eliminations.push({ cell: other, digit: d });
        }
      }
    }
    this._pairsByCell.delete(ck);

    for (const pair of this._sumPairsByCell.get(ck) ?? []) {
      const [a, , total] = pair;
      const ak = cellKey(a);
      const idx = this.sumPairs.indexOf(pair);
      if (idx >= 0) this.sumPairs.splice(idx, 1);
      const other = ak === ck ? pair[1] : a;
      const otherKey = cellKey(other);
      const otherPairs = this._sumPairsByCell.get(otherKey);
      if (otherPairs) { const oi = otherPairs.indexOf(pair); if (oi >= 0) otherPairs.splice(oi, 1); }
      const otherVal = total - value;
      if (otherVal >= 1 && otherVal <= 9) {
        for (let d = 1; d <= 9; d++) {
          if (d !== otherVal) eliminations.push({ cell: other, digit: d });
        }
      }
    }
    this._sumPairsByCell.delete(ck);

    return eliminations;
  }

  substituteLiveRows(cell: Cell, value: number): Array<readonly [readonly Cell[], number, boolean]> {
```

becomes:

```ts
  substituteLiveRows(cell: Cell, value: number): Array<readonly [readonly Cell[], number, boolean]> {
```

- [ ] **Step 5: Remove the `substituteCell` call site in `KillerSolverEngine._onCellDetermined`**

In `web/src/engine/solverEngine.ts`, lines 416-419 currently read:

```ts
  protected override _onCellDetermined(cell: Cell, val: number): void {
    const newElims = this.board.linearSystem.substituteCell(cell, val);
    if (newElims.length > 0) this.applyEliminations(newElims);
    const newConstraints = this.board.linearSystem.substituteLiveRows(cell, val);
```

Change to:

```ts
  protected override _onCellDetermined(cell: Cell, val: number): void {
    const newConstraints = this.board.linearSystem.substituteLiveRows(cell, val);
```

- [ ] **Step 6: Run the full test suite and tsc**

Run: `cd web && npx vitest run src/engine/ && tsc --noEmit`
Expected: PASS — all existing tests still pass (the `_onCellDetermined` body still
processes `newConstraints` via `filterSumConstraint`/`filterSumRange`, unchanged
in this task).

- [ ] **Step 7: Commit**

```bash
cd /home/user/cagedoku
bash scripts/run-bronze-gate.sh
git add web/src/engine/linearSystem.ts web/src/engine/solverEngine.ts web/src/engine/solverEngine.test.ts
git commit -m "refactor: remove LinearSystem.substituteCell, add pendingVirtualCages queue"
```

---

### Task 3: Rewrite `_onCellDetermined` as bookkeeping-only; remove dead filter helpers

**Files:**
- Modify: `web/src/engine/solverEngine.ts` (imports, delete `filterSumRange`/`filterSumConstraint`, rewrite `_onCellDetermined`)
- Test: `web/src/engine/solverEngine.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `web/src/engine/solverEngine.test.ts`, after the (now-updated)
`KillerSolverEngine — _onCellDetermined override` describe block:

```ts
describe('KillerSolverEngine._onCellDetermined — bookkeeping only', () => {
  it('pushes a multi-cell distinct substituteLiveRows result onto pendingVirtualCages', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const engine = new KillerSolverEngine(board, []);
    vi.spyOn(board.linearSystem, 'substituteLiveRows').mockReturnValue([
      [[[1, 1], [1, 2]] as Cell[], 10, true],
    ]);
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    engine.applyEliminations(eliminations);
    expect(board.linearSystem.pendingVirtualCages).toEqual([
      { cells: [[1, 1], [1, 2]], total: 10 },
    ]);
  });

  it('drops a non-distinct substituteLiveRows result entirely', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const engine = new KillerSolverEngine(board, []);
    vi.spyOn(board.linearSystem, 'substituteLiveRows').mockReturnValue([
      [[[1, 1], [1, 2]] as Cell[], 10, false],
    ]);
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    engine.applyEliminations(eliminations);
    expect(board.linearSystem.pendingVirtualCages).toEqual([]);
  });

  it('skips a result whose cell-set already matches an existing unit', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const engine = new KillerSolverEngine(board, []);
    // Row 1 (unitId 1) covers all of row index 1 — reuse its cell-set.
    const rowCells = board.units[1]!.cells as Cell[];
    vi.spyOn(board.linearSystem, 'substituteLiveRows').mockReturnValue([
      [rowCells, 45, true],
    ]);
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    engine.applyEliminations(eliminations);
    expect(board.linearSystem.pendingVirtualCages).toEqual([]);
  });

  it('eager golden-check: a single-cell result contradicting golden reports a violation', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const violations: string[] = [];
    const engine = new KillerSolverEngine(board, [], {
      goldenSolution: KNOWN_SOLUTION,
      onViolation: (name) => violations.push(name),
    });
    const gold = KNOWN_SOLUTION[1]![1]!;
    const wrong = gold === 1 ? 2 : 1;
    vi.spyOn(board.linearSystem, 'substituteLiveRows').mockReturnValue([
      [[[1, 1]] as Cell[], wrong, true],
    ]);
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    engine.applyEliminations(eliminations);
    expect(violations).toEqual(['DerivedVirtualCage']);
  });

  it('eager golden-check: throws when no onViolation handler is set', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const engine = new KillerSolverEngine(board, [], { goldenSolution: KNOWN_SOLUTION });
    const gold = KNOWN_SOLUTION[1]![1]!;
    const wrong = gold === 1 ? 2 : 1;
    vi.spyOn(board.linearSystem, 'substituteLiveRows').mockReturnValue([
      [[[1, 1]] as Cell[], wrong, true],
    ]);
    const eliminations = [1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ cell: [0, 0] as Cell, digit: d }));
    expect(() => engine.applyEliminations(eliminations)).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/engine/solverEngine.test.ts -t "bookkeeping only"`
Expected: FAIL — `pendingVirtualCages` stays empty in the multi-cell test (current
code routes through `filterSumConstraint`/`filterSumRange` and never pushes), and
the golden-check tests don't report/throw (current code calls `filterSumConstraint`
on `[[1,1]]` with the wrong total, which doesn't check golden at all).

- [ ] **Step 3: Rewrite `_onCellDetermined` and remove dead helpers**

In `web/src/engine/solverEngine.ts`:

1. Remove the `solSums` import (line 20) — it becomes unused:

```ts
import { solSums } from '../solver/equation.js';
```
→ delete this line entirely.

2. Add `cellKey` to the `./types.js` import (line 22-32). Change:

```ts
import {
  BoardEvent,
  Cell,
  Elimination,
  Placement,
  SolutionElimination,
  Trigger,
  UnitKind,
  VirtualCageAddition,
  hasProgress,
} from './types.js';
```

to:

```ts
import {
  BoardEvent,
  Cell,
  cellKey,
  Elimination,
  Placement,
  SolutionElimination,
  Trigger,
  UnitKind,
  VirtualCageAddition,
  hasProgress,
} from './types.js';
```

3. Delete `filterSumRange` (lines 50-76, including its doc comment) and
   `filterSumConstraint` (lines 78-126, including its doc comment) entirely —
   i.e. everything between `unitKindFromId` and `dedupHints` becomes just the
   blank separator lines.

4. Rewrite `KillerSolverEngine._onCellDetermined` (currently lines 416-434):

```ts
  protected override _onCellDetermined(cell: Cell, val: number): void {
    const newConstraints = this.board.linearSystem.substituteLiveRows(cell, val);
    if (newConstraints.length === 0) return;

    const existingCellSets = new Set(
      this.board.units.map(u => u.cells.map(cellKey).slice().sort().join('|')),
    );
    for (const [vcells, vtotal, distinct] of newConstraints) {
      if (!distinct) continue;
      const cells = [...vcells] as Cell[];
      if (cells.length === 1) {
        this._checkAgainstGolden('DerivedVirtualCage', cells[0]!, vtotal);
      }
      const key = cells.map(cellKey).slice().sort().join('|');
      if (existingCellSets.has(key)) continue;
      existingCellSets.add(key);
      this.board.linearSystem.pendingVirtualCages.push({ cells, total: vtotal });
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/engine/solverEngine.test.ts`
Expected: PASS (all tests in the file, including the new `bookkeeping only` block).

- [ ] **Step 5: Run tsc to confirm no unused-import/dead-code errors**

Run: `cd web && tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/user/cagedoku
bash scripts/run-bronze-gate.sh
git add web/src/engine/solverEngine.ts web/src/engine/solverEngine.test.ts
git commit -m "refactor: make _onCellDetermined bookkeeping-only, drop filterSumConstraint/filterSumRange"
```

---

### Task 4: New `DerivedVirtualCage` rule

**Files:**
- Create: `web/src/engine/rules/derivedVirtualCage.ts`
- Create: `web/src/engine/rules/derivedVirtualCage.test.ts`
- Modify: `web/src/engine/rules/index.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/engine/rules/derivedVirtualCage.test.ts`:

```ts
/**
 * Tests for DerivedVirtualCage — drains LinearSystem.pendingVirtualCages.
 */

import { describe, expect, it } from 'vitest';
import { DerivedVirtualCage } from './derivedVirtualCage.js';
import { KillerBoardState } from '../boardState.js';
import { makeTrivialSpec } from '../fixtures.js';
import type { Cell } from '../types.js';
import { Trigger } from '../types.js';
import type { KillerRuleContext } from '../rule.js';

function makeCtx(board: KillerBoardState): KillerRuleContext {
  return { unit: null, cell: null, board, hint: Trigger.GLOBAL, hintDigit: null };
}

describe('DerivedVirtualCage', () => {
  it('returns emptyResult when pendingVirtualCages is empty', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    const rule = new DerivedVirtualCage();
    const result = rule.applyKiller(makeCtx(board));
    expect(result.virtualCageAdditions).toEqual([]);
  });

  it('returns exactly one virtualCageAddition (the first entry) when non-empty', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    board.linearSystem.pendingVirtualCages.push(
      { cells: [[0, 0], [0, 1]] as Cell[], total: 10 },
      { cells: [[1, 0], [1, 1]] as Cell[], total: 12 },
    );
    const rule = new DerivedVirtualCage();
    const result = rule.applyKiller(makeCtx(board));
    expect(result.virtualCageAdditions).toEqual([
      { cells: [[0, 0], [0, 1]], total: 10 },
    ]);
    // Pure: does not mutate the queue itself.
    expect(board.linearSystem.pendingVirtualCages).toHaveLength(2);
  });

  it('asHintsKiller surfaces every pending entry as a virtual cage suggestion', () => {
    const board = new KillerBoardState(makeTrivialSpec());
    board.linearSystem.pendingVirtualCages.push(
      { cells: [[0, 0], [0, 1]] as Cell[], total: 10 },
      { cells: [[1, 0], [1, 1]] as Cell[], total: 12 },
    );
    const rule = new DerivedVirtualCage();
    const hints = rule.asHintsKiller(makeCtx(board), []);
    expect(hints).toHaveLength(2);
    expect(hints[0]!.virtualCageSuggestion).toEqual([[[0, 0], [0, 1]], 10]);
    expect(hints[1]!.virtualCageSuggestion).toEqual([[[1, 0], [1, 1]], 12]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/engine/rules/derivedVirtualCage.test.ts`
Expected: FAIL — `Cannot find module './derivedVirtualCage.js'`.

- [ ] **Step 3: Create the rule**

Create `web/src/engine/rules/derivedVirtualCage.ts`:

```ts
/**
 * DerivedVirtualCage — surfaces cell-sets + totals derived by
 * LinearSystem.substituteLiveRows as virtual cages.
 *
 * Mirrors no Python module — this rule is new in the TS engine.
 *
 * pendingVirtualCages entries are linear combinations of existing row/col/box/cage
 * sum equations (produced by LinearSystem's live-row Gaussian-elimination
 * reduction), so any valid solution satisfies them — adding them as cages is sound.
 */

import type { HintResult } from '../hint.js';
import { KillerOnlyRule } from '../rule.js';
import type { KillerRuleContext } from '../rule.js';
import { cellLabel } from './_labels.js';
import { Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';

export class DerivedVirtualCage extends KillerOnlyRule {
  readonly name = 'DerivedVirtualCage';
  readonly displayName = 'Derived Virtual Cage';
  readonly description = `
Derived Virtual Cage — adds a cell-set + total derived from the linear system as a virtual cage.

LinearSystem.substituteLiveRows reduces the row/col/box/cage sum equations as cells become
determined. Each remaining single-coefficient row of the form "these cells sum to T" is a
linear combination of the original equations, so it holds for every valid solution —
adding it as a virtual cage cannot eliminate the correct digit from any cell.

Guards:
  ctx.board.linearSystem.pendingVirtualCages   only system-derived cell-sets are surfaced
`.trim();
  readonly priority = 1;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  applyKiller(ctx: KillerRuleContext): RuleResult {
    const pending = ctx.board.linearSystem.pendingVirtualCages;
    if (pending.length === 0) return emptyResult();
    return { ...emptyResult(), virtualCageAdditions: [pending[0]!] };
  }

  asHintsKiller(ctx: KillerRuleContext, _eliminations: readonly Elimination[]): HintResult[] {
    const pending = ctx.board.linearSystem.pendingVirtualCages;
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

- [ ] **Step 4: Register the rule**

In `web/src/engine/rules/index.ts`:

1. Add to the priority-order doc comment (after `1  LinearElimination       — GLOBAL`):

```
 *  1  DerivedVirtualCage      — GLOBAL
```

2. Add the import (alphabetical, after `DeltaConstraint`):

```ts
import { DerivedVirtualCage } from './derivedVirtualCage.js';
```

3. Add to the `export { ... }` block (alphabetical, after `DeltaConstraint`):

```ts
  DerivedVirtualCage,
```

4. Add to `defaultRules()` (after `new DeltaConstraint(),`... actually alongside
   `LinearElimination` for priority grouping — add immediately after
   `new LinearElimination(),`):

```ts
    new LinearElimination(),
    new DerivedVirtualCage(),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/engine/rules/derivedVirtualCage.test.ts && tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/user/cagedoku
bash scripts/run-bronze-gate.sh
git add web/src/engine/rules/derivedVirtualCage.ts web/src/engine/rules/derivedVirtualCage.test.ts web/src/engine/rules/index.ts
git commit -m "feat: add DerivedVirtualCage rule to drain pendingVirtualCages"
```

---

### Task 5: `solve()` applies `virtualCageAdditions`, golden-checked

**Files:**
- Modify: `web/src/engine/solverEngine.ts:299-401` (`solve()`)
- Test: `web/src/engine/solverEngine.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `web/src/engine/solverEngine.test.ts`, after the existing `SolverEngine virtual
cage additions` describe block (currently ends around line 225):

```ts
describe('SolverEngine.solve — applies virtualCageAdditions', () => {
  it('calls addVirtualCage, shifts pendingVirtualCages, and evaluates the new unit', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const gold = KNOWN_SOLUTION;
    const cells = [[0, 0], [0, 1]] as Cell[];
    const total = gold[0]![0]! + gold[0]![1]!;
    bs.linearSystem.pendingVirtualCages.push({ cells, total });

    let fired = false;
    const vca = { cells, total };
    const rule: SolverRule = {
      name: 'vcaStub', displayName: 'vcaStub', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(_ctx: RuleContext): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), virtualCageAdditions: [vca] };
      },
      asHints() { return []; },
    };

    const unitsBefore = bs.units.length;
    const engine = new KillerSolverEngine(bs, [rule], { goldenSolution: gold });
    engine.solve();

    expect(bs.units.length).toBe(unitsBefore + 1);
    expect(bs.linearSystem.pendingVirtualCages).toEqual([]);
    expect(engine.appliedVirtualCages).toEqual([vca]);
    const mutation = engine.appliedMutations.find(m => m.type === 'virtual_cage_added');
    expect(mutation).toBeDefined();
  });

  it('golden-check: a virtualCageAddition whose cells sum to the wrong total is not applied', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const gold = KNOWN_SOLUTION;
    const cells = [[0, 0], [0, 1]] as Cell[];
    const wrongTotal = gold[0]![0]! + gold[0]![1]! + 1;
    bs.linearSystem.pendingVirtualCages.push({ cells, total: wrongTotal });

    let fired = false;
    const vca = { cells, total: wrongTotal };
    const rule: SolverRule = {
      name: 'badVcaRule', displayName: 'badVcaRule', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(_ctx: RuleContext): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), virtualCageAdditions: [vca] };
      },
      asHints() { return []; },
    };

    const unitsBefore = bs.units.length;
    const violations: string[] = [];
    const engine = new KillerSolverEngine(bs, [rule], {
      goldenSolution: gold,
      onViolation: (name) => violations.push(name),
    });
    engine.solve();

    expect(violations).toEqual(['badVcaRule']);
    expect(bs.units.length).toBe(unitsBefore);
    expect(engine.appliedVirtualCages).toEqual([]);
  });

  it('golden-check: throws when no onViolation handler is set', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const gold = KNOWN_SOLUTION;
    const cells = [[0, 0], [0, 1]] as Cell[];
    const wrongTotal = gold[0]![0]! + gold[0]![1]! + 1;
    bs.linearSystem.pendingVirtualCages.push({ cells, total: wrongTotal });

    let fired = false;
    const vca = { cells, total: wrongTotal };
    const rule: SolverRule = {
      name: 'badVcaRule', displayName: 'badVcaRule', description: '', priority: 5,
      killerOnly: false,
      triggers: new Set([Trigger.GLOBAL]), unitKinds: new Set(),
      apply(_ctx: RuleContext): RuleResult {
        if (fired) return emptyResult();
        fired = true;
        return { ...emptyResult(), virtualCageAdditions: [vca] };
      },
      asHints() { return []; },
    };

    const engine = new KillerSolverEngine(bs, [rule], { goldenSolution: gold });
    expect(() => engine.solve()).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/engine/solverEngine.test.ts -t "applies virtualCageAdditions"`
Expected: FAIL — `bs.units.length` unchanged (nothing calls `addVirtualCage` today),
and the golden-check tests see no violations/throws.

- [ ] **Step 3: Extend `solve()`**

In `web/src/engine/solverEngine.ts`, the main loop's `else` branch (currently
lines 351-396) is:

```ts
      } else {
        if (result.eliminations.length > 0) {
          if (this._goldenSolution !== null) {
            const offending = result.eliminations.filter(e => {
              const [r, c] = e.cell;
              const gold = this._goldenSolution![r]?.[c];
              return gold !== undefined && e.digit === gold && this.board.cands(r, c).has(gold);
            });
            if (offending.length > 0) {
              if (this._onViolation !== null) {
                // Report only the first violation per solve() pass — subsequent
                // violations may be cascades of the first bug.
                if (!this._violationFired) {
                  this._onViolation(item.rule.name, offending);
                  this._violationFired = true;
                }
                // Always suppress the entire rule result regardless of whether
                // the violation was reported.
                continue;
              } else {
                const [r, c] = offending[0]!.cell;
                const gold = offending[0]!.digit;
                throw new NoSolnError(
                  `${item.rule.name}: would eliminate correct digit ${gold} from r${r + 1}c${c + 1}`,
                );
              }
            }
          }
          for (const e of result.eliminations)
            this.appliedMutations.push({ ruleName: item.rule.name, type: 'candidate_removed',
              row: e.cell[0], col: e.cell[1], digit: e.digit });
          this.applyEliminations(result.eliminations);
        }
        for (const p of result.placements) {
          this.appliedPlacements.push(p);
          this.appliedMutations.push({ ruleName: item.rule.name, type: 'placement',
            row: p.cell[0], col: p.cell[1], digit: p.digit });
        }
        for (const se of result.solutionEliminations)
          this._onSolutionElimination(se, item.rule.name);
        for (const vca of result.virtualCageAdditions) {
          this.appliedVirtualCages.push(vca);
          this.appliedMutations.push({ ruleName: item.rule.name, type: 'virtual_cage_added',
            cells: vca.cells, total: vca.total });
        }
      }
```

Replace it with:

```ts
      } else {
        if (this._goldenSolution !== null && result.virtualCageAdditions.length > 0) {
          const offending = result.virtualCageAdditions.find(vca => {
            const goldSum = vca.cells.reduce((sum, [r, c]) => sum + this._goldenSolution![r]![c]!, 0);
            return goldSum !== vca.total;
          });
          if (offending !== undefined) {
            if (this._onViolation !== null) {
              // Report only the first violation per solve() pass — subsequent
              // violations may be cascades of the first bug.
              if (!this._violationFired) {
                this._onViolation(item.rule.name, []);
                this._violationFired = true;
              }
              // Always suppress the entire rule result regardless of whether
              // the violation was reported.
              continue;
            } else {
              const goldSum = offending.cells.reduce((sum, [r, c]) => sum + this._goldenSolution![r]![c]!, 0);
              throw new NoSolnError(
                `${item.rule.name}: virtual cage ${offending.cells.map(c => cellLabel(c)).join('+')} = ${offending.total} ` +
                `contradicts golden solution (sums to ${goldSum})`,
              );
            }
          }
        }

        if (result.eliminations.length > 0) {
          if (this._goldenSolution !== null) {
            const offending = result.eliminations.filter(e => {
              const [r, c] = e.cell;
              const gold = this._goldenSolution![r]?.[c];
              return gold !== undefined && e.digit === gold && this.board.cands(r, c).has(gold);
            });
            if (offending.length > 0) {
              if (this._onViolation !== null) {
                // Report only the first violation per solve() pass — subsequent
                // violations may be cascades of the first bug.
                if (!this._violationFired) {
                  this._onViolation(item.rule.name, offending);
                  this._violationFired = true;
                }
                // Always suppress the entire rule result regardless of whether
                // the violation was reported.
                continue;
              } else {
                const [r, c] = offending[0]!.cell;
                const gold = offending[0]!.digit;
                throw new NoSolnError(
                  `${item.rule.name}: would eliminate correct digit ${gold} from r${r + 1}c${c + 1}`,
                );
              }
            }
          }
          for (const e of result.eliminations)
            this.appliedMutations.push({ ruleName: item.rule.name, type: 'candidate_removed',
              row: e.cell[0], col: e.cell[1], digit: e.digit });
          this.applyEliminations(result.eliminations);
        }
        for (const p of result.placements) {
          this.appliedPlacements.push(p);
          this.appliedMutations.push({ ruleName: item.rule.name, type: 'placement',
            row: p.cell[0], col: p.cell[1], digit: p.digit });
        }
        for (const se of result.solutionEliminations)
          this._onSolutionElimination(se, item.rule.name);
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
      }
```

Note: `this.board` is typed `BoardState` on `SolverEngine`, but `addVirtualCage` is
only defined on `KillerBoardState`. Since `result.virtualCageAdditions` is only ever
non-empty for killer-only rules (which only run when `ctx.board instanceof
KillerBoardState`, per `KillerOnlyRule.apply`), this is safe at runtime. To satisfy
the type checker without a cast, narrow with `instanceof` inside the loop:

```ts
        for (const vca of result.virtualCageAdditions) {
          if (!(this.board instanceof KillerBoardState)) continue;
          this.board.addVirtualCage(vca.cells, vca.total, []);
          this.board.linearSystem.pendingVirtualCages.shift();
          ...
```

Use this `instanceof`-guarded version of the loop (replacing the unguarded one above).

Add `cellLabel` to the imports at the top of `web/src/engine/solverEngine.ts`:

```ts
import { cellLabel } from './rules/_labels.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/engine/solverEngine.test.ts && tsc --noEmit`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run the full engine test suite**

Run: `cd web && npx vitest run src/engine/`
Expected: PASS — fixture-based regression tests (`__fixtures__/index.ts`) continue
to pass; only `distinct === false` derivations now produce fewer automatic
eliminations (per spec, an acceptable bounded change).

- [ ] **Step 6: Commit**

```bash
cd /home/user/cagedoku
bash scripts/run-bronze-gate.sh
git add web/src/engine/solverEngine.ts web/src/engine/solverEngine.test.ts
git commit -m "feat: solve() applies virtualCageAdditions via addVirtualCage, golden-checked"
```

---

### Task 6: Update `SumPairConstraint`'s stale comments

**Files:**
- Modify: `web/src/engine/rules/sumPairConstraint.ts:10-12, 32, 42`

- [ ] **Step 1: Update the module doc comment**

In `web/src/engine/rules/sumPairConstraint.ts`, lines 10-12:

```ts
 * Sum pairs do not enforce digit distinctness — the cells are typically
 * non-burb so repeated digits are allowed. CELL_DETERMINED is handled by
 * LinearSystem.substituteCell; this rule handles COUNT_DECREASED filtering.
 */
```

becomes:

```ts
 * Sum pairs do not enforce digit distinctness — the cells are typically
 * non-burb so repeated digits are allowed. removeCandidate emits
 * COUNT_DECREASED for a cell's units before CELL_DETERMINED, so by the time
 * CELL_DETERMINED fires the COUNT_DECREASED-triggered pass for the same cell
 * has already narrowed the partner cell; the CELL_DETERMINED-triggered pass
 * is redundant and skipped.
 */
```

- [ ] **Step 2: Update the `description` guard line**

Line 32:

```ts
  ctx.hint !== CELL_DETERMINED   CELL_DETERMINED is handled by LinearSystem.substituteCell
```

becomes:

```ts
  ctx.hint !== CELL_DETERMINED   redundant with the COUNT_DECREASED pass already triggered for the cell's units when it was determined
```

- [ ] **Step 3: Update the inline guard comment**

Line 42:

```ts
    // CELL_DETERMINED is handled by LinearSystem.substituteCell — skip here
```

becomes:

```ts
    // Redundant with the COUNT_DECREASED pass triggered for the cell's units
    // when it was determined — skip here.
```

- [ ] **Step 4: Run tsc and the rule's tests**

Run: `cd web && npx vitest run src/engine/rules/sumPairConstraint.test.ts && tsc --noEmit`
Expected: PASS — comment-only change.

- [ ] **Step 5: Commit**

```bash
cd /home/user/cagedoku
bash scripts/run-bronze-gate.sh
git add web/src/engine/rules/sumPairConstraint.ts
git commit -m "docs: update SumPairConstraint comments for substituteCell removal"
```

---

### Task 7: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit test suite**

Run: `cd web && npx vitest run`
Expected: PASS — including all `__fixtures__`-based regression tests.

- [ ] **Step 2: Run tsc for both configs**

Run: `cd web && tsc --noEmit && tsc -p tsconfig.node.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Verify no remaining references to removed symbols**

Run: `cd web/src && grep -rn "substituteCell\|filterSumConstraint\|filterSumRange"`
Expected: no matches (the grep itself should print nothing).

- [ ] **Step 4: Commit (if any cleanup was needed)**

If steps 1-3 required additional fixes, stage and commit them with a descriptive
message. If everything already passed, no commit is needed for this task.

---

## Self-Review Notes

- **Spec coverage:** §1 (Task 2), §2/§2a (Tasks 1 & 3), §3 (Task 4), §4 (Task 5),
  §5 (Tasks 3 & 7, dead-code removal), SumPairConstraint comment (Task 6) — all covered.
- **Eager golden-check test placement:** the spec's Testing section says
  "`linearSystem.test.ts`: test the eager golden-check path" — but the eager check
  (`_checkAgainstGolden`) lives on `SolverEngine`/`KillerSolverEngine`, not
  `LinearSystem`, which has no golden-solution concept. This plan places the
  eager-check tests in `solverEngine.test.ts` (Tasks 1 and 3) where the logic
  actually executes, using a `vi.spyOn(board.linearSystem, 'substituteLiveRows')`
  mock to drive the scenario deterministically.
- **`distinct === false` dropped case:** Task 3's "drops a non-distinct result"
  test directly covers this; Task 7 confirms existing fixtures still pass with
  the narrower automatic-elimination surface.
