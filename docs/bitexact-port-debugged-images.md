# Bit-exact port: debugged corpus images

Tracks specific puzzle images found to fail via `evaluate-corpus.ts` during the
Python bit-exact port effort (`feature/python-bitexact-port`), so every fix can
be regression-checked against everything found so far, not just the one image
that motivated it.

## Re-checking all of them

```bash
cd web
npx vite-node scripts/evaluate-corpus.ts \
  --filter "path IN ('C:\Users\geoff\PycharmProjects\killer_sudoku\guardian\killer_sudoku_0.jpg', 'C:\Users\geoff\PycharmProjects\killer_sudoku\observer\killer_sudoku_255.jpg')" \
  --git-hash "regression-check-$(date +%s)"
```

Use a fresh `--git-hash` every time — `claimEvaluation` skips puzzles already
evaluated for a given hash, so a stale hash silently no-ops.

## Images

| Image | Status | Root cause | Fixed in |
|---|---|---|---|
| `guardian/killer_sudoku_0.jpg` | fixed | `buildCageTotals`'s contour→cell assignment had x/y swapped relative to grid row/col (same axis quirk `_sample_strip` already accounts for in Stage 4) | `323d07d` |
| `observer/killer_sudoku_255.jpg` | fixed | `solve()`/`solveFromCandidates()` built the killer board with `includeVirtualCages: false`, silently disabling derived cage constraints other rules need for pruning | `04162fb` |
| `classic_observer/killer_sudoku_0.jpg` | investigating | notSolved / "no solution found" (classic). Python succeeds (`killer_sudoku.solver.engine.solve()`, not the older `Grid` class) | — |
| `guardian/killer_sudoku_220.jpg` | investigating | notSolved / "ocr warning" (killer). Python succeeds | — |
| `classic_guardian/medium/killer_sudoku_105.jpg` | investigating | notSolved / "no solution found" (classic). Python succeeds | — |

## Notes

- "Python succeeds" was checked via `killer_sudoku.solver.engine.solve()` (the
  coaching-engine port, matching TS's `solve()`) — **not** `killer_sudoku.solver.grid.Grid`,
  an older/different solver architecture that gave misleading "fails" results
  for classic puzzles during this investigation (its `given_digits` seeding
  behaves differently and doesn't reflect real Python behavior for this path).
- Per the design spec, `guardian/killer_sudoku_247.jpg` and
  `guardian/killer_sudoku_275.jpg` are permanently excluded — Python's own
  reference fails on those two, so they're not comparable.
