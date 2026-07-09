# Sprint 5 — #161: Auto-Solve Fires with No Animation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user cycles a candidate that triggers rule-step deductions (including auto-placement of the last digit), those steps play through the `AnimationPlayer` exactly as cell entry does.

**Architecture:** `cycleCandidate` in `actions.ts` currently returns only `PuzzleState`, discarding `ruleSteps` and `baseState`. `handleCandidateCycle` in `main.ts` therefore calls plain `refreshDisplay()` with no animation.

Fix:
1. Change `cycleCandidate` to return `{ state: PuzzleState; ruleSteps: readonly RuleStep[]; baseState: PuzzleState }` — the same shape as `enterCellStep`.
2. Update `handleCandidateCycle` in `main.ts` to mirror the animated path from `handleCellEntry`.

`PuzzleStateOps.eliminateCandidate`, `PuzzleStateOps.restoreCandidate`, and `PuzzleStateOps.resetCellCandidates` all go through `recordTurn`, which already produces `{ state, ruleSteps, baseState, board }`. `cycleCandidate` already receives a `SessionResult` from each branch — it just discards `ruleSteps` and `baseState`.

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- Branch: `feature/bug-fixes-160-161-162-165-166-167`
- Bronze gate must pass before every commit
- Before merging to master: run corpus evaluator and verify no regression vs baseline
- `cycleCandidate` is in `web/src/session/actions.ts:901-926`
- `handleCandidateCycle` is in `web/src/main.ts:1697-1706` (approx)
- `handleCellEntry` (animated path) is in `web/src/main.ts:1630-1680` — use it as the reference implementation

---

### Task 1: Expose ruleSteps from cycleCandidate

**Files:**
- Modify: `web/src/session/actions.ts:901-926` (`cycleCandidate`)
- Test: `web/src/session/actions.test.ts`

**Interfaces:**
- New return type: `{ state: PuzzleState; ruleSteps: readonly RuleStep[]; baseState: PuzzleState }`
- `PuzzleStateOps.eliminateCandidate(state, r, c, digit)` returns `SessionResult` — `{ state, board, ruleSteps }`. To get `baseState`, call `recordTurn` directly (it returns `{ state, ruleSteps, baseState, board }`).
- `PuzzleStateOps.restoreCandidate` and `PuzzleStateOps.resetCellCandidates` must also expose `baseState`; read their signatures in `engine.ts` before implementing.

- [ ] **Step 1: Write the failing test**

In `web/src/session/actions.test.ts`, add:

```typescript
describe('cycleCandidate — returns ruleSteps', () => {
  it('returns ruleSteps when eliminating a candidate triggers auto-placement', () => {
    // Set up a confirmed state where eliminating a candidate causes NakedSingle to fire.
    // cycleCandidate should return non-empty ruleSteps in that case.
    const result = cycleCandidate(ROW_1B, COL_1B, DIGIT);
    // New return type: { state, ruleSteps, baseState }
    expect(result).toHaveProperty('ruleSteps');
    expect(result).toHaveProperty('baseState');
    expect(Array.isArray(result.ruleSteps)).toBe(true);
  });
});
```

*Note:* Replace `ROW_1B`, `COL_1B`, `DIGIT` with values from a test puzzle cell where eliminating `DIGIT` leaves a NakedSingle. The puzzle must be in confirmed state.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/session/actions.test.ts -t "returns ruleSteps"
```

Expected: FAIL — `result` is currently `PuzzleState`, not an object with `ruleSteps`.

- [ ] **Step 3: Change cycleCandidate return type and body**

In `web/src/session/actions.ts`, replace `cycleCandidate` (lines 901-926):

```typescript
export function cycleCandidate(
  row1b: number,
  col1b: number,
  digit: number,
): { state: PuzzleState; ruleSteps: readonly RuleStep[]; baseState: PuzzleState } {
  const state = requireConfirmed();
  const r = row1b - 1;
  const c = col1b - 1;

  if (digit === 0) {
    const result = PuzzleStateOps.resetCellCandidates(state, r, c);
    setState(result.state);
    return { state: result.state, ruleSteps: result.ruleSteps, baseState: state };
  }

  const cellRemoved = new Set(
    userRemoved(state).filter(([rr, cc]) => rr === r && cc === c).map(([,, d]) => d),
  );
  const { board } = buildEngine(state);

  let result: SessionResult;
  if (cellRemoved.has(digit)) {
    result = PuzzleStateOps.restoreCandidate(state, r, c, digit);
  } else if (board.cands(r, c).has(digit)) {
    result = PuzzleStateOps.eliminateCandidate(state, r, c, digit);
  } else {
    // auto-impossible and not user-removed — no-op
    return { state, ruleSteps: [], baseState: state };
  }

  setState(result.state);
  return { state: result.state, ruleSteps: result.ruleSteps, baseState: state };
}
```

*Note:* `PuzzleStateOps.resetCellCandidates` and `PuzzleStateOps.restoreCandidate` return `SessionResult` which has `ruleSteps` but not `baseState`. Use the pre-action `state` as `baseState` for all branches (this is correct: `baseState` is the state the user sees before the action and its rule steps).

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web && npx vitest run src/session/actions.test.ts -t "returns ruleSteps"
```

Expected: PASS.

- [ ] **Step 5: Fix TypeScript errors from the return-type change**

Run:

```bash
cd web && npx tsc --noEmit 2>&1 | head -30
```

The only expected error is in `main.ts:handleCandidateCycle` which destructures the old return value. Fix it in the next task. All other callers of `cycleCandidate` (if any) must also be updated.

---

### Task 2: Update handleCandidateCycle to use the animated path

**Files:**
- Modify: `web/src/main.ts` — `handleCandidateCycle` (approx line 1697)

**Interfaces:**
- `cycleCandidate(row1b, col1b, digit)` now returns `{ state, ruleSteps, baseState }`
- `AnimationPlayer` interface: `{ baseState, ruleSteps, cursor, playing }`
- `AnimationPlayer.stateAtCursor(player)` — returns state with mutations applied up to `cursor`
- `AnimationPlayer.boardAtCursor(player)` — returns `CandidatesResponse` at cursor
- `AnimationPlayer.currentStep(player)` — returns current `RuleStep` or null
- `AnimationPlayer.tick(player)` — advances cursor
- `getAutoPlacementDelay()` — returns 0 if animation is disabled, positive ms otherwise
- `setAutoApplyLock(bool)` — prevents concurrent auto-apply
- `showHintPill`, `hideHintPill` — from `hintPill.ts`

- [ ] **Step 6: Replace handleCandidateCycle in main.ts**

Replace the `handleCandidateCycle` function body (mirror `handleCellEntry`'s animated path):

```typescript
async function handleCandidateCycle(row1b: number, col1b: number, digit: number): Promise<void> {
  try {
    const delay = getAutoPlacementDelay();
    if (delay === 0) {
      const { state } = cycleCandidate(row1b, col1b, digit);
      currentState = state;
      refreshDisplay();
      updateUndoButton(state);
    } else {
      setAutoApplyLock(true);
      try {
        const animRefresh = (player: AnimationPlayer): void => {
          currentState = AnimationPlayer.stateAtCursor(player);
          if (showCandidates) {
            const data = AnimationPlayer.boardAtCursor(player);
            currentCandidates = data;
            setCandidatesCache(data);
          }
          redrawGrid();
        };

        const { state: finalState, ruleSteps, baseState } = cycleCandidate(row1b, col1b, digit);
        updateUndoButton(finalState);

        let player: AnimationPlayer = { baseState, ruleSteps, cursor: 0, playing: true };
        animRefresh(player);

        while (player.cursor < ruleSteps.length) {
          const step = AnimationPlayer.currentStep(player)!;
          hintHighlightCells = new Set(step.highlightCells.map(([r, c]) => `${r},${c}`));
          hintElimCells = new Set(
            step.mutations
              .filter((m): m is EliminateCandidateMutation => m.type === 'eliminateCandidate')
              .map(m => `${m.row},${m.col}`),
          );
          showHintPill(el('hint-pill'), el('hint-pill-label'), step.displayName);
          await new Promise<void>(resolve => { setTimeout(resolve, fastForwardRequested ? 0 : delay); });

          player = AnimationPlayer.tick(player);
          hintHighlightCells = new Set();
          hintElimCells = new Set();
          hideHintPill(el('hint-pill'));
          animRefresh(player);
        }

        currentState = finalState;
        refreshDisplay();
      } finally {
        setAutoApplyLock(false);
      }
    }
  } catch (e) { setStatus(String(e), true); }
}
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit
```

Expected: 0 errors.

- [ ] **Step 8: Run full test suite**

```bash
cd web && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 9: Run bronze gate**

```bash
cd /c/Users/geoff/PycharmProjects/killer_sudoku && bash scripts/run-bronze-gate.sh
```

Expected: all checks pass, token created.

- [ ] **Step 10: Commit**

```bash
git add web/src/session/actions.ts web/src/main.ts web/src/session/actions.test.ts
git commit -m "fix: thread ruleSteps through cycleCandidate for auto-solve animation (#161)"
```
