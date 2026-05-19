# Ctrl-inverted keyboard digit mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Ctrl+digit` keyboard shortcuts that perform the opposite-mode digit action without switching modes.

**Architecture:** Extract the mode/ctrl/key → action mapping into a pure `resolveDigitKey` function (testable in isolation), then call it from the existing `keydown` handler in `main.ts`. One callout string is also updated.

**Tech Stack:** TypeScript, Vitest (tests run from `web/` with `npx vitest run`)

---

## File map

| File | Change |
|------|--------|
| `web/src/resolveDigitKey.ts` | **Create** — pure function, no DOM imports |
| `web/src/resolveDigitKey.test.ts` | **Create** — 8-combination unit tests |
| `web/src/main.ts` | **Modify** — import + use `resolveDigitKey` in `keydown` handler; update digit-pad callout string |

---

### Task 1: `resolveDigitKey` — TDD

**Files:**
- Create: `web/src/resolveDigitKey.ts`
- Create: `web/src/resolveDigitKey.test.ts`

- [ ] **Step 1: Create the feature branch**

```bash
git checkout master && git pull
git checkout -b feature/65-ctrl-digit-mode
```

- [ ] **Step 2: Write the failing tests**

Create `web/src/resolveDigitKey.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveDigitKey } from './resolveDigitKey.js';

describe('resolveDigitKey', () => {
  // Normal mode, no Ctrl — place digit
  it('normal mode + no ctrl + digit → placeDigit', () => {
    expect(resolveDigitKey(false, false, '5')).toEqual({ action: 'placeDigit', digit: 5 });
  });
  it('normal mode + no ctrl + Backspace → placeDigit digit 0', () => {
    expect(resolveDigitKey(false, false, 'Backspace')).toEqual({ action: 'placeDigit', digit: 0 });
  });

  // Normal mode, Ctrl — cycle candidate
  it('normal mode + ctrl + digit → cycleCandidate', () => {
    expect(resolveDigitKey(false, true, '3')).toEqual({ action: 'cycleCandidate', digit: 3 });
  });
  it('normal mode + ctrl + Delete → cycleCandidate digit 0', () => {
    expect(resolveDigitKey(false, true, 'Delete')).toEqual({ action: 'cycleCandidate', digit: 0 });
  });

  // Candidate mode, no Ctrl — cycle candidate
  it('candidate mode + no ctrl + digit → cycleCandidate', () => {
    expect(resolveDigitKey(true, false, '7')).toEqual({ action: 'cycleCandidate', digit: 7 });
  });
  it('candidate mode + no ctrl + Backspace → cycleCandidate digit 0', () => {
    expect(resolveDigitKey(true, false, 'Backspace')).toEqual({ action: 'cycleCandidate', digit: 0 });
  });

  // Candidate mode, Ctrl — place digit
  it('candidate mode + ctrl + digit → placeDigit', () => {
    expect(resolveDigitKey(true, true, '1')).toEqual({ action: 'placeDigit', digit: 1 });
  });
  it('candidate mode + ctrl + Delete → placeDigit digit 0', () => {
    expect(resolveDigitKey(true, true, 'Delete')).toEqual({ action: 'placeDigit', digit: 0 });
  });

  // Non-digit keys return null
  it('returns null for unrelated keys', () => {
    expect(resolveDigitKey(false, false, 'ArrowUp')).toBeNull();
    expect(resolveDigitKey(false, true, 'Enter')).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests — confirm RED**

```bash
cd web && npx vitest run src/resolveDigitKey.test.ts
```

Expected: `Failed to resolve import "./resolveDigitKey.js"` (module does not exist yet).

- [ ] **Step 4: Implement `resolveDigitKey`**

Create `web/src/resolveDigitKey.ts`:

```ts
export type DigitAction = 'placeDigit' | 'cycleCandidate';

/**
 * Maps the current mode + Ctrl state + key to a digit action.
 * Returns null when the key is not a handled digit or clear key.
 *
 * Rule: Ctrl inverts the mode for that keypress.
 *   candidateEditMode === ctrlKey  →  placeDigit
 *   candidateEditMode !== ctrlKey  →  cycleCandidate
 */
export function resolveDigitKey(
  candidateEditMode: boolean,
  ctrlKey: boolean,
  key: string,
): { action: DigitAction; digit: number } | null {
  let digit: number;
  if (key >= '1' && key <= '9') digit = Number(key);
  else if (key === 'Backspace' || key === 'Delete') digit = 0;
  else return null;

  const action: DigitAction = (candidateEditMode === ctrlKey) ? 'placeDigit' : 'cycleCandidate';
  return { action, digit };
}
```

- [ ] **Step 5: Run tests — confirm GREEN**

```bash
cd web && npx vitest run src/resolveDigitKey.test.ts
```

Expected: `10 tests | 10 passed`

- [ ] **Step 6: Commit**

```bash
cd .. && git add web/src/resolveDigitKey.ts web/src/resolveDigitKey.test.ts
git commit -m "feat: resolveDigitKey — Ctrl-inverted mode mapping (TDD)"
```

---

### Task 2: Wire into `main.ts` keydown handler + callout update

**Files:**
- Modify: `web/src/main.ts`

- [ ] **Step 1: Add the import**

At the top of `web/src/main.ts`, after the existing local imports, add:

```ts
import { resolveDigitKey } from './resolveDigitKey.js';
```

- [ ] **Step 2: Replace the playing-mode digit key block in the keydown handler**

Find the block (around line 1531 in the current file):

```ts
    if (candidateEditMode && selectedCell !== null) {
      if (e.key >= '1' && e.key <= '9') { void handleCandidateCycle(selectedCell.row, selectedCell.col, Number(e.key)); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { void handleCandidateCycle(selectedCell.row, selectedCell.col, 0); return; }
    } else if (selectedCell !== null) {
      if (e.key >= '1' && e.key <= '9') { void handleCellEntry(Number(e.key)); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { void handleCellEntry(0); return; }
    }
```

Replace with:

```ts
    if (selectedCell !== null) {
      const resolved = resolveDigitKey(candidateEditMode, e.ctrlKey, e.key);
      if (resolved !== null) {
        if (e.ctrlKey) e.preventDefault();
        if (resolved.action === 'placeDigit') {
          void handleCellEntry(resolved.digit);
        } else {
          void handleCandidateCycle(selectedCell.row, selectedCell.col, resolved.digit);
        }
        return;
      }
    }
```

- [ ] **Step 3: Update the digit-pad tutorial callout text**

Find in `renderPlayingMode` (around line 531):

```ts
    { id: 'digit-1',       text: 'Use these buttons to enter digits. In Candidate mode, they toggle pencil marks instead.' },
```

Replace with:

```ts
    { id: 'digit-1',       text: 'Use these buttons to enter digits. In Candidate mode, they toggle pencil marks instead. On a keyboard, Ctrl+digit works in the opposite mode.' },
```

- [ ] **Step 4: Run full bronze gate**

```bash
cd web
npx tsc --noEmit
npx tsc -p tsconfig.node.json --noEmit
npx vitest run
```

Expected: all type checks pass, all tests pass (37+ test files).

- [ ] **Step 5: Commit**

```bash
cd .. && git add web/src/main.ts
git commit -m "feat: Ctrl+digit inverts keyboard mode (#65)

In normal mode Ctrl+1-9 toggles a candidate; Ctrl+Backspace/Delete
resets candidates. In candidate mode Ctrl+1-9 places a digit;
Ctrl+Backspace/Delete clears it. Also updates the digit-pad tutorial
callout to describe the shortcut."
```

- [ ] **Step 6: Push and open PR**

```bash
git push -u origin feature/65-ctrl-digit-mode
gh pr create --base master --head feature/65-ctrl-digit-mode \
  --title "feat: Ctrl+digit inverts keyboard mode (#65)" \
  --body "$(cat <<'EOF'
## Summary
- In normal mode, Ctrl+digit toggles that candidate; Ctrl+Backspace/Delete resets candidates
- In candidate mode, Ctrl+digit places the digit; Ctrl+Backspace/Delete clears the cell
- Logic extracted into pure \`resolveDigitKey(candidateEditMode, ctrlKey, key)\` helper (10 unit tests)
- Digit-pad tutorial callout updated to document the shortcut

## Test plan
- [ ] Normal mode: Ctrl+3 on a selected cell toggles candidate 3 without switching mode
- [ ] Candidate mode: Ctrl+3 on a selected cell places digit 3
- [ ] Ctrl+Backspace in normal mode resets all candidates for the cell
- [ ] Ctrl+Backspace in candidate mode clears the placed digit
- [ ] Plain 1-9 and Backspace/Delete behave identically to before
- [ ] \`npx vitest run\` passes (37+ files)

Closes #65
EOF
)"
```

---

## Verification

After the PR is open:
1. Manual test on a killer puzzle with a cell selected
2. Confirm Ctrl+digit in both modes produces the expected action
3. Open the help modal and advance callouts to the digit-pad step — verify the updated text appears
