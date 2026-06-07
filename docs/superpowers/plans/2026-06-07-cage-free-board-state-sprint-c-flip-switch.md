# Cage-Free BoardState — Sprint C: Flip the Construction Switch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `buildEngine` construct a plain `BoardState`+`SolverEngine` pair for classic puzzles (instead of always building a `KillerBoardState`+`KillerSolverEngine`), decided once via the new `PuzzleState.isKiller` predicate, and delete the now-dead `makeClassicSpec` synthesis path.

**Architecture:** Add `PuzzleState.isKiller(state)` as the one canonical "is this killer" predicate (spec §2.5). `buildEngine` consults it once and builds the entire matching bundle — board class, engine class, rule list — from that single decision, replacing the current always-killer construction. `engine/index.ts`'s `solveFromStall` does the same simplification: it no longer needs a synthetic classic `PuzzleSpec` (`makeClassicSpec`) once it can build a plain cage-free `BoardState` directly. Five small helper functions across `session/engine.ts`, `engine/index.ts`, and `engine/triggerValidator.ts` were over-narrowed to `KillerBoardState` by Sprint A's blanket rename even though their bodies only touch base-`BoardState` members (`.cands()`, `.units`); this sprint widens them back to `BoardState` so they accept either board type.

**Tech Stack:** TypeScript, Vitest, serena MCP tools (mandatory for all `.ts` edits per CLAUDE.md)

**Prerequisites:** Sprints A and B (plans `2026-06-07-cage-free-board-state-sprint-a-extract-superclass.md` and `2026-06-07-cage-free-board-state-sprint-b-widen-contracts.md`) must already be merged. This plan's "before" code blocks show the post-Sprint-A/B state of each file — i.e. `BoardState` has already been renamed to `KillerBoardState` everywhere it appeared pre-refactor, the new cage-free `BoardState` superclass exists, and `KillerSolverEngine` exists with a virtual `_onCellDetermined` hook.

---

### Task 1: Add the `PuzzleState.isKiller` predicate

**Files:**
- Modify: `web/src/session/types.ts:276`
- Test: `web/src/session/engine.test.ts`

`PuzzleState.isKiller` is the one canonical predicate every construction call site will consult (spec §2.5). It lives in a `namespace PuzzleState` immediately after the `PuzzleState` interface — the same relative position `namespace UserAction` already occupies relative to its type.

- [ ] **Step 1: Change `PuzzleState` from a type-only import to a value import in `engine.test.ts`**

`PuzzleState.isKiller` is a namespace member — calling it requires importing `PuzzleState` as a value, not just a type (mirroring how `UserAction` is already imported as a value on the same line for `UserAction.applyToCages`).

Open `web/src/session/engine.test.ts`. Edit line 18:
```typescript
import { UserAction, type PuzzleState, type Turn, type VirtualCage, type EliminateCandidateAction, type RestoreCandidateAction, type ResetCellCandidatesAction, type ApplyHintAction } from './types.js';
```
→
```typescript
import { UserAction, PuzzleState, type Turn, type VirtualCage, type EliminateCandidateAction, type RestoreCandidateAction, type ResetCellCandidatesAction, type ApplyHintAction } from './types.js';
```

(`PuzzleState` remains usable as a type everywhere it already is — TypeScript's declaration merging means a named import of an interface works as both a type and, once the namespace exists, a value.)

- [ ] **Step 2: Write the failing test**

Insert a new `describe` block directly after the `describe('userVirtualCages', ...)` block's closing `});` (currently line 141) and before the `// buildEngine` section comment (currently lines 143-145):
```typescript
  it('removes a cage via removeVirtualCage', () => {
    const state = makeState();
    const key = '0,0:0,1:10';
    const turns = [
      makeTurn({ type: 'addVirtualCage', cage: vc }),
      makeTurn({ type: 'removeVirtualCage', key }),
    ];
    expect(userVirtualCages({ ...state, turns })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildEngine
// ---------------------------------------------------------------------------

describe('buildEngine', () => {
```
→
```typescript
  it('removes a cage via removeVirtualCage', () => {
    const state = makeState();
    const key = '0,0:0,1:10';
    const turns = [
      makeTurn({ type: 'addVirtualCage', cage: vc }),
      makeTurn({ type: 'removeVirtualCage', key }),
    ];
    expect(userVirtualCages({ ...state, turns })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PuzzleState.isKiller
// ---------------------------------------------------------------------------

describe('PuzzleState.isKiller', () => {
  it('returns true for killer puzzles', () => {
    expect(PuzzleState.isKiller(makeState())).toBe(true);
  });

  it('returns false for classic puzzles', () => {
    expect(PuzzleState.isKiller({ ...makeState(), puzzleType: 'classic' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildEngine
// ---------------------------------------------------------------------------

describe('buildEngine', () => {
```

- [ ] **Step 3: Run the test to verify it fails to compile**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run src/session/engine.test.ts`
Expected: FAIL — TypeScript error similar to `Property 'isKiller' does not exist on type 'typeof PuzzleState'` (the interface has no namespace yet).

- [ ] **Step 4: Add the `PuzzleState.isKiller` namespace**

Open `web/src/session/types.ts`. Find the `PuzzleState` interface's closing brace (line 276):
```typescript
  readonly fixtureStalledCandidates?: readonly number[][][] | null;
}

// ---------------------------------------------------------------------------
// Coach settings
// ---------------------------------------------------------------------------
```
→
```typescript
  readonly fixtureStalledCandidates?: readonly number[][][] | null;
}

export namespace PuzzleState {
  export function isKiller(state: PuzzleState): boolean {
    return state.puzzleType !== 'classic';
  }
}

// ---------------------------------------------------------------------------
// Coach settings
// ---------------------------------------------------------------------------
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run src/session/engine.test.ts -t "isKiller"`
Expected: PASS — both `isKiller` cases green.

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku" && git add web/src/session/types.ts web/src/session/engine.test.ts && git commit -m "$(cat <<'EOF'
feat: add PuzzleState.isKiller as the canonical killer/classic predicate

buildEngine and friends currently re-derive "is this killer" from
state.puzzleType inline at each construction site. Promoting it to a
named namespace member (spec §2.5) gives every call site one shared,
testable definition — and matches the shape puzzle-state-redesign §6
already expects to upgrade to a type guard later.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Widen `triggerValidator.ts` back to plain `BoardState`

**Files:**
- Modify: `web/src/engine/triggerValidator.ts`

Sprint A's blanket `\bBoardState\b → KillerBoardState` rename over-narrowed `classifyEliminations` and `findTriggerMisses` (and the file's `BoardState` import). Both functions touch only `board.cands()` and `RuleResult`/`RuleContext` shapes — no killer-only members. They must accept a plain `BoardState` because Sprint 3 of this plan makes `buildEngine` call `findTriggerMisses` (via `scheduleTriggerValidation` → `runTriggerValidation`) with a classic-puzzle's plain `BoardState`.

- [ ] **Step 1: Widen the type-only `BoardState` import**

Open `web/src/engine/triggerValidator.ts`. Edit line 18:
```typescript
import type { KillerBoardState } from './boardState.js';
```
→
```typescript
import type { BoardState } from './boardState.js';
```

- [ ] **Step 2: Widen `classifyEliminations`'s `board` parameter**

Edit line 68:
```typescript
  board: KillerBoardState,
```
→
```typescript
  board: BoardState,
```

- [ ] **Step 3: Widen `findTriggerMisses`'s `board` parameter**

Edit line 109:
```typescript
  board: KillerBoardState,
```
→
```typescript
  board: BoardState,
```

- [ ] **Step 4: Run the type checker and the file's tests**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx tsc --noEmit && npx vitest run src/engine/triggerValidator.test.ts`
Expected: `tsc` exits 0; all tests in `triggerValidator.test.ts` pass unchanged — they construct `KillerBoardState` (assignable to the widened `BoardState` parameter, since `KillerBoardState extends BoardState`), so zero test-file edits are needed.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku" && git add web/src/engine/triggerValidator.ts && git commit -m "$(cat <<'EOF'
refactor: widen triggerValidator back to plain BoardState

Sprint A's blanket rename over-narrowed classifyEliminations and
findTriggerMisses to KillerBoardState even though both touch only
board.cands() — base BoardState members. buildEngine's classic branch
(Task 3) needs to pass a plain BoardState through this path.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Teach `buildEngine` to build a cage-free pair for classic puzzles

**Files:**
- Modify: `web/src/session/engine.ts`
- Test: `web/src/session/engine.test.ts`

This is the heart of the sprint. `buildEngine` currently always constructs `new KillerBoardState(spec, ...)` + `new KillerSolverEngine(...)`. It must instead consult `PuzzleState.isKiller(state)` once and build the matching bundle — `KillerBoardState`+`KillerSolverEngine` (with cage-solution pruning and virtual-cage re-adding) for killer puzzles, or a plain `BoardState`+`SolverEngine` for classic puzzles (spec §3 row 1).

Four small helpers in this same file (`scheduleTriggerValidation`, `runTriggerValidation`, `userEliminations`, `captureSnapshot`) were over-narrowed to `KillerBoardState` by Sprint A's rename for the same reason as Task 2's `triggerValidator` functions — their bodies touch only `board.cands()`/`board.peerEliminations()`, base members. They must be widened back to `BoardState` so `buildEngine`'s classic branch can pass its plain `BoardState` through them without a type error.

- [ ] **Step 1: Add board/engine class imports to `engine.test.ts`**

Open `web/src/session/engine.test.ts`. Edit line 19 (directly after the `./types.js` import edited in Task 1):
```typescript
import type { Cell } from '../engine/types.js';
```
→
```typescript
import type { Cell } from '../engine/types.js';
import { BoardState, KillerBoardState } from '../engine/boardState.js';
import { SolverEngine, KillerSolverEngine } from '../engine/solverEngine.js';
```

- [ ] **Step 2: Write the two failing tests**

Insert two new `it` blocks at the end of the `describe('buildEngine', ...)` block, directly before its closing `});` (currently lines 208-209):
```typescript
  it('fixtureStalledCandidates: board candidates unchanged after hint-mode solve', () => {
    // Hint rules can observe the board but cannot modify it — they only populate
    // pendingHints. After seeding with fixtureStalledCandidates, the board must
    // still reflect those candidates even after buildEngine runs hint rules.
    const stalledCandidates = KNOWN_SOLUTION.map(row => row.map(d => [d!]));
    const state: PuzzleState = {
      ...makeState(),
      alwaysApplyRules: [],
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      fixtureStalledCandidates: stalledCandidates,
    };
    const { board } = buildEngine(state, { includeHints: true });
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        expect([...board.cands(r, c)]).toEqual([KNOWN_SOLUTION[r]![c]!]);
      }
    }
  });
});
```
→
```typescript
  it('fixtureStalledCandidates: board candidates unchanged after hint-mode solve', () => {
    // Hint rules can observe the board but cannot modify it — they only populate
    // pendingHints. After seeding with fixtureStalledCandidates, the board must
    // still reflect those candidates even after buildEngine runs hint rules.
    const stalledCandidates = KNOWN_SOLUTION.map(row => row.map(d => [d!]));
    const state: PuzzleState = {
      ...makeState(),
      alwaysApplyRules: [],
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
      fixtureStalledCandidates: stalledCandidates,
    };
    const { board } = buildEngine(state, { includeHints: true });
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        expect([...board.cands(r, c)]).toEqual([KNOWN_SOLUTION[r]![c]!]);
      }
    }
  });

  it('constructs a KillerBoardState and KillerSolverEngine for killer puzzles', () => {
    const { board, engine } = buildEngine(makeState());
    expect(board).toBeInstanceOf(KillerBoardState);
    expect(engine).toBeInstanceOf(KillerSolverEngine);
  });

  it('constructs a plain BoardState and SolverEngine (not Killer variants) for classic puzzles', () => {
    const state: PuzzleState = { ...makeState(), puzzleType: 'classic' };
    const { board, engine } = buildEngine(state);
    expect(board).toBeInstanceOf(BoardState);
    expect(board).not.toBeInstanceOf(KillerBoardState);
    expect(engine).toBeInstanceOf(SolverEngine);
    expect(engine).not.toBeInstanceOf(KillerSolverEngine);
  });
});
```

- [ ] **Step 3: Run the new tests to verify the classic one fails**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run src/session/engine.test.ts -t "constructs a"`
Expected: the killer-puzzle test PASSES (current `buildEngine` already always builds `KillerBoardState`+`KillerSolverEngine`, so this is a regression guard, not a red test); the classic-puzzle test FAILS at `expect(board).not.toBeInstanceOf(KillerBoardState)` — `board` IS a `KillerBoardState` because `buildEngine` does not yet branch on puzzle type.

- [ ] **Step 4: Widen the four over-narrowed helper signatures**

Open `web/src/session/engine.ts`.

Edit line 19 (the `BoardState`/`KillerBoardState` import — post-Sprint-A-rename it imports only `KillerBoardState`, but the classic branch in Step 6 needs the plain superclass too):
```typescript
import { KillerBoardState } from '../engine/boardState.js';
```
→
```typescript
import { BoardState, KillerBoardState } from '../engine/boardState.js';
```

Edit line 31 (the `UserAction`/`PuzzleState` value import — `PuzzleState.isKiller` needs `PuzzleState` as a value, mirroring `UserAction`):
```typescript
import { UserAction } from './types.js';
```
→
```typescript
import { UserAction, PuzzleState } from './types.js';
```

Edit line 32 (drop `PuzzleState` from the type-only import now that it's imported as a value above — it remains usable as a type via declaration merging):
```typescript
import type { AutoMutation, BoardSnapshot, PuzzleState, Turn, VirtualCage } from './types.js';
```
→
```typescript
import type { AutoMutation, BoardSnapshot, Turn, VirtualCage } from './types.js';
```

Edit `scheduleTriggerValidation`'s signature (line 46):
```typescript
function scheduleTriggerValidation(
  board: KillerBoardState,
```
→
```typescript
function scheduleTriggerValidation(
  board: BoardState,
```

Edit `runTriggerValidation`'s signature (line 60):
```typescript
function runTriggerValidation(
  board: KillerBoardState,
```
→
```typescript
function runTriggerValidation(
  board: BoardState,
```

Edit `userEliminations`'s signature (line 142):
```typescript
export function userEliminations(board: KillerBoardState, userGrid: number[][] | null): Elimination[] {
```
→
```typescript
export function userEliminations(board: BoardState, userGrid: number[][] | null): Elimination[] {
```

Edit `captureSnapshot`'s signature (line 493):
```typescript
function captureSnapshot(board: KillerBoardState): BoardSnapshot {
```
→
```typescript
function captureSnapshot(board: BoardState): BoardSnapshot {
```

- [ ] **Step 5: Run the type checker to confirm the widened signatures still compile against existing callers**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx tsc --noEmit`
Expected: still reports the one error from Step 3's new test (classic branch not yet implemented) plus possibly a "declared but its value is never read" warning is NOT expected — `BoardState` is now used by the widened signatures. No new errors beyond the test assertion failure (which is a runtime `expect` failure, not a compile error, so `tsc` itself should exit 0 at this point).

- [ ] **Step 6: Restructure `buildEngine`'s construction to branch on `PuzzleState.isKiller`**

Open `web/src/session/engine.ts`. First, widen the return-type annotation. Use serena's `find_symbol` to locate `buildEngine`, then `replace_content` (or a direct text edit) on the signature line:
```typescript
): { board: KillerBoardState; engine: SolverEngine } {
```
→
```typescript
): { board: BoardState; engine: SolverEngine } {
```

Then use serena's `replace_symbol_body` on `buildEngine` to replace its entire body with the restructured version below. The new body moves `spec`/`rules`/`activeRules`/`hintRules`/`userCorrupted`/`activeGolden` computation to the top (so both branches can use them), replaces the single inline `onViolation` closure with a `makeOnViolation` factory parameterised on `board` (because `board` doesn't exist yet at the point the closure is defined — it's constructed inside the branch), and wraps each branch's full construction sequence (board → cage setup → engine) in an immediately-invoked function expression so the `const { board, engine }` destructuring assigns one coherent pair. Both IIFE branches return `{ board: <Killer>BoardState; engine: <Killer>SolverEngine }`; both subtype pairs are assignable to the explicit `{ board: BoardState; engine: SolverEngine }` annotation, so no cast is needed. The trailing "apply user placements, solve, schedule validation, return" logic is **completely unchanged** — only its `board`/`engine` are now polymorphic.

```typescript
export function buildEngine(
  state: PuzzleState,
  { includeHints = false, skipSolve = false }: { includeHints?: boolean; skipSolve?: boolean } = {},
): { board: BoardState; engine: SolverEngine } {
  const spec = dataToSpec(state.specData);

  const _disabled = new Set(DISABLED_RULES);
  const allRules = defaultRules().filter(r => !_disabled.has(r.name));
  const rules = PuzzleState.isKiller(state)
    ? allRules
    : allRules.filter(r => !r.killerOnly);
  const alwaysApplySet = new Set(state.alwaysApplyRules);

  // Non-hint mode: only always-apply rules run.
  // Hint mode: all rules run; always-apply rules apply directly, hint-only rules go to pendingHints.
  const activeRules = includeHints ? rules : rules.filter(r => alwaysApplySet.has(r.name));
  const hintRules = includeHints
    ? new Set(rules.filter(r => !alwaysApplySet.has(r.name)).map(r => r.name))
    : new Set<string>();

  // Golden checks are only meaningful when the user hasn't already corrupted the
  // board. Once a wrong placement or candidate removal is present, rules might
  // legitimately produce any elimination — disabling the checks prevents spurious
  // bug reports that would merely reflect the user's mistake.
  const userCorrupted = isUserCorrupted(state);
  const activeGolden = userCorrupted ? null : state.goldenSolution;

  const makeOnViolation = (board: BoardState) =>
    activeGolden !== null
      ? (ruleName: string, offending: readonly Elimination[]) => {
          if (isRuleDisabledForSession(ruleName)) return;
          disableRuleForSession(ruleName);
          const stalledCandidates = Array.from({ length: 9 }, (_, r) =>
            Array.from({ length: 9 }, (_, c) => [...board.cands(r, c)].sort((a, b) => a - b))
          );
          submitRuleBugReport({
            ruleName,
            offendingEliminations: offending.map(e => ({ cell: [e.cell[0], e.cell[1]] as [number, number], digit: e.digit })),
            goldenSolution: activeGolden,
            stalledCandidates,
            puzzleType: state.puzzleType,
            regions: spec.regions as number[][],
            cageTotals: spec.cageTotals as number[][],
          });
        }
      : null;

  const { board, engine }: { board: BoardState; engine: SolverEngine } = PuzzleState.isKiller(state)
    ? (() => {
        const board = new KillerBoardState(spec, { includeVirtualCages: false });

        // Apply user-eliminated cage solutions for real cages before any rules run.
        for (let i = 0; i < state.cageStates.length; i++) {
          const eliminated = state.cageStates[i]!.userEliminatedSolns;
          if (eliminated.length === 0) continue;
          const elimKeys = new Set(eliminated.map(solutionKey));
          const solns = board.cageSolns[i]!;
          solns.splice(0, Infinity, ...solns.filter(s => !elimKeys.has(solutionKey(s))));
        }

        // Re-add virtual cages — use state.virtualCages directly so that
        // eliminatedSolns set by eliminateVirtualCageSolution are applied.
        for (const vc of state.virtualCages) {
          board.addVirtualCage(vc.cells, vc.total, vc.eliminatedSolns, {
            ...(vc.negativeCells !== undefined && { negativeCells: vc.negativeCells }),
            ...(vc.eliminatedDiffSolns !== undefined && { eliminatedDiffSolns: vc.eliminatedDiffSolns }),
          });
        }

        const engine = new KillerSolverEngine(board, activeRules, {
          hintRules,
          goldenSolution: activeGolden,
          onViolation: makeOnViolation(board),
        });
        return { board, engine };
      })()
    : (() => {
        const board = new BoardState();
        const engine = new SolverEngine(board, activeRules, {
          hintRules,
          goldenSolution: activeGolden,
          onViolation: makeOnViolation(board),
        });
        return { board, engine };
      })();

  // Apply user placements and explicit candidate removals, then solve.
  // All three steps are wrapped in a single try/catch: any step can produce a
  // NoSolnError (e.g. removing the last candidate from a cell), and in every case
  // the board should be returned as-is so the caller can detect the contradiction
  // and offer a Rewind hint.
  let _solveCompleted = false;
  try {
    const placementElims = userEliminations(board, state.userGrid);
    if (placementElims.length > 0) engine.applyEliminations(placementElims);

    const removed = userRemoved(state);
    if (removed.length > 0) {
      engine.applyEliminations(
        removed.map(([r, c, d]) => ({ cell: [r, c] as Cell, digit: d })),
      );
    }

    // Eliminate each placed digit from row/col/box/cage peers unconditionally.
    // Applied after userRemoved so explicit user candidate removals take effect
    // first. This is a fundamental sudoku constraint independent of NakedSingle.
    if (state.userGrid !== null) {
      const peerElims: Elimination[] = [];
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const d = state.userGrid[r]![c]!;
          if (d > 0) peerElims.push(...board.peerEliminations(r, c, d));
        }
      }
      if (peerElims.length > 0) engine.applyEliminations(peerElims);
    }

    // Fixture stall seed: bring the board to the documented all-rules-exhausted
    // state before running rules. Since the stall is a fixed point of all rules,
    // the subsequent engine.solve() finds nothing left to do.
    if (state.fixtureStalledCandidates != null) {
      const stallElims: Elimination[] = [];
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const keep = new Set(state.fixtureStalledCandidates[r]![c]!);
          for (const d of board.cands(r, c)) {
            if (!keep.has(d)) stallElims.push({ cell: [r, c] as Cell, digit: d });
          }
        }
      }
      if (stallElims.length > 0) engine.applyEliminations(stallElims);
    }

    if (!skipSolve) engine.solve();
    _solveCompleted = true;
  } catch (e) {
    if (!(e instanceof NoSolnError)) throw e;
    // Board is contradictory — return as-is so callers can detect the inconsistency
    // via findLastConsistentTurnIdx / findMissingGoldenCandidate and offer a Rewind hint.
  }

  // Schedule a background brute-force check for trigger misses. Only runs when
  // a golden solution is present and the board is not user-corrupted, so we can
  // distinguish valid missed progress from wrong-rule bugs. Runs once per user
  // action (debounced); no UX impact since it executes after the current task.
  if (_solveCompleted && !includeHints && activeGolden !== null) {
    scheduleTriggerValidation(board, activeRules, activeGolden, state, spec);
  }

  return { board, engine };
}
```

- [ ] **Step 7: Run the type checker**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx tsc --noEmit`
Expected: exits 0 — no errors.

- [ ] **Step 8: Run the new tests to verify they pass**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run src/session/engine.test.ts`
Expected: PASS — all tests in the file green, including both new `'constructs a ...'` cases.

- [ ] **Step 9: Run the full unit suite**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run`
Expected: all tests pass. In particular `actions.test.ts`/`tutorial.test.ts` (which exercise `buildEngine` end-to-end for both puzzle types via `loadClassicDirect`/cage flows) stay green — `loadClassicDirect` is unchanged by this sprint (spec §3 row 3: it still synthesizes row-cage `specData`/`cageStates`, so `state.puzzleType === 'classic'` now routes through the new plain-`BoardState` branch instead of the old always-`KillerBoardState` branch, and the resulting board still solves the same puzzle — just without an unused `LinearSystem`/cage overlay).

- [ ] **Step 10: Commit**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku" && git add web/src/session/engine.ts web/src/session/engine.test.ts && git commit -m "$(cat <<'EOF'
feat: build a cage-free BoardState+SolverEngine pair for classic puzzles

buildEngine previously always constructed a KillerBoardState and
KillerSolverEngine, even for classic puzzles with no cage overlay. It
now consults PuzzleState.isKiller(state) once and builds the matching
bundle — KillerBoardState+KillerSolverEngine with cage-solution pruning
for killer puzzles, or a plain BoardState+SolverEngine for classic ones.

scheduleTriggerValidation/runTriggerValidation/userEliminations/
captureSnapshot are widened back to BoardState — Sprint A's blanket
rename over-narrowed them even though they touch only base members.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Widen and flip `engine/index.ts` — delete `makeClassicSpec`, build `solveFromStall` on a plain board

**Files:**
- Modify: `web/src/engine/index.ts`

`solveFromStall` currently builds a synthetic classic `PuzzleSpec` via `makeClassicSpec()` purely to give `KillerBoardState` "a neutral board container" (per its doc comment). With the new cage-free `BoardState`, it can construct one directly — `makeClassicSpec` becomes dead code. Five small helpers (`seedGivenDigits`, `SolveResult.board`, `checkStalled`, `snapshotCandidates`, `runWithBacktrack`) were over-narrowed to `KillerBoardState` by Sprint A's rename for the same reason as Tasks 2 and 3 — they touch only `board.cands()`/`board.candidates`, base members — and must widen back to `BoardState` so `solveFromStall` can pass its plain board through them.

Conversely, `solve`/`solveFromCandidates`/`getHints` must be **upgraded** from `SolverEngine` to `KillerSolverEngine`: they always build a `KillerBoardState` from a real cage `PuzzleSpec`, and post-Sprint-B the base `SolverEngine._onCellDetermined` is a no-op — constructing `new SolverEngine(killerBoard, ...)` would now silently skip linear-system propagation (a behavioural regression). `KillerSolverEngine` is the only engine that still wires a `KillerBoardState`'s `LinearSystem` into rule propagation.

- [ ] **Step 1: Widen the `BoardState`/`SolverEngine` imports**

Open `web/src/engine/index.ts`. Edit line 13:
```typescript
import { KillerBoardState } from './boardState.js';
```
→
```typescript
import { BoardState, KillerBoardState } from './boardState.js';
```

Edit line 15:
```typescript
import { SolverEngine } from './solverEngine.js';
```
→
```typescript
import { SolverEngine, KillerSolverEngine } from './solverEngine.js';
```

- [ ] **Step 2: Widen `seedGivenDigits`'s `board` parameter**

Edit line 28:
```typescript
function seedGivenDigits(engine: SolverEngine, board: KillerBoardState, givenDigits: number[][]): void {
```
→
```typescript
function seedGivenDigits(engine: SolverEngine, board: BoardState, givenDigits: number[][]): void {
```

- [ ] **Step 3: Widen `SolveResult.board`**

Edit lines 44-45:
```typescript
export interface SolveResult {
  board: KillerBoardState;
```
→
```typescript
export interface SolveResult {
  board: BoardState;
```

- [ ] **Step 4: Delete `makeClassicSpec` — it becomes dead code once `solveFromStall` builds a plain `BoardState` directly**

Delete lines 54-65 in their entirety:
```typescript
/** Build a classic spec for use as a neutral board container in solveFromStall.
 *  Nine row-cages (total=45 each), all vertical walls, no horizontal walls. */
function makeClassicSpec(): PuzzleSpec {
  const cageTotals = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  for (let r = 0; r < 9; r++) cageTotals[r]![0] = 45;
  return {
    regions: Array.from({ length: 9 }, (_, r) => new Array<number>(9).fill(r + 1)),
    cageTotals,
    borderX: Array.from({ length: 9 }, () => new Array<boolean>(8).fill(true)),
    borderY: Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false)),
  };
}

function checkStalled(board: KillerBoardState): boolean {
```
→
```typescript
function checkStalled(board: BoardState): boolean {
```

(This single edit both deletes `makeClassicSpec` and widens `checkStalled`'s signature — they are adjacent in the file.)

- [ ] **Step 5: Widen `snapshotCandidates`'s `board` parameter**

Edit line 73 (now shifted up by 12 lines after Step 4's deletion — use serena's `search_for_pattern` to locate, do not rely on the line number):
```typescript
function snapshotCandidates(board: KillerBoardState): number[][][] {
```
→
```typescript
function snapshotCandidates(board: BoardState): number[][][] {
```

- [ ] **Step 6: Widen `runWithBacktrack`'s `board` parameter**

Edit (originally line 79, now shifted):
```typescript
function runWithBacktrack(board: KillerBoardState, stalled: boolean): SolveResult {
```
→
```typescript
function runWithBacktrack(board: BoardState, stalled: boolean): SolveResult {
```

- [ ] **Step 7: Convert `solve` to construct `KillerSolverEngine`**

Edit (originally lines 99-100, now shifted):
```typescript
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, defaultRules());
```
→
```typescript
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  const engine = new KillerSolverEngine(board, defaultRules());
```

(This occurrence is inside `export function solve(spec: PuzzleSpec, givenDigits?: number[][]): SolveResult {`.)

- [ ] **Step 8: Flip `solveFromStall` onto a plain cage-free `BoardState`**

Edit (originally lines 119-121, now shifted):
```typescript
export function solveFromStall(candidates: number[][][]): SolveResult {
  const board = new KillerBoardState(makeClassicSpec(), { includeVirtualCages: false });
  const engine = new SolverEngine(board, defaultRules());
```
→
```typescript
export function solveFromStall(candidates: number[][][]): SolveResult {
  const board = new BoardState();
  const engine = new SolverEngine(board, defaultRules().filter(r => !r.killerOnly));
```

(`new SolverEngine` is correct here, unchanged — a plain `BoardState` has no `LinearSystem` for `KillerSolverEngine` to propagate through, and the base `SolverEngine._onCellDetermined` no-op is exactly what a cage-free board needs. `defaultRules().filter(r => !r.killerOnly)` matches `buildEngine`'s classic-branch rule set from Task 3.)

- [ ] **Step 9: Convert `solveFromCandidates` to construct `KillerSolverEngine`**

Edit (originally lines 151-152, now shifted):
```typescript
export function solveFromCandidates(spec: PuzzleSpec, candidates: number[][][]): SolveResult {
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, defaultRules());
```
→
```typescript
export function solveFromCandidates(spec: PuzzleSpec, candidates: number[][][]): SolveResult {
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  const engine = new KillerSolverEngine(board, defaultRules());
```

- [ ] **Step 10: Convert `getHints` to construct `KillerSolverEngine`**

Edit (originally lines 178-179, now shifted):
```typescript
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, defaultRules().filter(r => !_disabled.has(r.name)), { hintRules: hintRuleNames });
```
→
```typescript
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  const engine = new KillerSolverEngine(board, defaultRules().filter(r => !_disabled.has(r.name)), { hintRules: hintRuleNames });
```

- [ ] **Step 11: Run the type checker**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx tsc --noEmit`
Expected: exits 0. (If `PuzzleSpec` is reported as an unused import, that confirms `makeClassicSpec` was its only consumer in this file beyond the `solve`/`solveFromCandidates`/`getHints` parameter types that still use it — check with `search_for_pattern` for `PuzzleSpec` before assuming it's unused; it is still used as a parameter type in `solve`, `solveFromCandidates`, and `getHints`, so the import stays.)

- [ ] **Step 12: Run the engine unit suite**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run src/engine/index.test.ts src/engine/solverEngine.test.ts src/engine/kernelAnalysis.test.ts`
Expected: all pass. In particular `index.test.ts`'s `solveFromStall` cases (lines 5-32) — which only assert `result.board.cands(...)`/`usedBacktracking`/`stalledCandidates` against an already-fully-solved 81-cell grid where no rule needs to fire — pass unchanged against the new `new BoardState()` + filtered-rules construction.

- [ ] **Step 13: Run the full unit suite**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run`
Expected: all tests pass.

- [ ] **Step 14: Commit**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku" && git add web/src/engine/index.ts && git commit -m "$(cat <<'EOF'
refactor: build solveFromStall on a plain cage-free BoardState

solveFromStall previously synthesized a fake classic PuzzleSpec
(makeClassicSpec — nine 45-total row-cages) purely to give
KillerBoardState "a neutral board container". The new cage-free
BoardState makes that synthesis unnecessary — solveFromStall now
constructs new BoardState() directly and makeClassicSpec is deleted.

solve/solveFromCandidates/getHints now construct KillerSolverEngine
instead of the base SolverEngine: post-Sprint-B, SolverEngine's
_onCellDetermined is a no-op, so building one atop a real KillerBoardState
would have silently dropped linear-system propagation.

seedGivenDigits/SolveResult.board/checkStalled/snapshotCandidates/
runWithBacktrack are widened back to BoardState — over-narrowed by
Sprint A's rename despite touching only base members.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Add hint-text regression tests — no cage terminology leaks against a plain `BoardState`

**Files:**
- Modify: `web/src/engine/boardState.test.ts`

Spec §2 requires that running cage-aware rules (`HiddenSingle`, `LockedCandidates`) against a plain cage-free `BoardState` never produces hint text mentioning cages — both rules branch their `asHints` explanation on `ctx.unit.kind === UnitKind.CAGE`, which can never be true for a board with no `CAGE` units. This task adds a regression test proving that guarantee, anchored in `boardState.test.ts` (the home of plain-`BoardState` behavioural tests) rather than in each rule's own test file, because the property under test ("no cage units exist") is a `BoardState` invariant, not a rule-specific behaviour.

- [ ] **Step 1: Add the rule and context imports**

Open `web/src/engine/boardState.test.ts`. Edit line 9 (directly after the existing `Trigger`/`UnitKind` import):
```typescript
import { Trigger, UnitKind } from './types.js';
```
→
```typescript
import { Trigger, UnitKind } from './types.js';
import { HiddenSingle } from './rules/hiddenSingle.js';
import { LockedCandidates } from './rules/lockedCandidates.js';
import type { RuleContext } from './rule.js';
```

- [ ] **Step 2: Write the failing tests**

Insert a new `describe` block directly after the `describe('BoardState (plain) construction', ...)` block's closing `});` (the block Sprint A inserts — its final test is `'removeCandidate works without any cage bookkeeping'`):
```typescript
  it('removeCandidate works without any cage bookkeeping', () => {
    const bs = new BoardState();
    const events = bs.removeCandidate(0, 0, 9);
    expect(events.some(e => e.trigger === Trigger.COUNT_DECREASED)).toBe(true);
    expect(bs.cands(0, 0).has(9)).toBe(false);
  });
});
```
→
```typescript
  it('removeCandidate works without any cage bookkeeping', () => {
    const bs = new BoardState();
    const events = bs.removeCandidate(0, 0, 9);
    expect(events.some(e => e.trigger === Trigger.COUNT_DECREASED)).toBe(true);
    expect(bs.cands(0, 0).has(9)).toBe(false);
  });
});

describe('Cage-aware rule hints never mention cages against a plain BoardState', () => {
  it('HiddenSingle.asHints uses the non-cage explanation for a row unit', () => {
    const bs = new BoardState();
    for (let c = 1; c < 9; c++) bs.cands(0, c).delete(1);
    const rowUid = bs.rowUnitId(0);
    const ctx: RuleContext = { unit: bs.units[rowUid] ?? null, cell: null, board: bs, hint: Trigger.COUNT_HIT_ONE, hintDigit: 1 };
    const rule = new HiddenSingle();
    const hints = rule.asHints(ctx, rule.apply(ctx).eliminations);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.explanation.toLowerCase()).not.toContain('cage');
    expect(hints[0]!.displayName.toLowerCase()).not.toContain('cage');
  });

  it('LockedCandidates.asHints uses the box-line explanation, never the cage-line one', () => {
    const bs = new BoardState();
    // Digit 5 in row 0 is confined to cols 0-2 (box 0) — forces a box-line elimination.
    for (let c = 3; c < 9; c++) bs.cands(0, c).delete(5);
    const rowUid = bs.rowUnitId(0);
    const ctx: RuleContext = { unit: bs.units[rowUid] ?? null, cell: null, board: bs, hint: Trigger.COUNT_DECREASED, hintDigit: null };
    const rule = new LockedCandidates();
    const hints = rule.asHints(ctx, rule.apply(ctx).eliminations);
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) {
      expect(hint.displayName).toBe('Locked Candidates (Box-Line)');
      expect(hint.explanation.toLowerCase()).not.toContain('cage');
    }
  });
});
```

- [ ] **Step 3: Run the new tests**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run src/engine/boardState.test.ts -t "never mention cages"`
Expected: PASS — both cases green. (These tests exercise rule logic that is unaffected by this sprint's `buildEngine`/`engine/index.ts` changes — they construct rules and contexts directly — so they should pass immediately. Their value is as a permanent regression guard: if a future change adds a `CAGE`-branch fallback that fires incorrectly against cage-free boards, or `BoardState` ever grows `CAGE` units by mistake, this test catches the resulting hint-text leak.)

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku" && git add web/src/engine/boardState.test.ts && git commit -m "$(cat <<'EOF'
test: lock in that cage-aware rule hints never leak cage text on a plain board

HiddenSingle and LockedCandidates both branch their asHints explanation
on ctx.unit.kind === UnitKind.CAGE. A plain BoardState has no CAGE units,
so that branch is unreachable — but nothing previously asserted it. This
regression test pins the guarantee spec §2 relies on: a classic puzzle's
hints never mention cages.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Add a `KillerSolverEngine._onCellDetermined` delegation regression test

**Files:**
- Modify: `web/src/engine/solverEngine.test.ts`

Sprint B replaced the `_linearSystemActive`-flag mechanism with a virtual `_onCellDetermined` hook (no-op on `SolverEngine`, overridden on `KillerSolverEngine` to call `board.linearSystem.substituteCell`/`substituteLiveRows`) and added a regression test proving the *base* engine's hook is a no-op against a plain board. This task adds the complementary case: proving `KillerSolverEngine`'s override actually delegates to `LinearSystem` — closing the loop so a future accidental revert of either override is caught.

- [ ] **Step 1: Add `vi` and `KillerSolverEngine` to the test file's imports**

Open `web/src/engine/solverEngine.test.ts`. Edit line 12:
```typescript
import { describe, expect, it } from 'vitest';
```
→
```typescript
import { describe, expect, it, vi } from 'vitest';
```

Edit line 15:
```typescript
import { SolverEngine } from './solverEngine.js';
```
→
```typescript
import { SolverEngine, KillerSolverEngine } from './solverEngine.js';
```

- [ ] **Step 2: Write the failing test**

Insert a new `describe` block directly after the `describe('SolverEngine — _onCellDetermined virtual hook', ...)` block Sprint B inserts (its sole test ends `expect(plain.cands(0, 0)).toEqual(new Set([9]));\n  });\n});`):
```typescript
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
→
```typescript
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

- [ ] **Step 3: Run the new test**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run src/engine/solverEngine.test.ts -t "delegates to LinearSystem"`
Expected: PASS.

- [ ] **Step 4: Run the full unit suite**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx vitest run`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku" && git add web/src/engine/solverEngine.test.ts && git commit -m "$(cat <<'EOF'
test: lock in that KillerSolverEngine delegates cell-determination to LinearSystem

Sprint B's regression test proved the base SolverEngine's
_onCellDetermined hook is a no-op against a plain BoardState. This is
the complementary case: KillerSolverEngine's override must actually
forward to LinearSystem.substituteCell/substituteLiveRows — closing the
loop so an accidental revert of either override is caught by tests.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Final verification and branch completion

**Files:** none (verification only)

- [ ] **Step 1: Run the bronze gate**

Run: `cd "C:\Users\geoff\PycharmProjects\killer_sudoku" && bash scripts/run-bronze-gate.sh`
Expected: passes — `tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, and `npm test` all green; creates `.bronze-gate-ok`.

- [ ] **Step 2: Run the silver gate checks (required before merging to `master`)**

Run from `web/`:
```bash
cd "C:\Users\geoff\PycharmProjects\killer_sudoku\web" && npx tsc --noEmit && npx vitest run --reporter=verbose && npx playwright test && npx playwright test --config playwright.dev.config.ts
```
Expected: all four steps pass.

- [ ] **Step 3: Doc hygiene — confirm the spec and all three plans are fully incorporated**

Per CLAUDE.md's silver-gate doc-hygiene check: the implementation details from
`docs/superpowers/specs/2026-06-07-cage-free-board-state-for-classic.md` and the
three plan files (`2026-06-07-cage-free-board-state-sprint-a-extract-superclass.md`,
`-sprint-b-widen-contracts.md`, `-sprint-c-flip-switch.md`) must be written into
`docs/architecture.md` with concrete descriptions of what was actually built — not
a summary or pointer back to the spec/plans. Once incorporated, delete all four
files (the spec and the three plans). **Do not merge while any of them remain.**

- [ ] **Step 4: Hand off to `finishing-a-development-branch`**

Announce: "I'm using the finishing-a-development-branch skill to complete this work."
**REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch — it structures the merge/PR/cleanup decision and runs the master-branch silver-gate commit sequence (`scripts/run-silver-gate.sh` → commit/merge) per CLAUDE.md.
