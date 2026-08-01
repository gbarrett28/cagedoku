# Expunge UniqueRectangle and Fix Delta-Pair Staleness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two independent cleanups on `feature/expunge-ur-fix-delta-pairs`: (1) fully
remove the `UniqueRectangle` rule, which has been disabled since it depends on a
"puzzle has a unique solution" assumption no other rule makes, and (2) fix a real
staleness bug in `LinearSystem`: `deltaPairs` (read by `DeltaConstraint`) are derived
once at `BoardState` construction and never refreshed as cells get solved, unlike
`pendingVirtualCages` (read by `DerivedVirtualCage`), which already has a live-update
path. This is why some puzzles (e.g. the one that surfaced this investigation) need
backtracking instead of resolving purely through rules.

**Architecture:** Part 1 is a mechanical deletion across the rule registry, its tests,
and one diagnostic script. Part 2 adds one new branch to
`LinearSystem.substituteLiveRows` (already the live-update entry point invoked by
`KillerSolverEngine._onCellDetermined` on every `CELL_DETERMINED` event) that detects
a freshly-reduced two-term row with coefficients `+1`/`-1` — the same shape the
constructor's own RREF dispatch already recognises for pairs present at *setup* time —
and records it via the existing private `_addDeltaPair` helper. No other module
changes: `DeltaConstraint.pairsForCell()` already reads live off `_pairsByCell`, so it
picks up newly-added pairs automatically on its next trigger.

**Tech Stack:** TypeScript, Vitest, the existing `LinearSystem` exact-rational (`Frac`)
arithmetic.

## Global Constraints

- Row-major `[row][col]` everywhere; `Cell = [row, col]`.
- Use `cellLabel()` for any new user-facing text (not needed here — Part 2 touches no
  UI-facing strings).
- Bronze gate (`bash scripts/run-bronze-gate.sh`) before every feature-branch commit;
  silver gate (`bash scripts/run-silver-gate.sh`) before merging to master, per
  `CLAUDE.md`.
- Use serena MCP tools for all TypeScript reads/edits (per `CLAUDE.md`'s Agent
  Protocol) — plain `Read`/`Edit` are blocked on `.ts` files in this repo.

---

## Part 1 — Expunge UniqueRectangle

**Context:** `UniqueRectangle` (`web/src/engine/rules/uniqueRectangle.ts`) has been in
`DISABLED_RULES` (`web/src/engine/rules/disabled-rules.ts`) since it was found to
depend on "the puzzle has a unique solution" — a meta-assumption no other active rule
makes — so `buildEngine()`/`getHints()` already filter it out at runtime. It is dead
weight: the class, its dedicated test file, its registration, and a diagnostic-script
reference to it should all go. `DISABLED_RULES` becomes empty; the mechanism itself
(deliberately curated, manually maintained, per `docs/architecture.md`) stays for future
use.

Full current reference inventory (confirmed via a repo-wide search — nothing else
references `UniqueRectangle`):

| File | What's there |
|---|---|
| `web/src/engine/rules/uniqueRectangle.ts` | the rule class itself |
| `web/src/engine/rules/uniqueRectangle.test.ts` | its dedicated tests |
| `web/src/engine/rules/index.ts` | priority-comment line, import, export, `defaultRules()` entry |
| `web/src/engine/rules/index.test.ts` | `'UniqueRectangle'` in `EXPECTED_RULES` |
| `web/src/engine/rules/disabled-rules.ts` | the sole entry in `DISABLED_RULES` |
| `web/src/engine/rules/__fixtures__/skipPolicy.test.ts` | uses `'UniqueRectangle'` as its example of a globally-disabled rule (coupled to real prod data) |
| `web/scripts/repro-bugs.ts` | imports the class; a whole "Bug #139 — Unique Rectangle" diagnostic block |
| `docs/architecture.md` | names `UniqueRectangle` as the current example in the "Disabled rules" section |

**Not touched, deliberately:** `web/scripts/seed-rule-fixtures.ts` — a one-time,
already-run historical generator script that records `ruleName: 'UniqueRectangle'` in
its frozen `ISSUES` array (from issues #124/#126) and a comment. It does not import the
`UniqueRectangle` class, so nothing breaks; editing it would misrepresent history for no
functional benefit.

### Task 1: Delete the rule, its test, and all registrations

**Files:**
- Delete: `web/src/engine/rules/uniqueRectangle.ts`
- Delete: `web/src/engine/rules/uniqueRectangle.test.ts`
- Modify: `web/src/engine/rules/index.ts`
- Modify: `web/src/engine/rules/index.test.ts`
- Modify: `web/scripts/repro-bugs.ts`

- [ ] **Step 1: Delete the two UniqueRectangle files**

Use serena's `safe_delete_symbol` or plain file deletion (these are whole-file
deletions, not symbol edits) for:
- `web/src/engine/rules/uniqueRectangle.ts`
- `web/src/engine/rules/uniqueRectangle.test.ts`

- [ ] **Step 2: Remove UniqueRectangle from `index.ts`**

In `web/src/engine/rules/index.ts`:
- Remove the ` * 20  UniqueRectangle         — GLOBAL` line from the priority-order
  comment block at the top (leave every other line/number as-is — gaps in the priority
  sequence are fine, ties are broken by declaration order, not contiguous numbering).
- Remove `import { UniqueRectangle } from './uniqueRectangle.js';`
- Remove `UniqueRectangle,` from the `export { ... }` block.
- Remove `new UniqueRectangle(),` from the `defaultRules()` array.

- [ ] **Step 3: Remove UniqueRectangle from the registry smoke test**

In `web/src/engine/rules/index.test.ts`, remove `'UniqueRectangle',` from
`EXPECTED_RULES`.

- [ ] **Step 4: Remove the dead import and Bug #139 block from `repro-bugs.ts`**

In `web/scripts/repro-bugs.ts`:
- Remove `import { UniqueRectangle } from '../src/engine/rules/uniqueRectangle.js';`
- Remove the entire `// Bug #139 — Unique Rectangle — ...` block (from
  `console.log('\n====== Bug #139 — Unique Rectangle ======');` through the closing
  `}` right before the `// Bug #141 — Naked Pair` section header comment). Bug #141 and
  #144's blocks are unrelated and stay untouched.

- [ ] **Step 5: Verify**

Run: `cd web && npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit && npx vitest run src/engine/rules/index.test.ts`
Expected: no `TS2307`/`TS6133` errors (confirms nothing else imports the deleted
files), `index.test.ts` passes with `UniqueRectangle` gone from both the expected list
and the actual `defaultRules()` output.

- [ ] **Step 6: Commit**

```bash
bash scripts/run-bronze-gate.sh
git add web/src/engine/rules/index.ts web/src/engine/rules/index.test.ts web/scripts/repro-bugs.ts
git rm web/src/engine/rules/uniqueRectangle.ts web/src/engine/rules/uniqueRectangle.test.ts
git commit -m "chore: remove UniqueRectangle rule and its registrations"
```

### Task 2: Empty DISABLED_RULES and decouple skipPolicy.test.ts from it

**Files:**
- Modify: `web/src/engine/rules/disabled-rules.ts`
- Modify: `web/src/engine/rules/__fixtures__/skipPolicy.test.ts`

**Context:** `skipPolicy.test.ts`'s "skips a fixture for a globally disabled rule" test
currently hardcodes `'UniqueRectangle'` as its example — coupling a test of generic
`shouldSkipFixture()` behaviour to whatever the *real* `DISABLED_RULES` list currently
contains. That coupling is exactly what breaks the moment the referenced rule is
deleted. The file already mocks `./needs-triage.js` for its `NEEDS_TRIAGE_FIXTURES`
case (`vi.mock('./needs-triage.js', () => ({ NEEDS_TRIAGE_FIXTURES: [...] }))`) — apply
the same pattern to `../disabled-rules.js` so the test is self-contained.

- [ ] **Step 1: Empty out `disabled-rules.ts`**

Replace the body of `web/src/engine/rules/disabled-rules.ts` with:

```ts
// Manually curated list of rule names excluded from the active rule set (see
// docs/architecture.md's "Disabled rules" section). Empty for now -- no rule is
// currently disabled. A rule is added here only as a deliberate product decision,
// never automatically.
export const DISABLED_RULES: readonly string[] = [];
```

- [ ] **Step 2: Write the (currently passing, soon-to-be-decoupled) mock for `skipPolicy.test.ts`**

In `web/src/engine/rules/__fixtures__/skipPolicy.test.ts`, add a mock for
`../disabled-rules.js` alongside the existing `./needs-triage.js` mock:

```ts
vi.mock('../disabled-rules.js', () => ({
  DISABLED_RULES: ['SomeDisabledRule'],
}));
```

Then change the "skips a fixture for a globally disabled rule" test to use that
fictitious name instead of `'UniqueRectangle'`:

```ts
it('skips a fixture for a globally disabled rule', () => {
  const fixture = makeFixture({ ruleName: 'SomeDisabledRule' });
  const rule = { name: 'SomeDisabledRule' } as SolverRule;
  expect(shouldSkipFixture(fixture, rule, [])).toBe(true);
});
```

- [ ] **Step 3: Run the test to verify it still passes**

Run: `cd web && npx vitest run src/engine/rules/__fixtures__/skipPolicy.test.ts`
Expected: PASS — the test now exercises the same `DISABLED_RULES.includes(...)` branch
in `shouldSkipFixture`, but against a mocked list instead of production data.

- [ ] **Step 4: Commit**

```bash
bash scripts/run-bronze-gate.sh
git add web/src/engine/rules/disabled-rules.ts web/src/engine/rules/__fixtures__/skipPolicy.test.ts
git commit -m "chore: empty DISABLED_RULES, decouple skipPolicy test from a real rule name"
```

### Task 3: Update docs/architecture.md's "Disabled rules" section

**Files:**
- Modify: `docs/architecture.md` (around line 1002-1013, "### Disabled rules")

- [ ] **Step 1: Rewrite the section**

Replace the paragraph that names `UniqueRectangle` as the current example:

```markdown
A rule is added to `DISABLED_RULES` only as a deliberate product decision (e.g.
`UniqueRectangle`, whose Type 1/2 proofs depend on "the puzzle has a unique
solution" — a meta-assumption no other active rule makes). Its regression-fixture
tests (see below) use the same `it.skip` convention while disabled.
```

with:

```markdown
A rule is added to `DISABLED_RULES` only as a deliberate product decision — e.g. a
proof that depends on "the puzzle has a unique solution", a meta-assumption no other
active rule makes. (`UniqueRectangle` was the sole past example; it was removed
entirely, not just disabled, once it had no other path back to being enabled — see
git history for its removal.) The list is currently empty. Any regression-fixture
tests for a disabled rule should use the same `it.skip` convention while it remains
disabled.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: update Disabled rules section after removing UniqueRectangle"
```

---

## Part 2 — Fix delta-pair staleness in LinearSystem

**Context (already diagnosed and the fix already verified against a hand-built
repro — see below):**

`LinearSystem.deltaPairs` / the `_pairsByCell` index that `DeltaConstraint` reads via
`pairsForCell()` are populated *only* by the private `_addDeltaPair` helper, which is
called *only* during the constructor's one-time RREF pass over the static puzzle spec
(`web/src/engine/linearSystem.ts`, the `nonzero.length === 2` branch around line 226).
`BoardState` builds the `LinearSystem` exactly once, at construction
(`web/src/engine/boardState.ts:259`). Nothing else ever calls `_addDeltaPair` again —
so `DeltaConstraint` can never see a delta relationship that only becomes derivable
after some cells get solved.

By contrast, `LinearSystem.substituteLiveRows(cell, value)` *is* a live-update path:
`KillerSolverEngine._onCellDetermined` calls it on every `CELL_DETERMINED` event
(`web/src/engine/solverEngine.ts:386-388`), and it already detects two shapes in a
freshly-reduced row: a single remaining term (a determined cell, golden-checked) and a
uniform-coefficient multi-term row (a virtual-cage/sum constraint, queued onto
`pendingVirtualCages` for `DerivedVirtualCage`). It does **not** currently detect the
third shape the constructor's own dispatch already knows about: a row that reduces to
exactly two terms with coefficients `+1`/`-1` — a delta pair. That row shape is
silently dropped today.

**Verified repro (hand-built, run via `npx vite-node` against the current code before
this fix):** a spec with two 3-cell cages straddling the box0/box1 boundary —
`(0,2),(0,3),(0,4)` totalling `17` and `(1,2),(1,3),(1,4)` totalling `12` — RREF-reduces
(against box0's own sum-45 equation) to a genuinely mixed-sign live row:
`(0,2) - (1,3) - (1,4) = -6`. Substituting `(1,4) = 9` (its `KNOWN_SOLUTION` value)
reduces this to `(0,2) - (1,3) = 3` — a clean two-term delta row. On current
(unfixed) code, `substituteLiveRows([1,4], 9)` returns only the *other* live row's
result (`(0,4) = 7`, a single-cell determination, plus the unrelated
`(1,2)+(1,3)=3` virtual cage from a third live row) and **silently drops** the
`(0,2) - (1,3) = 3` relationship: `pairsForCell([0,2])` stays `[]` after the call.

**Fix:** add a `_maybeAddLiveDeltaPair` private helper (mirroring the existing
`_maybeAddVirtualCage` naming/shape) and call it from `substituteLiveRows` between the
single-cell branch and the uniform-coefficient branch. It records new pairs directly
via `_addDeltaPair` — no return-type change, no `SolverEngine`/`DeltaConstraint`
changes needed, since `pairsForCell()` already reads live off `_pairsByCell`.

### Task 4: Write the failing regression test

**Files:**
- Modify: `web/src/engine/linearSystem.test.ts`

- [ ] **Step 1: Write the test**

Add a new `describe` block using the verified repro spec above (built inline with
`validateCageLayout`/`makeTrivialBorderX`/`makeTrivialBorderY`/`KNOWN_SOLUTION`, the
same helpers `web/src/engine/fixtures.ts` already exports and this file already
imports):

```ts
import { validateCageLayout } from '../image/validation.js';
import { KNOWN_SOLUTION, makeTrivialBorderX, makeTrivialBorderY } from './fixtures.js';
import type { Cell } from './types.js';

function makeCrossBoxDeltaSpec(): PuzzleSpec {
  // Two 3-cell cages straddling the box0/box1 boundary in rows 0-1. Combined with
  // box0's own sum-45 equation, RREF reduces this to a genuinely mixed-sign live
  // row -- (0,2) - (1,3) - (1,4) = -6 -- that only becomes a clean two-term delta
  // pair, (0,2) - (1,3) = 3, once (1,4) is substituted mid-solve.
  const cageTotals = KNOWN_SOLUTION.map(row => [...row]);
  const borderX = makeTrivialBorderX();
  const borderY = makeTrivialBorderY();

  const cageA = KNOWN_SOLUTION[0]![2]! + KNOWN_SOLUTION[0]![3]! + KNOWN_SOLUTION[0]![4]!;
  cageTotals[0]![2] = cageA; cageTotals[0]![3] = 0; cageTotals[0]![4] = 0;
  borderY[2]![0] = false; // open colGap=2, row=0 -> connects (0,2)-(0,3)
  borderY[3]![0] = false; // open colGap=3, row=0 -> connects (0,3)-(0,4)

  const cageF = KNOWN_SOLUTION[1]![2]! + KNOWN_SOLUTION[1]![3]! + KNOWN_SOLUTION[1]![4]!;
  cageTotals[1]![2] = cageF; cageTotals[1]![3] = 0; cageTotals[1]![4] = 0;
  borderY[2]![1] = false; // open colGap=2, row=1 -> connects (1,2)-(1,3)
  borderY[3]![1] = false; // open colGap=3, row=1 -> connects (1,3)-(1,4)

  return validateCageLayout(cageTotals, borderX, borderY);
}

describe('LinearSystem.substituteLiveRows — delta-pair derivation', () => {
  it('has no delta pair for (0,2)/(1,3) at construction', () => {
    const ls = new LinearSystem(makeCrossBoxDeltaSpec());
    expect(ls.pairsForCell([0, 2] as Cell)).toEqual([]);
  });

  it('derives a fresh delta pair once the shared cell (1,4) is substituted', () => {
    const ls = new LinearSystem(makeCrossBoxDeltaSpec());
    const v4 = KNOWN_SOLUTION[1]![4]!; // 9
    ls.substituteLiveRows([1, 4] as Cell, v4);

    expect(ls.deltaPairs).toContainEqual([[0, 2], [1, 3], 3]);
    expect(ls.pairsForCell([0, 2] as Cell)).toContainEqual([[0, 2], [1, 3], 3]);
    expect(ls.pairsForCell([1, 3] as Cell)).toContainEqual([[0, 2], [1, 3], 3]);
  });

  it('still derives the unrelated virtual-cage and single-cell results from the same substitution', () => {
    const ls = new LinearSystem(makeCrossBoxDeltaSpec());
    const v4 = KNOWN_SOLUTION[1]![4]!;
    const result = ls.substituteLiveRows([1, 4] as Cell, v4);

    expect(result).toContainEqual([[[0, 4]], KNOWN_SOLUTION[0]![4]!, true]);
    expect(result).toContainEqual([[[1, 2], [1, 3]], KNOWN_SOLUTION[1]![2]! + KNOWN_SOLUTION[1]![3]!, true]);
  });
});
```

Also add `import type { PuzzleSpec } from '../solver/puzzleSpec.js';` to the existing
import block if not already present.

- [ ] **Step 2: Confirm the first two new tests fail against the current (unfixed) `substituteLiveRows`**

Run: `cd web && npx vitest run src/engine/linearSystem.test.ts`
Expected: the "has no delta pair... at construction" test PASSES (this part is already
true today); "derives a fresh delta pair..." FAILS, because current code's
`substituteLiveRows` never calls `_addDeltaPair`. The third test (virtual-cage/single-
cell results) should already PASS, confirming it's a true regression-guard for the
untouched behaviour, not something the fix needs to change.

### Task 5: Implement the fix

**Files:**
- Modify: `web/src/engine/linearSystem.ts`

**Interfaces:**
- Consumes: existing private `_addDeltaPair(p: Cell, q: Cell, delta: number): void`
  (unchanged).
- Produces: no public API change — `substituteLiveRows`'s return type and the
  `pairsForCell`/`deltaPairs` fields `DeltaConstraint` already reads are unchanged in
  shape; only their *contents* grow.

- [ ] **Step 1: Add the `_maybeAddLiveDeltaPair` helper right after `_addDeltaPair`**

```ts
  /**
   * If `rowDict` (with right-hand side `rhs`) is a freshly-reduced two-term row with
   * coefficients +1/-1, records it as a new delta pair and returns true. Returns false
   * (no-op) for any other shape, including a uniform two-term (+1/+1) row -- that one
   * falls through to the general virtual-cage branch in substituteLiveRows.
   */
  private _maybeAddLiveDeltaPair(rowDict: SparseRow, rhs: Frac, seen: Set<string>): boolean {
    if (rowDict.size !== 2 || !rhs.isInteger()) return false;
    const [[pk, pc], [qk, qc]] = [...rowDict.entries()];
    let p: string, q: string, delta: number;
    if (pc!.eq(Frac.ONE) && qc!.eq(new Frac(-1))) { p = pk!; q = qk!; delta = rhs.toInt(); }
    else if (pc!.eq(new Frac(-1)) && qc!.eq(Frac.ONE)) { p = qk!; q = pk!; delta = -rhs.toInt(); }
    else return false;

    const dkey = `delta:${[p, q].sort().join('|')}`;
    if (!seen.has(dkey)) {
      seen.add(dkey);
      this._addDeltaPair(keyToCell(p), keyToCell(q), delta);
    }
    return true;
  }
```

- [ ] **Step 2: Call it from `substituteLiveRows`, between the single-cell and uniform-coefficient branches**

In `substituteLiveRows`, change:

```ts
      } else if ([...rowDict.values()].every(c => c.eq(Frac.ONE))) {
```

to:

```ts
      } else if (this._maybeAddLiveDeltaPair(rowDict, newRhs, seen)) {
        // A row freshly reduced to exactly two terms with coefficients +1/-1 is a
        // delta pair (value[p] - value[q] = delta) that only became derivable once
        // `cell` was substituted -- mirrors the constructor's nonzero.length === 2
        // dispatch, but for pairs that emerge live rather than at setup. Recorded
        // directly onto deltaPairs/_pairsByCell inside the helper; nothing to push
        // onto `constraints` (unlike virtual cages, delta pairs need no engine-side
        // unit bookkeeping -- DeltaConstraint reads them straight off the board).
      } else if ([...rowDict.values()].every(c => c.eq(Frac.ONE))) {
```

(leaving the rest of that branch's body untouched).

- [ ] **Step 3: Run the new tests to verify they pass**

Run: `cd web && npx vitest run src/engine/linearSystem.test.ts`
Expected: all tests PASS, including "derives a fresh delta pair...".

- [ ] **Step 4: Run the full existing suite for touched modules to check for regressions**

Run: `cd web && npx vitest run src/engine/linearSystem.test.ts src/engine/solverEngine.test.ts src/engine/rules/deltaConstraint.test.ts src/engine/rules/derivedVirtualCage.test.ts`
Expected: all PASS unchanged — `solverEngine.test.ts`'s `substituteLiveRows` tests
mock the method directly so they're unaffected by the real implementation; this run
is a regression check, not expected to need any edits.

- [ ] **Step 5: Commit**

```bash
bash scripts/run-bronze-gate.sh
git add web/src/engine/linearSystem.ts web/src/engine/linearSystem.test.ts
git commit -m "fix: derive delta pairs live as substituteLiveRows reduces rows, not just at setup"
```

### Task 6: Update docs/architecture.md

**Files:**
- Modify: `docs/architecture.md`

**Context:** Two places describe this machinery and both currently describe
`substituteLiveRows` as producing only golden-checks + `pendingVirtualCages` entries
"without mutating the board" — both need a line added, not rewritten, since the rest
of what they say remains accurate.

- [ ] **Step 1: Update the `_onCellDetermined` paragraph (around line 70-87)**

After the sentence ending `...distinct]` constraints without mutating the board.`, add:

```markdown
  As of the delta-pair live-derivation fix, it *does* have one side effect beyond that:
  a freshly-reduced two-term row with coefficients `+1`/`-1` is recorded as a new delta
  pair directly on `board.linearSystem.deltaPairs`/`_pairsByCell` (mirroring the
  constructor's own setup-time dispatch for the same row shape) — `DeltaConstraint`
  reads these live via `pairsForCell()`, so no further engine-side plumbing is needed.
```

- [ ] **Step 2: Update the `pendingVirtualCages` section (around line 468-484)**

After the existing paragraph (ending `...within the same pass.`), add a new paragraph:

```markdown
**Delta pairs also re-derive live, unlike `pendingVirtualCages`'s one-time-vs-live
split might suggest.** `deltaPairs` (read by `DeltaConstraint` via `pairsForCell()`)
used to be populated only once, during the constructor's initial RREF pass — genuinely
stale, since a `p - q = delta` relationship that only becomes derivable after some
cells are solved could never be surfaced. `substituteLiveRows` now also detects a
freshly-reduced two-term row with coefficients `+1`/`-1` (the same shape the
constructor's own dispatch already recognises for pairs present at *setup* time) and
records it via the same private `_addDeltaPair` helper the constructor uses. Unlike
virtual cages, a new delta pair needs no unit-level engine bookkeeping — there is no
`pendingDeltaPairs` queue; `DeltaConstraint` already reads `pairsForCell()` fresh on
every trigger, so it sees new pairs immediately.
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: document live delta-pair derivation in substituteLiveRows"
```

---

## Final: Silver gate and merge

- [ ] **Step 1: Run the silver gate from the repo root**

Run: `bash scripts/run-silver-gate.sh`
Expected: all checks pass; confirm doc hygiene when prompted.

- [ ] **Step 2: Merge to master**

```bash
git checkout master
git merge feature/expunge-ur-fix-delta-pairs
git branch -d feature/expunge-ur-fix-delta-pairs
```
