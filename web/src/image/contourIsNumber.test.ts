import { describe, expect, it } from 'vitest';
import { contourIsNumber, isDigitSizedContour, getNumContours } from './numberRecognition.js';
import type { BRect, ContourInfo } from './numberRecognition.js';

const SUBRES_FULL = 128; // diagnostic values were captured at this subres

describe('isDigitSizedContour', () => {
  it('accepts a digit-sized blob', () => {
    expect(isDigitSizedContour(10, 20, 128)).toBe(true); // w=10 in [8,64), h=20 in [16,64)
  });

  it('rejects a too-narrow blob (thin border-line bleed)', () => {
    expect(isDigitSizedContour(4, 10, 128)).toBe(false); // w=4 < 8
  });

  it('rejects a too-wide blob (merged two-digit glyph)', () => {
    expect(isDigitSizedContour(70, 10, 128)).toBe(false); // w=70 >= 64
  });

  it('rejects a too-short blob', () => {
    expect(isDigitSizedContour(20, 5, 128)).toBe(false); // h=5 < 16
  });
});

describe('contourIsNumber (pinning the existing behaviour through the refactor)', () => {
  it('accepts a digit-sized contour at an even-parity y', () => {
    // yy = floor(2*(y + h/2) / subres) must be even. subres=128, h=20 -> y=0: yy = floor(2*10/128) = 0 (even)
    const br: BRect = [0, 0, 10, 20];
    expect(contourIsNumber(br, SUBRES_FULL, 120, 0.3)).toBe(true); // fillRatio 120/200 = 0.6
  });

  it('rejects an odd-parity y even when width/height/fill-ratio are digit-like', () => {
    const br: BRect = [0, 64, 10, 20]; // y=64, h=20 -> yy = floor(2*74/128) = 1 (odd)
    expect(contourIsNumber(br, SUBRES_FULL, 120, 0.3)).toBe(false);
  });

  it('rejects a too-narrow contour regardless of parity or fill ratio', () => {
    const br: BRect = [0, 0, 4, 10];
    expect(contourIsNumber(br, SUBRES_FULL, 30, 0.3)).toBe(false); // fillRatio 30/40 = 0.75, still rejected on size
  });

  it('rejects a low-fill-ratio border-corner artifact despite digit-like size and even parity', () => {
    // width=11, height=52, area=84 -> fillRatio ~0.15, the same dashed
    // border-line-segment shape as isCageTotalContour's reference case
    // (cellScan.test.ts). A killer cage's L-shaped border corner produces a
    // contour with this shape when it falls in a non-head cell's top half,
    // and was previously misread as a digit (bug: spurious cage-total
    // duplicate, e.g. observer/killer_sudoku_397.jpg's false "11" at r1c5).
    const br: BRect = [0, 0, 11, 52];
    expect(contourIsNumber(br, SUBRES_FULL, 84, 0.3)).toBe(false);
  });

  it('accepts a real digit glyph matching the "20" left-digit reference fill ratio', () => {
    const br: BRect = [0, 0, 24, 30];
    expect(contourIsNumber(br, SUBRES_FULL, 581, 0.3)).toBe(true); // fillRatio ~0.81
  });
});

// ---------------------------------------------------------------------------
// getNumContours -- depth requirement
// ---------------------------------------------------------------------------

/**
 * RETR_TREE hierarchy for a warped killer-puzzle image: depth 0 is the
 * single outer-grid contour, depth 1 is the 81 per-cell border frames (plus,
 * on images with fragmented border ink, stray non-cell line fragments),
 * depth 2 is genuine digit ink nested inside a cell's frame, depth 3 is a
 * digit's individual strokes nested inside a merged multi-stroke blob.
 * Diagnostic values below are real, from observer/killer_sudoku_397.jpg
 * (the bug) and guardian/killer_sudoku_0.jpg (the regression this guards
 * against).
 */
function makeNode(br: BRect, area: number, children: ContourInfo[] = []): ContourInfo {
  return [[], br, area, children];
}

describe('getNumContours (depth requirement)', () => {
  it('rejects a digit-sized, high-fill-ratio contour at depth 1 (cage-border corner notch, not nested in a cell)', () => {
    // observer/killer_sudoku_397.jpg: the L-shaped "18" cage's corner notch
    // at r1c5, br=[640,135,8,18], fillRatio ~0.65 -- passes contourIsNumber
    // on shape/fill-ratio alone, but sits as a sibling of cell frames
    // (depth 1, a direct child of the outer-grid contour), not nested inside
    // one.
    const depth1Notch = makeNode([640, 135, 8, 18], 93);
    const outerGrid = makeNode([0, 0, 1152, 1152], 1324801, [depth1Notch]);
    expect(getNumContours([outerGrid], SUBRES_FULL, 0.3)).toEqual([]);
  });

  it('accepts a digit-sized contour nested at depth 2 inside a cell frame', () => {
    // guardian/killer_sudoku_0.jpg r8c0's real total digit, br=[30,1024,15,32].
    const digit = makeNode([30, 1024, 15, 32], 262.5);
    const cellFrame = makeNode([0, 1024, 123, 123], 14600, [digit]);
    const outerGrid = makeNode([0, 0, 1152, 1152], 1324801, [cellFrame]);
    expect(getNumContours([outerGrid], SUBRES_FULL, 0.3)).toEqual([digit]);
  });

  it('still finds a depth-2 digit nested inside a rejected depth-1 fragment\'s sibling tree', () => {
    // The depth-1 frame itself is never digit-sized (it's ~123x123), so it's
    // never a candidate match -- but the search must still recurse into its
    // children to find the real digit underneath.
    const digit = makeNode([777, 16, 12, 31], 171.5);
    const cellFrame = makeNode([768, 10, 123, 123], 13101.5, [digit]);
    const outerGrid = makeNode([0, 0, 1152, 1152], 1324801, [cellFrame]);
    expect(getNumContours([outerGrid], SUBRES_FULL, 0.3)).toEqual([digit]);
  });

  it('accepts a depth-2 merged multi-stroke blob whole, without descending into its strokes', () => {
    // Pre-existing behaviour, unaffected by the depth requirement: once a
    // node matches, it's accepted as a single unit (split into individual
    // digit thumbnails later by splitNum) rather than recursing into its
    // own digit-sized children.
    const stroke = makeNode([799, 147, 9, 22], 134);
    const mergedBlob = makeNode([795, 142, 18, 32], 430, [stroke]);
    const cellFrame = makeNode([768, 133, 123, 126], 12396.5, [mergedBlob]);
    const outerGrid = makeNode([0, 0, 1152, 1152], 1324801, [cellFrame]);
    expect(getNumContours([outerGrid], SUBRES_FULL, 0.3)).toEqual([mergedBlob]);
  });

  it('rejects the single outer-grid contour itself (depth 0), even though it is never digit-sized', () => {
    const outerGrid = makeNode([0, 0, 1152, 1152], 1324801);
    expect(getNumContours([outerGrid], SUBRES_FULL, 0.3)).toEqual([]);
  });
});
