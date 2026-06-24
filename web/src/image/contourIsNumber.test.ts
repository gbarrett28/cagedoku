import { describe, expect, it } from 'vitest';
import { contourIsNumber, isDigitSizedContour } from './numberRecognition.js';
import type { BRect } from './numberRecognition.js';

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
    expect(contourIsNumber(br, 128)).toBe(true);
  });

  it('rejects an odd-parity y even when width/height are digit-sized', () => {
    const br: BRect = [0, 64, 10, 20]; // y=64, h=20 -> yy = floor(2*74/128) = 1 (odd)
    expect(contourIsNumber(br, 128)).toBe(false);
  });

  it('rejects a too-narrow contour regardless of parity', () => {
    const br: BRect = [0, 0, 4, 10];
    expect(contourIsNumber(br, 128)).toBe(false);
  });
});
