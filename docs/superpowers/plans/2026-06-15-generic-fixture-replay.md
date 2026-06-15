# Generic Rule-Bug Fixture Replay Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3 copy-pasted, fake-classic-spec "rule-bug regression fixtures" test blocks with one generic harness that replays any `RuleBugFixture` against its real cage geometry, plus a reusable debug script and a linked how-to doc.

**Architecture:** A `BoardState.restoreCandidates()` method (type-specific candidate restoration) + a `boardFromFixture()` factory (uses `dataToSpec` to deserialise the fixture's real `regions`/`cageTotals`) feed a single `regression.test.ts` that checks, per fixture, whether `fixture.ruleName`'s own rule still produces a golden-contradicting elimination via `findTriggerMisses`. A separate `debug-fixture.ts` CLI runs all active rules against a fixture for manual cross-attribution investigation.

**Tech Stack:** TypeScript, Vitest, vite-node.

---

### Task 1: `BoardState.restoreCandidates()`

**Files:**
- Modify: `web/src/engine/boardState.ts` (add method to `BoardState` class, immediately after `removeCandidate`, which ends at line 165 with `return events;` / `}`)
- Test: `web/src/engine/boardState.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block in `web/src/engine/boardState.test.ts`, immediately after the `describe('removeCandidate', ...)` block that ends at line 178 (before the trailing blank line 179):

```ts
describe('restoreCandidates', () => {
  it('reduces candidates to exactly the given set', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const candidates: number[][][] = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => (r === 0 && c === 0) ? [1, 2, 3] : [...bs.cands(r, c)]));
    bs.restoreCandidates(candidates);
    expect(bs.cands(0, 0)).toEqual(new Set([1, 2, 3]));
  });

  it('is a no-op for cells whose candidates already match', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const before = bs.cands(1, 1).size;
    const candidates: number[][][] = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => [...bs.cands(r, c)]));
    bs.restoreCandidates(candidates);
    expect(bs.cands(1, 1).size).toBe(before);
  });

  it('prunes cage solutions via the KillerBoardState removeCandidate override', () => {
    const bs = new KillerBoardState(makeTrivialSpec());
    const cageIdx = bs.regions[0]![0]!;
    const before = bs.cageSolns[cageIdx]!.length;
    const candidates: number[][][] = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => (r === 0 && c === 0) ? [bs.cands(0, 0).values().next().value!] : [...bs.cands(r, c)]));
    bs.restoreCandidates(candidates);
    expect(bs.cageSolns[cageIdx]!.length).toBeLessThanOrEqual(before);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/engine/boardState.test.ts`
Expected: FAIL — `bs.restoreCandidates is not a function`

- [ ] **Step 3: Implement `restoreCandidates`**

In `web/src/engine/boardState.ts`, inside `class BoardState`, add this method directly after the closing `}` of `removeCandidate` (line 165):

```ts
  /**
   * Reduce candidates[r][c] to exactly the given set for every cell, removing
   * everything else via removeCandidate (so KillerBoardState's cage-solution
   * pruning runs correctly). Used to replay a RuleBugFixture's stalledCandidates
   * onto a freshly constructed board.
   */
  restoreCandidates(candidates: readonly (readonly (readonly number[])[])[]): void {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const keep = new Set(candidates[r]![c]!);
        for (const d of [...this.cands(r, c)]) {
          if (!keep.has(d)) this.removeCandidate(r, c, d);
        }
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/engine/boardState.test.ts`
Expected: PASS (all tests in the file, including the 3 new ones)

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/boardState.test.ts web/src/engine/boardState.ts
git commit -m "feat: add BoardState.restoreCandidates for fixture replay"
```

---

### Task 2: `boardFromFixture()` replay factory

**Files:**
- Create: `web/src/engine/rules/__fixtures__/replay.ts`
- Test: `web/src/engine/rules/__fixtures__/replay.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/engine/rules/__fixtures__/replay.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { boardFromFixture } from './replay.js';
import { ruleBugFixtures } from './index.js';

describe('boardFromFixture', () => {
  it('reproduces the fixture stalled-candidates grid exactly', () => {
    const fixture = ruleBugFixtures[0]!;
    const board = boardFromFixture(fixture);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        expect([...board.cands(r, c)].sort((a, b) => a - b)).toEqual(fixture.stalledCandidates[r]![c]);
      }
    }
  });

  it('builds cage units from the fixture regions (0-based)', () => {
    const fixture = ruleBugFixtures.find(f => f.puzzleType === 'killer');
    if (!fixture) return; // no killer fixtures yet
    const board = boardFromFixture(fixture);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        expect(board.regions[r]![c]).toBe(fixture.regions[r]![c]! - 1);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/engine/rules/__fixtures__/replay.test.ts`
Expected: FAIL — cannot find module `./replay.js`

- [ ] **Step 3: Implement `boardFromFixture`**

Create `web/src/engine/rules/__fixtures__/replay.ts`:

```ts
/**
 * Generic rule-bug fixture replay: reconstructs the exact board state a
 * RuleBugFixture was captured from, using the standard PuzzleSpecData
 * deserialiser (dataToSpec) so killer cage geometry is preserved.
 *
 * See docs/debugging-fixtures.md for how this is used.
 */

import { dataToSpec } from '../../../session/specUtils.js';
import { KillerBoardState } from '../../boardState.js';
import type { RuleBugFixture } from '../../../../../shared/src/fixture.js';

/** Build a KillerBoardState matching the fixture's cage geometry and stalled candidates. */
export function boardFromFixture(fixture: RuleBugFixture): KillerBoardState {
  const spec = dataToSpec({ regions: fixture.regions, cageTotals: fixture.cageTotals });
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  board.restoreCandidates(fixture.stalledCandidates);
  return board;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/engine/rules/__fixtures__/replay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/rules/__fixtures__/replay.ts web/src/engine/rules/__fixtures__/replay.test.ts
git commit -m "feat: add boardFromFixture generic fixture replay factory"
```

---

### Task 3: Generic regression test

**Files:**
- Create: `web/src/engine/rules/__fixtures__/regression.test.ts`

- [ ] **Step 1: Write the test**

Create `web/src/engine/rules/__fixtures__/regression.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ruleBugFixtures } from './index.js';
import { boardFromFixture } from './replay.js';
import { defaultRules } from '../index.js';
import { DISABLED_RULES } from '../disabled-rules.js';
import { findTriggerMisses } from '../../triggerValidator.js';

/**
 * Generic replacement for the per-rule "rule-bug regression fixtures" blocks.
 * For each fixture, replays it with real cage geometry and checks whether
 * fixture.ruleName's own rule still produces a golden-contradicting
 * elimination. See docs/debugging-fixtures.md.
 */
describe('rule-bug fixture regression', () => {
  for (const fixture of ruleBugFixtures) {
    const rule = defaultRules().find(r => r.name === fixture.ruleName);
    const itFixture = !rule || DISABLED_RULES.includes(fixture.ruleName) ? it.skip : it;
    itFixture(`${fixture.name}: ${fixture.ruleName} produces no golden-contradicting elimination`, () => {
      const board = boardFromFixture(fixture);
      const { violations } = findTriggerMisses(board, [rule!], fixture.goldenSolution);
      expect(violations).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run the test and record the result**

Run: `cd web && npx vitest run src/engine/rules/__fixtures__/regression.test.ts`

Expected: most cases PASS or `it.skip`. If any case FAILS, do not "fix" it as part of this plan — record which fixture(s) fail in the commit message / a follow-up note, since per the spec's scope decision, a still-reproducible violation is a real bug to investigate separately (use `debug-fixture.ts` from Task 5 once it exists).

- [ ] **Step 3: Commit**

```bash
git add web/src/engine/rules/__fixtures__/regression.test.ts
git commit -m "feat: add generic rule-bug fixture regression test"
```

---

### Task 4: Remove the 3 duplicated per-rule fixture blocks

**Files:**
- Modify: `web/src/engine/rules/nakedSingle.test.ts`
- Modify: `web/src/engine/rules/twoStringKite.test.ts`
- Modify: `web/src/engine/rules/uniqueRectangle.test.ts`

- [ ] **Step 1: `nakedSingle.test.ts` — remove the regression block and its now-unused imports**

Remove lines 190–247 (everything from the `// ---...` comment header through the end of the file):

```ts
// ---------------------------------------------------------------------------
// Rule-bug regression fixtures (formerly CellSolutionElimination fixtures)
// ---------------------------------------------------------------------------

function boardFromStallCandidates(stalledCandidates: readonly (readonly (readonly number[])[])[]): KillerBoardState {
  const spec = {
    regions: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, () => r + 1)),
    cageTotals: Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, (_, c) => (c === 0 ? 45 : 0))),
    borderX: Array.from({ length: 9 }, () => Array.from({ length: 8 }, () => true)),
    borderY: Array.from({ length: 8 }, () => Array.from({ length: 9 }, () => false)),
  };
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, []);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const keep = new Set(stalledCandidates[r]![c]!);
      const elims: Array<{ cell: Cell; digit: number }> = [];
      for (let d = 1; d <= 9; d++) {
        if (!keep.has(d) && board.cands(r, c).has(d))
          elims.push({ cell: [r, c] as Cell, digit: d });
      }
      if (elims.length) engine.applyEliminations(elims);
    }
  }
  return board;
}

// CellSolutionElimination was merged into NakedSingle; its fixtures are no longer fetched
// by sync-rule-fixtures.js (propagation-rule bugs are caught by the golden check, not here).
const nsFixtures = ruleBugFixtures.filter(f => f.ruleName === 'NakedSingle');
const itNS = DISABLED_RULES.includes('NakedSingle') ? it.skip : it;

if (nsFixtures.length > 0) {
  describe('NakedSingle — rule-bug regression fixtures', () => {
    for (const fixture of nsFixtures) {
      itNS(`${fixture.name}: no elimination contradicts golden solution`, () => {
        const board = boardFromStallCandidates(fixture.stalledCandidates);
        const rule = new NakedSingle();
        for (let r = 0; r < 9; r++) {
          for (let c = 0; c < 9; c++) {
            if (board.cands(r, c).size !== 1) continue;
            const d = [...board.cands(r, c)][0]!;
            const ctx: RuleContext = {
              board, unit: null, cell: [r, c] as Cell,
              hint: Trigger.CELL_DETERMINED, hintDigit: d,
            };
            const result = rule.apply(ctx);
            for (const e of result.eliminations) {
              const [er, ec] = e.cell;
              expect(fixture.goldenSolution[er]![ec]).not.toBe(e.digit);
            }
          }
        }
      });
    }
  });
}
```

Then remove these two now-unused imports (lines 18–19):

```ts
import { DISABLED_RULES } from './disabled-rules.js';
import { ruleBugFixtures } from './__fixtures__/index.js';
```

Keep `SolverEngine`, `KillerBoardState`, `Cell`, `Trigger`, `RuleContext` imports — all are still used elsewhere in the file (e.g. lines 11, 47, 49, 51, 53, 181).

- [ ] **Step 2: `twoStringKite.test.ts` — remove the regression block and its now-unused imports**

Remove lines 136–180 (everything from the `// ---...` comment header through the final `});`):

```ts
// ---------------------------------------------------------------------------
// Regression tests against rule-bug fixtures
// Skipped while TwoStringKite is in DISABLED_RULES; active once the rule is fixed.
// ---------------------------------------------------------------------------

function boardFromStallCandidates(stalledCandidates: readonly (readonly (readonly number[])[])[]): KillerBoardState {
  const spec = {
    regions: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, () => r + 1)),
    cageTotals: Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, (_, c) => (c === 0 ? 45 : 0))),
    borderX: Array.from({ length: 9 }, () => Array.from({ length: 8 }, () => true)),
    borderY: Array.from({ length: 8 }, () => Array.from({ length: 9 }, () => false)),
  };
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, []);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const keep = new Set(stalledCandidates[r]![c]!);
      const elims: Array<{ cell: Cell; digit: number }> = [];
      for (let d = 1; d <= 9; d++) {
        if (!keep.has(d) && board.cands(r, c).has(d))
          elims.push({ cell: [r, c] as Cell, digit: d });
      }
      if (elims.length) engine.applyEliminations(elims);
    }
  }
  return board;
}

const kiteFixtures = ruleBugFixtures.filter(f => f.ruleName === 'TwoStringKite');
const itKite = DISABLED_RULES.includes('TwoStringKite') ? it.skip : it;

describe('TwoStringKite — rule-bug regression fixtures', () => {
  for (const fixture of kiteFixtures) {
    itKite(`${fixture.name}: no elimination contradicts golden solution`, () => {
      const board = boardFromStallCandidates(fixture.stalledCandidates);
      const ctx = { board, unit: null, cell: null, hint: Trigger.GLOBAL, hintDigit: null } as const;
      const result = new TwoStringKite().apply(ctx);
      for (const e of result.eliminations) {
        const [r, c] = e.cell;
        expect(fixture.goldenSolution[r]![c]).not.toBe(e.digit);
      }
    });
  }
});
```

Then remove these two now-unused imports (lines 8–9):

```ts
import { DISABLED_RULES } from './disabled-rules.js';
import { ruleBugFixtures } from './__fixtures__/index.js';
```

Keep `SolverEngine`, `KillerBoardState`, `Cell`, `Trigger` imports — all still used elsewhere in the file (e.g. lines 32, 34, 48–49).

- [ ] **Step 3: `uniqueRectangle.test.ts` — remove the regression block and its now-unused imports**

Remove lines 157–202 (everything from the `// ---...` comment header through the end of the file):

```ts
// ---------------------------------------------------------------------------
// Regression tests against rule-bug fixtures
// Skipped while UniqueRectangle is in DISABLED_RULES; active once the rule is fixed.
// ---------------------------------------------------------------------------

function boardFromStallCandidates(stalledCandidates: readonly (readonly (readonly number[])[])[]): KillerBoardState {
  const spec = {
    regions: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, () => r + 1)),
    cageTotals: Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, (_, c) => (c === 0 ? 45 : 0))),
    borderX: Array.from({ length: 9 }, () => Array.from({ length: 8 }, () => true)),
    borderY: Array.from({ length: 8 }, () => Array.from({ length: 9 }, () => false)),
  };
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  const engine = new SolverEngine(board, []);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const keep = new Set(stalledCandidates[r]![c]!);
      const elims: Array<{ cell: Cell; digit: number }> = [];
      for (let d = 1; d <= 9; d++) {
        if (!keep.has(d) && board.cands(r, c).has(d))
          elims.push({ cell: [r, c] as Cell, digit: d });
      }
      if (elims.length) engine.applyEliminations(elims);
    }
  }
  return board;
}

const urFixtures = ruleBugFixtures.filter(f => f.ruleName === 'UniqueRectangle');
const itUR = DISABLED_RULES.includes('UniqueRectangle') ? it.skip : it;

describe('UniqueRectangle — rule-bug regression fixtures', () => {
  for (const fixture of urFixtures) {
    itUR(`${fixture.name}: no elimination contradicts golden solution`, () => {
      const board = boardFromStallCandidates(fixture.stalledCandidates);
      const ctx: RuleContext = { board, unit: null, cell: null, hint: Trigger.GLOBAL, hintDigit: null };
      const result = new UniqueRectangle().apply(ctx);
      for (const e of result.eliminations) {
        const [r, c] = e.cell;
        expect(fixture.goldenSolution[r]![c]).not.toBe(e.digit);
      }
    });
  }
});
```

Then remove these four now-unused imports (lines 10, 12, 13, 14):

```ts
import type { Cell } from '../types.js';
import { SolverEngine } from '../solverEngine.js';
import { DISABLED_RULES } from './disabled-rules.js';
import { ruleBugFixtures } from './__fixtures__/index.js';
```

Keep `KillerBoardState`, `Trigger`, `RuleContext` imports — all still used elsewhere in the file (e.g. lines 9, 16–18, 22).

- [ ] **Step 4: Run the bronze gate**

Run: `bash scripts/run-bronze-gate.sh`
Expected: PASS — `tsc --noEmit` (both configs) confirms no unused-import / missing-symbol errors from the removed code, and `npm test` passes (the removed coverage is now provided by `regression.test.ts` from Task 3).

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/rules/nakedSingle.test.ts web/src/engine/rules/twoStringKite.test.ts web/src/engine/rules/uniqueRectangle.test.ts
git commit -m "refactor: remove duplicated per-rule fixture regression blocks

Superseded by the generic rule-bug fixture regression test."
```

---

### Task 5: `debug-fixture.ts` reusable inspector

**Files:**
- Create: `web/scripts/debug-fixture.ts`

- [ ] **Step 1: Create the script**

Create `web/scripts/debug-fixture.ts`:

```ts
#!/usr/bin/env vite-node
/**
 * Inspect rule-bug fixture(s): replay against real cage geometry and report
 * which active rules (if any) produce a golden-contradicting elimination,
 * including cross-attribution (a rule other than fixture.ruleName).
 *
 * Usage (from web/):
 *   npx vite-node scripts/debug-fixture.ts <name-substring-or-ruleName>
 *
 * See docs/debugging-fixtures.md.
 */

import { ruleBugFixtures } from '../src/engine/rules/__fixtures__/index.js';
import { boardFromFixture } from '../src/engine/rules/__fixtures__/replay.js';
import { defaultRules } from '../src/engine/rules/index.js';
import { DISABLED_RULES } from '../src/engine/rules/disabled-rules.js';
import { findTriggerMisses } from '../src/engine/triggerValidator.js';

const query = process.argv[2];
if (!query) {
  console.error('Usage: npx vite-node scripts/debug-fixture.ts <name-substring-or-ruleName>');
  process.exit(1);
}

const matches = ruleBugFixtures.filter(f => f.name.includes(query) || f.ruleName === query);
if (matches.length === 0) {
  console.error(`No fixtures match "${query}"`);
  process.exit(1);
}

const activeRules = defaultRules().filter(r => !DISABLED_RULES.includes(r.name));

for (const fixture of matches) {
  console.log(`\n=== ${fixture.name} ===`);
  console.log(`  ruleName: ${fixture.ruleName}, source: ${fixture.source}, puzzleType: ${fixture.puzzleType}`);
  console.log(`  unsolvedCells: ${fixture.unsolvedCells}, totalCandidates: ${fixture.totalCandidates}`);

  const board = boardFromFixture(fixture);
  const { violations, misses } = findTriggerMisses(board, activeRules, fixture.goldenSolution);

  if (violations.length === 0) {
    console.log('  No golden-contradicting eliminations found.');
  } else {
    for (const v of violations) {
      const cross = v.ruleName === fixture.ruleName ? '' : ' (CROSS-ATTRIBUTION: different rule than fixture.ruleName)';
      console.log(`  VIOLATION by ${v.ruleName} at ${v.missedContext}${cross}`);
      for (const e of v.offendingEliminations) {
        console.log(`    cell [${e.cell[0]},${e.cell[1]}] digit ${e.digit}`);
      }
    }
  }

  if (misses.length > 0) {
    console.log(`  ${misses.length} trigger miss(es):`);
    for (const m of misses) {
      console.log(`    ${m.ruleName} at ${m.missedContext}: ${m.eliminations.length} elimination(s)`);
    }
  }
}
```

- [ ] **Step 2: Run it against a known fixture and verify the output is sensible**

Run: `cd web && npx vite-node scripts/debug-fixture.ts SolutionMapFilter-r2-2026-05-29T07-06-49-234Z`
Expected: prints the fixture metadata, then either "No golden-contradicting eliminations found." or one or more `VIOLATION by ...` lines (cross-attribution noted if the violating rule differs from `SolutionMapFilter`).

- [ ] **Step 3: Run the bronze gate**

Run: `bash scripts/run-bronze-gate.sh`
Expected: PASS (`tsc -p tsconfig.node.json --noEmit` must accept the new script — check it follows the same import style as `sync-rule-fixtures.ts`)

- [ ] **Step 4: Commit**

```bash
git add web/scripts/debug-fixture.ts
git commit -m "feat: add debug-fixture.ts generic fixture inspector"
```

---

### Task 6: Documentation

**Files:**
- Create: `docs/debugging-fixtures.md`
- Modify: `docs/architecture.md` (§ Rule-bug fixture pipeline, lines 893–933)

- [ ] **Step 1: Create `docs/debugging-fixtures.md`**

Create `docs/debugging-fixtures.md`:

```markdown
# Debugging rule-bug fixtures

`web/src/engine/rules/__fixtures__/index.ts` holds `RuleBugFixture` entries —
puzzle states where a rule either produced a golden-contradicting elimination
(`source: 'issue' | 'r2'`) or failed to apply a valid one (`source: 'trigger-miss'`).
See `docs/architecture.md` § "Rule-bug fixture pipeline" for how they get there.

## Running the regression test

```bash
cd web && npx vitest run src/engine/rules/__fixtures__/regression.test.ts
```

For each fixture, this replays it on a board built from the fixture's **real**
`regions`/`cageTotals` (via `boardFromFixture()`, which uses the standard
`dataToSpec` deserialiser) and `stalledCandidates`, then runs only
`fixture.ruleName`'s rule across all of its trigger contexts
(`findTriggerMisses`) and asserts it produces **no** elimination that
contradicts `fixture.goldenSolution`.

- A fixture whose rule is in `DISABLED_RULES` (`web/src/engine/rules/disabled-rules.ts`)
  runs as `it.skip`.
- A **red** test means `fixture.ruleName` still produces a golden-contradicting
  elimination on this board — a real, currently-unfixed bug in that rule.
- A `source: 'trigger-miss'` fixture was never a violation to begin with, so
  this check is a cheap sanity pass for those — it isn't expected to catch
  anything new.

## Debugging a specific fixture

```bash
cd web && npx vite-node scripts/debug-fixture.ts <name-substring-or-ruleName>
```

Examples: a fixture's full `name` (e.g. a specific timestamped entry), a
substring of it, or a `ruleName` (e.g. `SolutionMapFilter`, which matches every
fixture for that rule).

For each match, this prints the fixture's metadata, then runs **all active
rules** (not just `fixture.ruleName`) against the replayed board via
`findTriggerMisses` and reports:

- `VIOLATION by <rule> at <context>` — a golden-contradicting elimination.
  If `<rule>` is **not** `fixture.ruleName`, this is flagged
  `CROSS-ATTRIBUTION` — see below.
- Trigger misses — valid eliminations no rule's trigger applied (informational;
  not a correctness bug).

## Cross-attribution

`regression.test.ts` only checks `fixture.ruleName`'s own output. If
`debug-fixture.ts` shows a violation attributed to a **different** rule than
`fixture.ruleName`, that points at a bug in a shared puzzle invariant (e.g. the
linear system or cage-solution pruning) rather than in the named rule —
investigate and fix it as its own issue, separate from the fixture's recorded
`ruleName`.
```

- [ ] **Step 2: Update `docs/architecture.md` § Rule-bug fixture pipeline**

In `docs/architecture.md`, replace step 4 and the "Debugging a fixture" paragraph
(lines 920–933) — i.e. everything from `4. **Regression tests**` through the end
of the "Debugging a fixture" paragraph — with:

```markdown
4. **Regression tests** — `web/src/engine/rules/__fixtures__/regression.test.ts`
   generically replays every fixture (via `boardFromFixture()`, which uses
   `dataToSpec` to preserve the fixture's real cage geometry) and checks that
   `fixture.ruleName`'s rule produces no golden-contradicting elimination.
   While the rule is in `DISABLED_RULES` the case runs as `it.skip`.

See [`docs/debugging-fixtures.md`](./debugging-fixtures.md) for how to run the
regression test and debug a specific fixture (including cross-attribution
checks via `web/scripts/debug-fixture.ts`).
```

- [ ] **Step 3: Run the bronze gate**

Run: `bash scripts/run-bronze-gate.sh`
Expected: PASS

- [ ] **Step 4: Delete this plan and the design spec, then commit everything**

```bash
rm docs/superpowers/plans/2026-06-15-generic-fixture-replay.md
rm docs/superpowers/specs/2026-06-15-fixture-replay-design.md
git add docs/debugging-fixtures.md docs/architecture.md
git add -u docs/superpowers
git commit -m "docs: add fixture-debugging how-to and link from architecture"
```

---

### Task 7: Push and request review

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feature/generic-fixture-replay
```

- [ ] **Step 2: Invoke `superpowers:requesting-code-review`** before merging to `master`, per CLAUDE.md.
