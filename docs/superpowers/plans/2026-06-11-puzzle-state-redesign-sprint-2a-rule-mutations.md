# Puzzle State Redesign — Sprint 2a: RuleMutation Type Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add the `RuleMutation` type hierarchy (interface + four concrete mutation types + factory/revive namespace) from spec section 2, as a new, purely additive file with full unit test coverage. No existing code is modified or wired up — that happens in later sprints (2b+).

**Architecture:** One new file `web/src/session/ruleMutation.ts` defines `RuleMutation` (base interface with `type: string` and `apply(state): PuzzleState`), four concrete mutation interfaces (`PlaceDigitMutation`, `EliminateCandidateMutation`, `AddVirtualCageMutation`, `EliminateCageSolutionMutation`) each with a same-name namespace holding a pure `apply(mutation, state)` function, and a `RuleMutation` namespace with factory functions (`placeDigit`, `eliminateCandidate`, `addVirtualCage`, `eliminateCageSolution`) that close over the mutation's data and a `revive(data)` function that is the single type-keyed switch in the system (used to reconstruct mutations after a JSON round-trip, since `JSON.stringify` drops the `apply` closure).

**Tech Stack:** TypeScript, Vitest. Lives in `web/src/session/` alongside `types.ts` (which defines `PuzzleState`, `KillerPuzzleState`, `VirtualCage`, `CageState` — all needed by `ruleMutation.ts`).

---

## Background for the engineer

- `PuzzleState` is a plain readonly-data interface (`web/src/session/types.ts:239-263`). `KillerPuzzleState extends PuzzleState` adds `specData`, `cageStates`, `virtualCages`, `warpedImageUrl` (`types.ts:265-281`). `PuzzleState.isKiller(state)` (`types.ts:285-287`) is a type guard: `state is KillerPuzzleState`.
- `userGrid: number[][]` is row-major, `userGrid[row][col]`.
- `userRemovedCandidates: readonly [number, number, number][]` is a flat list of `[row, col, digit]` triples.
- `VirtualCage` (`types.ts:43-56`) has `cells`, `total`, `eliminatedSolns`, optional `negativeCells`/`eliminatedDiffSolns`.
- `CageState` (`types.ts:35-41`) has `label`, `total`, `cells`, `userEliminatedSolns: readonly (readonly number[])[]`. `label` is the cage's stable identifier (e.g. `'A'`, `'B'`, ... from `cageLabel()` in `specUtils.ts`) — this is what `EliminateCageSolutionMutation.cageId` refers to.
- All state updates are immutable: spread `{ ...state, field: newValue }`, never mutate arrays/objects in place.
- Per `CLAUDE.md`'s namespace-merging pattern: each interface gets a same-name `namespace` with an `apply` function; the union type's namespace performs any cross-cutting work (here, `revive`'s switch).

This sprint does **not** modify `engine.ts`, `actions.ts`, `main.ts`, or any existing file. It is a new, self-contained, fully-tested module.

---

## Task 1: `PlaceDigitMutation`

**Files:**
- Create: `web/src/session/ruleMutation.ts`
- Test: `web/src/session/ruleMutation.test.ts`

- [x] **Step 1: Write the failing test**

Create `web/src/session/ruleMutation.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { PuzzleState } from './types.js';
import { RuleMutation, PlaceDigitMutation } from './ruleMutation.js';

function blankClassicState(): PuzzleState {
  return PuzzleState.createClassic(null, [], null);
}

describe('PlaceDigitMutation', () => {
  it('sets the digit at the given cell', () => {
    const state = blankClassicState();
    const mutation = RuleMutation.placeDigit(2, 3, 7);

    expect(mutation.type).toBe('placeDigit');
    const next = mutation.apply(state);

    expect(next.userGrid[2]![3]).toBe(7);
    // Original state is untouched.
    expect(state.userGrid[2]![3]).toBe(0);
  });

  it('does not mutate other cells', () => {
    const state = blankClassicState();
    const next = RuleMutation.placeDigit(0, 0, 5).apply(state);

    expect(next.userGrid[0]![1]).toBe(0);
    expect(next.userGrid[1]![0]).toBe(0);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session/ruleMutation.test.ts`
Expected: FAIL — `Cannot find module './ruleMutation.js'` (file doesn't exist yet).

- [x] **Step 3: Write minimal implementation**

Create `web/src/session/ruleMutation.ts`:

```typescript
/**
 * Rule effects as data: each mutation carries its own `apply`, so dispatch
 * lives on the value itself rather than in an external switch. The only
 * type-keyed switch in this module is `RuleMutation.revive`, used to
 * reconstruct mutations after a JSON round-trip (JSON.stringify drops the
 * `apply` closure).
 */

import type { PuzzleState } from './types.js';

export interface RuleMutation {
  readonly type: string;
  apply(state: PuzzleState): PuzzleState;
}

// ---------------------------------------------------------------------------
// PlaceDigitMutation
// ---------------------------------------------------------------------------

export interface PlaceDigitMutation extends RuleMutation {
  readonly type: 'placeDigit';
  readonly row: number;
  readonly col: number;
  readonly digit: number;
}

export namespace PlaceDigitMutation {
  export function apply(m: PlaceDigitMutation, state: PuzzleState): PuzzleState {
    const userGrid = state.userGrid.map(row => [...row]);
    userGrid[m.row]![m.col] = m.digit;
    return { ...state, userGrid };
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/session/ruleMutation.test.ts`
Expected: FAIL — `RuleMutation.placeDigit is not a function` (the `RuleMutation` namespace with factories doesn't exist yet; this is expected, fix in Task 5). For now, temporarily verify `PlaceDigitMutation.apply` works directly by adjusting the test to call `PlaceDigitMutation.apply({ type: 'placeDigit', row: 2, col: 3, digit: 7, apply: () => state }, state)` — **do not commit this temporary version**. Instead, proceed to Task 5 first if you want green tests sooner, or accept that Tasks 1-4 stay red until Task 5 adds the factories. This plan adds factories in Task 5 and re-runs the full suite there. Continue to Task 2.

---

## Task 2: `EliminateCandidateMutation`

**Files:**
- Modify: `web/src/session/ruleMutation.ts`
- Modify: `web/src/session/ruleMutation.test.ts`

- [x] **Step 1: Add the failing test**

Append to `web/src/session/ruleMutation.test.ts`:

```typescript
import { EliminateCandidateMutation } from './ruleMutation.js';

describe('EliminateCandidateMutation', () => {
  it('appends [row, col, digit] to userRemovedCandidates', () => {
    const state = blankClassicState();
    const mutation = RuleMutation.eliminateCandidate(4, 5, 9);

    expect(mutation.type).toBe('eliminateCandidate');
    const next = mutation.apply(state);

    expect(next.userRemovedCandidates).toEqual([[4, 5, 9]]);
    expect(state.userRemovedCandidates).toEqual([]);
  });

  it('preserves existing removed candidates', () => {
    const state = { ...blankClassicState(), userRemovedCandidates: [[0, 0, 1]] as const };
    const next = RuleMutation.eliminateCandidate(1, 1, 2).apply(state);

    expect(next.userRemovedCandidates).toEqual([[0, 0, 1], [1, 1, 2]]);
  });
});
```

(Add `EliminateCandidateMutation` to the existing `import { RuleMutation, PlaceDigitMutation } from './ruleMutation.js';` line instead of a separate import — keep all imports from `./ruleMutation.js` on one line.)

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session/ruleMutation.test.ts`
Expected: FAIL — `EliminateCandidateMutation` is not exported.

- [x] **Step 3: Implement `EliminateCandidateMutation`**

Append to `web/src/session/ruleMutation.ts`:

```typescript
// ---------------------------------------------------------------------------
// EliminateCandidateMutation
// ---------------------------------------------------------------------------

export interface EliminateCandidateMutation extends RuleMutation {
  readonly type: 'eliminateCandidate';
  readonly row: number;
  readonly col: number;
  readonly digit: number;
}

export namespace EliminateCandidateMutation {
  export function apply(m: EliminateCandidateMutation, state: PuzzleState): PuzzleState {
    return {
      ...state,
      userRemovedCandidates: [...state.userRemovedCandidates, [m.row, m.col, m.digit]],
    };
  }
}
```

- [x] **Step 4: Run test to verify it still fails on the missing factory (expected)**

Run: `cd web && npx vitest run src/session/ruleMutation.test.ts`
Expected: FAIL — `RuleMutation.placeDigit`/`RuleMutation.eliminateCandidate` are not functions (factories added in Task 5). Continue to Task 3.

---

## Task 3: `AddVirtualCageMutation`

**Files:**
- Modify: `web/src/session/ruleMutation.ts`
- Modify: `web/src/session/ruleMutation.test.ts`

- [x] **Step 1: Add the failing test**

Append to `web/src/session/ruleMutation.test.ts`. This needs a killer state — add a shared helper near the top of the file (next to `blankClassicState`):

```typescript
import { specToData, specToCageStates, classicSyntheticSpec } from './specUtils.js';

function blankKillerState(): KillerPuzzleState {
  const spec = classicSyntheticSpec();
  return PuzzleState.createKiller(specToData(spec), specToCageStates(spec), [], null, null);
}
```

Add `KillerPuzzleState` to the `import type { ... } from './types.js'` (or add a new `import type { KillerPuzzleState } from './types.js';` line).

Then append:

```typescript
import { AddVirtualCageMutation } from './ruleMutation.js';
import type { VirtualCage } from './types.js';

describe('AddVirtualCageMutation', () => {
  const cage: VirtualCage = { cells: [[0, 0], [0, 1]], total: 10, eliminatedSolns: [] };

  it('appends the cage to virtualCages on a killer state', () => {
    const state = blankKillerState();
    const mutation = RuleMutation.addVirtualCage(cage);

    expect(mutation.type).toBe('addVirtualCage');
    const next = mutation.apply(state) as KillerPuzzleState;

    expect(next.virtualCages).toEqual([cage]);
    expect(state.virtualCages).toEqual([]);
  });

  it('throws when applied to a classic state', () => {
    const state = blankClassicState();
    const mutation = RuleMutation.addVirtualCage(cage);

    expect(() => mutation.apply(state)).toThrow();
  });
});
```

(Again, merge `AddVirtualCageMutation` into the single `from './ruleMutation.js'` import line, and `VirtualCage`/`KillerPuzzleState` into the single `from './types.js'` type-import line.)

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session/ruleMutation.test.ts`
Expected: FAIL — `AddVirtualCageMutation` is not exported.

- [x] **Step 3: Implement `AddVirtualCageMutation`**

Append to `web/src/session/ruleMutation.ts`. Add `PuzzleState` value import (the type guard `isKiller` is a function, so it needs a value import alongside the existing type-only import):

```typescript
import { PuzzleState } from './types.js';
import type { VirtualCage } from './types.js';
```

(Combine with the existing `import type { PuzzleState } from './types.js';` — replace it with the two lines above: a value import for `PuzzleState` and `isKiller`, and a type-only import for `VirtualCage`. `PuzzleState` itself is used both as a type — `state: PuzzleState` — and as a value — `PuzzleState.isKiller(...)` — which is fine since `PuzzleState` is declared as both an interface and a namespace in `types.ts`.)

```typescript
// ---------------------------------------------------------------------------
// AddVirtualCageMutation
// ---------------------------------------------------------------------------

export interface AddVirtualCageMutation extends RuleMutation {
  readonly type: 'addVirtualCage';
  readonly cage: VirtualCage;
}

export namespace AddVirtualCageMutation {
  export function apply(m: AddVirtualCageMutation, state: PuzzleState): PuzzleState {
    if (!PuzzleState.isKiller(state)) {
      throw new Error('AddVirtualCageMutation can only be applied to a killer puzzle state');
    }
    return { ...state, virtualCages: [...state.virtualCages, m.cage] };
  }
}
```

- [x] **Step 4: Run test to verify it still fails on the missing factory (expected)**

Run: `cd web && npx vitest run src/session/ruleMutation.test.ts`
Expected: FAIL — `RuleMutation.addVirtualCage` is not a function (added in Task 5). Continue to Task 4.

---

## Task 4: `EliminateCageSolutionMutation`

**Files:**
- Modify: `web/src/session/ruleMutation.ts`
- Modify: `web/src/session/ruleMutation.test.ts`

- [x] **Step 1: Add the failing test**

Append to `web/src/session/ruleMutation.test.ts`:

```typescript
import { EliminateCageSolutionMutation } from './ruleMutation.js';

describe('EliminateCageSolutionMutation', () => {
  it('appends the solution to the matching cage\'s userEliminatedSolns', () => {
    const state = blankKillerState();
    const mutation = RuleMutation.eliminateCageSolution('A', [1, 8]);

    expect(mutation.type).toBe('eliminateCageSolution');
    const next = mutation.apply(state) as KillerPuzzleState;

    const cageA = next.cageStates.find(c => c.label === 'A')!;
    expect(cageA.userEliminatedSolns).toEqual([[1, 8]]);

    // Other cages untouched.
    const cageB = next.cageStates.find(c => c.label === 'B')!;
    expect(cageB.userEliminatedSolns).toEqual([]);

    // Original state is untouched.
    const originalCageA = state.cageStates.find(c => c.label === 'A')!;
    expect(originalCageA.userEliminatedSolns).toEqual([]);
  });

  it('throws when applied to a classic state', () => {
    const state = blankClassicState();
    const mutation = RuleMutation.eliminateCageSolution('A', [1, 8]);

    expect(() => mutation.apply(state)).toThrow();
  });

  it('throws when the cage label does not exist', () => {
    const state = blankKillerState();
    const mutation = RuleMutation.eliminateCageSolution('ZZ', [1, 8]);

    expect(() => mutation.apply(state)).toThrow();
  });
});
```

(Merge `EliminateCageSolutionMutation` into the single `from './ruleMutation.js'` import line. `classicSyntheticSpec()` from `specUtils.ts` produces 9 row-cages labelled `'A'`..`'I'`, each summing to 45 — `'A'` and `'B'` both exist.)

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session/ruleMutation.test.ts`
Expected: FAIL — `EliminateCageSolutionMutation` is not exported.

- [x] **Step 3: Implement `EliminateCageSolutionMutation`**

Append to `web/src/session/ruleMutation.ts`:

```typescript
// ---------------------------------------------------------------------------
// EliminateCageSolutionMutation
// ---------------------------------------------------------------------------

export interface EliminateCageSolutionMutation extends RuleMutation {
  readonly type: 'eliminateCageSolution';
  readonly cageId: string;
  readonly solution: readonly number[];
}

export namespace EliminateCageSolutionMutation {
  export function apply(m: EliminateCageSolutionMutation, state: PuzzleState): PuzzleState {
    if (!PuzzleState.isKiller(state)) {
      throw new Error('EliminateCageSolutionMutation can only be applied to a killer puzzle state');
    }
    const idx = state.cageStates.findIndex(c => c.label === m.cageId);
    if (idx === -1) {
      throw new Error(`EliminateCageSolutionMutation: no cage with label '${m.cageId}'`);
    }
    const cageStates = state.cageStates.map((c, i) =>
      i === idx ? { ...c, userEliminatedSolns: [...c.userEliminatedSolns, m.solution] } : c,
    );
    return { ...state, cageStates };
  }
}
```

- [x] **Step 4: Run test to verify it still fails on the missing factory (expected)**

Run: `cd web && npx vitest run src/session/ruleMutation.test.ts`
Expected: FAIL — `RuleMutation.eliminateCageSolution` is not a function (added in Task 5).

---

## Task 5: `RuleMutation` namespace — factories and `revive`

**Files:**
- Modify: `web/src/session/ruleMutation.ts`
- Modify: `web/src/session/ruleMutation.test.ts`

- [x] **Step 1: Add the failing tests**

Append to `web/src/session/ruleMutation.test.ts`:

```typescript
describe('RuleMutation.revive', () => {
  it('round-trips placeDigit through JSON', () => {
    const original = RuleMutation.placeDigit(2, 3, 7);
    const revived = RuleMutation.revive(JSON.parse(JSON.stringify(original)));

    const state = blankClassicState();
    expect(revived.apply(state)).toEqual(original.apply(state));
  });

  it('round-trips eliminateCandidate through JSON', () => {
    const original = RuleMutation.eliminateCandidate(4, 5, 9);
    const revived = RuleMutation.revive(JSON.parse(JSON.stringify(original)));

    const state = blankClassicState();
    expect(revived.apply(state)).toEqual(original.apply(state));
  });

  it('round-trips addVirtualCage through JSON', () => {
    const cage: VirtualCage = { cells: [[0, 0], [0, 1]], total: 10, eliminatedSolns: [] };
    const original = RuleMutation.addVirtualCage(cage);
    const revived = RuleMutation.revive(JSON.parse(JSON.stringify(original)));

    const state = blankKillerState();
    expect(revived.apply(state)).toEqual(original.apply(state));
  });

  it('round-trips eliminateCageSolution through JSON', () => {
    const original = RuleMutation.eliminateCageSolution('A', [1, 8]);
    const revived = RuleMutation.revive(JSON.parse(JSON.stringify(original)));

    const state = blankKillerState();
    expect(revived.apply(state)).toEqual(original.apply(state));
  });

  it('throws on an unknown mutation type', () => {
    expect(() => RuleMutation.revive({ type: 'bogus' })).toThrow();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session/ruleMutation.test.ts`
Expected: FAIL — `RuleMutation.placeDigit is not a function` (and similar for the other factories — the `RuleMutation` namespace doesn't exist yet). All tests from Tasks 1-5 fail at this point.

- [x] **Step 3: Implement the `RuleMutation` namespace**

Append to `web/src/session/ruleMutation.ts`:

```typescript
// ---------------------------------------------------------------------------
// RuleMutation factories and revive
// ---------------------------------------------------------------------------

export namespace RuleMutation {
  export function placeDigit(row: number, col: number, digit: number): PlaceDigitMutation {
    const data = { type: 'placeDigit' as const, row, col, digit };
    return { ...data, apply: (state: PuzzleState) => PlaceDigitMutation.apply(data, state) };
  }

  export function eliminateCandidate(row: number, col: number, digit: number): EliminateCandidateMutation {
    const data = { type: 'eliminateCandidate' as const, row, col, digit };
    return { ...data, apply: (state: PuzzleState) => EliminateCandidateMutation.apply(data, state) };
  }

  export function addVirtualCage(cage: VirtualCage): AddVirtualCageMutation {
    const data = { type: 'addVirtualCage' as const, cage };
    return { ...data, apply: (state: PuzzleState) => AddVirtualCageMutation.apply(data, state) };
  }

  export function eliminateCageSolution(cageId: string, solution: readonly number[]): EliminateCageSolutionMutation {
    const data = { type: 'eliminateCageSolution' as const, cageId, solution };
    return { ...data, apply: (state: PuzzleState) => EliminateCageSolutionMutation.apply(data, state) };
  }

  /**
   * Reconstructs a mutation from its JSON-deserialized data. JSON.stringify
   * drops the `apply` closure that factories attach, so persisted mutations
   * (in `Turn`/`ApplyHintAction`, written to localStorage) must be revived
   * before `.apply()` can be called again. This switch is the only
   * type-keyed dispatch in the module — every other call site uses
   * `mutation.apply(state)` directly.
   */
  export function revive(data: { type: string; [k: string]: unknown }): RuleMutation {
    switch (data.type) {
      case 'placeDigit':
        return placeDigit(data['row'] as number, data['col'] as number, data['digit'] as number);
      case 'eliminateCandidate':
        return eliminateCandidate(data['row'] as number, data['col'] as number, data['digit'] as number);
      case 'addVirtualCage':
        return addVirtualCage(data['cage'] as VirtualCage);
      case 'eliminateCageSolution':
        return eliminateCageSolution(data['cageId'] as string, data['solution'] as readonly number[]);
      default:
        throw new Error(`RuleMutation.revive: unknown mutation type '${data.type}'`);
    }
  }
}
```

- [x] **Step 4: Run the full test file to verify everything passes**

Run: `cd web && npx vitest run src/session/ruleMutation.test.ts`
Expected: PASS — all tests across Tasks 1-5 green.

- [x] **Step 5: Run `tsc` to check types**

Run: `cd web && npx tsc --noEmit`
Expected: no errors. If the merged-import instructions from earlier steps left duplicate or stray imports in `ruleMutation.test.ts` or `ruleMutation.ts`, fix them now (one import per source module, no `* as` star imports, per `CLAUDE.md`).

- [x] **Step 6: Run the full unit test suite**

Run: `cd web && npx vitest run`
Expected: PASS — all 573 pre-existing tests plus the new `ruleMutation.test.ts` tests (574+ total).

---

## Task 6: Bronze gate, commit, merge, ship

**Files:** none (process only)

- [x] **Step 1: Create the feature branch**

```bash
git checkout master
git pull
git checkout -b feature/puzzle-state-redesign-sprint-2a
```

- [x] **Step 2: Run the bronze gate**

```bash
bash scripts/run-bronze-gate.sh
```

Expected: PASS (runs `tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, `npm test`). This creates a one-time `.bronze-gate-ok` token.

- [x] **Step 3: Update the spec status note**

Edit `docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md`. Add a status note after the "## 2. `RuleMutation` Type Hierarchy" heading (after the existing introductory paragraph, before the `interface RuleMutation { ... }` code block):

```markdown
> **Status (Sprint 2a — ✅ shipped):** `RuleMutation` and the four concrete mutation
> types (`PlaceDigitMutation`, `EliminateCandidateMutation`, `AddVirtualCageMutation`,
> `EliminateCageSolutionMutation`) are implemented in `web/src/session/ruleMutation.ts`,
> exactly as specified below, with full unit test coverage including JSON-round-trip
> `revive()` tests. This is purely additive — nothing in `engine.ts`, `actions.ts`, or
> `main.ts` references these types yet; integration begins in Sprint 2b
> (`buildEngine()` contract: `baseBoard`, `ruleSteps`, `validationContext`).
```

- [x] **Step 4: Commit**

```bash
git add web/src/session/ruleMutation.ts web/src/session/ruleMutation.test.ts docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md
git commit -m "$(cat <<'EOF'
feat: add RuleMutation type hierarchy

Foundational types for the puzzle-state-redesign Phase 2 execution path
rewrite (spec section 2). Each mutation carries its own apply(state),
with RuleMutation.revive() as the single type-keyed switch for
reconstructing mutations after a JSON round-trip. Purely additive -
no existing code wired up yet.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

- [x] **Step 5: Merge to master**

```bash
git checkout master
git pull
git merge feature/puzzle-state-redesign-sprint-2a
```

Expected: fast-forward merge (no conflicts, since this is a new file plus a doc edit).

- [x] **Step 6: Run the silver gate**

```bash
cd web
export PLAYWRIGHT_BROWSERS_PATH="$HOME/AppData/Local/ms-playwright"
bash ../scripts/run-silver-gate.sh
```

Expected: PASS — `tsc --noEmit`, unit tests (574+), `npm run build`, and both Playwright configs (app/offline + flow, ~61 e2e tests). This step is slow (3-5 min); run in background and poll.

When prompted for doc hygiene confirmation: `docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md` still describes the live design accurately (Sprint 2a status note added in Step 3, sections 3-7 remain the not-yet-implemented design for Sprints 2b+) — confirm yes. This plan file (`docs/superpowers/plans/2026-06-11-puzzle-state-redesign-sprint-2a-rule-mutations.md`) has all steps checked — delete it as part of the doc hygiene step.

- [x] **Step 7: Push and clean up**

```bash
git push
git branch -d feature/puzzle-state-redesign-sprint-2a
rm -f .bronze-gate-ok .silver-gate-ok web/.bronze-gate-ok web/.silver-gate-ok
rm -f docs/superpowers/plans/2026-06-11-puzzle-state-redesign-sprint-2a-rule-mutations.md
git add docs/superpowers/plans/2026-06-11-puzzle-state-redesign-sprint-2a-rule-mutations.md
git commit -m "$(cat <<'EOF'
docs: remove completed sprint 2a plan

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
git push
```

---

## Self-Review Notes

- **Spec coverage:** All four mutation types and the `RuleMutation` namespace (factories + `revive`) from spec section 2 (lines 96-136) are implemented exactly as specified, with `apply` on each value per the "dispatch lives on the value itself" requirement.
- **Placeholder scan:** No TBD/TODO; every step has complete code.
- **Type consistency:** `PlaceDigitMutation`, `EliminateCandidateMutation`, `AddVirtualCageMutation`, `EliminateCageSolutionMutation` names and field names (`row`/`col`/`digit`, `cage`, `cageId`/`solution`) are consistent across the interface definitions (Tasks 1-4), the namespace `apply` functions, and the `RuleMutation` factories/`revive` (Task 5).
- **Scope:** Sprint 2a is additive-only (~1-2 hours), the foundation for Sprint 2b (`buildEngine()` returning `baseBoard`/`ruleSteps`/`validationContext`, using these mutation types to build `RuleStep.mutations`).
