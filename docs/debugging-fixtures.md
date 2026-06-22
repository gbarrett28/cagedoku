# Debugging rule-bug fixtures

`web/src/engine/rules/__fixtures__/index.ts` holds `RuleBugFixture` entries —
puzzle states where a rule either produced a golden-contradicting elimination
(`source: 'issue' | 'r2'`) or failed to apply a valid one (`source: 'trigger-miss'`).
See `docs/architecture.md` § "Rule-bug fixture pipeline" for how they get there.

## Running the regression test

```bash
cd web && npx vitest run src/engine/rules/__fixtures__/regression.test.ts
```

For each fixture, `boardFromFixture(fixture)` calls `PuzzleState.deserialize(fixture.state)`
to reconstruct the exact `PuzzleState`/`KillerPuzzleState` (full turn history,
`goldenSolution`, and — for killer — `specData`/`cageStates`/`virtualCages`), then
`buildEngine(state, { skipValidation: true })` to rebuild the board exactly as the
live app would at the moment the bug was detected. The test then runs only
`fixture.ruleName`'s rule across all of its trigger contexts
(`findTriggerMisses`) and asserts it produces **no** elimination that
contradicts `state.goldenSolution`.

- A fixture whose rule is in `DISABLED_RULES` (`web/src/engine/rules/disabled-rules.ts`)
  runs as `it.skip`.
- A fixture listed in `KNOWN_FAILING_FIXTURES` (top of `regression.test.ts`) also
  runs as `it.skip` — these are tracked, still-reproducing bugs in the named rule
  itself, kept out of this gate until fixed.
- A **red** test means `fixture.ruleName` still produces a golden-contradicting
  elimination on this board — a real, currently-unfixed bug in that rule.
- A `source: 'trigger-miss'` fixture was never a violation to begin with, so
  this check is a cheap sanity pass for those — it isn't expected to catch
  anything new.
- When `ruleBugFixtures` is empty, the suite contains a single `it.skip`
  placeholder so the test file passes trivially.

## Debugging a specific fixture

```bash
cd web && npx vite-node scripts/debug-fixture.ts <name-substring-or-ruleName>
```

Examples: a fixture's full `name` (e.g. a specific timestamped entry), a
substring of it, or a `ruleName` (e.g. `SolutionMapFilter`, which matches every
fixture for that rule).

For each match, this prints the fixture's metadata, then runs **all active
rules** (not just `fixture.ruleName`) against the replayed board (via
`boardFromFixture()` and `state.goldenSolution`) using `findTriggerMisses` and
reports:

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
