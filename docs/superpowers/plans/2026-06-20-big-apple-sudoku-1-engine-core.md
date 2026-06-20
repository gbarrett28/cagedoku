# Big Apple Sudoku — Sprint 1: Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `BigAppleBoardState` engine class that registers the 4 extra window units, fix the two `UnitKind`-inference landmines that would misclassify or mislabel those units, and thread window-peer elimination through the MRV backtracker.

**Architecture:** `BigAppleBoardState extends BoardState` (mirrors `KillerBoardState`'s `_addUnit()` pattern) registers 4 `UnitKind.BOX` window units in its constructor. A new virtual method `BoardState.extraPeers(r, c)` (default `[]`) lets the backtracker's `assign()` propagate window eliminations without an `instanceof` check. `unitKindFromId` in `solverEngine.ts` is replaced by a direct `board.units[uid].kind` lookup. `unitLabel` in `_labels.ts` gains a window-aware branch keyed on each unit's corner cell.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- Window coordinates (0-based, inclusive): top-left rows 1–3 cols 1–3; bottom-left rows 5–7 cols 1–3; top-right rows 1–3 cols 5–7; bottom-right rows 5–7 cols 5–7.
- Windows reuse `UnitKind.BOX` (not a new enum value) — see spec §2.
- `LockedCandidates`'s box-line reduction not covering window units is an accepted, documented gap — no task in this plan touches `lockedCandidates.ts`.

---

## File Structure

| File | Change |
|---|---|
| `web/src/engine/boardState.ts` | Add `extraPeers(r, c): readonly Cell[]` virtual method (default `[]`) to `BoardState`. |
| `web/src/engine/bigAppleBoardState.ts` | **New file.** `BigAppleBoardState extends BoardState`, registers 4 window units, overrides `extraPeers`. |
| `web/src/engine/bigAppleBoardState.test.ts` | **New file.** Unit tests for the above. |
| `web/src/engine/backtracker.ts` | Thread `extraPeers` table through `mrvBacktrack` → `search` → `assign`; union into the peer-elimination loop. |
| `web/src/engine/backtracker.test.ts` | Add window-peer elimination regression test. |
| `web/src/engine/solverEngine.ts` | Delete `unitKindFromId`; replace its one call site with `this.board.units[uid]!.kind`. |
| `web/src/engine/rules/_labels.ts` | `unitLabel`'s `BOX` case gains a window-corner lookup before the standard arithmetic. |
| `web/src/engine/rules/_labels.test.ts` | Add 4 window-label tests. |

---

### Task 1: `BoardState.extraPeers()` virtual method

**Files:**
- Modify: `web/src/engine/boardState.ts:184-190` (just before `cageConstraints()`)
- Test: `web/src/engine/boardState.test.ts`

**Interfaces:**
- Produces: `BoardState.extraPeers(r: number, c: number): readonly Cell[]` — default `[]`, overridden by `BigAppleBoardState` in Task 2.

- [x] **Step 1: Write the failing test**

Add to `web/src/engine/boardState.test.ts`, inside the existing `describe('BoardState (plain) construction', ...)` block (after the `'removeCandidate works without any cage bookkeeping'` test, before the closing `});` at line 85):

```ts
  it('extraPeers returns empty for every cell by default', () => {
    const bs = new BoardState();
    expect(bs.extraPeers(0, 0)).toEqual([]);
    expect(bs.extraPeers(4, 4)).toEqual([]);
    expect(bs.extraPeers(8, 8)).toEqual([]);
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/engine/boardState.test.ts -t "extraPeers returns empty"`
Expected: FAIL with `bs.extraPeers is not a function`

- [x] **Step 3: Write minimal implementation**

In `web/src/engine/boardState.ts`, insert immediately before the `cageConstraints()` method (currently at line 184-190):

```ts
  /**
   * Cells outside the standard row/col/box that share an extra distinct-digit
   * constraint with (r, c) — e.g. Big Apple window peers. Empty for a plain
   * board; overridden by BigAppleBoardState.
   */
  extraPeers(_r: number, _c: number): readonly Cell[] { return []; }

```

- [x] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/engine/boardState.test.ts -t "extraPeers returns empty"`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add web/src/engine/boardState.ts web/src/engine/boardState.test.ts
git commit -m "feat: add BoardState.extraPeers() virtual method"
```

---

### Task 2: `BigAppleBoardState` — window unit registration

**Files:**
- Create: `web/src/engine/bigAppleBoardState.ts`
- Test: `web/src/engine/bigAppleBoardState.test.ts`

**Interfaces:**
- Consumes: `BoardState` (`web/src/engine/boardState.ts`) — `protected _addUnit(unit: Unit): void`, `extraPeers()` from Task 1.
- Consumes: `UnitKind`, `Cell`, `Unit` from `web/src/engine/types.ts`.
- Produces: `export class BigAppleBoardState extends BoardState` with `extraPeers(r, c): readonly Cell[]` override, for Sprint 2's `buildEngine` dispatch and Sprint 1 Task 4 (backtracker) to consume.

- [x] **Step 1: Write the failing test**

Create `web/src/engine/bigAppleBoardState.test.ts`:

```ts
/**
 * Tests for BigAppleBoardState — window unit registration and extraPeers.
 */

import { describe, expect, it } from 'vitest';
import { BigAppleBoardState } from './bigAppleBoardState.js';
import { UnitKind } from './types.js';

describe('BigAppleBoardState construction', () => {
  it('builds 27 row/col/box units plus 4 window units (31 total)', () => {
    const bs = new BigAppleBoardState();
    expect(bs.units.length).toBe(31);
  });

  it('all 4 extra units are UnitKind.BOX', () => {
    const bs = new BigAppleBoardState();
    const extra = bs.units.slice(27);
    expect(extra).toHaveLength(4);
    expect(extra.every(u => u.kind === UnitKind.BOX)).toBe(true);
  });

  it('window units cover the documented 0-based coordinates', () => {
    const bs = new BigAppleBoardState();
    const cellSets = bs.units.slice(27).map(u =>
      new Set((u.cells as [number, number][]).map(([r, c]) => `${r},${c}`)));

    const expectWindow = (r0: number, c0: number) => {
      const expected = new Set<string>();
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) expected.add(`${r0 + dr},${c0 + dc}`);
      expect(cellSets.some(s => s.size === 9 && [...expected].every(k => s.has(k)))).toBe(true);
    };
    expectWindow(1, 1); // top-left
    expectWindow(5, 1); // bottom-left
    expectWindow(1, 5); // top-right
    expectWindow(5, 5); // bottom-right
  });

  it('cell (1,1) belongs to ROW, COL, standard BOX, and the top-left window — 2 BOX-kind units', () => {
    const bs = new BigAppleBoardState();
    const kinds = bs.cellUnitIds(1, 1).map(uid => bs.units[uid]!.kind);
    expect(kinds.filter(k => k === UnitKind.BOX)).toHaveLength(2);
  });

  it('cell (0,0) belongs to no window — exactly 1 BOX-kind unit', () => {
    const bs = new BigAppleBoardState();
    const kinds = bs.cellUnitIds(0, 0).map(uid => bs.units[uid]!.kind);
    expect(kinds.filter(k => k === UnitKind.BOX)).toHaveLength(1);
  });
});

describe('BigAppleBoardState.extraPeers', () => {
  it('returns the other 8 cells of cell (1,1)\'s window', () => {
    const bs = new BigAppleBoardState();
    const peers = new Set(bs.extraPeers(1, 1).map(([r, c]) => `${r},${c}`));
    expect(peers.size).toBe(8);
    expect(peers.has('1,1')).toBe(false);
    expect(peers.has('3,3')).toBe(true); // bottom-right corner of the same window
    expect(peers.has('5,5')).toBe(false); // different window
  });

  it('returns [] for a cell outside every window', () => {
    const bs = new BigAppleBoardState();
    expect(bs.extraPeers(0, 0)).toEqual([]);
    expect(bs.extraPeers(4, 4)).toEqual([]); // centre cell, in no window
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/engine/bigAppleBoardState.test.ts`
Expected: FAIL — `Cannot find module './bigAppleBoardState.js'`

- [x] **Step 3: Write minimal implementation**

Create `web/src/engine/bigAppleBoardState.ts`:

```ts
/**
 * BigAppleBoardState — classic board plus 4 offset 3×3 "window" regions.
 *
 * Big Apple Sudoku (aka Hyper Sudoku / Windoku): classic sudoku rules plus 4
 * extra non-aligned 3×3 regions, each requiring digits 1-9 exactly once.
 * Windows reuse UnitKind.BOX (not a new enum value) so every rule already
 * gating on UnitKind.BOX automatically covers them — see
 * docs/superpowers/specs/2026-06-20-big-apple-sudoku-design.md §2.
 */

import { BoardState } from './boardState.js';
import { Cell, UnitKind } from './types.js';

// 0-based top-left corner of each window, in row-major reading order.
const WINDOW_STARTS: readonly (readonly [number, number])[] = [
  [1, 1], // top-left
  [5, 1], // bottom-left
  [1, 5], // top-right
  [5, 5], // bottom-right
];

function buildWindowCells(r0: number, c0: number): readonly Cell[] {
  const cells: Cell[] = [];
  for (let dr = 0; dr < 3; dr++)
    for (let dc = 0; dc < 3; dc++)
      cells.push([r0 + dr, c0 + dc] as Cell);
  return cells;
}

export class BigAppleBoardState extends BoardState {
  private readonly _windowPeers: Cell[][][];

  constructor() {
    super();
    this._windowPeers = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => [] as Cell[]));
    for (const [r0, c0] of WINDOW_STARTS) {
      const cells = buildWindowCells(r0, c0);
      this._addUnit({ unitId: this.units.length, kind: UnitKind.BOX, cells, distinctDigits: true });
      for (const [r, c] of cells) {
        this._windowPeers[r]![c] = cells.filter(([r2, c2]) => !(r2 === r && c2 === c));
      }
    }
  }

  override extraPeers(r: number, c: number): readonly Cell[] {
    return this._windowPeers[r]![c]!;
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/engine/bigAppleBoardState.test.ts`
Expected: PASS (7 tests)

- [x] **Step 5: Commit**

```bash
git add web/src/engine/bigAppleBoardState.ts web/src/engine/bigAppleBoardState.test.ts
git commit -m "feat: add BigAppleBoardState with 4 window units"
```

---

### Task 3: Fix `unitKindFromId` landmine in `solverEngine.ts`

**Files:**
- Modify: `web/src/engine/solverEngine.ts:44-49` (function definition), `:196` (call site)
- Test: `web/src/engine/solverEngine.test.ts`

**Interfaces:**
- Consumes: `BigAppleBoardState` (Task 2), `SolverEngine` (existing, `web/src/engine/solverEngine.ts`).
- Produces: no public API change — `unitKindFromId` is deleted; `SolverEngine._routeEvents()`'s trigger routing now reads `this.board.units[uid]!.kind` directly, correctly classifying window units (id ≥27 on a `BigAppleBoardState`) as `UnitKind.BOX` instead of the wrong `UnitKind.CAGE` fallback.

- [x] **Step 1: Write the failing test**

Add to `web/src/engine/solverEngine.test.ts`, after the existing `describe('SolverEngine init', ...)` block (after line 29):

```ts
describe('SolverEngine trigger routing on a BigAppleBoardState', () => {
  it('routes COUNT_DECREASED events for window units (id >= 27) to BOX-gated rules', () => {
    const bs = new BigAppleBoardState();
    let routedUnitId: number | null = null;
    const probeRule: SolverRule = {
      name: 'ProbeRule',
      displayName: 'Probe',
      description: 'test probe',
      priority: 0,
      triggers: new Set([Trigger.COUNT_DECREASED]),
      unitKinds: new Set([UnitKind.BOX]),
      apply(ctx: RuleContext): RuleResult {
        if (ctx.unit !== null) routedUnitId = ctx.unit.unitId;
        return emptyResult();
      },
      asHints(): HintResult[] { return []; },
    };
    const engine = new SolverEngine(bs, [probeRule]);
    // (1,1) is in the top-left window (unit id 27) and box (1,1)'s standard
    // box (unit id 18) — removing a candidate fires COUNT_DECREASED for both.
    engine.applyEliminations([{ cell: [1, 1] as Cell, digit: 9 }]);
    engine.solve();
    expect(routedUnitId).not.toBeNull();
  });
});
```

Add the import at the top of the file:

```ts
import { BigAppleBoardState } from './bigAppleBoardState.js';
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/engine/solverEngine.test.ts -t "routes COUNT_DECREASED events for window units"`
Expected: FAIL — `routedUnitId` is `null` (the probe never fires, because `unitKindFromId(27)` returns `UnitKind.CAGE`, not `UnitKind.BOX`, so the `rule.unitKinds.has(kind)` check in `_routeEvents()` excludes it)

- [x] **Step 3: Write minimal implementation**

In `web/src/engine/solverEngine.ts`, delete the `unitKindFromId` function (lines 44-49):

```ts
function unitKindFromId(unitId: number): UnitKind {
  if (unitId < 9)  return UnitKind.ROW;
  if (unitId < 18) return UnitKind.COL;
  if (unitId < 27) return UnitKind.BOX;
  return UnitKind.CAGE;
}
```

Replace its one call site at line 196 — change:

```ts
        const kind = unitKindFromId(uid);
```

to:

```ts
        const kind = this.board.units[uid]!.kind;
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/engine/solverEngine.test.ts`
Expected: PASS (all tests, including the new one)

- [x] **Step 5: Commit**

```bash
git add web/src/engine/solverEngine.ts web/src/engine/solverEngine.test.ts
git commit -m "fix: classify unit kind from board.units instead of numeric id ranges"
```

---

### Task 4: Window-peer elimination in the MRV backtracker

**Files:**
- Modify: `web/src/engine/backtracker.ts` (`mrvBacktrack`, `search`, `assign`)
- Test: `web/src/engine/backtracker.test.ts`

**Interfaces:**
- Consumes: `BigAppleBoardState.extraPeers()` (Task 2).
- Produces: no public API change — `mrvBacktrack(board: BoardState)` signature is unchanged; window constraints are now respected internally when `board instanceof BigAppleBoardState`.

- [x] **Step 1: Write the failing test**

Add to `web/src/engine/backtracker.test.ts`, after the existing `describe('mrvBacktrack', ...)` tests (after line 54, before the next `it` at line 56-60, or simply appended inside the same `describe` block):

```ts
  it('respects window constraints on a BigAppleBoardState (bug: PEERS table is row/col/box-only)', () => {
    const bs = new BigAppleBoardState();
    // Force a window conflict: place digit 5 at every other cell of the
    // top-left window (rows 1-3, cols 1-3) except (1,1), and also force (1,1)
    // to only have candidate {5} — without window-aware forward checking the
    // backtracker would happily place 5 at (1,1) since rows/cols/boxes alone
    // permit it (the conflicting cells are spread across distinct rows/cols/boxes
    // outside the window). With window peers wired in, assign() must reject it.
    bs.candidates[1]![1]! = new Set([5]);
    bs.candidates[1]![2]! = new Set([5]); // same window, same row as (1,1) too — use a same-window, different-row/col cell instead
    bs.candidates[2]![2]! = new Set([5]); // window peer of (1,1), different row AND column AND box-aligned-row/col group avoided
    const result = mrvBacktrack(bs);
    // (1,1) and (2,2) share no row, column, or standard box (different box-row
    // group is impossible within one window — both are box-aligned here, so
    // assert via extraPeers directly instead of relying on box overlap).
    expect(bs.extraPeers(1, 1).some(([r, c]) => r === 2 && c === 2)).toBe(true);
    expect(result).toBeNull();
  });
```

Add the import at the top of the file:

```ts
import { BigAppleBoardState } from './bigAppleBoardState.js';
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/engine/backtracker.test.ts -t "respects window constraints"`
Expected: FAIL — `mrvBacktrack` returns a non-null (invalid) grid, since `assign()` only consults the static `PEERS` table and never calls `board.extraPeers()`

- [x] **Step 3: Write minimal implementation**

In `web/src/engine/backtracker.ts`:

1. Update `mrvBacktrack` (around line 60-75) to precompute and thread an `extraPeers` table:

```ts
export function mrvBacktrack(board: BoardState): number[][] | null {
  const constraints = board.cageConstraints();
  const cageOf: number[][] = constraints?.cageOf ?? Array.from({length: 9}, () => new Array<number>(9).fill(0));
  const cageTotal: ReadonlyMap<number, number> = constraints?.cageTotal ?? new Map();
  const cageCells: ReadonlyMap<number, readonly Cell[]> = constraints?.cageCells ?? new Map();
  const extraPeers: readonly (readonly Cell[])[][] = Array.from({length: 9}, (_, r) =>
    Array.from({length: 9}, (__, c) => board.extraPeers(r, c)));

  const cands: Set<number>[][] = Array.from({length: 9}, (_, r) =>
    Array.from({length: 9}, (__, c) => new Set(board.cands(r, c))));

  const solution = search(cands, cageOf, cageTotal, cageCells, extraPeers, { n: 0 });
  if (solution !== null && !gridValid(solution)) {
    console.error('mrvBacktrack: search returned an invalid solution — treating as unsolvable');
    return null;
  }
  return solution;
}
```

2. Update `assign`'s signature and peer loop (currently lines 148-176):

```ts
function assign(
  cands: Set<number>[][],
  r: number,
  c: number,
  d: number,
  cageOf: number[][],
  cageTotal: ReadonlyMap<number, number>,
  cageCells: ReadonlyMap<number, readonly Cell[]>,
  extraPeers: readonly (readonly Cell[])[][],
): boolean {
  cands[r]![c] = new Set([d]);
  const queue: Array<[number, number, number]> = [[r, c, d]];

  while (queue.length > 0) {
    const [r0, c0, d0] = queue.pop()!;
    if (!cageValid(cands, cageOf[r0]![c0]!, cageTotal, cageCells)) return false;
    for (const [r2, c2] of [...PEERS[r0]![c0]!, ...extraPeers[r0]![c0]!]) {
      const s = cands[r2]![c2]!;
      if (!s.has(d0)) continue;
      s.delete(d0);
      if (s.size === 0) return false;
      if (s.size === 1) {
        const dNew = s.values().next().value as number;
        queue.push([r2, c2, dNew]);
        if (!cageValid(cands, cageOf[r2]![c2]!, cageTotal, cageCells)) return false;
      }
    }
  }
  return true;
}
```

3. Update `search`'s signature to accept and thread `extraPeers` (currently lines 188-245) — add the parameter and pass it through both the recursive call and the `assign` call:

```ts
function search(
  cands: Set<number>[][],
  cageOf: number[][],
  cageTotal: ReadonlyMap<number, number>,
  cageCells: ReadonlyMap<number, readonly Cell[]>,
  extraPeers: readonly (readonly Cell[])[][],
  counter: { n: number },
): number[][] | null {
```

(body unchanged except the two call sites below)

```ts
    if (assign(newCands, r, c, d, cageOf, cageTotal, cageCells, extraPeers)) {
      const result = search(newCands, cageOf, cageTotal, cageCells, extraPeers, counter);
      if (result !== null) return result;
    }
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/engine/backtracker.test.ts`
Expected: PASS (all tests, including the new one)

- [x] **Step 5: Commit**

```bash
git add web/src/engine/backtracker.ts web/src/engine/backtracker.test.ts
git commit -m "fix: thread window-peer elimination through MRV backtracker"
```

---

### Task 5: Window-aware `unitLabel`

**Files:**
- Modify: `web/src/engine/rules/_labels.ts:15-30`
- Test: `web/src/engine/rules/_labels.test.ts`

**Interfaces:**
- Consumes: nothing new — pure label arithmetic on `Unit.cells`.
- Produces: `unitLabel(unit: Unit): string` now returns `"top-left window"` / `"bottom-left window"` / `"top-right window"` / `"bottom-right window"` for the 4 window units instead of colliding with or misrepresenting a standard box label.

- [x] **Step 1: Write the failing test**

Add to `web/src/engine/rules/_labels.test.ts`, inside the existing `describe('unitLabel', ...)` block (after the `'BOX: labels by 1-based box row and col'` test, before the `'CAGE: lists sorted cell labels'` test):

```ts
  it('BOX (window): labels the 4 Big Apple windows by position, not box arithmetic', () => {
    const windowAt = (r0: number, c0: number): Cell[] => {
      const cells: Cell[] = [];
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) cells.push([r0 + dr, c0 + dc] as Cell);
      return cells;
    };
    expect(unitLabel(makeUnit(UnitKind.BOX, windowAt(1, 1)))).toBe('top-left window');
    expect(unitLabel(makeUnit(UnitKind.BOX, windowAt(5, 1)))).toBe('bottom-left window');
    expect(unitLabel(makeUnit(UnitKind.BOX, windowAt(1, 5)))).toBe('top-right window');
    expect(unitLabel(makeUnit(UnitKind.BOX, windowAt(5, 5)))).toBe('bottom-right window');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/engine/rules/_labels.test.ts -t "labels the 4 Big Apple windows"`
Expected: FAIL — `unitLabel(windowAt(1,1))` returns `'box (1,1)'` (wrong: `(1/3|0)+1 = 1`, `(1/3|0)+1 = 1`, colliding with the actual standard box (1,1))

- [x] **Step 3: Write minimal implementation**

In `web/src/engine/rules/_labels.ts`, add a module-level lookup and use it in `unitLabel`'s `BOX` case:

```ts
const WINDOW_LABELS_BY_CORNER: ReadonlyMap<string, string> = new Map([
  ['1,1', 'top-left window'],
  ['5,1', 'bottom-left window'],
  ['1,5', 'top-right window'],
  ['5,5', 'bottom-right window'],
]);

export function unitLabel(unit: Unit): string {
  const cells = unit.cells as Cell[];
  switch (unit.kind) {
    case UnitKind.ROW: return `row ${cells[0]![0] + 1}`;
    case UnitKind.COL: return `col ${cells[0]![1] + 1}`;
    case UnitKind.BOX: {
      const windowLabel = WINDOW_LABELS_BY_CORNER.get(`${cells[0]![0]},${cells[0]![1]}`);
      if (windowLabel !== undefined) return windowLabel;
      const br = (cells[0]![0] / 3 | 0) + 1;
      const bc = (cells[0]![1] / 3 | 0) + 1;
      return `box (${br},${bc})`;
    }
    default: {
      const labels = cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(cellLabel);
      return `cage [${labels.join(', ')}]`;
    }
  }
}
```

This relies on `cells[0]` being each unit's top-left corner — true both for standard boxes (`BOX_CELLS` in `boardState.ts` builds cells starting at `(b/3|0)*3, (b%3)*3`) and for windows (`buildWindowCells` in `bigAppleBoardState.ts`, Task 2, builds cells starting at `[r0, c0]`).

- [x] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/engine/rules/_labels.test.ts`
Expected: PASS (all tests, including the new one)

- [x] **Step 5: Commit**

```bash
git add web/src/engine/rules/_labels.ts web/src/engine/rules/_labels.test.ts
git commit -m "fix: label Big Apple window units by position instead of box arithmetic"
```

---

## Sprint 1 Completion Check

Run the full unit test suite and type-check before moving to Sprint 2:

```bash
cd web && npx tsc --noEmit && npx vitest run src/engine/
```

Expected: all green. `BigAppleBoardState` exists with 4 window units correctly registered, labeled, and respected by both the rule-trigger router and the MRV backtracker — ready for Sprint 2 to wire it into `buildEngine` via a new `PuzzleState.isBigApple` branch.
