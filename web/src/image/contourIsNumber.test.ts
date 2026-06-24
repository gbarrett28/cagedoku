import { describe, expect, it } from 'vitest';
import { contourIsNumber, isDigitSizedContour } from './numberRecognition.js';
import type { BRect } from './numberRecognition.js';

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
