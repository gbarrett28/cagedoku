# Hidden-tuple secondary highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pale-blue `secondaryHighlightCells` overlay to HiddenSingle, HiddenPair,
and the Hidden Triple/Quad branches of NakedHiddenTriple/NakedHiddenQuad, so the hint
shows the full unit context while the orange/yellow highlight is reserved for the
cells the deduction is actually about (fixes issue #153).

**Architecture:** New optional field `secondaryHighlightCells?: readonly Cell[]` on
`HintResult` (engine layer) and `HintItem` (session layer), mapped through
`actions.ts` the same way `patternDigits` is. Rendered in `main.ts` as a new
module-level highlight set, drawn with a pale-blue fill before the existing
orange/yellow overlays.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Add `secondaryHighlightCells` to `HintResult`

**Files:**
- Modify: `web/src/engine/hint.ts`

- [ ] **Step 1: Add the field with doc comment**

In `web/src/engine/hint.ts`, add a new field to the `HintResult` interface, after
`colourGroups?` (after line 35):

```typescript
  /** Two colour groups for bipartite-chain rules; absent for all other rules. */
  readonly colourGroups?: readonly ColourGroup[];
  /**
   * Cells rendered with a pale-blue wash to give unit context for the deduction
   * (e.g. "this is the unit in which the digit/tuple is unique"). Distinct from
   * `highlightCells` (orange/yellow) and `colourGroups` (chain-colouring blue/green).
   */
  readonly secondaryHighlightCells?: readonly Cell[];
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (adding an optional field doesn't break existing object literals).

- [ ] **Step 3: Commit**

```bash
git add web/src/engine/hint.ts
git commit -m "feat: add secondaryHighlightCells to HintResult"
```

---

### Task 2: Add `secondaryHighlightCells` to `HintItem` and map it through `actions.ts`

**Files:**
- Modify: `web/src/session/types.ts:710` (after `patternDigits`)
- Modify: `web/src/session/actions.ts:1200` (after the `patternDigits` spread)

- [ ] **Step 1: Add the field to `HintItem`**

In `web/src/session/types.ts`, after line 710 (`readonly patternDigits?: readonly number[];`),
add:

```typescript
  /** Cells rendered with a pale-blue wash for unit context; see HintResult.secondaryHighlightCells. */
  readonly secondaryHighlightCells?: readonly [number, number][];
```

- [ ] **Step 2: Map it through in `actions.ts`**

In `web/src/session/actions.ts`, after line 1200
(`...(h.patternDigits ? { patternDigits: [...h.patternDigits] } : {}),`), add:

```typescript
      ...(h.secondaryHighlightCells ? {
        secondaryHighlightCells: [...h.secondaryHighlightCells].map(([r, c]) => [r, c] as [number, number]),
      } : {}),
```

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/session/types.ts web/src/session/actions.ts
git commit -m "feat: thread secondaryHighlightCells through HintItem"
```

---

### Task 3: Render `secondaryHighlightCells` as a pale-blue overlay in `main.ts`

**Files:**
- Modify: `web/src/main.ts`

- [ ] **Step 1: Add module-level state**

In `web/src/main.ts`, near line 122 (`let hintColourGroups: ... = [];`), add a new
module-level set on the line directly after it:

```typescript
let hintHighlightCells = new Set<string>();     // "r,c" keys, 0-based — pattern cells (orange)
let hintElimCells = new Set<string>();          // "r,c" keys, 0-based — elimination cells (yellow)
let hintColourGroups: readonly { cells: readonly [number, number][]; colour: 'blue' | 'green' }[] = [];
let hintSecondaryHighlightCells = new Set<string>(); // "r,c" keys, 0-based — pale-blue unit context
```

- [ ] **Step 2: Draw the pale-blue overlay before the orange overlay**

In `drawUnderlays` (`web/src/main.ts`), the existing orange-highlight block looks like
this (around line 239):

```typescript
  if (highlightKeys !== null && highlightKeys.size > 0) {
    ctx.fillStyle = 'rgba(249, 115, 22, 0.35)';
    for (const key of highlightKeys) {
      const parts = key.split(',').map(Number);
      const r = parts[0]!, c = parts[1]!;
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }
```

Insert a new block **immediately before** it (so the pale blue is painted first and
orange/yellow can paint over it if cells ever overlap):

```typescript
  if (hintSecondaryHighlightCells.size > 0) {
    ctx.fillStyle = 'rgba(96, 165, 240, 0.18)';
    for (const key of hintSecondaryHighlightCells) {
      const parts = key.split(',').map(Number);
      const r = parts[0]!, c = parts[1]!;
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }
  if (highlightKeys !== null && highlightKeys.size > 0) {
    ctx.fillStyle = 'rgba(249, 115, 22, 0.35)';
    for (const key of highlightKeys) {
      const parts = key.split(',').map(Number);
      const r = parts[0]!, c = parts[1]!;
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }
```

- [ ] **Step 3: Populate the set when a hint is shown**

In `showHintModal` (`web/src/main.ts`, around line 985), after the line
`hintColourGroups = hint.colourGroups ?? [];`, add:

```typescript
  hintSecondaryHighlightCells = new Set((hint.secondaryHighlightCells ?? []).map(([r, c]) => `${r},${c}`));
```

- [ ] **Step 4: Clear the set when the hint is dismissed**

In `clearHintHighlight` (`web/src/main.ts`, around line 1021), after the line
`hintColourGroups = [];`, add:

```typescript
  hintSecondaryHighlightCells = new Set();
```

- [ ] **Step 5: Clear the set on full session reset**

In `web/src/main.ts` around line 2098, the reset line currently reads:

```typescript
    hintHighlightCells = new Set(); hintElimCells = new Set(); hintColourGroups = []; activeHintItem = null;
```

Change it to:

```typescript
    hintHighlightCells = new Set(); hintElimCells = new Set(); hintColourGroups = [];
    hintSecondaryHighlightCells = new Set(); activeHintItem = null;
```

- [ ] **Step 6: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/main.ts
git commit -m "feat: render secondaryHighlightCells as a pale-blue overlay"
```

---

### Task 4: HiddenSingle — split `highlightCells` and add `secondaryHighlightCells`

**Files:**
- Modify: `web/src/engine/rules/hiddenSingle.ts:63-96` (the `asHints` method)
- Test: `web/src/engine/rules/hiddenSingle.test.ts`

- [ ] **Step 1: Replace the existing peer-highlight test with a failing test**

In `web/src/engine/rules/hiddenSingle.test.ts`, replace the test
`'asHints includes peer cells holding d in highlightCells'` (the whole `it(...)`
block) with:

```typescript
  it('asHints: highlightCells contains only the sole cell; secondaryHighlightCells covers the rest of the unit', () => {
    // d=7 confined to (0,4) in row 0; col-4 and box-1 peers still hold 7
    const bs = new KillerBoardState(makeTrivialSpec());
    const rowUid = bs.rowUnitId(0);
    for (let c = 0; c < 9; c++) {
      if (c !== 4) bs.cands(0, c).delete(7);
    }
    bs.counts[rowUid]![7] = 1;
    const ctx = makeCtx(bs, rowUid, 7);
    const elims = new HiddenSingle().apply(ctx).eliminations;
    const hints = new HiddenSingle().asHints(ctx, [...elims]);
    expect(hints).toHaveLength(1);
    const hint = hints[0]!;
    // highlightCells contains only the sole cell (0,4)
    expect(hint.highlightCells).toEqual([[0, 4]]);
    // secondaryHighlightCells covers the other 8 cells of row 0
    expect(hint.secondaryHighlightCells).toHaveLength(8);
    expect(hint.secondaryHighlightCells!.some(([r, c]) => r === 0 && c === 0)).toBe(true);
    expect(hint.secondaryHighlightCells!.every(([r, c]) => !(r === 0 && c === 4))).toBe(true);
    // col-4 peers (outside row 0) are in neither highlight set
    expect(hint.secondaryHighlightCells!.some(([r, c]) => r !== 0 && c === 4)).toBe(false);
    // eliminations are unchanged: non-7 candidates of (0,4) only
    expect(hint.eliminations.every(e => e.cell[0] === 0 && e.cell[1] === 4)).toBe(true);
    expect(hint.eliminations.every(e => e.digit !== 7)).toBe(true);
    // explanation still mentions peer removal in prose
    expect(hint.explanation).toContain('also removes 7 from');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/engine/rules/hiddenSingle.test.ts`
Expected: FAIL — `hint.highlightCells` currently also contains peer cells, so
`toEqual([[0, 4]])` fails, and `hint.secondaryHighlightCells` is `undefined`.

- [ ] **Step 3: Update `asHints` in `hiddenSingle.ts`**

In `web/src/engine/rules/hiddenSingle.ts`, the final `return` of `asHints` currently
reads:

```typescript
    return [{
      ruleName: this.name,
      displayName: 'Hidden Single',
      explanation,
      highlightCells: [sole, ...peerCells],
      eliminations,
      placement: null,
      virtualCageSuggestion: null,
      patternDigits: [d],
    }];
```

Change it to:

```typescript
    return [{
      ruleName: this.name,
      displayName: 'Hidden Single',
      explanation,
      highlightCells: [sole],
      secondaryHighlightCells: (ctx.unit.cells as Cell[]).filter(([ur, uc]) => !(ur === r && uc === c)),
      eliminations,
      placement: null,
      virtualCageSuggestion: null,
      patternDigits: [d],
    }];
```

(`peerCells` and `peerNote` remain unchanged — they still feed the explanation text.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/engine/rules/hiddenSingle.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/rules/hiddenSingle.ts web/src/engine/rules/hiddenSingle.test.ts
git commit -m "fix: HiddenSingle highlights only the target cell, with pale-blue unit context (issue #153)"
```

---

### Task 5: HiddenPair — add `secondaryHighlightCells`

**Files:**
- Modify: `web/src/engine/rules/hiddenPair.ts:80-86` (the `asHints` return)
- Test: `web/src/engine/rules/hiddenPair.test.ts`

- [ ] **Step 1: Add a failing assertion**

In `web/src/engine/rules/hiddenPair.test.ts`, in the test
`'asHints: returns a hint with correct shape for a hidden pair'`, after the line
`expect(hints[0]!.placement).toBeNull();`, add:

```typescript
    // secondaryHighlightCells covers the rest of the unit, not the pair cells
    expect(hints[0]!.secondaryHighlightCells).toHaveLength(7);
    expect(hints[0]!.secondaryHighlightCells!.every(([r, c]) => !(r === 0 && (c === 0 || c === 1)))).toBe(true);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/engine/rules/hiddenPair.test.ts`
Expected: FAIL — `hints[0]!.secondaryHighlightCells` is `undefined`.

- [ ] **Step 3: Update `asHints` in `hiddenPair.ts`**

The final `return` of `asHints` currently reads:

```typescript
    return [{
      ruleName: this.name, displayName: 'Hidden Pair',
      explanation: `Hidden Pair: only {${digits.join(',')}} can go in ${cellLabel(c1)} and ${cellLabel(c2)} within ${unitLabel(ctx.unit)}. Remove all other candidates from these two cells.`,
      highlightCells: [...pairCells, ...eliminations.map(e => e.cell)],
      eliminations: [...eliminations], placement: null, virtualCageSuggestion: null,
      patternDigits: digits,
    }];
```

Change it to:

```typescript
    return [{
      ruleName: this.name, displayName: 'Hidden Pair',
      explanation: `Hidden Pair: only {${digits.join(',')}} can go in ${cellLabel(c1)} and ${cellLabel(c2)} within ${unitLabel(ctx.unit)}. Remove all other candidates from these two cells.`,
      highlightCells: [...pairCells, ...eliminations.map(e => e.cell)],
      secondaryHighlightCells: cells.filter(([pr, pc]) => !pairCells.some(([qr, qc]) => qr === pr && qc === pc)),
      eliminations: [...eliminations], placement: null, virtualCageSuggestion: null,
      patternDigits: digits,
    }];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/engine/rules/hiddenPair.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/rules/hiddenPair.ts web/src/engine/rules/hiddenPair.test.ts
git commit -m "feat: HiddenPair pale-blue highlight for unit context (issue #153)"
```

---

### Task 6: NakedHiddenTriple (Hidden Triple branch) — add `secondaryHighlightCells`

**Files:**
- Modify: `web/src/engine/rules/nakedHiddenTriple.ts:130-136` (the Hidden Triple `return`)
- Test: `web/src/engine/rules/nakedHiddenTriple.test.ts`

- [ ] **Step 1: Add a failing assertion**

In `web/src/engine/rules/nakedHiddenTriple.test.ts`, in the test
`'asHints: hidden triple returns hint with correct shape'`, after the line
`expect(hints[0]!.placement).toBeNull();`, add:

```typescript
    // secondaryHighlightCells covers the rest of the unit, not the hidden-triple cells
    expect(hints[0]!.secondaryHighlightCells).toHaveLength(6);
    expect(hints[0]!.secondaryHighlightCells!.every(([r, c]) => !(r === 0 && [0, 1, 2].includes(c)))).toBe(true);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/engine/rules/nakedHiddenTriple.test.ts`
Expected: FAIL — `hints[0]!.secondaryHighlightCells` is `undefined`.

- [ ] **Step 3: Update the Hidden Triple `return` in `nakedHiddenTriple.ts`**

The Hidden Triple branch's `return` currently reads:

```typescript
      return [{
        ruleName: this.name, displayName: 'Hidden Triple',
        explanation: `Hidden Triple: {${digits.join(',')}} are confined to ${tripleCells.map(c => cellLabel(c)).join(', ')} within ${unitLabel(ctx.unit)}. Remove all other candidates from these cells.`,
        highlightCells: [...tripleCells, ...elims.map(e => e.cell)],
        eliminations: elims, placement: null, virtualCageSuggestion: null,
        patternDigits: digits,
      }];
```

Change it to:

```typescript
      return [{
        ruleName: this.name, displayName: 'Hidden Triple',
        explanation: `Hidden Triple: {${digits.join(',')}} are confined to ${tripleCells.map(c => cellLabel(c)).join(', ')} within ${unitLabel(ctx.unit)}. Remove all other candidates from these cells.`,
        highlightCells: [...tripleCells, ...elims.map(e => e.cell)],
        secondaryHighlightCells: cells.filter(([pr, pc]) => !tripleCells.some(([qr, qc]) => qr === pr && qc === pc)),
        eliminations: elims, placement: null, virtualCageSuggestion: null,
        patternDigits: digits,
      }];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/engine/rules/nakedHiddenTriple.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/rules/nakedHiddenTriple.ts web/src/engine/rules/nakedHiddenTriple.test.ts
git commit -m "feat: NakedHiddenTriple Hidden Triple pale-blue highlight for unit context (issue #153)"
```

---

### Task 7: NakedHiddenQuad (Hidden Quad branch) — add `secondaryHighlightCells`

**Files:**
- Modify: `web/src/engine/rules/nakedHiddenQuad.ts:130-136` (the Hidden Quad `return`)
- Test: `web/src/engine/rules/nakedHiddenQuad.test.ts`

- [ ] **Step 1: Add a failing assertion**

In `web/src/engine/rules/nakedHiddenQuad.test.ts`, in the test
`'asHints: hidden quad returns hint with correct shape'`, after the line
`expect(hints[0]!.placement).toBeNull();`, add:

```typescript
    // secondaryHighlightCells covers the rest of the unit, not the hidden-quad cells
    expect(hints[0]!.secondaryHighlightCells).toHaveLength(5);
    expect(hints[0]!.secondaryHighlightCells!.every(([r, c]) => !(r === 0 && [0, 1, 2, 3].includes(c)))).toBe(true);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/engine/rules/nakedHiddenQuad.test.ts`
Expected: FAIL — `hints[0]!.secondaryHighlightCells` is `undefined`.

- [ ] **Step 3: Update the Hidden Quad `return` in `nakedHiddenQuad.ts`**

The Hidden Quad branch's `return` currently reads:

```typescript
      return [{
        ruleName: this.name, displayName: 'Hidden Quad',
        explanation: `Hidden Quad: {${digits.join(',')}} are confined to ${quadCells.map(c => cellLabel(c)).join(', ')} within ${unitLabel(ctx.unit)}. Remove all other candidates from these cells.`,
        highlightCells: [...quadCells, ...elims.map(e => e.cell)],
        eliminations: elims, placement: null, virtualCageSuggestion: null,
        patternDigits: digits,
      }];
```

Change it to:

```typescript
      return [{
        ruleName: this.name, displayName: 'Hidden Quad',
        explanation: `Hidden Quad: {${digits.join(',')}} are confined to ${quadCells.map(c => cellLabel(c)).join(', ')} within ${unitLabel(ctx.unit)}. Remove all other candidates from these cells.`,
        highlightCells: [...quadCells, ...elims.map(e => e.cell)],
        secondaryHighlightCells: cells.filter(([pr, pc]) => !quadCells.some(([qr, qc]) => qr === pr && qc === pc)),
        eliminations: elims, placement: null, virtualCageSuggestion: null,
        patternDigits: digits,
      }];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/engine/rules/nakedHiddenQuad.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/rules/nakedHiddenQuad.ts web/src/engine/rules/nakedHiddenQuad.test.ts
git commit -m "feat: NakedHiddenQuad Hidden Quad pale-blue highlight for unit context (issue #153)"
```

---

### Task 8: Documentation and doc hygiene

**Files:**
- Modify: `docs/architecture.md` (around line 838-850)
- Delete: `docs/superpowers/specs/2026-06-15-hidden-tuple-secondary-highlight-design.md`
- Delete: `docs/superpowers/plans/2026-06-15-hidden-tuple-secondary-highlight.md` (this file, once all steps above are checked)

- [ ] **Step 1: Document the new field in `docs/architecture.md`**

The `HintResult` interface listing currently reads (around line 834-844):

```typescript
interface HintResult {
  ruleName:     string;
  displayName:  string;
  explanation:  string;                              // plain English; use cellLabel()
  highlightCells: readonly Cell[];                   // elimination targets only (0-based [row, col])
  eliminations: readonly Elimination[];
  placement:    readonly [number, number, number] | null;  // [row, col, digit] or null
  virtualCageSuggestion: readonly [readonly Cell[], number] | null;
  colourGroups?: readonly ColourGroup[];             // optional — bipartite chain colouring
}
```

Change it to:

```typescript
interface HintResult {
  ruleName:     string;
  displayName:  string;
  explanation:  string;                              // plain English; use cellLabel()
  highlightCells: readonly Cell[];                   // elimination targets only (0-based [row, col])
  eliminations: readonly Elimination[];
  placement:    readonly [number, number, number] | null;  // [row, col, digit] or null
  virtualCageSuggestion: readonly [readonly Cell[], number] | null;
  colourGroups?: readonly ColourGroup[];             // optional — bipartite chain colouring
  secondaryHighlightCells?: readonly Cell[];         // optional — pale-blue unit-context cells
}
```

Then, after the existing `colourGroups` paragraph (ends "...See `CellColour` and
`ColourGroup` in `web/src/engine/hint.ts`."), add a new paragraph:

```markdown
**`secondaryHighlightCells`** gives the unit context for "hidden" deductions
(HiddenSingle, HiddenPair, and the Hidden Triple/Quad branches of
NakedHiddenTriple/NakedHiddenQuad): the rest of `ctx.unit.cells`, excluding the
cells already in `highlightCells`. Rendered as a pale-blue wash underneath the
orange/yellow overlays, so the user sees "this is the unit the deduction is about"
without it competing visually with the actual target cell(s).
```

- [ ] **Step 2: Confirm doc hygiene**

Run:
```bash
ls docs/specs/ docs/superpowers/specs/ docs/plans/ docs/superpowers/plans/ ~/.claude/plans/ 2>/dev/null
```
Confirm the only spec/plan files remaining are the two created for this feature
(the design spec and this plan) — both will be deleted in the next step.

- [ ] **Step 3: Delete the spec and this plan**

```bash
git rm docs/superpowers/specs/2026-06-15-hidden-tuple-secondary-highlight-design.md
git rm docs/superpowers/plans/2026-06-15-hidden-tuple-secondary-highlight.md
```

- [ ] **Step 4: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: document secondaryHighlightCells; remove completed spec/plan (issue #153)"
```

---

### Task 9: Bronze gate and finish

- [ ] **Step 1: Run the bronze gate**

Run: `bash scripts/run-bronze-gate.sh` (from repo root)
Expected: all checks pass (`tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, `npm test`).

- [ ] **Step 2: Invoke `superpowers:finishing-a-development-branch`** to decide how to
  land `feature/hidden-tuple-secondary-highlight` (merge / PR / etc).
