# Big Apple Sudoku — Sprint 4: Dropdown UI + Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Big Apple a first-class entry in the OCR-review puzzle-type dropdown (manual override, independent of detection), widen every dropdown-driven dispatch site to 3-way, render the 4 window regions with a background tint, and fold the feature into the permanent docs.

**Architecture:** `activeCandidate` widens to a 3-way `kindOf` dispatch (per the approved design spec's exact helper). The dropdown change handler and `renderState`'s heading/dropdown-value logic both gain a third `'bigapple'` branch alongside `'killer'`/`'classic'`. Rendering adds one small, additive draw call — a `fillRect` per window cell, gated on `PuzzleState.isBigApple(state)` — with no border math, since window units need no boundary lines (the standard 3×3 box lines already render unconditionally).

**Tech Stack:** TypeScript, Vitest, manual + Playwright UI verification.

## Global Constraints

- All 2-D grid arrays are row-major (`grid[row][col]`); cell tuples are `[row, col]`.
- No `any`; prefer the weakest parameter type and strongest return type.
- This sprint depends on Sprint 1 (`BigAppleBoardState`), Sprint 2 (`PuzzleState.isBigApple`/`createBigApple`), and Sprint 3 (`detectBigApple`, the `#bigapple-banner` element, `UploadResult.detectedBigApple`) all being complete.
- Per CLAUDE.md's Frontend Design Scope: the window tint is a functional indicator required by the feature itself (showing the reader which cells form the extra regions), not aesthetic polish — pick any clearly-visible, unobtrusive fill colour; do not spend time tuning it for visual appeal.
- This is the last of the 4 sprints. Once its Completion Check passes, run the project's Silver Gate doc-hygiene step (CLAUDE.md "Doc hygiene") across all 4 sprint plan files plus the spec file — see Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `web/src/session/actions.ts` | Widen `activeCandidate` to a 3-way `kindOf` dispatch. |
| `web/src/session/actions.test.ts` | Add a Big Apple case to the existing `activeCandidate` tests. |
| `web/index.html` | Add `<option value="bigapple">Big Apple</option>` to `#puzzle-type-select`. |
| `web/src/main.ts` | 3-way dropdown change handler; 3-way `puzzleType` in `renderState` (heading text, dropdown value, dataset); auto-hide the detection banner on dropdown change; `drawWindowTint` + wiring into `drawGrid`. |
| `docs/architecture.md` | Amend the Board State Hierarchy section to mention `BigAppleBoardState` and the 3-way `buildEngine` dispatch. |
| `docs/big-apple-sudoku.md` | **New file.** Permanent reference doc for the variant, mirroring `docs/classic-sudoku.md`'s structure. |

No e2e test is added for the OCR-pipeline-triggered detection path in this sprint, consistent with the existing project convention documented at `main.ts`'s classic auto-confirm path ("a direct E2E test of this path is impractical — requires a real 81/81-digit OCR result").

---

## Task 1: `activeCandidate` 3-way widening

**Files:**
- Modify: `web/src/session/actions.ts`
- Test: `web/src/session/actions.test.ts`

**Interfaces:**
- Consumes: `PuzzleState.isKiller`, `PuzzleState.isBigApple` (Sprint 2).
- Produces: `activeCandidate(candidates: readonly PuzzleState[], selectedType: 'killer' | 'classic' | 'bigapple'): PuzzleState | undefined` — widened from the current `'killer' | 'classic'` signature. Consumed by Task 2's dropdown change handler.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('activeCandidate', ...)` block in `web/src/session/actions.test.ts` (currently lines 1007-1023), after the existing 3 tests, before the closing `});`:

```ts
  it('returns the Big Apple candidate when selectedType is bigapple', () => {
    const bigAppleCandidate = PuzzleState.createBigApple(null, [], null);
    expect(activeCandidate([killerCandidate, classicCandidate, bigAppleCandidate], 'bigapple')).toBe(bigAppleCandidate);
  });

  it('does not return the classic candidate when selectedType is bigapple', () => {
    expect(activeCandidate([classicCandidate], 'bigapple')).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/session/actions.test.ts -t "selectedType is bigapple"`
Expected: FAIL — current `activeCandidate(candidates, selectedType: 'killer' | 'classic')` has no `'bigapple'` member in its parameter type, so this is a TypeScript compile error (`npx tsc --noEmit` will also report it); under plain `vitest run` without a prior `tsc` pass, the runtime behaviour is wrong instead: `PuzzleState.isKiller(c) === (selectedType === 'killer')` evaluates `selectedType === 'killer'` to `false` for `'bigapple'`, so it matches the **first non-killer** candidate (the classic one), making `toBe(bigAppleCandidate)` fail.

- [ ] **Step 3: Write minimal implementation**

Replace `activeCandidate` in `web/src/session/actions.ts` (currently lines 586-591):

```ts
/**
 * Returns the OCR-review candidate matching the puzzle-type dropdown's
 * current selection, or undefined if no candidate of that type was built
 * (e.g. a Classic-detected scan never offers a Killer candidate, and most
 * scans never offer a Big Apple candidate unless detectBigApple fired).
 */
export function activeCandidate(
  candidates: readonly PuzzleState[],
  selectedType: 'killer' | 'classic' | 'bigapple',
): PuzzleState | undefined {
  const kindOf = (c: PuzzleState): 'killer' | 'classic' | 'bigapple' =>
    PuzzleState.isKiller(c) ? 'killer' : PuzzleState.isBigApple(c) ? 'bigapple' : 'classic';
  return candidates.find(c => kindOf(c) === selectedType);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/session/actions.test.ts -t activeCandidate`
Expected: PASS (all 5 tests — 3 existing, 2 new).

- [ ] **Step 5: Commit**

```bash
git add web/src/session/actions.ts web/src/session/actions.test.ts
git commit -m "feat: widen activeCandidate to a 3-way killer/classic/bigapple dispatch"
```

---

## Task 2: Dropdown option + 3-way change handler + heading

**Files:**
- Modify: `web/index.html`
- Modify: `web/src/main.ts`

**Interfaces:**
- Consumes: `activeCandidate` (Task 1), `PuzzleState.isBigApple`/`createBigApple` (Sprint 2).
- Produces: the puzzle-type dropdown can select/display `'bigapple'`; no new exports. Verified manually + via Playwright (DOM wiring, same convention as Sprint 3 Task 5 — no isolated unit-testable surface).

- [ ] **Step 1: Add the dropdown option**

In `web/index.html`, add a third `<option>` to `#puzzle-type-select` (currently lines 165-168):

```html
      <select id="puzzle-type-select" class="puzzle-type-select">
        <option value="killer">Killer</option>
        <option value="classic">Classic</option>
        <option value="bigapple">Big Apple</option>
      </select>
```

- [ ] **Step 2: Widen `renderState`'s `puzzleType` to 3-way**

In `web/src/main.ts`, replace the `puzzleType` derivation in `renderState` (currently line 629):

```ts
  const puzzleType = PuzzleState.isKiller(state) ? 'killer' : PuzzleState.isBigApple(state) ? 'bigapple' : 'classic';
```

Update the heading logic immediately below it (currently lines 631-636) to a 3-way switch:

```ts
  const heading = document.getElementById('detected-layout-heading');
  if (heading !== null) {
    heading.textContent =
      puzzleType === 'classic' ? 'Detected Layout — Classic Sudoku' :
      puzzleType === 'bigapple' ? 'Detected Layout — Big Apple Sudoku' :
      'Detected Layout — Killer Sudoku';
  }
```

The line just below, `el<HTMLElement>('classic-edit-hint').hidden = puzzleType !== 'classic' || state.goldenSolution !== null;` (currently line 638-639), stays **unchanged but now also needs to cover Big Apple** — Big Apple's OCR review screen has the exact same shape as classic's (large centred digits, click-to-correct), so the edit hint should show for Big Apple too. Change it to:

```ts
  el<HTMLElement>('classic-edit-hint').hidden =
    puzzleType === 'killer' || state.goldenSolution !== null;
```

The two lines after that (currently lines 645-646, `el('puzzle-type-select').value = puzzleType;` and `el('review-panel').dataset['puzzleType'] = puzzleType;`) need no code change — `puzzleType` is now correctly `'killer' | 'classic' | 'bigapple'` and both lines already just assign it through.

- [ ] **Step 3: Widen the dropdown change handler to 3-way**

In `web/src/main.ts`, replace the change handler (currently lines 2163-2189):

```ts
  el<HTMLSelectElement>('puzzle-type-select').addEventListener('change', (e) => {
    const state = currentState;
    if (state === null) return;
    const type = (e.target as HTMLSelectElement).value as 'killer' | 'classic' | 'bigapple';
    el<HTMLElement>('bigapple-banner').hidden = true;
    const candidates = getStateCandidates();
    const found = activeCandidate(candidates, type);
    let updated: PuzzleState;
    if (found !== undefined) {
      updated = found;
      setStateCandidates([found, ...candidates.filter(c => c !== found)]);
    } else if (type === 'killer') {
      const synthetic = classicSyntheticSpec();
      updated = PuzzleState.createKiller(
        specToData(synthetic), specToCageStates(synthetic),
        state.alwaysApplyRules, state.originalImageUrl, null,
      );
      setState(updated);
    } else if (type === 'bigapple') {
      const givenDigits = PuzzleState.isKiller(state)
        ? Array.from({ length: 9 }, () => new Array<number>(9).fill(0))
        : state.givenDigits;
      updated = PuzzleState.createBigApple(givenDigits, state.alwaysApplyRules, state.originalImageUrl);
      setState(updated);
    } else {
      const givenDigits = PuzzleState.isKiller(state)
        ? Array.from({ length: 9 }, () => new Array<number>(9).fill(0))
        : state.givenDigits;
      updated = PuzzleState.createClassic(givenDigits, state.alwaysApplyRules, state.originalImageUrl);
      setState(updated);
    }
    currentState = updated;
    renderState(updated);
  });
```

The new `el<HTMLElement>('bigapple-banner').hidden = true;` line is the Sprint-3-deferred behaviour noted in that sprint's plan: switching the dropdown to any type (including back to Big Apple manually) clears the auto-detection banner, since the user has now taken an explicit action on the type.

- [ ] **Step 4: Manual verification**

Run: `cd web && npm run dev -- --port 5175`

Using the existing `__testLoad` dev hook or a real upload, confirm:
1. The dropdown shows 3 options: Killer, Classic, Big Apple.
2. Selecting "Big Apple" on a plain classic state synthesizes a `BigApplePuzzleState` from the current given digits, updates the heading to "Detected Layout — Big Apple Sudoku", and shows the classic-style edit hint (not hidden).
3. Switching away from "Big Apple" back to "Classic" preserves the given digits and hides the banner if it was showing.

Defer to the Silver Gate's Playwright suites for regression coverage of the existing killer/classic dropdown paths (`flow.spec.ts:195`, `flow.spec.ts:425` already assert on `#puzzle-type-select`).

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/src/main.ts
git commit -m "feat: add Big Apple option to the puzzle-type dropdown"
```

---

## Task 3: Window-tint rendering

**Files:**
- Modify: `web/src/main.ts`

**Interfaces:**
- Consumes: `MARGIN`, `CELL` constants (`main.ts:96-97`), `PuzzleState.isBigApple` (Sprint 2).
- Produces: `drawWindowTint(ctx: CanvasRenderingContext2D): void` — module-private, called from `drawGrid`. No new exports.

The 4 window corners (0-based, top-left of each 3×3 window) mirror `BigAppleBoardState`'s own `WINDOW_STARTS` constant (`web/src/engine/bigAppleBoardState.ts`, Sprint 1) — duplicated here rather than imported/exported across the engine/UI boundary, since it is 4 fixed numbers unlikely to ever change independently in only one of the two places.

- [ ] **Step 1: Add `drawWindowTint`**

In `web/src/main.ts`, add a new function immediately after `drawCageBorders` (after line 325, before `drawGridLines`):

```ts
// 0-based top-left corner of each Big Apple window, in row-major reading
// order — mirrors BigAppleBoardState's WINDOW_STARTS (web/src/engine/bigAppleBoardState.ts).
const WINDOW_STARTS: readonly (readonly [number, number])[] = [
  [1, 1], // top-left
  [5, 1], // bottom-left
  [1, 5], // top-right
  [5, 5], // bottom-right
];

function drawWindowTint(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = 'rgba(37, 99, 235, 0.10)';
  for (const [r0, c0] of WINDOW_STARTS) {
    ctx.fillRect(MARGIN + c0 * CELL, MARGIN + r0 * CELL, 3 * CELL, 3 * CELL);
  }
}
```

- [ ] **Step 2: Wire it into `drawGrid`**

In `web/src/main.ts`, update `drawGrid` (currently lines 511-514) to call it right after the cage-border draw call, before grid lines:

```ts
  drawUnderlays(ctx, candidatesData, vcSelection, highlightKeys, selected, errorCells, suspectCells, vcNegSelection);
  if (PuzzleState.isKiller(state)) drawCageBorders(ctx, state, draft);
  if (PuzzleState.isBigApple(state)) drawWindowTint(ctx);
  drawGridLines(ctx);
  if (PuzzleState.isKiller(state)) drawCageTotals(ctx, state);
```

- [ ] **Step 3: Manual verification**

Run: `cd web && npm run dev -- --port 5175`. Switch the puzzle-type dropdown to "Big Apple" (per Task 2) and confirm 4 lightly-tinted 3×3 regions appear at the expected offset positions (rows/cols 2–4 and 6–8 in 1-based terms), with standard grid lines drawn on top of the tint (not obscured by it) and digits still fully legible.

This is a pure canvas-drawing change with no DOM state to unit-test; defer to manual verification plus the Silver Gate's Playwright suites (which already exercise `drawGrid` indirectly via screenshot-free DOM assertions — no pixel-level test exists for cage borders either, so none is added here for consistency).

- [ ] **Step 4: Commit**

```bash
git add web/src/main.ts
git commit -m "feat: render Big Apple window regions with a background tint"
```

---

## Task 4: Doc updates and spec/plan cleanup

**Files:**
- Modify: `docs/architecture.md`
- Create: `docs/big-apple-sudoku.md`
- Delete: `docs/superpowers/specs/2026-06-20-big-apple-sudoku-design.md`
- Delete: `docs/superpowers/plans/2026-06-20-big-apple-sudoku-1-engine-core.md`, `-2-session-state.md`, `-3-ocr-detection.md`, `-4-dropdown-rendering.md` (this file)

This task has no test — it is documentation and repo hygiene, run once all 3 implementation sprints are verified complete (all checkboxes ticked across all 4 plan files).

- [ ] **Step 1: Amend `docs/architecture.md`**

In the "Board State Hierarchy" section, insert a new paragraph after the existing one ending "...Fresh states are built via `PuzzleState.createClassic(...)` and `PuzzleState.createKiller(...)` factories rather than synthetic specs." (currently `docs/architecture.md:111-112`), before the `userGrid is always a real 9×9 grid...` paragraph:

```markdown
`BigAppleBoardState extends BoardState` (`web/src/engine/bigAppleBoardState.ts`)
adds a third axis orthogonal to killer/classic: 4 extra offset 3×3 "window"
units (rows/cols `[1..3]`/`[5..7]` crossed with `[1..3]`/`[5..7]`, 0-based),
registered via the same `UnitKind.BOX` every box-aware rule already gates on
— no per-rule changes were needed to cover them. `PuzzleState.isBigApple`
(`'bigApple' in state`, mirroring `isKiller`'s `'specData' in state` pattern)
makes `buildEngine`'s `isKiller` ternary 3-way: killer → `KillerBoardState` +
`KillerSolverEngine`; Big Apple → `BigAppleBoardState` + plain `SolverEngine`;
classic → plain `BoardState` + plain `SolverEngine`. Big Apple shares
classic's `PuzzleState` shape exactly (no cage fields, same `givenDigits`),
so it needs no new serialized fields beyond the `bigApple: true` discriminant.
A virtual method, `BoardState.extraPeers(r, c): readonly Cell[]` (default
`[]`, overridden by `BigAppleBoardState` to return the cell's window peers),
lets `mrvBacktrack`'s forward-checking respect window constraints without an
`instanceof` check — the same template-method shape `cageConstraints()`
already established for cage validity in the backtracker.
```

- [ ] **Step 2: Write `docs/big-apple-sudoku.md`**

Create the file, mirroring `docs/classic-sudoku.md`'s structure:

```markdown
# Big Apple Sudoku

> Read this before touching Big Apple detection, the `BigAppleBoardState`
> engine class, or any UI branch conditioned on `PuzzleState.isBigApple`.

Big Apple Sudoku is classic sudoku plus 4 extra offset 3×3 "window" regions,
each of which must also contain digits 1–9 exactly once.

| Window | Rows (1-based) | Cols (1-based) |
|---|---|---|
| Top-left | 2–4 | 2–4 |
| Bottom-left | 6–8 | 2–4 |
| Top-right | 2–4 | 6–8 |
| Bottom-right | 6–8 | 6–8 |

0-based: rows/cols `[1..3]` and `[5..7]` crossed with `[1..3]` and `[5..7]`.

---

## Detection

There is no visual/OCR cue distinguishing a Big Apple puzzle image from a
classic one — both show large centred givens, no cage borders. Detection is
solvability-based: `detectBigApple` (`web/src/engine/index.ts`) runs the rule
engine with classic-only rules (constraint propagation, no backtracking); if
it stalls before every cell is solved, it retries with classic + window rules
(`BigAppleBoardState`); if that retry completes the grid, the image is
treated as Big Apple.

This only runs for classic-*detected* OCR scans (`result.puzzleType ===
'classic'`) — never for killer-detected scans, whose `classicCandidate` comes
from a less-reliable digit pass (see `solveCurrentSpec`'s comment on
false-positive digit detection near cage-total text), and because a real Big
Apple photo never has cage borders to begin with.

`buildCandidatesFromParseResult` (`web/src/session/actions.ts`) prepends a
`PuzzleState.createBigApple(...)` candidate when detection fires, making it
the default `activeCandidate`, and reports `detectedBigApple: boolean`
alongside the candidate list. The OCR review screen shows a dismissible
banner (`#bigapple-banner` in `web/index.html`) when this flag is set; the
banner also auto-hides as soon as the user changes the puzzle-type dropdown.

## Manual override

The puzzle-type dropdown (`#puzzle-type-select`) always offers a "Big Apple"
option, selectable regardless of what detection concluded. Selecting it
synthesizes a `BigApplePuzzleState` from the current given digits via
`PuzzleState.createBigApple`, exactly mirroring the existing Classic branch's
on-the-fly synthesis — no cage/spec data is involved.

## Engine

`BigAppleBoardState extends BoardState` (`web/src/engine/bigAppleBoardState.ts`)
registers the 4 window cell-sets as `UnitKind.BOX` units via the protected
`_addUnit` method, after the standard 27 row/col/box units. Reusing
`UnitKind.BOX` means every rule gating on `unitKinds.has(UnitKind.BOX)` —
`NakedPair`/`Triple`/`Quad`, `HiddenSingle`/`Pair`/`Triple`/`Quad`,
`PointingPairs`, `WWing` — automatically covers the windows with no per-rule
changes. `extraPeers(r, c)` returns the cell's 8 window-mates so
`mrvBacktrack`'s forward-checking respects window constraints during
backtracking.

`solveBigApple(givenDigits?)` (`web/src/engine/index.ts`) is the Big Apple
sibling of `solve()`, used by `solveCurrentSpec` (`web/src/session/actions.ts`)
to compute the golden solution at confirm time whenever
`PuzzleState.isBigApple(state)`.

**Known coverage gap:** `LockedCandidates`' box-line reduction
(`web/src/engine/rules/lockedCandidates.ts`) computes box unit ids
geometrically (`board.boxUnitId(br*3, bc*3)`) rather than by iterating
`board.units` by kind, so it does not extend to window units. Windows still
get full coverage from every other `UnitKind.BOX`-aware rule; this is an
accepted, documented gap, not a blocker.

## Rendering

Window cells get a light background tint (`drawWindowTint`, `web/src/main.ts`)
gated on `PuzzleState.isBigApple(state)` — a plain `fillRect` per window cell
with no border math, since window units need no boundary lines. Standard
3×3 box lines render unconditionally, same as for classic and killer.

## Out of scope

- No combined killer + Big Apple variant — the three puzzle types remain
  mutually exclusive.
- Orientation correction, already deferred for classic, remains deferred.
```

- [ ] **Step 3: Run the Silver Gate doc-hygiene check**

Confirm (manually) that every implementation detail in
`docs/superpowers/specs/2026-06-20-big-apple-sudoku-design.md` is now reflected
in either `docs/architecture.md` (Step 1) or `docs/big-apple-sudoku.md`
(Step 2). Confirm every `- [ ]` checkbox is ticked across all 4 sprint plan
files (`docs/superpowers/plans/2026-06-20-big-apple-sudoku-{1,2,3,4}-*.md`).

- [ ] **Step 4: Delete the spec and plan files**

```bash
git rm docs/superpowers/specs/2026-06-20-big-apple-sudoku-design.md
git rm docs/superpowers/plans/2026-06-20-big-apple-sudoku-1-engine-core.md
git rm docs/superpowers/plans/2026-06-20-big-apple-sudoku-2-session-state.md
git rm docs/superpowers/plans/2026-06-20-big-apple-sudoku-3-ocr-detection.md
git rm docs/superpowers/plans/2026-06-20-big-apple-sudoku-4-dropdown-rendering.md
```

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md docs/big-apple-sudoku.md docs/superpowers/
git commit -m "docs: fold Big Apple Sudoku design into architecture.md and a dedicated reference doc"
```

(The `git rm` deletions from Step 4 are already staged; the `git add docs/superpowers/` above picks up those staged deletions alongside the two new/modified doc files.)

---

## Sprint 4 Completion Check

Run from `web/`:

```bash
npx tsc --noEmit
npx vitest run
npx playwright test
npx playwright test --config playwright.dev.config.ts
```

All must pass. This is the Silver Gate (per CLAUDE.md) — once green, the feature branch is ready to merge to `master` following CLAUDE.md's "Master — commit sequence" (`bash scripts/run-silver-gate.sh`, then `git merge feature/<name>`).
