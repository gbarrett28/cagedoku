/**
 * Tests for image/inpImage.ts — OCR image pipeline.
 *
 * Most functions in inpImage.ts depend on OpenCV.js (WASM) which cannot be
 * initialised in the standard Vitest Node.js environment.  Tests that require
 * OpenCV are marked `.todo` and should be ported to a browser-based test
 * harness (e.g. Playwright) when the infrastructure is available.
 */

import { describe, it } from 'vitest';

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
