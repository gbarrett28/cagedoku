# LinearSystem Derive-Equation Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove the `solns`-tracking cross-product from `LinearSystem._deriveNonburbVirtualCages`/`_reduceDerive` so derivation of virtual cages is pure cell-set/total arithmetic (pencil-and-paper style), eliminating the exponential blow-up found by `web/scripts/fuzz-cage-rules.ts` for cages larger than 2 cells.

**Architecture:** `DeriveEq` drops its `solns: number[][]` field. `_reduceDerive` keeps its existing subset-subtraction fixpoint over `cells`/`total` only. All intermediate `solSums(...)` calls are removed; the final emission loop computes `solSums` at most once per surviving non-distinct equation (for the "must contain" feasibility check) and always pushes `precomputedSolns: null` (KillerBoardState computes the same value lazily).

**Tech Stack:** TypeScript, Vitest, vite-node (for the dev fuzzer script).

---

### Task 1: Refactor `_deriveNonburbVirtualCages` / `_reduceDerive` / `DeriveEq`

**Files:**
- Modify: `web/src/engine/linearSystem.ts:81-85` (`DeriveEq` interface)
- Modify: `web/src/engine/linearSystem.ts:423-512` (`_deriveNonburbVirtualCages`)
- Modify: `web/src/engine/linearSystem.ts:584-607` (`_reduceDerive`)

- [x] **Step 1: Replace the `DeriveEq` interface**

Replace (around line 81-85):

```ts
interface DeriveEq {
  cells: Set<string>;
  total: number;
  solns: number[][];
}
```

with:

```ts
interface DeriveEq {
  cells: Set<string>;
  total: number;
}
```

- [x] **Step 2: Replace `_deriveNonburbVirtualCages` (lines 423-512)**

Replace the entire method body with:

```ts
  private _deriveNonburbVirtualCages(
    _spec: PuzzleSpec,
    realCageCellSets: Set<string>,
    cageCellsMap: Map<number, Cell[]>,
    cageTotalsMap: Map<number, number>,
  ): void {
    const eqs: DeriveEq[] = [];

    const rowSets = Array.from({length: 9}, (_, r) =>
      new Set(Array.from({length: 9}, (__, c) => cellKey([r, c] as Cell))));
    const colSets = Array.from({length: 9}, (_, c) =>
      new Set(Array.from({length: 9}, (__, r) => cellKey([r, c] as Cell))));
    const boxCellSets = Array.from({length: 9}, (_, b) => {
      const s = new Set<string>();
      for (let dr = 0; dr < 3; dr++)
        for (let dc = 0; dc < 3; dc++)
          s.add(cellKey([(b / 3 | 0) * 3 + dr, (b % 3) * 3 + dc] as Cell));
      return s;
    });

    for (const r of rowSets) eqs.push({cells: r, total: 45});
    for (const c of colSets) eqs.push({cells: c, total: 45});
    for (const b of boxCellSets) eqs.push({cells: b, total: 45});

    const cageOf  = new Map<string, Set<string>>();
    const totalOf = new Map<string, number>();
    for (const [cid, cells] of cageCellsMap) {
      const total = cageTotalsMap.get(cid) ?? 0;
      if (total > 0) {
        const fc = new Set(cells.map(cellKey));
        for (const cell of cells) {
          cageOf.set(cellKey(cell as Cell), fc);
          totalOf.set(cellKey(cell as Cell), total);
        }
        eqs.push({cells: fc, total});
      }
    }

    const seenSw = new Set<string>(eqs.map(e => [...e.cells].sort().join('|')));
    for (const { cells } of this.virtualCages)
      seenSw.add(this._cellSetKey(cells as Cell[]));

    const pushDerived = (fcvr: Set<string>, sm: number) => {
      const key = [...fcvr].sort().join('|');
      if (seenSw.has(key) || realCageCellSets.has(key)) return;
      seenSw.add(key);
      const cells = [...fcvr].map(keyToCell) as Cell[];
      eqs.push({cells: fcvr, total: sm});
      this.virtualCages.push({ cells, total: sm, distinct: true, precomputedSolns: null });
    };

    const allLines = [...rowSets, ...[...rowSets].reverse(), ...colSets, ...[...colSets].reverse()];
    for (const [f, sm] of this._addEqunsLine(allLines.slice(0, 18), cageOf, totalOf)) pushDerived(f, sm);
    for (const [f, sm] of this._addEqunsLine(allLines.slice(18), cageOf, totalOf)) pushDerived(f, sm);
    for (const [f, sm] of this._addEqunsBox(boxCellSets, cageOf, totalOf)) pushDerived(f, sm);

    for (const { cells, total: vtotal, distinct } of this.virtualCages) {
      if (distinct) {
        const key = this._cellSetKey(cells as Cell[]);
        if (!seenSw.has(key)) {
          seenSw.add(key);
          const fc = new Set(cells.map(c => cellKey(c as Cell)));
          eqs.push({cells: fc, total: vtotal});
        }
      }
    }

    const initialCellSets = new Set<string>(eqs.map(e => [...e.cells].sort().join('|')));
    LinearSystem._reduceDerive(eqs);

    const seen = new Set<string>([...initialCellSets, ...seenSw]);
    for (const eq of eqs) {
      if (eq.cells.size === 0) continue;
      const key = [...eq.cells].sort().join('|');
      if (seen.has(key)) continue;
      const cells = [...eq.cells].map(keyToCell) as Cell[];
      const distinct = isBurb(cells);
      if (!distinct) {
        const solns = solSums(cells.length, 0, eq.total);
        if (solns.length === 0) continue;
        const must = solns.reduce<Set<number> | null>((acc, s) => {
          if (acc === null) return new Set(s);
          return new Set(s.filter(d => acc!.has(d)));
        }, null);
        if (!must || must.size === 0) continue;
      }
      seen.add(key);
      this.virtualCages.push({ cells, total: eq.total, distinct, precomputedSolns: null });
    }
  }
```

- [x] **Step 3: Replace `_reduceDerive` (lines 584-607)**

Replace the entire method with:

```ts
  private static _reduceDerive(eqs: DeriveEq[]): void {
    let reduced = true;
    while (reduced) {
      reduced = false;
      const active = eqs.filter(e => e.cells.size > 0).sort((a, b) => a.cells.size - b.cells.size);
      for (let i = 0; i < active.length; i++) {
        const ei = active[i]!;
        for (let j = i + 1; j < active.length; j++) {
          const ej = active[j]!;
          if (ei.cells.isSubsetOf(ej.cells)) {
            ej.cells = ej.cells.difference(ei.cells);
            ej.total -= ei.total;
            reduced = true;
          }
        }
      }
    }
  }
```

- [x] **Step 4: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS (no errors). The `solSums` import on line 14 remains used (single call in the new emission loop), `nineSolns`/`cloneSolns` are gone.

- [x] **Step 5: Commit**

```bash
git add web/src/engine/linearSystem.ts
git commit -m "$(cat <<'EOF'
refactor: drop solns cross-product from LinearSystem virtual-cage derivation

_reduceDerive previously tracked and recombined eqs[].solns on every subset
subtraction, multiplying combination counts across passes and causing
exponential blow-up for cage layouts with cages larger than 2 cells
(found via web/scripts/fuzz-cage-rules.ts). Derivation is now pure
cell-set/total arithmetic; the final emission computes solSums at most once
per surviving non-distinct equation, and all derived virtual cages use
precomputedSolns: null (KillerBoardState computes the same value lazily).

See docs/superpowers/specs/2026-06-14-linear-system-derive-simplification-design.md.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add a regression test for the `precomputedSolns: null` invariant

**Files:**
- Create: `web/src/engine/linearSystem.test.ts`

- [x] **Step 1: Write the test**

```ts
/**
 * Tests for LinearSystem virtual-cage derivation.
 */

import { describe, expect, it } from 'vitest';
import { LinearSystem } from './linearSystem.js';
import { makeTrivialSpec, makeThreeCellCageSpec, makeRowCageSpec, makeOutieSpec } from './fixtures.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';

const specs: ReadonlyArray<[string, PuzzleSpec]> = [
  ['trivial spec', makeTrivialSpec()],
  ['three-cell cage spec', makeThreeCellCageSpec()],
  ['row cage spec', makeRowCageSpec()],
  ['outie spec', makeOutieSpec()],
];

describe('LinearSystem._deriveNonburbVirtualCages', () => {
  it.each(specs)('derives virtual cages with precomputedSolns: null for %s', (_name, spec) => {
    const ls = new LinearSystem(spec);
    expect(ls.virtualCages.length).toBeGreaterThan(0);
    for (const vc of ls.virtualCages) {
      expect(vc.precomputedSolns).toBeNull();
    }
  });

  it.each(specs)('every derived virtual cage cell set is non-empty and within bounds for %s', (_name, spec) => {
    const ls = new LinearSystem(spec);
    for (const vc of ls.virtualCages) {
      expect(vc.cells.length).toBeGreaterThan(0);
      expect(vc.cells.length).toBeLessThanOrEqual(9);
      for (const [r, c] of vc.cells) {
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(8);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(8);
      }
    }
  });
});
```

- [x] **Step 2: Run the new test file**

Run: `cd web && npx vitest run src/engine/linearSystem.test.ts`
Expected: PASS for all `it.each` cases (4 specs × 2 tests = 8 tests).

If `virtualCages.length` is 0 for any spec (making the first test fail), remove that spec from the `specs` array — the goal is to cover specs that produce at least one derived cage under the new algorithm, not to force a minimum count for every spec.

- [x] **Step 3: Commit**

```bash
git add web/src/engine/linearSystem.test.ts
git commit -m "$(cat <<'EOF'
test: add LinearSystem virtual-cage derivation invariant tests

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Run the full suite, update any tests affected by the narrower derivation

**Files:**
- Modify (only if needed): any test file failing in this step

- [x] **Step 1: Run the full test suite**

Run: `cd web && npx vitest run`
Expected: Most tests PASS. Some tests in `boardState.test.ts`, `engine.test.ts`, `engine.autoApply.test.ts`, or rule test files MAY fail if they assert a specific count, cell-set, or `precomputedSolns` value for a `virtualCages` entry, or rely on a deduction that depended on the now-removed cross-equation solns narrowing.

- [x] **Step 2: Triage each failure**

For each failing test:
1. Read the failing assertion and the code path that produces the now-different value (a `virtualCages` entry, a `cageSolns` entry, an elimination, or a placement).
2. Confirm the difference is explained by the design's "Safety tradeoff" section (docs/superpowers/specs/2026-06-14-linear-system-derive-simplification-design.md): either (a) a derived virtual cage that no longer appears because its `must`-digit no longer exists under the unnarrowed `solSums`, or (b) a `cageSolns`/candidate set that is now a superset of the previous value.
3. If confirmed, update the test's expectation to match the new (superset / smaller-derivation-set) behavior, adding a one-line comment referencing the design doc, e.g.:
   ```ts
   // Narrower derivation removed by 2026-06-14 LinearSystem simplification —
   // see docs/superpowers/specs/2026-06-14-linear-system-derive-simplification-design.md
   ```
4. If a failure is NOT explained by the safety tradeoff (e.g. a crash, an `undefined`, a type error, or an elimination that now contradicts a *golden* solution in a fixture), STOP — this indicates a bug in the Task 1 refactor, not an expected test update. Re-check Task 1's code against the plan exactly before proceeding.

- [x] **Step 3: Re-run the full suite until green**

Run: `cd web && npx vitest run`
Expected: PASS (all test files).

- [x] **Step 4: Run the bronze gate**

Run: `bash scripts/run-bronze-gate.sh` (from repo root)
Expected: `Bronze gate passed. Token created — run 'git commit' now.`

- [x] **Step 5: Commit any test updates**

If Step 2 required changes:

```bash
git add <changed test files>
git commit -m "$(cat <<'EOF'
test: update expectations for narrower LinearSystem virtual-cage derivation

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

If no test files needed changes, skip this commit.

---

### Task 4: Verify the blow-up is fixed and check golden-violation status

**Files:**
- Modify: `web/scripts/fuzz-cage-rules.ts:42-49`

- [x] **Step 1: Raise the cage-size cap and remove the stale workaround comment**

Replace lines 42-49:

```ts
// NOTE: LinearSystem._deriveNonburbVirtualCages/_reduceDerive has unbounded
// (apparently exponential) complexity for layouts with many 3+ cell cages —
// see the OOM finding documented separately. Keep cages small/sparse here so
// the reproducer can actually run; this still exercises real virtual-cage
// derivation for pair cages.
const MERGE_PASSES = 1;
const MERGE_PROB = 0.08;
const MAX_CAGE_SIZE = 2;
```

with:

```ts
const MERGE_PASSES = 3;
const MERGE_PROB = 0.15;
const MAX_CAGE_SIZE = 5;
```

- [x] **Step 2: Run the fuzzer**

Run: `cd web && npx vite-node ../web/scripts/fuzz-cage-rules.ts 500` (run from `web/`, so use `npx vite-node scripts/fuzz-cage-rules.ts 500`)

Confirm:
- The run completes (no OOM, no hang) within a couple of minutes.
- Note whether any `seed=N: golden-violating elimination` output appears for `CageCandidateFilter` or `SolutionMapFilter`.

- [x] **Step 3: Commit the fuzzer update**

```bash
git add web/scripts/fuzz-cage-rules.ts
git commit -m "$(cat <<'EOF'
test: raise fuzz-cage-rules cage-size cap now that derivation is bounded

The solns cross-product removed from LinearSystem._deriveNonburbVirtualCages/
_reduceDerive no longer multiplies across reduction passes, so layouts with
cages up to 5 cells no longer OOM.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

- [x] **Step 4: Push and report**

```bash
git push -u origin claude/debug-github-actions-failure-ihzgq6
```

Report to the user: whether the fuzzer ran cleanly at the larger cage size, and whether `CageCandidateFilter`/`SolutionMapFilter` golden violations were observed, found, or absent — this determines the next investigation step (not part of this plan).

---

## Out of scope (do not do in this plan)

- Re-enabling `CageCandidateFilter`/`SolutionMapFilter` in `web/src/engine/rules/disabled-rules.ts`.
- Any change to `_addEqunsLine`/`_addEqunsBox` or the main constructor RREF.
- Further investigation into remaining golden violations found in Task 4 — report findings and stop.
