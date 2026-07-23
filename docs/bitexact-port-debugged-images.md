# Bit-exact port: debugged corpus images

Tracks specific puzzle images found to fail via `evaluate-corpus.ts` during the
Python bit-exact port effort (`feature/python-bitexact-port`), so every fix can
be regression-checked against everything found so far, not just the one image
that motivated it.

## Re-checking all of them

```bash
cd web
npx vite-node scripts/evaluate-corpus.ts \
  --filter "path IN ('C:\Users\geoff\PycharmProjects\killer_sudoku\guardian\killer_sudoku_0.jpg', 'C:\Users\geoff\PycharmProjects\killer_sudoku\observer\killer_sudoku_255.jpg', 'C:\Users\geoff\PycharmProjects\killer_sudoku\classic_observer\killer_sudoku_0.jpg', 'C:\Users\geoff\PycharmProjects\killer_sudoku\guardian\killer_sudoku_220.jpg', 'C:\Users\geoff\PycharmProjects\killer_sudoku\classic_guardian\medium\killer_sudoku_105.jpg', 'C:\Users\geoff\PycharmProjects\killer_sudoku\observer\killer_sudoku_163.jpg', 'C:\Users\geoff\PycharmProjects\killer_sudoku\observer\killer_sudoku_130.jpg')" \
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
| `classic_guardian/hard/killer_sudoku_441.jpg` | ignored | Python's own reference (`solve()`) also fails to fully solve this one — not comparable, per the design spec's exclusion rule | — |
| `observer/killer_sudoku_163.jpg` | fixed | `topInkRowProfile` used "first nonzero pixel per column" where Python's `split_num` uses `np.argmax` ("row of the strongest pixel per column"). `warpedBlk` isn't strictly binary — `INTER_LINEAR` perspective-warp antialiasing puts a 0-255 continuum at glyph edges — so a faint antialiased fringe pixel could be nonzero one row above a column's true saturated ink, silently desyncing the peak-detection profile from Python's for specific digit shapes. Confirmed via a byte-for-byte dump of the raw `warpedBlk` region: identical pixels on both sides, yet different computed profiles — isolating the bug to this function, not any upstream geometry | `cb89cea` |
| `observer/killer_sudoku_130.jpg` | fixed | Same root cause as `observer/killer_sudoku_163.jpg` above | `cb89cea` |
| `classic_guardian/expert/killer_sudoku_274.jpg` | known limitation | Both puzzles below are **genuinely valid, solvable newspaper puzzles** — confirmed by visually reading the actual printed digit from the warped source photo and re-verifying with an independent brute-force solver — not invalid puzzles. Cell (row=1,col=0) is printed as `2`; both TS and Python misread it as `7`, on a crop confirmed **byte-for-byte identical** between the two (direct pixel diff, 0 differing pixels) — a true, confirmed shared digit-recognizer accuracy limitation (this classifier confuses `2`↔`7` in this font/print style), not a port-fidelity bug. TS faithfully reproduces Python's exact behavior here, mistake included — this *is* what a correct bit-exact port looks like when the thing being ported has its own bug | — |
| `classic_guardian/easy/killer_sudoku_465.jpg` | known limitation | Superficially looks like the same `2↔7` classifier confusion as `expert/274`, but is a **different root cause** — verify crop-identity per cell rather than assuming it from one already-confirmed case. This image's raw grayscale is *not* bit-identical between TS and Python (≈2% of pixels differ by 1 — the documented JPEG-decoder noise, present on some corpus images and absent on others e.g. `observer/163`). That noise survives the shared hard-threshold `blk` computation and produces genuinely different (not identical) crops at both of this image's given-digit disagreement cells: (row=0,col=6) — 658/4096 pixels differ, both engines still misread the printed `2` as `7`; (row=3,col=2) — 631/4096 pixels differ, and here the differing crops land on *opposite* sides of the classifier's decision boundary: TS correctly reads `2`, Python incorrectly reads `7`. Neither is a TS or Python code bug — both trace to the same pre-existing, undocumented-as-a-behavioral-risk JPEG-decode noise, which can occasionally flip a near-boundary classification either direction, not just block the bitcheck stage-comparator as originally documented | — |

## Notes

- "Python succeeds" was checked via `killer_sudoku.solver.engine.solve()` (the
  coaching-engine port, matching TS's `solve()`) — **not** `killer_sudoku.solver.grid.Grid`,
  an older/different solver architecture that gave misleading "fails" results
  for classic puzzles during this investigation (its `given_digits` seeding
  behaves differently and doesn't reflect real Python behavior for this path).
- **"Every cell has exactly one candidate" is not the same claim as "the grid
  is a valid solution."** Checking `all(len(board.candidates[r][c]) == 1 ...)`
  after `solve()` (as done for `guardian/killer_sudoku_220.jpg` and
  `observer/killer_sudoku_255.jpg` earlier in this doc) only proves nothing was
  left ambiguous — it does not prove the singleton values are mutually
  consistent. `classic_guardian/expert/killer_sudoku_274.jpg`'s given-digits
  (as misread — see below) is a confirmed case of `solve()` passing this check
  while returning a grid with duplicate digits in the same row/column. When
  treating Python as ground truth for a *specific puzzle* (not just "did it
  error"), also check row/column/box uniqueness on the returned grid.
- **A given-digit set that brute-force-solves to "no solution" is *not* proof
  the puzzle is invalid — these are real newspaper puzzles and are very
  unlikely to actually be broken.** It far more often means a digit was
  misread. Before concluding a puzzle is genuinely unsolvable/invalid, verify
  the given-digits against the actual printed source image (crop the warped
  color image — `InpImage.warped_img` in Python, the `warpedImageData` field
  in TS — and view it directly) rather than trusting either engine's OCR
  output as ground truth. Both `expert/274` and `easy/465` initially looked
  like invalid/unsolvable puzzles from the OCR'd given-digits alone; both
  turned out to be genuinely solvable once the misread digit was identified
  by eye and corrected, then re-verified independently (a trivial textbook
  brute-force backtracker sharing no code with either engine is enough for
  that verification step).
- Per the design spec, `guardian/killer_sudoku_247.jpg` and
  `guardian/killer_sudoku_275.jpg` are permanently excluded — Python's own
  reference fails on those two, so they're not comparable.
- `bitcheck_diff.py`'s automated stage-by-stage comparator requires an exact
  match at "Stage 1: grayscale image" before it will check any later stage.
  In practice the raw grayscale differs by ±1-2 per pixel between Python's
  `cv2.imread` JPEG decode and the browser's canvas JPEG decode on **some**
  real photos (confirmed absent on others, e.g. `observer/163`/`130` — check
  per-image, don't assume) — this is decoder-implementation noise, not a
  pipeline bug, and it will make `bitcheck_diff.py` report "DIVERGES at Stage
  1" regardless of whether later stages actually match. To check a specific
  later stage (cage_totals, given_digits, regions, …), compare those JSON
  fields directly instead of relying on the stage-ordered tool to reach them.
  This noise is not purely cosmetic: it survives the shared hard-threshold
  `blk` computation and can produce genuinely non-bit-identical digit crops
  (`easy/killer_sudoku_465.jpg` above), occasionally flipping a
  near-decision-boundary classification either direction. Don't infer
  crop-identity for one cell from a confirmed result on a different cell, even
  in the same image — check each one directly.
- The dumped `puzzleType`/`puzzle_type` field is **not** directly comparable:
  Python's is the raw image-pipeline classification (`classic`/`killer` only,
  from `InpImage`). TS's `bitcheck-dump.ts` reports `PuzzleState.kind()`, a
  session-layer value that further splits `classic` into `classic`/`bigapple`
  via `detectBigApple()` (a solver heuristic with no Python equivalent —
  Python has no "Big Apple" concept at all). A `classic` vs `bigapple`
  mismatch against Python's `classic` is not a divergence; what matters is
  whether the puzzle solves, which `evaluate-corpus.ts`'s bucket reports
  directly.
