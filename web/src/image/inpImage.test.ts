/**
 * Tests for image/inpImage.ts — OCR image pipeline.
 *
 * Most functions in inpImage.ts depend on OpenCV.js (WASM) which cannot be
 * initialised in the standard Vitest Node.js environment.  Tests that require
 * OpenCV are marked `.todo` and should be ported to a browser-based test
 * harness (e.g. Playwright) when the infrastructure is available.
 */

import { describe, it, expect } from 'vitest';
import { connectivityScore } from './inpImage.js';

// ---------------------------------------------------------------------------
// buildCageTotals orientation contract (T1)
//
// After the row-major fix, buildCageTotals must store:
//   cageTotals[row][col]  (first index = visual row, second = visual column)
//
// A digit recognised at pixel (x = col*subres, y = row*subres) must land in
// cageTotals[row][col], NOT cageTotals[col][row].
// ---------------------------------------------------------------------------

describe('buildCageTotals — row-major orientation (T1)', () => {
  it.todo(
    'cageTotals[row][col] stores digit from pixel (x=col*subres, y=row*subres)' +
    ' — requires OpenCV WASM; port to Playwright when browser tests are available',
  );

  it.todo(
    'cageTotals[row=3][col=1] is non-zero when digit is centred at' +
    ' y=3.5*subres, x=1.5*subres — requires OpenCV WASM',
  );
});

// ---------------------------------------------------------------------------
// Three-region asymmetric baseline (T2)
//
// Three vertical strips created by walls at colGap=0 and colGap=4:
//   Region A = col 0       (9 cells)
//   Region B = cols 1–4   (36 cells)
//   Region C = cols 5–8   (36 cells)
//
// One cage head per region at a fully off-diagonal position:
//   cageTotals[row=2][col=0] = 15  → Region A
//   cageTotals[row=0][col=3] = 20  → Region B
//   cageTotals[row=1][col=7] = 30  → Region C
//
// Correct row-major read  cageTotals[r][c]:
//   A: BFS cell [c=0,r=2] → cageTotals[2][0]=15 → 1 head  ✓
//   B: BFS cell [c=3,r=0] → cageTotals[0][3]=20 → 1 head  ✓
//   C: BFS cell [c=7,r=1] → cageTotals[1][7]=30 → 1 head  ✓
//   Score = 3
//
// Buggy column-major read  cageTotals[c][r]:
//   A: BFS cell [c=0,r=3] → cageTotals[0][3]=20 → 1 head (B's value misrouted to A)
//   B: BFS cell [c=2,r=0] → cageTotals[2][0]=15 → 1st head
//      BFS cell [c=1,r=7] → cageTotals[1][7]=30 → 2nd head (C's value misrouted to B)
//   C: no cells hit a non-zero entry → 0 heads
//   Score = 1  (only A has exactly 1 head)
// ---------------------------------------------------------------------------

describe('connectivityScore — three-region asymmetric baseline (T2)', () => {
  function threeVerticalRegions(): { borderX: boolean[][]; borderY: boolean[][] } {
    const borderX = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(false));
    const borderY = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false));
    for (let r = 0; r < 9; r++) {
      borderY[0]![r] = true; // wall: col 0 | col 1
      borderY[4]![r] = true; // wall: col 4 | col 5
    }
    return { borderX, borderY };
  }

  it('scores 3 when each region has exactly one off-diagonal head (axis swap: score would be 1)', () => {
    // All heads are at positions where row ≠ col and the transposed coordinate
    // falls in a different region, so this test unambiguously detects the axis swap.
    const { borderX, borderY } = threeVerticalRegions();
    const cageTotals = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    cageTotals[2]![0] = 15; // row=2, col=0 — Region A head
    cageTotals[0]![3] = 20; // row=0, col=3 — Region B head
    cageTotals[1]![7] = 30; // row=1, col=7 — Region C head
    expect(connectivityScore(borderX, borderY, cageTotals)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Bug #29 – connectivityScore reads cageTotals with row/col axes swapped
//
// buildCageTotals produces row-major cageTotals[row][col], but the BFS
// inside connectivityScore accesses cageTotals[c]![r]! (column first).
//
// Setup: place the single cage head at cageTotals[row=0][col=5] — well away
// from the diagonal so the transposition is visibly wrong.
//
// With correct row-major access (cageTotals[r][c]):
//   - All 9 cells in the column-0 region have no head → score contribution 0
//   - The region containing [row=0][col=5] has exactly one head → score = 1
//   Total score = 1
//
// With the buggy column-major access (cageTotals[c][r] = cageTotals[5][0]):
//   - [row=5][col=0] is zero, so that region gets no head → score = 0
//   Total score = 0
// ---------------------------------------------------------------------------

describe('connectivityScore — bug #29: cageTotals axis swap', () => {
  // Build a grid split into two vertical strips by a wall down the entire
  // col=0 | col=1..8 boundary.  borderY[colGap=0][row] = true for all rows.
  //
  //   Region A = col 0 (9 cells)
  //   Region B = cols 1–8 (72 cells)
  //
  // The score counts regions that have exactly one cage total.
  function twoVerticalStrips(): { borderX: boolean[][]; borderY: boolean[][] } {
    const borderX = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(false));
    const borderY = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false));
    // Wall between col=0 and col=1 for every row
    for (let r = 0; r < 9; r++) borderY[0]![r] = true;
    return { borderX, borderY };
  }

  it('scores 2 when each strip has exactly one cage head on the diagonal (axis swap irrelevant)', () => {
    // Heads at (row=0,col=0) and (row=1,col=1) — both on the diagonal so
    // cageTotals[row][col] == cageTotals[col][row]. Axis swap cannot be detected.
    const { borderX, borderY } = twoVerticalStrips();
    const cageTotals = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    cageTotals[0]![0] = 15; // row=0, col=0 — in Region A (col=0)
    cageTotals[1]![1] = 20; // row=1, col=1 — in Region B (col=1..8)
    expect(connectivityScore(borderX, borderY, cageTotals)).toBe(2);
  });

  it('BUG #29: scores 2 when Region A head is at (row=0,col=0) and Region B head is at (row=0,col=1)', () => {
    // Both heads are off the main transpose-symmetric positions relative to each
    // other: head A at (row=0,col=0) is on-diagonal; head B at (row=0,col=1) is
    // off-diagonal — it lives in Region B (cols 1-8).
    //
    // Correct row-major read: cageTotals[r][c]
    //   BFS cell [c=0,r=0] → cageTotals[0][0] = 15 → Region A gets 1 head  ✓
    //   BFS cell [c=1,r=0] → cageTotals[0][1] = 20 → Region B gets 1 head  ✓
    //   Score = 2
    //
    // Buggy column-major read: cageTotals[c][r]
    //   BFS cell [c=0,r=0] → cageTotals[0][0] = 15 → Region A: 1 head  (same, diagonal)
    //   BFS cell [c=0,r=1] → cageTotals[0][1] = 20 → Region A: 2 heads! (should be B's head)
    //   BFS cell [c=1,r=0] → cageTotals[1][0] = 0  → Region B: 0 heads  (missed B's head)
    //   Score = 0 (neither region has exactly 1 head)
    const { borderX, borderY } = twoVerticalStrips();
    const cageTotals = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    cageTotals[0]![0] = 15; // row=0, col=0 — Region A head (on diagonal)
    cageTotals[0]![1] = 20; // row=0, col=1 — Region B head (off diagonal)

    // FAILS with current buggy code: returns 0 instead of 2
    expect(connectivityScore(borderX, borderY, cageTotals)).toBe(2);
  });

  it('BUG #29 complement: scores 2 when Region B head is at (row=1,col=0) stored row-major', () => {
    // Head in Region B at visual position row=1, col=1 but stored at [row=1][col=1].
    // Head in Region A at visual position row=0, col=0 stored at [row=0][col=0].
    // Both are symmetric — correct and buggy reads agree.  Confirms the
    // symmetric case does not expose the bug (unlike the test above).
    const { borderX, borderY } = twoVerticalStrips();
    const cageTotals = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    cageTotals[0]![0] = 15; // Region A, on diagonal
    cageTotals[2]![2] = 20; // Region B, on diagonal
    expect(connectivityScore(borderX, borderY, cageTotals)).toBe(2);
  });
});
