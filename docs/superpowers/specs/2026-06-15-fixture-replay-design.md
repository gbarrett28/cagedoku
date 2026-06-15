# Generic rule-bug fixture replay harness

## Problem

The "rule-bug regression fixtures" test blocks in `nakedSingle.test.ts`,
`twoStringKite.test.ts`, and `uniqueRectangle.test.ts` are copy-pasted, each with
its own `boardFromStallCandidates()` helper that builds a **fake classic spec**
(9 row-cages, ignoring the fixture's real `regions`/`cageTotals`). This is wrong
for killer-cage rules, and none of the 5 rules with `source: 'r2'` fixtures
(CageCandidateFilter, SolutionMapFilter, CageIntersection, HiddenSingle,
UnitPartitionFilter) have a regression block at all.

We need a single, generic harness — usable for any rule — that replays a
`RuleBugFixture` against the real cage geometry and asserts no golden-contradicting
elimination, plus a how-to for debugging when a fixture goes red.

## Scope decision

Per user direction: assume recent attribution fixes (execution-loop /
linear-system) are correct. Since rules are no longer auto-disabled, **the
important thing is that a real bug is reported as a failing test** — which rule
gets blamed in the failure message is secondary. The regression test checks only
`fixture.ruleName`'s own output for violations; it does **not** check for
cross-attribution (a different rule producing the violation). If a fixture is
found where a *different* rule violates (a puzzle-invariant bug), that is
investigated and fixed as its own bug, separately from this harness.

## Design

### 1. `BoardState.restoreCandidates()` (`web/src/engine/boardState.ts`)

```ts
/** Reduce each cell's candidates to exactly the given set, removing the rest. */
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

On `BoardState` (base class) so `KillerBoardState`'s `removeCandidate` override
(cage-solution pruning) runs correctly too.

### 2. `boardFromFixture()` (`web/src/engine/rules/__fixtures__/replay.ts`, new file)

```ts
import { dataToSpec } from '../../../session/specUtils.js';
import { KillerBoardState } from '../../boardState.js';
import type { RuleBugFixture } from '../../../../../shared/src/fixture.js';

export function boardFromFixture(fixture: RuleBugFixture): KillerBoardState {
  const spec = dataToSpec({ regions: fixture.regions, cageTotals: fixture.cageTotals });
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  board.restoreCandidates(fixture.stalledCandidates);
  return board;
}
```

`dataToSpec` is the standard wire-format deserialiser (already reused by
`backtracker.test.ts` importing from `session/` — precedent for engine tests
depending on `session/specUtils.js`). Works uniformly for `puzzleType: 'killer'`
and `'classic'` fixtures (classic fixtures' `regions`/`cageTotals` are valid
`PuzzleSpecData`: 9 row-cages, 45 totals).

### 3. `web/src/engine/rules/__fixtures__/regression.test.ts` (new file)

```ts
import { describe, it, expect } from 'vitest';
import { ruleBugFixtures } from './index.js';
import { boardFromFixture } from './replay.js';
import { defaultRules } from '../index.js';
import { DISABLED_RULES } from '../disabled-rules.js';
import { findTriggerMisses } from '../../triggerValidator.js';

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

`findTriggerMisses` with a single rule generically covers all of that rule's
trigger types (GLOBAL, CELL_DETERMINED, unit-scoped) — broader than the old
GLOBAL-only blocks — while staying cheap (1 rule × 1 board per fixture, ~530
fixtures total).

Applies uniformly to all `source` values (`'issue' | 'r2' | 'trigger-miss'`):
for `trigger-miss` fixtures (never a violation to begin with) this is a cheap
no-op check; for `'issue'`/`'r2'` it's the actual regression gate.

### 4. Remove the 3 duplicated blocks

Delete `boardFromStallCandidates()` and the `describe('<Rule> — rule-bug
regression fixtures')` blocks from `nakedSingle.test.ts`, `twoStringKite.test.ts`,
`uniqueRectangle.test.ts` — superseded by `regression.test.ts`. Verify
`DISABLED_RULES`/`ruleBugFixtures`/`Cell`/`Trigger` imports in those files aren't
used elsewhere in the file before removing them.

### 5. `web/scripts/debug-fixture.ts` — reusable fixture inspector (new file)

Rather than documenting "write a one-off script", add one generic CLI tool that
covers fixture inspection, including the cross-attribution checking that
`regression.test.ts` deliberately doesn't do:

```
cd web && npx vite-node scripts/debug-fixture.ts <name-substring-or-ruleName>
```

For each matching fixture in `ruleBugFixtures` (match on `name` substring or
exact `ruleName`):

- Print fixture metadata (`name`, `ruleName`, `source`, `puzzleType`,
  `unsolvedCells`/`totalCandidates`).
- Build the board with `boardFromFixture()`.
- Run `findTriggerMisses(board, defaultRules().filter(r =>
  !DISABLED_RULES.includes(r.name)), fixture.goldenSolution)` against **all**
  active rules (not just `fixture.ruleName`) and print every violation and miss
  with its `ruleName`/`missedContext`/cells/digits.
- Highlight whether `fixture.ruleName` itself is among the violators (the
  `regression.test.ts` check) vs. only other rules (cross-attribution —
  candidate puzzle-invariant bug, flagged for separate investigation).

This is the one tool used for both "is this fixture's own rule still buggy?" and
"did a different rule/invariant produce this?" — no new script needed per fixture.

### 6. Documentation: how-to for debugging fixtures

Replace the short "Debugging a fixture" paragraph in `docs/architecture.md`
(§ Rule-bug fixture pipeline, added in commit c0166f7) with a fuller how-to:

- How `regression.test.ts` works and what a red test means per `source` value.
- How to run `debug-fixture.ts` and interpret its output, including the
  cross-attribution case.
- Note on `DISABLED_RULES`/`it.skip` interaction.
- Note on the cross-attribution scope decision above (out of scope for the
  generic gate; investigate separately if `debug-fixture.ts` finds one).

## Testing

- `regression.test.ts` itself is the test — running it (~530 cases, mostly
  `it.skip` for disabled rules) is the verification.
- Bronze gate (`tsc` ×2 + `npm test`) must pass.
- Manually confirm: of the 12 `source: 'r2'` fixtures, the test for the
  `SolutionMapFilter-r2-2026-05-29T07-06-49-234Z` fixture passes or fails as
  expected given the prior finding (its own rule's violation — if `SolutionMapFilter`
  itself still violates, the test correctly fails red).
