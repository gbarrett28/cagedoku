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

describe('contourIsNumber (matches Python contour_is_number exactly)', () => {
  it('accepts a digit-sized contour at even x/y parity', () => {
    // xx = floor(2*(x + w/2) / subres), yy = floor(2*(y + h/2) / subres); both must be even.
    const br: BRect = [0, 0, 10, 20];
    expect(contourIsNumber(br, SUBRES_FULL)).toBe(true);
  });

  it('rejects an odd-parity y even when width/height are digit-like', () => {
    const br: BRect = [0, 64, 10, 20]; // y=64, h=20 -> yy = floor(2*74/128) = 1 (odd)
    expect(contourIsNumber(br, SUBRES_FULL)).toBe(false);
  });

  it('rejects an odd-parity x even when width/height are digit-like', () => {
    const br: BRect = [64, 0, 10, 20]; // x=64, w=10 -> xx = floor(2*69/128) = 1 (odd)
    expect(contourIsNumber(br, SUBRES_FULL)).toBe(false);
  });

  it('rejects a too-narrow contour regardless of parity', () => {
    const br: BRect = [0, 0, 4, 10];
    expect(contourIsNumber(br, SUBRES_FULL)).toBe(false);
  });

  it('accepts a real digit glyph matching the "20" left-digit reference shape', () => {
    const br: BRect = [0, 0, 24, 30];
    expect(contourIsNumber(br, SUBRES_FULL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getNumContours -- matches Python get_num_contours exactly (no depth requirement)
// ---------------------------------------------------------------------------

function makeNode(br: BRect, area: number, children: ContourInfo[] = []): ContourInfo {
  return [[], br, area, children];
}

describe('getNumContours (matches Python — no hierarchy-depth requirement)', () => {
  it('accepts a digit-sized contour nested at depth 2 inside a cell frame', () => {
    // guardian/killer_sudoku_0.jpg r8c0's real total digit, br=[30,1024,15,32].
    const digit = makeNode([30, 1024, 15, 32], 262.5);
    const cellFrame = makeNode([0, 1024, 123, 123], 14600, [digit]);
    const outerGrid = makeNode([0, 0, 1152, 1152], 1324801, [cellFrame]);
    expect(getNumContours([outerGrid], SUBRES_FULL)).toEqual([digit]);
  });

  it('still finds a digit nested inside a rejected fragment\'s sibling tree', () => {
    const digit = makeNode([777, 16, 12, 31], 171.5);
    const cellFrame = makeNode([768, 10, 123, 123], 13101.5, [digit]);
    const outerGrid = makeNode([0, 0, 1152, 1152], 1324801, [cellFrame]);
    expect(getNumContours([outerGrid], SUBRES_FULL)).toEqual([digit]);
  });

  it('accepts a merged multi-stroke blob whole, without descending into its strokes', () => {
    // Once a node matches contourIsNumber, it's accepted as a single unit
    // (split into individual digit thumbnails later by splitNum) rather than
    // recursing into its own digit-sized children.
    const stroke = makeNode([799, 147, 9, 22], 134);
    const mergedBlob = makeNode([795, 142, 18, 32], 430, [stroke]);
    const cellFrame = makeNode([768, 133, 123, 126], 12396.5, [mergedBlob]);
    const outerGrid = makeNode([0, 0, 1152, 1152], 1324801, [cellFrame]);
    expect(getNumContours([outerGrid], SUBRES_FULL)).toEqual([mergedBlob]);
  });

  it('rejects the single outer-grid contour itself (never digit-sized)', () => {
    const outerGrid = makeNode([0, 0, 1152, 1152], 1324801);
    expect(getNumContours([outerGrid], SUBRES_FULL)).toEqual([]);
  });
});
