# Sprint A: `rules()` Iterator + `availableCommands` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the rule-filtering logic in `buildEngine` into a `PuzzleState.rules()` iterator, and add a new `Command` type + `PuzzleState.availableCommands()` that consolidates three scattered UI-gating checks in `main.ts` (undo button, killer-only panel visibility, reveal button).

**Architecture:** Both additions live in `namespace PuzzleState` (`web/src/session/types.ts`), following the existing namespace-merging pattern. `buildEngine` (`session/engine.ts`) is updated to consume `PuzzleState.rules()`. `main.ts` is updated to consume `PuzzleState.availableCommands()` in three call sites. No new files, no behavioural change to end users — this is a refactor with new test coverage.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: `PuzzleState.rules()` iterator

**Files:**
- Modify: `web/src/session/types.ts`
- Test: `web/src/session/engine.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `web/src/session/engine.test.ts`, immediately after the existing `describe('PuzzleState.isKiller', ...)` block (after line 160):

```typescript
// ---------------------------------------------------------------------------
// PuzzleState.rules
// ---------------------------------------------------------------------------

describe('PuzzleState.rules', () => {
  it('killer state yields killerOnly rules', () => {
    const rules = [...PuzzleState.rules(makeState())];
    expect(rules.some(r => r.killerOnly)).toBe(true);
  });

  it('classic state excludes killerOnly rules', () => {
    const classic = PuzzleState.createClassic(null, [], null);
    const rules = [...PuzzleState.rules(classic)];
    expect(rules.some(r => r.killerOnly)).toBe(false);
    expect(rules.length).toBeGreaterThan(0);
  });

  it('excludes rules in DISABLED_RULES', () => {
    const rules = [...PuzzleState.rules(makeState())];
    const disabled = new Set(DISABLED_RULES);
    expect(rules.some(r => disabled.has(r.name))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/session/engine.test.ts -t "PuzzleState.rules"`

Expected: FAIL — `PuzzleState.rules is not a function`.

- [ ] **Step 3: Implement `PuzzleState.rules()`**

In `web/src/session/types.ts`, add these imports after the existing `import type { RuleMutation, EliminateCandidateMutation, RuleStep } from './ruleMutation.js';` (line 11):

```typescript
import { defaultRules } from '../engine/rules/index.js';
import { DISABLED_RULES } from '../engine/rules/disabled-rules.js';
import type { SolverRule } from '../engine/rule.js';
```

Then, inside `export namespace PuzzleState { ... }` (starts at line 300), add this function immediately after `isKiller` (after line 304, before the blank line preceding `createClassic`):

```typescript

  /** Enabled rules for this puzzle's type: killer yields all; classic excludes `killerOnly`. */
  export function* rules(state: PuzzleState): Iterable<SolverRule> {
    const disabled = new Set(DISABLED_RULES);
    const allRules = defaultRules().filter(r => !disabled.has(r.name));
    yield* isKiller(state) ? allRules : allRules.filter(r => !r.killerOnly);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/session/engine.test.ts -t "PuzzleState.rules"`

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/session/types.ts web/src/session/engine.test.ts
git commit -m "feat: add PuzzleState.rules() iterator"
```

---

### Task 2: Use `PuzzleState.rules()` in `buildEngine`

**Files:**
- Modify: `web/src/session/engine.ts:21-25,224-228`

- [ ] **Step 1: Replace the inline filter in `buildEngine`**

In `web/src/session/engine.ts`, replace lines 224-228:

```typescript
  const _disabled = new Set(DISABLED_RULES);
  const allRules = defaultRules().filter(r => !_disabled.has(r.name));
  const rules = PuzzleState.isKiller(state)
    ? allRules
    : allRules.filter(r => !r.killerOnly);
```

with:

```typescript
  const rules = [...PuzzleState.rules(state)];
```

- [ ] **Step 2: Remove now-unused imports**

`defaultRules` and `DISABLED_RULES` are no longer used in `engine.ts` (verify: `SolverRule` is still used at lines 51, 65, 213, so its import stays). Remove these two lines (21-22):

```typescript
import { defaultRules } from '../engine/rules/index.js';
import { DISABLED_RULES } from '../engine/rules/disabled-rules.js';
```

- [ ] **Step 3: Run the full session test suite**

Run: `cd web && npx vitest run src/session/`

Expected: PASS — all existing `buildEngine` tests (`describe('buildEngine', ...)` etc.) continue to pass unchanged, since `PuzzleState.rules()` produces the same rule list as the old inline filter.

- [ ] **Step 4: Run tsc**

Run: `cd web && npx tsc --noEmit`

Expected: PASS — no unused-import errors, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/session/engine.ts
git commit -m "refactor: buildEngine consumes PuzzleState.rules()"
```

---

### Task 3: `Command` type + `PuzzleState.availableCommands()`

**Files:**
- Modify: `web/src/session/types.ts`
- Test: `web/src/session/engine.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `web/src/session/engine.test.ts`, immediately after the `describe('PuzzleState.rules', ...)` block added in Task 1:

```typescript
// ---------------------------------------------------------------------------
// PuzzleState.availableCommands
// ---------------------------------------------------------------------------

describe('PuzzleState.availableCommands', () => {
  it('excludes undo when there are no turns', () => {
    const commands = PuzzleState.availableCommands(makeState());
    expect(commands.has('undo')).toBe(false);
  });

  it('includes undo after a user placement', () => {
    const turns = [makeTurn({ type: 'placeDigit', row: 0, col: 0, digit: 5, source: 'user' })];
    const commands = PuzzleState.availableCommands({ ...makeState(), turns });
    expect(commands.has('undo')).toBe(true);
  });

  it('excludes undo when the last turn is a given placement', () => {
    const turns = [makeTurn({ type: 'placeDigit', row: 0, col: 0, digit: 5, source: 'given' })];
    const commands = PuzzleState.availableCommands({ ...makeState(), turns });
    expect(commands.has('undo')).toBe(false);
  });

  it('includes inspectCage and virtualCage for killer states', () => {
    const commands = PuzzleState.availableCommands(makeState());
    expect(commands.has('inspectCage')).toBe(true);
    expect(commands.has('virtualCage')).toBe(true);
  });

  it('excludes inspectCage and virtualCage for classic states', () => {
    const classic = PuzzleState.createClassic(null, [], null);
    const commands = PuzzleState.availableCommands(classic);
    expect(commands.has('inspectCage')).toBe(false);
    expect(commands.has('virtualCage')).toBe(false);
  });

  it('includes reveal only when goldenSolution is set', () => {
    const withoutSolution = PuzzleState.availableCommands(makeState());
    expect(withoutSolution.has('reveal')).toBe(false);

    const withSolution = PuzzleState.availableCommands({
      ...makeState(),
      goldenSolution: KNOWN_SOLUTION.map(row => [...row]),
    });
    expect(withSolution.has('reveal')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/session/engine.test.ts -t "PuzzleState.availableCommands"`

Expected: FAIL — `PuzzleState.availableCommands is not a function`.

- [ ] **Step 3: Implement `Command` and `availableCommands()`**

In `web/src/session/types.ts`, add this exported type immediately before `export namespace PuzzleState {` (before line 300):

```typescript
/** UI commands whose availability depends on puzzle state. */
export type Command = 'undo' | 'inspectCage' | 'virtualCage' | 'reveal';

```

Then, inside `export namespace PuzzleState { ... }`, add this function immediately after the `rules()` function added in Task 1:

```typescript

  /** Commands available to the UI given the current state. */
  export function availableCommands(state: PuzzleState): ReadonlySet<Command> {
    const commands = new Set<Command>();
    const { turns } = state;
    if (turns.length > 0) {
      const last = turns[turns.length - 1]!.action;
      if (!(last.type === 'placeDigit' && last.source === 'given')) commands.add('undo');
    }
    if (isKiller(state)) { commands.add('inspectCage'); commands.add('virtualCage'); }
    if (state.goldenSolution !== null) commands.add('reveal');
    return commands;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/session/engine.test.ts -t "PuzzleState.availableCommands"`

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/session/types.ts web/src/session/engine.test.ts
git commit -m "feat: add Command type and PuzzleState.availableCommands()"
```

---

### Task 4: Wire `availableCommands` into `main.ts`

**Files:**
- Modify: `web/src/main.ts:719-721,727-737`

- [ ] **Step 1: Update `updateUndoButton`**

Replace (lines 727-732):

```typescript
function updateUndoButton(state: PuzzleState): void {
  const btn = el<HTMLButtonElement>('undo-btn');
  if (state.turns.length === 0) { btn.disabled = true; return; }
  const last = state.turns[state.turns.length - 1]!.action;
  btn.disabled = last.type === 'placeDigit' && last.source === 'given';
}
```

with:

```typescript
function updateUndoButton(state: PuzzleState): void {
  el<HTMLButtonElement>('undo-btn').disabled = !PuzzleState.availableCommands(state).has('undo');
}
```

- [ ] **Step 2: Update `renderPlayingMode`'s killer-only panel visibility**

Replace (lines 719-721):

```typescript
  const isKillerPuzzle = PuzzleState.isKiller(state);
  el<HTMLButtonElement>('inspect-cage-btn').hidden = !isKillerPuzzle;
  el<HTMLButtonElement>('virtual-cage-btn').hidden = !isKillerPuzzle;
```

with:

```typescript
  const commands = PuzzleState.availableCommands(state);
  el<HTMLButtonElement>('inspect-cage-btn').hidden = !commands.has('inspectCage');
  el<HTMLButtonElement>('virtual-cage-btn').hidden = !commands.has('virtualCage');
```

- [ ] **Step 3: Update `updateRevealButton`**

Replace (lines 734-737):

```typescript
function updateRevealButton(): void {
  el<HTMLButtonElement>('reveal-btn').hidden =
    currentState === null || currentState.goldenSolution === null || selectedCell === null;
}
```

with:

```typescript
function updateRevealButton(): void {
  el<HTMLButtonElement>('reveal-btn').hidden =
    currentState === null || !PuzzleState.availableCommands(currentState).has('reveal') || selectedCell === null;
}
```

- [ ] **Step 4: Run tsc**

Run: `cd web && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Run the full unit test suite**

Run: `cd web && npm test`

Expected: PASS — all existing tests continue to pass (this is a refactor of UI-gating logic with identical resulting behaviour).

- [ ] **Step 6: Commit**

```bash
git add web/src/main.ts
git commit -m "refactor: main.ts consumes PuzzleState.availableCommands()"
```

---

### Task 5: Bronze gate and doc updates

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md`
- Delete: `docs/superpowers/specs/2026-06-13-rules-iterator-available-commands-design.md`
- Delete: `docs/superpowers/plans/2026-06-13-rules-iterator-available-commands.md` (this file)

- [ ] **Step 1: Run the bronze gate**

Run: `cd /home/user/cagedoku && bash scripts/run-bronze-gate.sh`

Expected: PASS (`tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, `npm test` all succeed).

- [ ] **Step 2: If Step 1 fails, fix the underlying issue and re-run**

Do not proceed to commit until the bronze gate passes.

- [ ] **Step 3: Update `docs/architecture.md`**

Find the "Rule Mutations and Rule Steps" section (or the section documenting `buildEngine`'s rule selection) and add a short subsection documenting the new API. Add this content near where `buildEngine`'s rule-filtering is described:

```markdown
### `PuzzleState.rules()` and `Command` / `availableCommands`

`namespace PuzzleState` (`session/types.ts`) provides two additional members:

- `rules(state): Iterable<SolverRule>` — yields the enabled rule set for `state`'s puzzle
  type (killer yields all non-`DISABLED_RULES` rules; classic additionally excludes
  `killerOnly` rules). `buildEngine` consumes this directly: `const rules = [...PuzzleState.rules(state)]`.
- `Command = 'undo' | 'inspectCage' | 'virtualCage' | 'reveal'` and
  `availableCommands(state): ReadonlySet<Command>` — centralizes the UI-gating conditions
  for these four commands (turn history / `source: 'given'` for undo, `isKiller` for the
  cage commands, `goldenSolution !== null` for reveal). `main.ts`'s `updateUndoButton`,
  `renderPlayingMode`, and `updateRevealButton` consume this instead of repeating the
  underlying state checks. UI-local concerns (e.g. `selectedCell` for the reveal button)
  remain in `main.ts`.
```

- [ ] **Step 4: Update `docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md`**

In the "Shipped and incorporated into `docs/architecture.md`" list, add a new bullet:

```markdown
- **§6 `rules()` iterator and `availableCommands`** — `PuzzleState.rules()` and the new
  `Command` type / `PuzzleState.availableCommands()` (`web/src/session/types.ts`) are
  shipped. `buildEngine` consumes `rules()`; `main.ts`'s `updateUndoButton`,
  `renderPlayingMode`, and `updateRevealButton` consume `availableCommands()`. See
  "`PuzzleState.rules()` and `Command` / `availableCommands`" in `docs/architecture.md`.
```

Update the "Remaining work (this document)" list: remove the `rules()` iterator and
`availableCommands` portions from the first bullet, leaving only the display-method
extraction (Sprint B):

```markdown
- §6 Display methods (`candidateDisplay`, `cageBoundaries`, `cageLabels`, `cageDisplay`,
  `virtualCageDisplay`) extraction
```

- [ ] **Step 5: Delete the completed spec and plan files**

```bash
git rm docs/superpowers/specs/2026-06-13-rules-iterator-available-commands-design.md
git rm docs/superpowers/plans/2026-06-13-rules-iterator-available-commands.md
```

- [ ] **Step 6: Commit doc updates**

```bash
git add docs/architecture.md docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md
git commit -m "docs: incorporate rules() iterator and availableCommands into architecture.md"
```

---

## Next Step

After this task completes, invoke `superpowers:finishing-a-development-branch` to decide how
to integrate `feature/puzzlestate-display-methods-sprint-a` (merge, PR, or keep as-is). Per
CLAUDE.md, merging to `master` requires the **Silver Gate**
(`bash scripts/run-silver-gate.sh` from the repo root, plus the manual `tsc`/`npm
test`/Playwright checks documented there).
