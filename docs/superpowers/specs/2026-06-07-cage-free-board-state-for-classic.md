# Cage-Free BoardState for Classic

**Date:** 2026-06-07
**Branch:** feature/cage-free-board-state (to be created)
**Status:** Prerequisite for `puzzle-state-redesign` — must land on master before that work begins.

**Motivation:** Classic puzzles currently run on `BoardState`/`LinearSystem` instances built from a *synthetic killer spec* — nine fake "row cages" each totalling 45 (`loadClassicDirect`, `makeClassicSpec()`), or a single fake whole-grid cage (`buildStateFromParseResult`'s blank-spec fallback, which is legitimate — see §6). This fiction is not inert:

- `hiddenSingle`/`lockedCandidates` (core, non-`killerOnly` rules) branch on `UnitKind.CAGE` and produce cage-flavored hint text — e.g. *"... is essential to every remaining cage solution"* — for a puzzle that has no cages.
- `candidatesFromBoard` (actions.ts) reads `board.regions`/`board.cageSolns`/`board.units[27+idx]` unconditionally and special-cases classic with an explicit `puzzleType === 'classic'` branch and the comment *"cage solutions are always empty (dummy spec)"*.
- The synthetic-spec construction is duplicated three times (`loadClassicDirect`, `makeClassicSpec`, the blank-spec fallback for undetected killer layouts), each a slightly different shape.

This spec makes "classic has no cages" a structural fact enforced by the type system, eliminating all synthetic-spec duplication and the latent hint-text leak in one pass. It also produces the exact `PuzzleState`/`KillerPuzzleState` field split that `puzzle-state-redesign.md` §1 already specifies — landing this first resolves that spec's §1/§3 contradiction as a side effect.

---

## 1. Class hierarchy

`BoardState` becomes the plain 9×9 sudoku skeleton. It requires **no spec** to construct:

```typescript
class BoardState {
  readonly units: Unit[];           // ROW(0-8) / COL(9-17) / BOX(18-26) — 27 total
  candidates: Set<number>[][];
  counts: number[][];
  unitVersions: number[];
  // no regions, cageSolns, cageUnitId, linearSystem, spec, addVirtualCage

  constructor() { /* builds the 27 row/col/box units; no spec parameter */ }

  removeCandidate(r: number, c: number, d: number): BoardEvent[] {
    // row/col/box bookkeeping only: candidate removal, counts, versions,
    // COUNT_DECREASED/COUNT_HIT_TWO/COUNT_HIT_ONE, CELL_DETERMINED, NoSolnError
  }
}
```

`KillerBoardState extends BoardState` adds every cage-related concept:

```typescript
class KillerBoardState extends BoardState {
  readonly spec: PuzzleSpec;
  readonly regions: number[][];
  cageSolns: number[][][];
  readonly linearSystem: LinearSystem;

  constructor(spec: PuzzleSpec, opts?: { includeVirtualCages?: boolean }) {
    super();
    // builds CAGE units (27+), regions, cageSolns via solSums, linearSystem,
    // virtual-cage units from linearSystem.virtualCages
  }

  cageUnitId(r: number, c: number): number { return CAGE_UNIT_OFFSET + this.regions[r]![c]!; }
  addVirtualCage(cells, total, eliminatedSolns, opts): void { /* unchanged from current BoardState.addVirtualCage */ }
  removeCageSolution(cageIdx: number, solution: readonly number[]): BoardEvent { /* unchanged */ }
  private _pruneCageSolutions(cageIdx: number, r: number, c: number, d: number): BoardEvent[] { /* unchanged */ }

  override removeCandidate(r: number, c: number, d: number): BoardEvent[] {
    const events = super.removeCandidate(r, c, d);
    // additionally: for every CAGE unit containing (r, c), call _pruneCageSolutions
    // and append its events — this is the cage-solution-pruning step that the
    // current single removeCandidate performs inline (boardState.ts:225-229)
    return events;
  }
}
```

`peerEliminations` stays on the base `BoardState` unchanged — its `unit.kind === UnitKind.CAGE` branch (line `boardState.ts:176`) is already a no-op when no CAGE units exist, and `KillerBoardState` inherits it correctly because CAGE units are real `Unit` entries in `this.units` regardless of which class built them.

`validateSolution` (currently a free function taking `BoardState`) is unchanged — its `unit.kind === UnitKind.CAGE` skip already handles both cases generically.

## 2. Consumer narrowing — `instanceof KillerBoardState`

Every consumer that needs cage data narrows explicitly. This is defense-in-depth: `killerOnly` rule filtering already guarantees a `killerOnly` rule never receives a plain `BoardState` at runtime, but the type system needs the narrow to allow access to `regions`/`cageSolns`/`linearSystem`/`cageUnitId`.

**Killer-only rules** (`deltaConstraint`, `linearElimination`, `sumPairConstraint`, `cageCandidateFilter`, `cageConfinement`, `cageIntersection`, `mustContain`, `mustContainOutie`, `solutionMapFilter`, `unitPartitionFilter`) — each gets, at the top of its rule-evaluation method:

```typescript
if (!(ctx.board instanceof KillerBoardState)) return emptyResult();
const board = ctx.board; // now typed KillerBoardState; regions/cageSolns/linearSystem/cageUnitId available
```

**`SolverEngine._routeEvents`** (`solverEngine.ts:241`): replaces the `_linearSystemActive` boolean with a direct narrow:

```typescript
if (this.board instanceof KillerBoardState) {
  const newElims = this.board.linearSystem.substituteCell(cell, val);
  // ... unchanged
}
```

The `linearSystemActive` constructor option and `_linearSystemActive` field are deleted from `SolverEngine` entirely — this is the change §8 of `puzzle-state-redesign.md` already calls for ("`linearSystemActive` flag on `SolverEngine` is removed"); it lands here instead.

**`mrvBacktrack`** (`backtracker.ts`): currently reads `board.spec.regions`/`board.spec.cageTotals` unconditionally to build `cageOf`/`cageTotal`/`cageCells` for the validity check. It splits:

```typescript
export function mrvBacktrack(board: BoardState): number[][] | null {
  const cageOf = Array.from({length: 9}, () => new Array<number>(9).fill(0));
  const cageTotal = new Map<number, number>();
  const cageCells = new Map<number, Cell[]>();

  if (board instanceof KillerBoardState) {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const cid = board.spec.regions[r]![c]!;
        cageOf[r]![c] = cid;
        if (!cageCells.has(cid)) cageCells.set(cid, []);
        cageCells.get(cid)!.push([r, c] as Cell);
        const t = board.spec.cageTotals[r]![c]!;
        if (t !== 0) cageTotal.set(cid, t);
      }
    }
  }
  // search() degrades correctly when cageOf is all-zero / cageTotal is empty —
  // every cell maps to "cage 0" with no recorded total, so the cage-sum
  // validity check is vacuously satisfied and the search behaves as plain
  // row/col/box backtracking. (Confirmed by reading search()'s validity check
  // at backtracker.ts — it only constrains a cage when cageTotal.has(cid).)
  ...
}
```

**`candidatesFromBoard`** (actions.ts:635-696): the `cages` array construction (currently reading `board.regions`, `board.cageSolns`, `board.units[27+idx]`, `board.spec.cageTotals`) moves inside a narrow:

```typescript
const cages = board instanceof KillerBoardState
  ? Array.from({ length: Math.max(...board.regions.flat()) + 1 }, (_, idx) => { /* unchanged body */ })
  : [];
```

This also removes the `state.puzzleType === 'classic' ? ... : ...` branch at actions.ts:656-658 (and its "(dummy spec)" comment) — `solverCands` becomes simply `new Set([...board.cands(r, c)].filter(d => cagePossible.has(d)))` gated the same way, or more directly: the whole per-cell `cagePossible`/`solverCands` distinction collapses to `new Set(board.cands(r, c))` when `board` is plain `BoardState`, because there are no cage constraints to intersect against.

## 3. Construction call sites

| Site | Before | After |
|---|---|---|
| `buildEngine` (session/engine.ts) | `new BoardState(dataToSpec(state.specData), {...})` always | `PuzzleState.isKiller(state) ? new KillerBoardState(dataToSpec(state.specData), {...}) : new BoardState()` |
| `solveFromStall` (engine/index.ts:120) | `new BoardState(makeClassicSpec(), {...})` | `new BoardState()` |
| `loadClassicDirect` (session/actions.ts:163-196) | synthesizes 9 trivial row-cages, builds `PuzzleState` with `specData`/`cageStates` | deleted; constructs a classic `PuzzleState` with no `specData`/`cageStates` fields at all |
| `makeClassicSpec()` (engine/index.ts:56-65) | helper producing the trivial-row-cage `PuzzleSpec` | deleted — no longer has any caller |

`buildStateFromParseResult`'s blank-spec fallback (actions.ts:336-344, *"Cage layout could not be detected — starting with a blank grid"*) is **kept as-is** — see §6 (Out of Scope).

## 4. `PuzzleSpec` scope

`PuzzleSpec` (solver/puzzleSpec.ts) keeps its current shape — it still mirrors the Python solver's contract and is still produced by the image pipeline for killer OCR. The change is that, after this work, **nothing constructs a `PuzzleSpec` for a classic puzzle** — it becomes a killer-only contract in practice as well as in spirit.

`specData: PuzzleSpecData` and `cageStates: readonly CageState[]` move from the current monolithic `PuzzleState` onto `KillerPuzzleState` only — exactly the shape `puzzle-state-redesign.md` §1 already defines. (That redesign's actual type-split work remains in its own spec/plan; this prerequisite simply removes the obstacle that made §1 contradict §3.)

## 5. UI surface (`main.ts`)

No behavioral change — `drawCageBorders`/`drawCageTotals` are already gated behind `state.puzzleType !== 'classic'` (main.ts:520, 522), so the `state.specData.regions`/`cageTotals` reads inside them never execute for classic today. Once `specData` is removed from the base `PuzzleState` type (in the follow-on redesign work), those call sites simply require a `KillerPuzzleState` — no logic changes needed here, only type-level adjustments that land with the redesign's Sprint E (namespace `PuzzleState` public API).

This spec does not modify `main.ts`. It only needs to keep compiling against the narrowed `BoardState`/`KillerBoardState` split — verified by the bronze gate (`tsc --noEmit`).

## 6. Out of scope

- **The `PuzzleState`/`KillerPuzzleState` type-hierarchy split itself** — that is `puzzle-state-redesign.md`'s job (Sprint B onward). This spec only removes the architectural obstacle (synthetic specs, cage-modeling `BoardState`) that made that split impossible to do cleanly.
- **`buildStateFromParseResult`'s blank-spec fallback** (actions.ts:336-344) is unrelated to this spec's concern: it represents a **killer** puzzle whose cage layout the OCR pipeline failed to detect (`result.spec === null`, `result.puzzleType === 'killer'`). It genuinely needs a real, if temporarily wrong, `PuzzleSpec` so the user can correct the cage layout in the review screen. It is not touched.
- **Hint-text wording for `hiddenSingle`/`lockedCandidates`** — once classic boards have zero CAGE units, the `unit.kind === UnitKind.CAGE` branches in these rules simply never fire for classic. No wording change is needed; the leak disappears as a structural consequence of the type split, not through editing the rules.
- **`LinearSystem` internals** — unchanged; it remains a killer-only concept, now constructed only inside `KillerBoardState`.

## 7. Testing

- `boardState.test.ts` gains construction tests for both `new BoardState()` (27 units, no `regions`/`cageSolns`/`linearSystem` properties) and `new KillerBoardState(spec)` (current behavior, renamed).
- Existing cage-rule tests (`cageRules.test.ts`, `cageConfinement.test.ts`, `mustContain.test.ts`, `mustContainOutie.test.ts`, `hiddenSingle.test.ts`, `solverEngine.test.ts`, `linearElimination.test.ts`, `deltaConstraint.test.ts`, `sumPairConstraint.test.ts`) construct `KillerBoardState` directly in place of `BoardState`.
- A new `boardState.test.ts` case confirms `hiddenSingle`/`lockedCandidates` never produce cage-flavored explanation text against a plain `BoardState` (regression guard for the leak this spec fixes).
- `mrvBacktrack` gets a test confirming it solves a plain classic grid via `new BoardState()` with no `KillerBoardState` involved.
- Full bronze gate (`tsc --noEmit` ×2, `npm test`) must pass; Playwright suites re-run since this touches the session/engine boundary that `flow.spec.ts` and `app.spec.ts` exercise for both puzzle types.
