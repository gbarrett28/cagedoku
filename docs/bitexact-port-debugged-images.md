# Bit-exact port: debugged corpus images

Tracks specific puzzle images found to fail via `evaluate-corpus.ts` during the
Python bit-exact port effort (`feature/python-bitexact-port`), so every fix can
be regression-checked against everything found so far, not just the one image
that motivated it.

## Re-checking all of them

```bash
cd web
npx vite-node scripts/evaluate-corpus.ts \
  --filter "path IN ('C:\Users\geoff\PycharmProjects\killer_sudoku\guardian\killer_sudoku_0.jpg', 'C:\Users\geoff\PycharmProjects\killer_sudoku\observer\killer_sudoku_255.jpg', 'C:\Users\geoff\PycharmProjects\killer_sudoku\classic_observer\killer_sudoku_0.jpg', 'C:\Users\geoff\PycharmProjects\killer_sudoku\guardian\killer_sudoku_220.jpg', 'C:\Users\geoff\PycharmProjects\killer_sudoku\classic_guardian\medium\killer_sudoku_105.jpg')" \
  --git-hash "regression-check-$(date +%s)"
```

Use a fresh `--git-hash` every time — `claimEvaluation` skips puzzles already
evaluated for a given hash, so a stale hash silently no-ops.

## Images

| Image | Status | Root cause | Fixed in |
|---|---|---|---|
| `guardian/killer_sudoku_0.jpg` | fixed | `buildCageTotals`'s contour→cell assignment had x/y swapped relative to grid row/col (same axis quirk `_sample_strip` already accounts for in Stage 4) | `323d07d` |
| `observer/killer_sudoku_255.jpg` | fixed | `solve()`/`solveFromCandidates()` built the killer board with `includeVirtualCages: false`, silently disabling derived cage constraints other rules need for pruning | `04162fb` |
| `classic_observer/killer_sudoku_0.jpg` | fixed | Same root cause as below — a given-digit misread (1↔9) traced to `warpedBlkMat` diverging from Python's crop | `08151fe` |
| `guardian/killer_sudoku_220.jpg` | fixed | Same root cause as below — a missing cage-total contour traced to `warpedBlkMat` diverging from Python's crop | `08151fe` |
| `classic_guardian/medium/killer_sudoku_105.jpg` | fixed | `parsePuzzleImage` discarded `locateGrid`'s binary threshold mat (`blk`) and computed a fresh `adaptiveThreshold` on the warped grayscale for `warpedBlkMat`; Python's `InpImage` instead warps and reuses `locate_grid`'s own `blk` directly. The algorithmic mismatch produced different crop pixels feeding the digit classifier | `08151fe` |

## Notes

- "Python succeeds" was checked via `killer_sudoku.solver.engine.solve()` (the
  coaching-engine port, matching TS's `solve()`) — **not** `killer_sudoku.solver.grid.Grid`,
  an older/different solver architecture that gave misleading "fails" results
  for classic puzzles during this investigation (its `given_digits` seeding
  behaves differently and doesn't reflect real Python behavior for this path).
- Per the design spec, `guardian/killer_sudoku_247.jpg` and
  `guardian/killer_sudoku_275.jpg` are permanently excluded — Python's own
  reference fails on those two, so they're not comparable.
- `bitcheck_diff.py`'s automated stage-by-stage comparator requires an exact
  match at "Stage 1: grayscale image" before it will check any later stage.
  In practice the raw grayscale differs by ±1-2 per pixel between Python's
  `cv2.imread` JPEG decode and the browser's canvas JPEG decode on essentially
  every real photo — this is decoder-implementation noise, not a pipeline bug,
  and it will make `bitcheck_diff.py` report "DIVERGES at Stage 1" for nearly
  every real corpus image regardless of whether later stages actually match.
  To check a specific later stage (cage_totals, given_digits, regions, …),
  compare those JSON fields directly instead of relying on the stage-ordered
  tool to reach them.
- The dumped `puzzleType`/`puzzle_type` field is **not** directly comparable:
  Python's is the raw image-pipeline classification (`classic`/`killer` only,
  from `InpImage`). TS's `bitcheck-dump.ts` reports `PuzzleState.kind()`, a
  session-layer value that further splits `classic` into `classic`/`bigapple`
  via `detectBigApple()` (a solver heuristic with no Python equivalent —
  Python has no "Big Apple" concept at all). A `classic` vs `bigapple`
  mismatch against Python's `classic` is not a divergence; what matters is
  whether the puzzle solves, which `evaluate-corpus.ts`'s bucket reports
  directly.
