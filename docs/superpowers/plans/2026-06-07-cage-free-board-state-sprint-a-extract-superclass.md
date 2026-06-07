# Cage-Free BoardState — Sprint A: Rename + Extract Superclass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution — see CLAUDE.md "Token Efficiency") to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the existing `BoardState` class to `KillerBoardState` everywhere, then extract a new plain `BoardState` superclass (27 row/col/box units, no cage data, `cageConstraints()` returns `null`) that `KillerBoardState` extends with zero change to its public surface — and rewire `mrvBacktrack` to read cage data through the new `cageConstraints()` virtual method instead of `board.spec` directly.

**Architecture:** Three ordered moves, each independently testable and committed: (1) a pure mechanical rename across ~46 files via a word-boundary `sed` substitution, verified by the existing test suite; (2) extraction of a plain `BoardState` superclass via a new shared `_addUnit` helper that both classes' constructors call — `BoardState` builds the 27 row/col/box units, `KillerBoardState` additionally builds cage units, `cageSolns`, and the `LinearSystem`; (3) a new `CageConstraints` type in `backtracker.ts` plus a `cageConstraints()` virtual method (base returns `null`, `KillerBoardState` returns the populated maps) that `mrvBacktrack` consults instead of reading `board.spec.regions`/`board.spec.cageTotals` unconditionally — letting it run identically against plain classic boards and killer boards.

**Tech Stack:** TypeScript, Vitest, serena MCP tools (mandatory for all `.ts` edits per CLAUDE.md).

---

## Before you start

Read `docs/superpowers/specs/2026-06-07-cage-free-board-state-for-classic.md` §1 (Class hierarchy) — it defines the target shape this sprint builds. This plan implements that section plus the `mrvBacktrack` half of §2.3 (the `KillerOnlyRule`/`KillerSolverEngine`/`candidatesFromBoard` halves of §2 land in Sprint B).

All commands below run from `C:\Users\geoff\PycharmProjects\killer_sudoku\web` unless stated otherwise. Use the **Bash** tool (not PowerShell) per the user's standing preference.

---

### Task 1: Mechanical rename `BoardState` → `KillerBoardState`

**Files (46 total — every file referencing `BoardState`):**
```
scripts/repro-bugs.ts
scripts/seed-rule-fixtures.ts
src/engine/backtracker.test.ts
src/engine/backtracker.ts
src/engine/boardState.test.ts
src/engine/boardState.ts
src/engine/fixtures.ts
src/engine/index.ts
src/engine/linearSystem.ts
src/engine/rule.ts
src/engine/rules/cageConfinement.test.ts
src/engine/rules/cageRules.test.ts
src/engine/rules/deltaConstraint.test.ts
src/engine/rules/fishRules.test.ts
src/engine/rules/hiddenPair.test.ts
src/engine/rules/hiddenSingle.test.ts
src/engine/rules/linearElimination.test.ts
src/engine/rules/linearElimination.ts
src/engine/rules/lockedCandidates.test.ts
src/engine/rules/mustContain.test.ts
src/engine/rules/mustContainOutie.test.ts
src/engine/rules/nakedHiddenQuad.test.ts
src/engine/rules/nakedHiddenTriple.test.ts
src/engine/rules/nakedPair.test.ts
src/engine/rules/nakedPair.ts
src/engine/rules/nakedSingle.test.ts
src/engine/rules/pointingPairs.test.ts
src/engine/rules/simpleColouring.test.ts
src/engine/rules/skyscraper.test.ts
src/engine/rules/sumPairConstraint.test.ts
src/engine/rules/twoStringKite.test.ts
src/engine/rules/uniqueRectangle.test.ts
src/engine/rules/unitPartitionFilter.test.ts
src/engine/rules/wWing.test.ts
src/engine/rules/xWing.test.ts
src/engine/rules/xyWing.test.ts
src/engine/rules/xyzWing.test.ts
src/engine/solverEngine.solveOneStep.test.ts
src/engine/solverEngine.test.ts
src/engine/solverEngine.ts
src/engine/triggerValidator.test.ts
src/engine/triggerValidator.ts
src/engine/types.ts
src/session/actions.ts
src/session/engine.ts
src/solver/equation.ts
```

- [x] **Step 1: Create a feature branch**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku" && git checkout -b feature/cage-free-board-state
```

Expected: `Switched to a new branch 'feature/cage-free-board-state'`

- [x] **Step 2: Run the word-boundary rename across all 46 files**

This is a pure identifier rename — `\b` word-boundary anchors mean `KillerBoardState` (which already contains the substring `BoardState`) is left untouched, and unrelated identifiers like `boardState.ts`/`boardState.js` (lowercase first letter — the file name) are also untouched.

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && for f in \
  scripts/repro-bugs.ts scripts/seed-rule-fixtures.ts \
  src/engine/backtracker.test.ts src/engine/backtracker.ts \
  src/engine/boardState.test.ts src/engine/boardState.ts \
  src/engine/fixtures.ts src/engine/index.ts src/engine/linearSystem.ts src/engine/rule.ts \
  src/engine/rules/cageConfinement.test.ts src/engine/rules/cageRules.test.ts \
  src/engine/rules/deltaConstraint.test.ts src/engine/rules/fishRules.test.ts \
  src/engine/rules/hiddenPair.test.ts src/engine/rules/hiddenSingle.test.ts \
  src/engine/rules/linearElimination.test.ts src/engine/rules/linearElimination.ts \
  src/engine/rules/lockedCandidates.test.ts src/engine/rules/mustContain.test.ts \
  src/engine/rules/mustContainOutie.test.ts src/engine/rules/nakedHiddenQuad.test.ts \
  src/engine/rules/nakedHiddenTriple.test.ts src/engine/rules/nakedPair.test.ts \
  src/engine/rules/nakedPair.ts src/engine/rules/nakedSingle.test.ts \
  src/engine/rules/pointingPairs.test.ts src/engine/rules/simpleColouring.test.ts \
  src/engine/rules/skyscraper.test.ts src/engine/rules/sumPairConstraint.test.ts \
  src/engine/rules/twoStringKite.test.ts src/engine/rules/uniqueRectangle.test.ts \
  src/engine/rules/unitPartitionFilter.test.ts src/engine/rules/wWing.test.ts \
  src/engine/rules/xWing.test.ts src/engine/rules/xyWing.test.ts src/engine/rules/xyzWing.test.ts \
  src/engine/solverEngine.solveOneStep.test.ts src/engine/solverEngine.test.ts src/engine/solverEngine.ts \
  src/engine/triggerValidator.test.ts src/engine/triggerValidator.ts src/engine/types.ts \
  src/session/actions.ts src/session/engine.ts src/solver/equation.ts \
; do sed -i -E 's/\bBoardState\b/KillerBoardState/g' "$f"; done
```

Expected: no output (sed runs silently on success).

- [x] **Step 3: Verify the rename is total — no bare `BoardState` identifier remains**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && grep -rn '\bBoardState\b' src/ scripts/ --include="*.ts" | grep -v KillerBoardState
```

Expected: no output (every occurrence is now part of `KillerBoardState`).

- [x] **Step 4: Type-check both configs**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit
```

Expected: both commands exit 0 with no output (clean compile — this is a pure rename, so nothing should fail).

- [x] **Step 5: Run the full test suite**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npm test
```

Expected: all 537 tests pass (same count as before the rename — behavior is unchanged).

- [x] **Step 6: Run the bronze gate and commit**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku" && bash scripts/run-bronze-gate.sh
```

Expected: `Bronze gate passed` (or equivalent success message) — creates `.bronze-gate-ok`.

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku" && git add -A && git commit -m "$(cat <<'EOF'
refactor: rename BoardState to KillerBoardState

Pure mechanical rename ahead of extracting a plain cage-free BoardState
superclass — see docs/superpowers/specs/2026-06-07-cage-free-board-state-for-classic.md §1.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds (pre-commit hook's bronze-gate-token check passes).

---

### Task 2: Extract plain `BoardState` superclass

**Files:**
- Modify: `web/src/engine/boardState.ts` (full class restructuring)
- Modify: `web/src/engine/boardState.test.ts` (new construction tests)

This task replaces the single `KillerBoardState` class — which currently builds *everything* (row/col/box units, cage units, `cageSolns`, `linearSystem`) in one constructor — with two classes: a plain `BoardState` that builds only the 27 row/col/box units and the row/col/box half of `removeCandidate`, and `KillerBoardState extends BoardState` that adds cages on top via `super()`.

The key device that makes the split clean is a new `protected _addUnit(unit: Unit)` helper on `BoardState`. It performs the four-array bookkeeping (`units.push` / `counts.push` / `unitVersions.push` / `_cellUnitIds[r][c].push`) that today is duplicated inline in the constructor (for real cages and virtual cages) **and** in `addVirtualCage` (lines 293–299 of the current file). Both constructors and `addVirtualCage` call it — removing that duplication is itself a small win, not just a side effect of the split.

- [x] **Step 1: Write the failing construction test for plain `BoardState`**

Open `web/src/engine/boardState.test.ts`. Its current line 6 (post-rename) reads:
```typescript
import { KillerBoardState } from './boardState.js';
```
Change it to import both names — `BoardState` does not exist yet as an exported class, so this is the line that will fail to compile:
```typescript
import { BoardState, KillerBoardState } from './boardState.js';
```

Then add this new `describe` block immediately after the closing `});` of the existing `describe('KillerBoardState init', ...)` block (which starts at line 11 post-rename):

```typescript
describe('BoardState (plain) construction', () => {
  it('builds exactly 27 row/col/box units and no cage units', () => {
    const bs = new BoardState();
    expect(bs.units.length).toBe(27);
    expect(bs.units.every(u => u.kind !== UnitKind.CAGE)).toBe(true);
  });

  it('candidates start as full sets', () => {
    const bs = new BoardState();
    expect(bs.candidates[0]![0]!).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(bs.candidates[8]![8]!).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  it('counts are initialised to unit size for every digit', () => {
    const bs = new BoardState();
    const row0 = bs.rowUnitId(0);
    for (let d = 1; d <= 9; d++) {
      expect(bs.counts[row0]![d]!).toBe(9);
    }
  });

  it('cell (0,0) belongs to ROW, COL and BOX units only — no CAGE', () => {
    const bs = new BoardState();
    const kinds = new Set(bs.cellUnitIds(0, 0).map(uid => bs.units[uid]!.kind));
    expect(kinds).toEqual(new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX]));
  });

  it('cageConstraints returns null', () => {
    const bs = new BoardState();
    expect(bs.cageConstraints()).toBeNull();
  });

  it('removeCandidate works without any cage bookkeeping', () => {
    const bs = new BoardState();
    const events = bs.removeCandidate(0, 0, 9);
    expect(events.some(e => e.trigger === Trigger.COUNT_DECREASED)).toBe(true);
    expect(bs.cands(0, 0).has(9)).toBe(false);
  });
});
```

- [x] **Step 2: Run the test file to verify it fails to compile**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run src/engine/boardState.test.ts
```

Expected: **FAIL** — TypeScript error similar to:
```
Module '"./boardState.js"' has no exported member 'BoardState'.
```
(At this point only `KillerBoardState` is exported, and its constructor requires a `PuzzleSpec` argument — `new BoardState()` cannot resolve to it either way.)

- [x] **Step 3: Replace `boardState.ts`'s class section with the split hierarchy**

Open `web/src/engine/boardState.ts`. First, add a type-only import for the new `CageConstraints` interface (Task 3 will define it in `backtracker.ts`) — insert it directly after the existing `import type { PuzzleSpec } from '../solver/puzzleSpec.js';` line:

```typescript
import type { CageConstraints } from './backtracker.js';
```

This is a type-only circular reference (erased at compile time by `import type` — `backtracker.ts` already does `import type { KillerBoardState } from './boardState.js'`), so it introduces no runtime cycle.

Next, replace the file's header doc comment (currently lines 1–12, the `/** BoardState — all mutable solver state... */` block) with:

```typescript
/**
 * BoardState — plain row/col/box sudoku skeleton shared by classic and killer
 * boards. KillerBoardState (below) extends it with cage modelling.
 *
 * Mirrors the row/col/box half of Python's
 * `killer_sudoku.solver.engine.board_state` module — that module has no
 * classic/killer split; the split here exists purely to keep classic boards
 * free of cage machinery (see `docs/superpowers/specs/2026-06-07-cage-free-board-state-for-classic.md`).
 *
 * Rules read from this object but must never mutate it directly.
 * All mutations go through removeCandidate() (or, on KillerBoardState,
 * removeCageSolution()).
 */
```

Now replace the **entire** `export class KillerBoardState { ... }` body — from the `export class KillerBoardState {` line (currently line 57, post-rename) through its closing `}` (currently line 301) — with the following two classes:

```typescript
// ---------------------------------------------------------------------------
// BoardState — plain row/col/box skeleton shared by classic and killer boards
// ---------------------------------------------------------------------------

export class BoardState {
  readonly units: Unit[];
  /** candidates[r][c] = set of remaining digits for cell (r, c). Use cands(r,c) for safe read access. */
  candidates: Set<number>[][];
  /** counts[unitId][digit] = number of cells in that unit still having digit. Use count(uid,d) for safe read access. */
  counts: number[][];
  unitVersions: number[];

  private _cellUnitIds: number[][][]; // [9][9] → list of unit_ids

  constructor() {
    this.units = [];
    this._cellUnitIds = Array.from({length: 9}, () => Array.from({length: 9}, () => []));
    this.candidates = Array.from({length: 9}, () =>
      Array.from({length: 9}, () => new Set(Array.from({length: 9}, (_, i) => i + 1))));
    this.counts = [];
    this.unitVersions = [];

    for (let r = 0; r < 9; r++)
      this._addUnit({ unitId: ROW_UNIT_OFFSET + r, kind: UnitKind.ROW,
        cells: Array.from({length: 9}, (_, c) => [r, c] as Cell), distinctDigits: true });
    for (let c = 0; c < 9; c++)
      this._addUnit({ unitId: COL_UNIT_OFFSET + c, kind: UnitKind.COL,
        cells: Array.from({length: 9}, (_, r) => [r, c] as Cell), distinctDigits: true });
    for (let b = 0; b < 9; b++)
      this._addUnit({ unitId: BOX_UNIT_OFFSET + b, kind: UnitKind.BOX, cells: BOX_CELLS[b]!, distinctDigits: true });
  }

  // ── Safe read accessors (invariant: 9×9 board and nUnits always initialised) ─

  /** Candidates for cell (r, c). Indices are always 0–8 by solver invariant. */
  cands(r: number, c: number): Set<number> { return this.candidates[r]![c]!; }

  /** Count of cells in unit uid that still have digit d (d ∈ [1..9]; index 0 is unused). */
  count(uid: number, d: number): number { return this.counts[uid]![d]!; }

  // ── Unit ID accessors ────────────────────────────────────────────────────

  rowUnitId(r: number): number { return ROW_UNIT_OFFSET + r; }
  colUnitId(c: number): number { return COL_UNIT_OFFSET + c; }
  boxUnitId(r: number, c: number): number { return BOX_UNIT_OFFSET + (r / 3 | 0) * 3 + (c / 3 | 0); }
  cellUnitIds(r: number, c: number): number[] { return this._cellUnitIds[r]![c]!; }

  /**
   * Returns eliminations to apply to all peers of (r, c) when it is determined
   * to hold digit d — i.e. d removed from every other cell sharing a row, col,
   * box, or distinct-digit cage with (r, c).
   *
   * Used by NakedSingle and by buildEngine for unconditional placement propagation.
   */
  peerEliminations(r: number, c: number, d: number): Elimination[] {
    const seen = new Set<string>();
    const elims: Elimination[] = [];
    for (const uid of this.cellUnitIds(r, c)) {
      const unit = this.units[uid]!;
      if (unit.kind === UnitKind.CAGE && !unit.distinctDigits) continue;
      for (const [pr, pc] of unit.cells as Cell[]) {
        if (pr === r && pc === c) continue;
        const key = `${pr},${pc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (this.cands(pr, pc).has(d)) elims.push({ cell: [pr, pc] as Cell, digit: d });
      }
    }
    return elims;
  }

  // ── Mutation ─────────────────────────────────────────────────────────────

  /**
   * Remove digit d from candidates[r][c]; update counts, versions, emit events.
   *
   * This is the single mutation point for candidate sets. Steps:
   *  1. Remove d from candidates[r][c]
   *  2. Decrement counts[unitId][d] for all units containing (r, c)
   *  3. Emit COUNT_DECREASED / COUNT_HIT_TWO / COUNT_HIT_ONE as counts change
   *  4. Emit CELL_DETERMINED if candidates[r][c] becomes a singleton
   *  5. Raise NoSolnError if candidates[r][c] would become empty
   *
   * KillerBoardState overrides this to additionally prune cage solutions —
   * the same template-method shape as cageConstraints() below.
   */
  removeCandidate(r: number, c: number, d: number): BoardEvent[] {
    const cands = this.cands(r, c);
    if (!cands.has(d)) return [];
    if (cands.size === 1) throw new NoSolnError(`Cannot remove last candidate ${d} from (${r},${c})`);

    cands.delete(d);
    const events: BoardEvent[] = [];

    for (const uid of this.cellUnitIds(r, c)) {
      const prev = this.count(uid, d);
      const next = prev - 1;
      this.counts[uid]![d] = next;
      this.unitVersions[uid]!++;
      events.push({ trigger: Trigger.COUNT_DECREASED, payload: uid, hintDigit: d });
      if (next === 2) events.push({ trigger: Trigger.COUNT_HIT_TWO, payload: uid, hintDigit: d });
      else if (next === 1) events.push({ trigger: Trigger.COUNT_HIT_ONE, payload: uid, hintDigit: d });
    }

    if (cands.size === 1) {
      const sole = nextInSet(cands);
      events.push({ trigger: Trigger.CELL_DETERMINED, payload: [r, c] as Cell, hintDigit: sole });
    }

    return events;
  }

  /**
   * Cage-sum data for the MRV backtracker's validity check, or null when this
   * board has no cages. Plain BoardState always returns null — mrvBacktrack's
   * search() then degrades to pure row/col/box backtracking (cageTotal empty
   * ⟹ cageValid's `if (total === undefined) return true` short-circuit).
   */
  cageConstraints(): CageConstraints | null { return null; }

  /**
   * Register a new unit: append it to `units` and extend `counts` /
   * `unitVersions` / the per-cell unit-ID lookup to cover it.
   *
   * This is the single place that keeps those three parallel arrays in sync
   * with `units` — shared by the row/col/box construction above,
   * KillerBoardState's cage construction, and addVirtualCage.
   */
  protected _addUnit(unit: Unit): void {
    this.units.push(unit);
    const countsRow = new Array<number>(10).fill(0);
    for (let d = 1; d <= 9; d++)
      countsRow[d] = unit.cells.filter(([r, c]) => this.cands(r, c).has(d)).length;
    this.counts.push(countsRow);
    this.unitVersions.push(0);
    for (const [r, c] of unit.cells) this._cellUnitIds[r]![c]!.push(unit.unitId);
  }
}

// ---------------------------------------------------------------------------
// KillerBoardState — adds cage modelling: cage units, cage-solution tracking,
// the linear system, and virtual cages derived from it
// ---------------------------------------------------------------------------

export class KillerBoardState extends BoardState {
  readonly spec: PuzzleSpec;
  /** regions[r][c] = 0-based cage index */
  readonly regions: number[][];
  /** cage_solns[cage_idx] = remaining feasible digit sets for that cage */
  cageSolns: number[][][];
  readonly linearSystem: LinearSystem;

  constructor(spec: PuzzleSpec, { includeVirtualCages = true } = {}) {
    super();
    this.spec = spec;

    // Convert regions to 0-based (spec uses 1-based cage IDs)
    // Indices are loop-bounded 0–8, so [r]![c]! are always valid.
    this.regions = Array.from({length: 9}, (_, r) =>
      Array.from({length: 9}, (__, c) => spec.regions[r]![c]! - 1));
    const nCages = Math.max(...this.regions.flat()) + 1;

    // Build cage cell lists (0-based index)
    const cageCellsList: Cell[][] = Array.from({length: nCages}, () => []);
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        cageCellsList[this.regions[r]![c]!]!.push([r, c] as Cell);

    // Real cage units (27+)
    for (let idx = 0; idx < nCages; idx++)
      this._addUnit({ unitId: CAGE_UNIT_OFFSET + idx, kind: UnitKind.CAGE, cells: cageCellsList[idx]!, distinctDigits: true });

    // Real cage solutions via sol_sums
    this.cageSolns = cageCellsList.map(cells => {
      let total = 0;
      for (const [r, c] of cells) {
        const v = spec.cageTotals[r]![c]!;
        if (v !== 0) { total = v; break; }
      }
      return solSums(cells.length, 0, total);
    });

    // Build LinearSystem (this is the expensive step)
    this.linearSystem = new LinearSystem(spec, { deriveVirtualCages: includeVirtualCages });

    // Add virtual cage units from the linear system
    for (const { cells: vcells, total: vtotal, distinct, precomputedSolns: precompSolns } of includeVirtualCages ? this.linearSystem.virtualCages : []) {
      const vunitId = this.units.length;
      const cells = vcells as Cell[];
      this._addUnit({ unitId: vunitId, kind: UnitKind.CAGE, cells, distinctDigits: distinct });
      if (precompSolns !== null) {
        this.cageSolns.push(precompSolns);
      } else {
        this.cageSolns.push(solSums(cells.length, 0, vtotal));
      }
    }
  }

  cageUnitId(r: number, c: number): number { return CAGE_UNIT_OFFSET + this.regions[r]![c]!; }

  override removeCandidate(r: number, c: number, d: number): BoardEvent[] {
    const events = super.removeCandidate(r, c, d);
    if (events.length === 0) return events; // d wasn't a candidate — nothing changed, nothing to prune

    // Prune cage solutions for all cage units containing this cell
    for (const uid of this.cellUnitIds(r, c)) {
      if (this.units[uid]!.kind === UnitKind.CAGE) {
        events.push(...this._pruneCageSolutions(uid - CAGE_UNIT_OFFSET, r, c, d));
      }
    }

    return events;
  }

  removeCageSolution(cageIdx: number, solution: readonly number[]): BoardEvent {
    const solns = this.cageSolns[cageIdx]!;
    const idx = solns.findIndex(s => s.length === solution.length && s.every((d, i) => d === solution[i]));
    if (idx >= 0) solns.splice(idx, 1);
    const cageUnitId = CAGE_UNIT_OFFSET + cageIdx;
    return { trigger: Trigger.SOLUTION_PRUNED, payload: cageUnitId, hintDigit: null };
  }

  private _pruneCageSolutions(cageIdx: number, _r: number, _c: number, d: number): BoardEvent[] {
    const cageUnit = this.units[CAGE_UNIT_OFFSET + cageIdx]!;
    // If d is still possible somewhere in the cage, nothing to prune
    if (cageUnit.cells.some(([cr, cc]) => this.cands(cr, cc).has(d))) return [];
    // Remove all solutions containing d
    const toRemove = this.cageSolns[cageIdx]!.filter(s => s.includes(d));
    return toRemove.map(s => this.removeCageSolution(cageIdx, s));
  }

  /**
   * Builds { cageOf, cageTotal, cageCells } from this.spec — the same
   * extraction mrvBacktrack used to perform inline (now moved here so the
   * backtracker can ask the board for its constraints generically).
   */
  override cageConstraints(): CageConstraints {
    const cageOf = Array.from({length: 9}, () => new Array<number>(9).fill(0));
    const cageTotal = new Map<number, number>();
    const cageCells = new Map<number, Cell[]>();

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const cid = this.spec.regions[r]![c]!; // 1-based
        cageOf[r]![c] = cid;
        if (!cageCells.has(cid)) cageCells.set(cid, []);
        cageCells.get(cid)!.push([r, c] as Cell);
        const t = this.spec.cageTotals[r]![c]!;
        if (t !== 0) cageTotal.set(cid, t);
      }
    }

    return { cageOf, cageTotal, cageCells };
  }

  /**
   * Add a user-acknowledged virtual cage as a new cage unit.
   *
   * @param cells - cells that form the cage (row-major Cell tuples)
   * @param total - the cage sum constraint
   * @param eliminatedSolns - solutions the user has already ruled out; pre-filtered from the generated solution list
   * @param distinct - whether digits must be distinct within the cage (default true)
   */
  addVirtualCage(
    cells: readonly Cell[],
    total: number,
    eliminatedSolns: readonly (readonly number[])[],
    { distinct = true, negativeCells, eliminatedDiffSolns }: {
      distinct?: boolean;
      negativeCells?: readonly Cell[];
      eliminatedDiffSolns?: readonly DiffSolution[];
    } = {},
  ): void {
    const vunitId = this.units.length;

    if (negativeCells && negativeCells.length > 0) {
      // Diff cage: populate cageSolns with combined sorted digit arrays so that
      // CageCandidateFilter and SolutionMapFilter work correctly.
      // Combined [pos ∪ neg] is sound: any digit absent from all combined solutions
      // cannot appear in any cage cell regardless of role.
      const negKeys = new Set(negativeCells.map(([r, c]) => `${r},${c}`));
      const posCount = cells.length - negKeys.size;
      const negCount = negKeys.size;
      const diffKey = (s: DiffSolution) => `${[...s.pos].join(',')}|${[...s.neg].join(',')}`;
      const elimSet = new Set((eliminatedDiffSolns ?? []).map(diffKey));
      const solns = solDiffs(posCount, negCount, total)
        .filter(s => !elimSet.has(diffKey(s)))
        .map(s => [...s.pos, ...s.neg].sort((a, b) => a - b));
      this.cageSolns.push(solns);
    } else {
      const elimSet = new Set(eliminatedSolns.map(s => s.slice().sort().join(',')));
      const solns = solSums(cells.length, 0, total)
        .filter(s => !elimSet.has(s.slice().sort().join(',')));
      this.cageSolns.push(solns);
    }

    this._addUnit({ unitId: vunitId, kind: UnitKind.CAGE, cells, distinctDigits: distinct });
  }
}
```

Leave the trailing `// Helpers` section (`nextInSet` and `validateSolution`, currently lines 303–322) **unchanged** — `validateSolution(board: BoardState)` already takes the (now-plain) base type and works generically for both, since its `unit.kind === UnitKind.CAGE` skip degrades correctly when there are no CAGE units.

- [x] **Step 4: Run the test file to verify it now passes**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run src/engine/boardState.test.ts
```

Expected: **PASS** — all tests in both `describe('KillerBoardState init', ...)` and the new `describe('BoardState (plain) construction', ...)` block succeed.

- [x] **Step 5: Run the full test suite to confirm no regressions**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npm test
```

Expected: all tests pass — `KillerBoardState`'s public surface and runtime behavior are byte-for-byte identical to before the split (verified by the existing `KillerBoardState init` / cage-rule / linear-system / backtracker test suites, none of which needed to change).

- [x] **Step 6: Type-check both configs**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit
```

Expected: both exit 0 with no output.

> **Note (found during execution):** This step cannot pass in isolation — Step 3 above
> introduces `import type { CageConstraints } from './backtracker.js'`, and `CageConstraints`
> is not defined until Task 3 Step 3. `tsc --noEmit` reports `TS2305: Module has no exported
> member 'CageConstraints'` at this point (vitest's esbuild transpilation doesn't type-check,
> so Steps 4–5 above pass regardless). This is a one-task-early forward reference, not a
> design flaw — Task 3 Step 5 runs the combined `npm test && tsc` that validates everything
> together once `CageConstraints` exists. Proceeded directly into Task 3 without blocking here.

---

### Task 3: Add `CageConstraints` and rewire `mrvBacktrack` through `board.cageConstraints()`

**Files:**
- Modify: `web/src/engine/backtracker.ts`
- Modify: `web/src/engine/backtracker.test.ts`

`mrvBacktrack` currently reads `board.spec.regions`/`board.spec.cageTotals` unconditionally (lines 53–62 post-rename) — which only compiles against `KillerBoardState` (the only class with a `.spec`). This step extracts that logic onto the board itself via the new `cageConstraints()` virtual method, so `mrvBacktrack` can accept the plain `BoardState` type and degrade correctly (empty `cageTotal` map ⟹ `cageValid`'s `if (total === undefined) return true` short-circuit ⟹ pure row/col/box backtracking).

This also requires widening `cageValid`/`assign`/`search`'s `cageTotal`/`cageCells` parameters from `Map<number, ...>` to `ReadonlyMap<number, ...>` — they only ever call `.get()`/`.has()` on these maps, never mutate them, and `CageConstraints` exposes them as read-only views (the "weakest possible parameter type" rule from CLAUDE.md's TypeScript guidelines).

- [x] **Step 1: Write the failing test — `mrvBacktrack` against a plain `BoardState`**

Open `web/src/engine/backtracker.test.ts`. Change line 7 (post-Task-1-rename: `import { KillerBoardState } from './boardState.js';`) to import both names:
```typescript
import { BoardState, KillerBoardState } from './boardState.js';
```

Then add this test at the end of the `describe('mrvBacktrack', ...)` block, immediately before its closing `});`:

```typescript
  it('solves a plain classic grid via new BoardState() — no cage data, no KillerBoardState involved', () => {
    const bs = new BoardState();
    expect(bs.cageConstraints()).toBeNull();
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        bs.candidates[r]![c]! = new Set([KNOWN_SOLUTION[r]![c]!]);
    const result = mrvBacktrack(bs);
    expect(result).not.toBeNull();
    expect(validateSudokuSolution(result!)).toBeNull();
  });
```

> **Fixed during execution:** the snippet above originally passed `result` (typed
> `number[][] | null`) to `validateSudokuSolution(grid: number[][])`, which `tsc`
> rejects (`TS2345`). Added the `!` non-null assertion — matching the established
> convention two tests above (`result![r]!`) immediately after the same
> `expect(result).not.toBeNull()` guard.

- [x] **Step 2: Run the test file to verify it fails to compile**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run src/engine/backtracker.test.ts
```

Expected: **FAIL** — TypeScript error similar to:
```
Argument of type 'BoardState' is not assignable to parameter of type 'KillerBoardState'.
  Property 'spec' is missing in type 'BoardState' but required in type 'KillerBoardState'.
```
(`mrvBacktrack`'s parameter is currently typed `board: KillerBoardState` — the post-Task-1-rename signature.)

- [x] **Step 3: Add `CageConstraints`, widen the helper signatures, and rewire `mrvBacktrack`**

Open `web/src/engine/backtracker.ts`.

First, change line 14's import from the post-rename `import type { KillerBoardState } from './boardState.js';` back to the plain superclass — `mrvBacktrack` only needs `board.cands()`/`board.cageConstraints()`, both on the base class:
```typescript
import type { BoardState } from './boardState.js';
```

Next, add the `CageConstraints` interface — insert it directly after the `PEERS` constant block (after the closing `);` at line 34, before the `// Public entry point` comment divider):

```typescript
/**
 * Cage-sum data for mrvBacktrack's validity check — built by
 * KillerBoardState.cageConstraints(); plain BoardState has none (null).
 */
export interface CageConstraints {
  readonly cageOf: number[][];
  readonly cageTotal: ReadonlyMap<number, number>;
  readonly cageCells: ReadonlyMap<number, readonly Cell[]>;
}
```

Now replace the doc comment + body of `mrvBacktrack` (currently lines 40–73 post-rename — from `/** Find a solution via MRV backtracking...` through its closing `}`) with:

```typescript
/**
 * Find a solution via MRV backtracking from a partially-solved BoardState.
 *
 * Asks the board for its cage constraints (null for a plain classic board —
 * search() then degrades to pure row/col/box backtracking), copies current
 * candidate sets, and searches for a valid completion. Forward checking keeps
 * the branching factor small.
 *
 * Returns a 9×9 grid of placed digits, or null if unsolvable from this state.
 */
export function mrvBacktrack(board: BoardState): number[][] | null {
  const constraints = board.cageConstraints();
  const cageOf: number[][] = constraints?.cageOf ?? Array.from({length: 9}, () => new Array<number>(9).fill(0));
  const cageTotal: ReadonlyMap<number, number> = constraints?.cageTotal ?? new Map();
  const cageCells: ReadonlyMap<number, readonly Cell[]> = constraints?.cageCells ?? new Map();

  const cands: Set<number>[][] = Array.from({length: 9}, (_, r) =>
    Array.from({length: 9}, (__, c) => new Set(board.cands(r, c))));

  const solution = search(cands, cageOf, cageTotal, cageCells, { n: 0 });
  if (solution !== null && !gridValid(solution)) {
    console.error('mrvBacktrack: search returned an invalid solution — treating as unsolvable');
    return null;
  }
  return solution;
}
```

Finally, widen the `cageTotal`/`cageCells` parameter types in `cageValid`, `assign`, and `search` from `Map<number, ...>` to `ReadonlyMap<number, ...>` — they only ever read from these maps. Three signature edits:

In `cageValid` (the `function cageValid(` block):
```typescript
function cageValid(
  cands: Set<number>[][],
  cid: number,
  cageTotal: ReadonlyMap<number, number>,
  cageCells: ReadonlyMap<number, readonly Cell[]>,
): boolean {
```

In `assign` (the `function assign(` block):
```typescript
function assign(
  cands: Set<number>[][],
  r: number,
  c: number,
  d: number,
  cageOf: number[][],
  cageTotal: ReadonlyMap<number, number>,
  cageCells: ReadonlyMap<number, readonly Cell[]>,
): boolean {
```

In `search` (the `function search(` block):
```typescript
function search(
  cands: Set<number>[][],
  cageOf: number[][],
  cageTotal: ReadonlyMap<number, number>,
  cageCells: ReadonlyMap<number, readonly Cell[]>,
  counter: { n: number },
): number[][] | null {
```

Leave every line in the bodies of `cageValid`, `assign`, and `search` unchanged — they already only call `.get()`/`.has()` and iterate, which `ReadonlyMap`/`readonly Cell[]` support identically.

- [x] **Step 4: Run the test file to verify it now passes**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run src/engine/backtracker.test.ts
```

Expected: **PASS** — all `mrvBacktrack` tests succeed, including the new plain-`BoardState` case.

- [x] **Step 5: Run the full test suite and type-check**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npm test && npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit
```

Expected: all tests pass; both `tsc` invocations exit 0 with no output.

---

### Task 4: Fix up the `index.ts` re-export and the stale `BoardEvent` doc comment

**Files:**
- Modify: `web/src/engine/index.ts`
- Modify: `web/src/engine/types.ts`

Two small accuracy fixes surfaced by the split:

1. `engine/index.ts` re-exports `KillerBoardState` (post-rename) but downstream code (Sprint B/C) will need the new plain `BoardState` too — `actions.ts`/`session/engine.ts` import board types via this barrel.
2. `types.ts`'s `BoardEvent` doc comment was correctly renamed to `KillerBoardState` by Task 1's blanket rename (at that moment it was the only class) — but now that `removeCandidate` is defined on the base `BoardState` (with `KillerBoardState` only overriding it), the comment's accurate referent is the generic `BoardState` again.

- [x] **Step 1: Add `BoardState` to the `index.ts` re-export**

Open `web/src/engine/index.ts`. Line 22 currently reads (post-rename):
```typescript
export { KillerBoardState } from './boardState.js';
```
Change it to:
```typescript
export { BoardState, KillerBoardState } from './boardState.js';
```

- [x] **Step 2: Revert the `BoardEvent` doc comment to the generic name**

Open `web/src/engine/types.ts`. Find the line (renamed by Task 1 to):
```typescript
/** Typed event returned by KillerBoardState mutation methods. */
```
Change it back to:
```typescript
/** Typed event returned by BoardState mutation methods. */
```
(`BoardEvent` is now genuinely returned by the base `BoardState.removeCandidate` — `KillerBoardState.removeCandidate` only appends cage-pruning events to what `super.removeCandidate` already produced.)

- [x] **Step 3: Type-check, run tests, run the bronze gate, and commit**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit && npm test
```

Expected: both `tsc` invocations exit 0; all tests pass.

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku" && bash scripts/run-bronze-gate.sh
```

Expected: bronze gate passes, creating `.bronze-gate-ok`.

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku" && git add -A && git commit -m "$(cat <<'EOF'
refactor: extract plain BoardState superclass from KillerBoardState

Splits the monolithic board-state class into a cage-free BoardState
skeleton (27 row/col/box units) and a KillerBoardState subclass that adds
cage units, cage-solution tracking, and the linear system on top — with
zero change to KillerBoardState's existing public surface or behavior.

mrvBacktrack now reads cage data through the new cageConstraints()
virtual method (null on plain boards) instead of board.spec directly,
so it runs identically against both board types — see
docs/superpowers/specs/2026-06-07-cage-free-board-state-for-classic.md §1, §2.3.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds.

---

## Sprint A complete

At this point:
- `KillerBoardState` exists with an identical public surface and behavior to the original `BoardState` (verified by the full pre-existing test suite passing unchanged).
- A new plain `BoardState` exists: 27 row/col/box units, no `spec`/`regions`/`cageSolns`/`linearSystem`/`addVirtualCage`, `cageConstraints()` returns `null`.
- `mrvBacktrack` accepts either board type and degrades correctly for plain boards.
- Every other consumer in the codebase (rules, `SolverEngine`, `RuleContext`, `actions.ts`, `session/engine.ts`, `engine/index.ts`) still references `KillerBoardState` — **this is intentional**. Sprint B widens the specific contracts that should accept the plain `BoardState` (rule context, solver engine, `candidatesFromBoard`); Sprint C flips `buildEngine`/`solveFromStall` to actually construct plain boards for classic puzzles.

Proceed to `docs/superpowers/plans/2026-06-07-cage-free-board-state-sprint-b-widen-contracts.md`.
