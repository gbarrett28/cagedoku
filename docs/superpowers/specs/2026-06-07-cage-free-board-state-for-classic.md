# Cage-Free BoardState & Type-Safe Dispatch for Classic

**Date:** 2026-06-07
**Branch:** feature/cage-free-board-state (to be created)
**Status:** Prerequisite for `puzzle-state-redesign` — must land on master before that work begins.

**Motivation:** Classic puzzles currently run on `BoardState`/`LinearSystem` instances built from a *synthetic killer spec* — nine fake "row cages" each totalling 45 (`loadClassicDirect`, `makeClassicSpec()`), or a single fake whole-grid cage (`buildStateFromParseResult`'s blank-spec fallback, which is legitimate — see §6). This fiction is not inert:

- `hiddenSingle`/`lockedCandidates` (core, non-`killerOnly` rules) branch on `UnitKind.CAGE` and produce cage-flavored hint text — e.g. *"... is essential to every remaining cage solution"* — for a puzzle that has no cages.
- `candidatesFromBoard` (actions.ts) reads `board.regions`/`board.cageSolns`/`board.units[27+idx]` unconditionally and special-cases classic with an explicit `puzzleType === 'classic'` branch and the comment *"cage solutions are always empty (dummy spec)"*.
- The synthetic-spec construction appears three times (`loadClassicDirect`, `makeClassicSpec`, the blank-spec fallback for undetected killer layouts), each a slightly different shape. **Only `makeClassicSpec` can be deleted by this work.** `loadClassicDirect`'s synthetic spec is a structural necessity, not a design choice to revisit here: `PuzzleState.specData`/`cageStates` are non-optional fields on the current monolithic type (the split that would make them optional for classic is `puzzle-state-redesign`'s job — out of scope, see §6), and `solveCurrentSpec`/`solvePuzzle`/`solveAndValidateSpec` (`actions.ts:295,519,901` — invoked for **both** puzzle types; confirmed at `main.ts:1259`, which calls `solveCurrentSpec()` for classic) build a real `PuzzleSpec` via `cageStatesToSpec(state.cageStates, state.specData)` and feed it to `solve()`. Removing `loadClassicDirect`'s synthesis would leave those functions with no spec to solve — see the corrected §3 table.

Splitting `BoardState` into a plain skeleton plus a `KillerBoardState` subclass (§1) removes the synthetic-spec fiction. But that split alone creates a second problem if every consumer that needs cage data responds by adding `if (!(ctx.board instanceof KillerBoardState)) return ...`: the puzzle-type discriminant simply relocates from fake `PuzzleSpec` data into runtime board-identity tests, scattered through `SolverEngine`, `mrvBacktrack`, `candidatesFromBoard`, and ten rules. That is precisely the anti-pattern CLAUDE.md's "OO over discriminated unions" section warns against — *"More than one switch/if-else chain dispatching on the same discriminant across the codebase"* — just rebuilt one layer down.

This spec therefore does two things together: it makes "classic has no cages" a structural fact enforced by the type system (§1), **and** it routes every resulting dispatch decision through one of two existing, principled channels — virtual methods on `BoardState`/`KillerBoardState` (the board "knows what it is", the same template-method shape `removeCandidate` already uses) or the single canonical `PuzzleState.isKiller` predicate that `buildEngine` uses to decide which collaborators to construct (§2). Generic infrastructure — `SolverEngine`, `mrvBacktrack`, the rule contract — ends up with **zero** runtime type tests of its own. It also introduces the `isKiller` predicate at the exact spot and in the exact plain-`boolean` shape `puzzle-state-redesign.md` §6 already expects — so that redesign can later upgrade it to a `state is KillerPuzzleState` type guard with zero call-site changes (§2.5). The `PuzzleState`/`KillerPuzzleState` *field* split itself (`specData`/`cageStates` moving onto `KillerPuzzleState` only) remains entirely that redesign's job — see the corrected §3/§4.

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

  /** Cage-sum data for the MRV backtracker's validity check, or null when this
   *  board has no cages. Plain BoardState always returns null — search() then
   *  degrades to pure row/col/box backtracking (see §2.3). */
  cageConstraints(): CageConstraints | null { return null; }
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

  override cageConstraints(): CageConstraints | null {
    // builds { cageOf, cageTotal, cageCells } from this.regions / this.spec.cageTotals
    // — the extraction currently inlined at the top of mrvBacktrack (backtracker.ts:49-62)
  }
}
```

`CageConstraints` is a small new exported type in `backtracker.ts`:

```typescript
interface CageConstraints {
  readonly cageOf: number[][];
  readonly cageTotal: ReadonlyMap<number, number>;
  readonly cageCells: ReadonlyMap<number, readonly Cell[]>;
}
```

`peerEliminations` stays on the base `BoardState` unchanged — its `unit.kind === UnitKind.CAGE` branch (line `boardState.ts:176`) is already a no-op when no CAGE units exist, and `KillerBoardState` inherits it correctly because CAGE units are real `Unit` entries in `this.units` regardless of which class built them.

`validateSolution` (currently a free function taking `BoardState`) is unchanged — its `unit.kind === UnitKind.CAGE` skip already handles both cases generically.

## 2. Dispatch — virtual methods and the single `isKiller` predicate

No consumer tests `instanceof KillerBoardState` to decide *what to do*. Each of the four places that need cage data resolves it through one of two channels: a virtual method the board already has (because the board is the thing that "knows what it is"), or the single `PuzzleState.isKiller` predicate that `buildEngine` consults once, at construction, to wire up every type-specific collaborator together.

### 2.1 Killer-only rules — `KillerOnlyRule` base class

The ten `killerOnly` rules (`deltaConstraint`, `linearElimination`, `sumPairConstraint`, `cageCandidateFilter`, `cageConfinement`, `cageIntersection`, `mustContain`, `mustContainOutie`, `solutionMapFilter`, `unitPartitionFilter`) currently each implement `SolverRule` directly against `ctx: RuleContext` (`board: BoardState`). Rather than ten separate narrows, they extend one base that performs the narrow exactly once and hands subclasses a properly-typed context:

```typescript
// rule.ts
export interface KillerRuleContext extends Omit<RuleContext, 'board'> {
  readonly board: KillerBoardState;
}

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

Each killer rule changes from `class DeltaConstraint implements SolverRule` (with `apply`/`asHints` against `RuleContext`) to `class DeltaConstraint extends KillerOnlyRule` (with `applyKiller`/`asHintsKiller` against `KillerRuleContext` — `ctx.board` is `KillerBoardState`, so `ctx.board.linearSystem`/`regions`/`cageSolns`/`cageUnitId` are directly typed, no cast, no further narrow). `readonly killerOnly = true` moves from each rule into the base class — it is no longer repeated ten times.

This is the single point of "defense in depth": `killerOnly`-filtered rule sets (built by `buildEngine` via `PuzzleState.isKiller`, see §3) guarantee `ctx.board` is always a `KillerBoardState` when a `KillerOnlyRule.apply` runs, so the `instanceof` branch is unreachable in practice — but the type system still requires *some* narrow to expose `KillerBoardState`'s members to `applyKiller`, and this is the one place it lives.

### 2.2 `SolverEngine`/`KillerSolverEngine` — virtual `_onCellDetermined` hook

`SolverEngine._routeEvents` (`solverEngine.ts:236-282`) currently gates its linear-system substitution block (lines 241-259: `substituteCell`/`substituteLiveRows`/constraint narrowing) behind `if (this._linearSystemActive)`. That block becomes a protected virtual hook — the same template-method shape `KillerBoardState.removeCandidate` already uses for cage pruning:

```typescript
/** Options shared by SolverEngine and KillerSolverEngine — identical to the
 *  current SolverEngine constructor options minus `linearSystemActive`, which
 *  is deleted (see below: dispatch is now virtual, not flag-driven). */
export interface SolverEngineOptions {
  hintRules?: ReadonlySet<string>;
  goldenSolution?: readonly (readonly number[])[] | null;
  onViolation?: ((ruleName: string, offending: readonly Elimination[]) => void) | null;
}

export class SolverEngine {
  readonly board: BoardState;
  // ...

  constructor(board: BoardState, rules: SolverRule[], opts: SolverEngineOptions = {}) { /* unchanged minus _linearSystemActive */ }

  /** Linear-system propagation for a just-determined cell. No-op on a board
   *  with no LinearSystem; KillerSolverEngine overrides it. */
  protected _onCellDetermined(_cell: Cell, _val: number): void {}

  private _routeEvents(events: BoardEvent[], _srcR: number, _srcC: number): void {
    for (const event of events) {
      if (event.trigger === Trigger.CELL_DETERMINED) {
        const cell = event.payload as Cell;
        const val = event.hintDigit!;
        this._onCellDetermined(cell, val);
        // ... unchanged: enqueue CELL_DETERMINED / CELL_SOLVED listeners
      }
      // ... unchanged
    }
  }
}

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
      // unchanged body — current solverEngine.ts:246-258
    }
  }
}
```

`_linearSystemActive` (field + constructor option) is deleted entirely — this is the change §8 of `puzzle-state-redesign.md` already calls for ("`linearSystemActive` flag on `SolverEngine` is removed"); it lands here instead, as a consequence of dispatch becoming virtual rather than flag-driven.

### 2.3 `mrvBacktrack` — `board.cageConstraints()`

`mrvBacktrack` (`backtracker.ts:48-62`) currently reads `board.spec.regions`/`board.spec.cageTotals` unconditionally to build `cageOf`/`cageTotal`/`cageCells`. That extraction moves onto the board itself (§1's `cageConstraints()` virtual method — `KillerBoardState` builds the real maps, plain `BoardState` returns `null`):

```typescript
export function mrvBacktrack(board: BoardState): number[][] | null {
  const constraints = board.cageConstraints();
  const cageOf = constraints?.cageOf ?? Array.from({length: 9}, () => new Array<number>(9).fill(0));
  const cageTotal = constraints?.cageTotal ?? new Map<number, number>();
  const cageCells = constraints?.cageCells ?? new Map<number, readonly Cell[]>();
  // ... search() unchanged — degrades correctly when cageOf is all-zero / cageTotal
  // is empty, exactly as today (confirmed by reading cageValid: `if (total ===
  // undefined) return true`)
}
```

`mrvBacktrack` never asks what kind of board it has — it asks the board for its constraints, the same way it already asks for `board.cands(r, c)`. This also matters for callers that hold only a `board` and no `PuzzleState` — `repro-bugs.ts`, `seed-rule-fixtures.ts`, and the `altSolution = mrvBacktrack(board)` call sites in `actions.ts` (lines 1160, 1188) — none of which would be reachable by a `PuzzleState`-level dispatch.

### 2.4 `candidatesFromBoard` — one narrow, on the right question

`candidatesFromBoard` (`actions.ts:635-696`) currently asks the wrong question to decide whether cage display data exists — `state.puzzleType === 'classic' ? new Set(board.cands(r, c)) : new Set([...board.cands(r, c)].filter(d => cagePossible.has(d)))`, with the comment *"cage solutions are always empty (dummy spec) — use board candidates directly"*. That comment is a tell: the code is testing `state.puzzleType` to infer something about `board`'s structure, because today `board` always carries cage fields regardless of puzzle type (the dummy-spec fiction this whole spec removes).

Once `board` is genuinely either `BoardState` or `KillerBoardState`, the correct question — *does this board carry cage display data* — has a direct, structural answer:

```typescript
const cages = board instanceof KillerBoardState
  ? Array.from({ length: Math.max(...board.regions.flat()) + 1 }, (_, idx) => { /* unchanged body */ })
  : [];

const solverCands = board instanceof KillerBoardState
  ? new Set([...board.cands(r, c)].filter(d => cagePossible.has(d)))
  : new Set(board.cands(r, c));
```

This `instanceof` is not a relocation of the discriminant — it *replaces a wrong proxy test with the correct structural one*, in exactly one function, at the one place that needs `KillerBoardState`-shaped display data. It removes the `state.puzzleType === 'classic'` branch and the "(dummy spec)" comment entirely (actions.ts:656-658).

### 2.5 `PuzzleState.isKiller` — the one canonical predicate

`buildEngine` already branches on `state.puzzleType === 'classic'` to decide which rules to include (`session/engine.ts:237-239`). This spec promotes that check to a named predicate, placed in `session/types.ts` immediately after the `PuzzleState` interface — the exact spot `namespace UserAction` (line 141) already occupies relative to its type, and the namespace `puzzle-state-redesign.md` §6 expects to extend:

```typescript
// session/types.ts, directly after `export interface PuzzleState { ... }`
export namespace PuzzleState {
  export function isKiller(state: PuzzleState): boolean {
    return state.puzzleType !== 'classic';
  }
}
```

`buildEngine` (and `solveFromStall`, and anywhere else that currently inspects `state.puzzleType` to decide which `BoardState`/`SolverEngine`/rule-set to build) calls `PuzzleState.isKiller(state)` once and constructs the entire matching bundle — board class, engine class, rule list — from that single decision (see §3). No other call site re-derives "is this killer" from `state` or from `board`.

This is deliberately a plain `boolean` predicate, not a type guard — `PuzzleState` is not yet split into `PuzzleState`/`KillerPuzzleState` (that split is `puzzle-state-redesign`'s job, out of scope here per §6). `puzzle-state-redesign.md` §6 already specifies `namespace PuzzleState { export function isKiller(state: PuzzleState): state is KillerPuzzleState }` — landing the predicate now, under the same name, in the same namespace, with the same call sites, means its later upgrade to a type guard changes its declared return type only. No call site needs to change.

## 3. Construction call sites

| Site | Before | After |
|---|---|---|
| `buildEngine` (session/engine.ts) | `new BoardState(dataToSpec(state.specData), {...})` always; `SolverEngine` always; rules filtered inline by `state.puzzleType === 'classic'` | `PuzzleState.isKiller(state)` decides once: `new KillerBoardState(dataToSpec(state.specData), {...})` + `new KillerSolverEngine(board, allRules, {...})`, or `new BoardState()` + `new SolverEngine(board, allRules.filter(r => !r.killerOnly), {...})` |
| `solveFromStall` (engine/index.ts:120) | `new BoardState(makeClassicSpec(), {...})` + `new SolverEngine(board, defaultRules())` | `new BoardState()` + `new SolverEngine(board, defaultRules().filter(r => !r.killerOnly))` |
| `loadClassicDirect` (session/actions.ts:163-196) | synthesizes 9 trivial row-cages, builds `PuzzleState` with `specData`/`cageStates` | **unchanged** — still synthesizes the row-cage `PuzzleSpec`/`specData`/`cageStates`. `PuzzleState` (pre-type-split) requires those fields, and `solveCurrentSpec`/`solvePuzzle`/`solveAndValidateSpec` need a real `PuzzleSpec` to call `solve()` for classic puzzles too. Removing this synthesis is `puzzle-state-redesign`'s job, once `specData`/`cageStates` move onto `KillerPuzzleState` only. |
| `makeClassicSpec()` (engine/index.ts:56-65) | helper producing the trivial-row-cage `PuzzleSpec`, used only by `solveFromStall` | deleted — `solveFromStall` no longer needs a `PuzzleSpec` once it constructs a plain `BoardState()` directly (see row above) |
| `solve`/`solveCurrentSpec`/`solvePuzzle`/`solveAndValidateSpec` (engine/index.ts:98, actions.ts:295,519,901) | `new BoardState(spec, {...})` + `new SolverEngine(board, defaultRules())`, for both puzzle types | **unchanged** — these all take a `PuzzleSpec` (real for killer, synthetic row-cage for classic, per the `loadClassicDirect` row above) and construct `KillerBoardState`/`KillerSolverEngine` exactly as today. They are one-shot full-solve / OCR-validation paths, not the interactive engine where hints are surfaced — the synthetic cages are harmless there and changing them is out of scope (would require the same `specData` type-split). The architectural fix lands precisely where it matters: the interactive `buildEngine` path. |

`buildStateFromParseResult`'s blank-spec fallback (actions.ts:336-344, *"Cage layout could not be detected — starting with a blank grid"*) is **kept as-is** — see §6 (Out of Scope).

## 4. `PuzzleSpec` scope

`PuzzleSpec` (solver/puzzleSpec.ts) keeps its current shape — it still mirrors the Python solver's contract and is still produced by the image pipeline for killer OCR, *and* still synthesized for classic by `loadClassicDirect` (a structural necessity of the current `PuzzleState` shape — see §3). The claim that "nothing constructs a `PuzzleSpec` for a classic puzzle" does **not** hold yet — it becomes true only once `puzzle-state-redesign` removes `specData`/`cageStates` from the base `PuzzleState`. What *this* spec achieves is narrower but real: the **interactive** engine (`buildEngine`, where hints/rules run and where the cage-flavored hint-text leak actually manifests) stops being built from that synthetic spec for classic puzzles, using a cage-free `BoardState` instead.

`specData: PuzzleSpecData` and `cageStates: readonly CageState[]` **stay on the monolithic `PuzzleState`** for both puzzle types — moving them onto `KillerPuzzleState` only is `puzzle-state-redesign.md` §1's job, and depends on first removing `loadClassicDirect`'s synthesis (§3), which in turn depends on reworking `solveCurrentSpec`/`solvePuzzle`/`solveAndValidateSpec` to not need a `PuzzleSpec` for classic — a separate, larger change than this prerequisite's scope. What this spec *does* resolve is the **board/engine/rule-dispatch** half of `puzzle-state-redesign.md` §1's contradiction with §3 (the `BoardState`/`KillerBoardState` split, §1 of this spec); the **field** half remains for that redesign to address directly.

## 5. UI surface (`main.ts`)

No behavioral change — `drawCageBorders`/`drawCageTotals` are already gated behind `state.puzzleType !== 'classic'` (main.ts:520, 522), so the `state.specData.regions`/`cageTotals` reads inside them never execute for classic today. Once `specData` is removed from the base `PuzzleState` type (in the follow-on redesign work), those call sites simply require a `KillerPuzzleState` — no logic changes needed here, only type-level adjustments that land with the redesign's Sprint E (namespace `PuzzleState` public API).

This spec does not modify `main.ts`. It only needs to keep compiling against the narrowed `BoardState`/`KillerBoardState` split — verified by the bronze gate (`tsc --noEmit`).

## 6. Out of scope

- **The `PuzzleState`/`KillerPuzzleState` type-hierarchy split itself** — that is `puzzle-state-redesign.md`'s job (Sprint B onward). This spec only removes the architectural obstacles (synthetic specs, cage-modeling `BoardState`, board-identity dispatch in generic infrastructure) that made that split impossible to do cleanly. The `isKiller` predicate (§2.5) is introduced as a plain `boolean` precisely so the redesign can upgrade it to a type guard in place, without touching any of the call sites this spec creates.
- **`buildStateFromParseResult`'s blank-spec fallback** (actions.ts:336-344) is unrelated to this spec's concern: it represents a **killer** puzzle whose cage layout the OCR pipeline failed to detect (`result.spec === null`, `result.puzzleType === 'killer'`). It genuinely needs a real, if temporarily wrong, `PuzzleSpec` so the user can correct the cage layout in the review screen. It is not touched.
- **Hint-text wording for `hiddenSingle`/`lockedCandidates`** — once classic boards have zero CAGE units, the `unit.kind === UnitKind.CAGE` branches in these rules simply never fire for classic. No wording change is needed; the leak disappears as a structural consequence of the type split, not through editing the rules.
- **`LinearSystem` internals** — unchanged; it remains a killer-only concept, now constructed only inside `KillerBoardState`.
- **`PuzzleState`/`KillerPuzzleState` namespace display methods** (`candidateDisplay`, `cageDisplay`, `cageBoundaries`, etc., specified in `puzzle-state-redesign.md` §6) — building these now, before the type split exists, would mean throwaway scaffolding that the redesign immediately replaces. §2.4's single `instanceof` in `candidatesFromBoard` is the right amount of dispatch for *this* spec; the redesign's Sprint E replaces it with the namespace methods as part of building the type hierarchy those methods dispatch on.

## 7. Testing

- `boardState.test.ts` gains construction tests for both `new BoardState()` (27 units, no `regions`/`cageSolns`/`linearSystem`/`spec` properties, `cageConstraints()` returns `null`) and `new KillerBoardState(spec)` (current behavior, renamed; `cageConstraints()` returns the populated maps).
- A new `boardState.test.ts` case confirms `hiddenSingle`/`lockedCandidates` never produce cage-flavored explanation text against a plain `BoardState` (regression guard for the leak this spec fixes).
- `rule.test.ts` (or a new `killerOnlyRule.test.ts`) gains a test confirming `KillerOnlyRule.apply`/`asHints` return `emptyResult()`/`[]` when given a `RuleContext` whose `board` is a plain `BoardState` — the one-time defense-in-depth narrow, exercised directly rather than relying on it never being hit in practice.
- Existing cage-rule tests (`cageRules.test.ts`, `cageConfinement.test.ts`, `mustContain.test.ts`, `mustContainOutie.test.ts`, `linearElimination.test.ts`, `deltaConstraint.test.ts`, `sumPairConstraint.test.ts`) construct `KillerBoardState` directly in place of `BoardState`, and the rule classes under test extend `KillerOnlyRule` (`applyKiller`/`asHintsKiller` against `KillerRuleContext`).
- `hiddenSingle.test.ts`/`solverEngine.test.ts` construct `KillerBoardState` where cage behavior is exercised, and `KillerSolverEngine` where linear-system routing is exercised; a new `solverEngine.test.ts` case confirms `SolverEngine` (base) never calls into a `LinearSystem` — `_onCellDetermined` is a no-op — when given a plain `BoardState`.
- `backtracker.test.ts` gains a case confirming `mrvBacktrack` solves a plain classic grid via `new BoardState()` (whose `cageConstraints()` returns `null`) with no `KillerBoardState` involved, and that the existing killer-spec cases still pass via `KillerBoardState.cageConstraints()`.
- `actions.test.ts` (or wherever `candidatesFromBoard` is tested) gains a case confirming the `cages` array is `[]` and `solverCands` equals `board.cands(r, c)` exactly for a plain `BoardState`, with no `state.puzzleType` branch involved.
- A new test for `isKiller` confirms it returns `true`/`false` consistently with `state.puzzleType`.
- Full bronze gate (`tsc --noEmit` ×2, `npm test`) must pass; Playwright suites re-run since this touches the session/engine boundary that `flow.spec.ts` and `app.spec.ts` exercise for both puzzle types.
