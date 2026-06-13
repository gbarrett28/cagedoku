# Sprint A: `rules()` Iterator + `availableCommands` — Design

**Date:** 2026-06-13
**Parent spec:** `docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md` §6 (remaining work)
**Scope:** First of two sprints covering §6's remaining items. This sprint covers the `rules()`
iterator extraction and the new `Command` / `availableCommands` API. The six display-data
methods (`candidateDisplay`, `cageBoundaries`, `cageLabels`, `cageDisplay`,
`virtualCageDisplay`) are Sprint B — out of scope here.

---

## 1. `PuzzleState.rules(state)` — rule iterator

**File:** `web/src/session/types.ts`

```typescript
export namespace PuzzleState {
  export function* rules(state: PuzzleState): Iterable<SolverRule> {
    const disabled = new Set(DISABLED_RULES);
    const allRules = defaultRules().filter(r => !disabled.has(r.name));
    yield* isKiller(state) ? allRules : allRules.filter(r => !r.killerOnly);
  }
}
```

New imports required in `types.ts`:
- `defaultRules` (value) from `../engine/rules/index.js`
- `DISABLED_RULES` (value) from `../engine/rules/disabled-rules.js`
- `SolverRule` (type) from `../engine/rule.js`

No import cycle: `engine/` never imports from `session/`.

**Caller update — `buildEngine`** (`web/src/session/engine.ts:222-228`):

Before:
```typescript
const _disabled = new Set(DISABLED_RULES);
const allRules = defaultRules().filter(r => !_disabled.has(r.name));
const rules = PuzzleState.isKiller(state)
  ? allRules
  : allRules.filter(r => !r.killerOnly);
```

After:
```typescript
const rules = [...PuzzleState.rules(state)];
```

**Out of scope:** `getSettingsData` (`actions.ts:1318-1328`) keeps its own inline filter. It
has a `state === null` fallback case that `rules(state: PuzzleState)` (non-nullable parameter)
doesn't cleanly cover, and the parent spec scopes `rules()` to `buildEngine`'s internal use.
`DISABLED_RULES` is currently empty, so there is no behavioural divergence today.

---

## 2. `Command` type + `PuzzleState.availableCommands(state)`

**File:** `web/src/session/types.ts`

```typescript
export type Command = 'undo' | 'inspectCage' | 'virtualCage' | 'reveal';

export namespace PuzzleState {
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
}
```

### Consolidates three scattered checks in `web/src/main.ts`

1. **`updateUndoButton`** (lines 727-732):
   ```typescript
   function updateUndoButton(state: PuzzleState): void {
     const btn = el<HTMLButtonElement>('undo-btn');
     if (state.turns.length === 0) { btn.disabled = true; return; }
     const last = state.turns[state.turns.length - 1]!.action;
     btn.disabled = last.type === 'placeDigit' && last.source === 'given';
   }
   ```
   Becomes:
   ```typescript
   function updateUndoButton(state: PuzzleState): void {
     el<HTMLButtonElement>('undo-btn').disabled = !PuzzleState.availableCommands(state).has('undo');
   }
   ```

2. **`renderPlayingMode`** (lines 719-721):
   ```typescript
   const isKillerPuzzle = PuzzleState.isKiller(state);
   el<HTMLButtonElement>('inspect-cage-btn').hidden = !isKillerPuzzle;
   el<HTMLButtonElement>('virtual-cage-btn').hidden = !isKillerPuzzle;
   ```
   Becomes:
   ```typescript
   const commands = PuzzleState.availableCommands(state);
   el<HTMLButtonElement>('inspect-cage-btn').hidden = !commands.has('inspectCage');
   el<HTMLButtonElement>('virtual-cage-btn').hidden = !commands.has('virtualCage');
   ```

3. **`updateRevealButton`** (lines 734-737):
   ```typescript
   function updateRevealButton(): void {
     el<HTMLButtonElement>('reveal-btn').hidden =
       currentState === null || currentState.goldenSolution === null || selectedCell === null;
   }
   ```
   Becomes:
   ```typescript
   function updateRevealButton(): void {
     el<HTMLButtonElement>('reveal-btn').hidden =
       currentState === null || !PuzzleState.availableCommands(currentState).has('reveal') || selectedCell === null;
   }
   ```
   `selectedCell` is UI selection state, not part of `PuzzleState` — it stays a separate
   `main.ts`-local check.

---

## Testing

New `describe` blocks in `web/src/session/engine.test.ts`:

- **`PuzzleState.rules`**: killer state yields `killerOnly` rules; classic state excludes them.
- **`PuzzleState.availableCommands`**:
  - empty `turns` → no `'undo'`
  - last turn is a user placement → `'undo'` present
  - last turn is a `placeDigit` with `source: 'given'` → no `'undo'`
  - killer state → `'inspectCage'` and `'virtualCage'` present; classic state → absent
  - `goldenSolution !== null` → `'reveal'` present; `null` → absent

This is a refactor of existing behaviour (no new user-visible behaviour), so existing
`actions.test.ts` / e2e coverage of undo-button and panel-visibility behaviour should continue
to pass unchanged and serves as regression coverage.

---

## Out of Scope

- The six display-data methods (`candidateDisplay`, `cageBoundaries`, `cageLabels`,
  `cageDisplay`, `virtualCageDisplay`) and their `main.ts` rewiring — Sprint B.
- `getSettingsData`'s rule filter (see §1).
- §7 Serialization (separate, later work per parent spec).
