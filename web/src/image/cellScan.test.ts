/**
 * Tests for image/cellScan.ts — computeQuadSums, detectPuzzleType, detectRotation.
 *
 * These functions accept an OpenCVMat but only read .data (Uint8Array) and .cols,
 * so we can exercise them with a plain fake Mat — no OpenCV WASM needed.
 */

import { describe, expect, it } from 'vitest';
import { computeQuadSums, detectPuzzleType, detectRotation, isCageTotalContour } from './cellScan.js';
import type { OpenCVMat } from './opencv.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUBRES = 6;               // margin=1, inner=4, halfInner=2
const IMG_SIZE = 9 * SUBRES;   // 54 pixels per side

function fakeMat(data: Uint8Array): OpenCVMat {
  return {
    rows: IMG_SIZE,
    cols: IMG_SIZE,
    data,
    data32S: new Int32Array(0),
    data32F: new Float32Array(0),
    channels: () => 1,
    roi: () => { throw new Error('not implemented'); },
    clone: () => { throw new Error('not implemented'); },
    delete: () => {},
  };
}

function allWhiteMat(): OpenCVMat {
  return fakeMat(new Uint8Array(IMG_SIZE * IMG_SIZE).fill(255));
}

function allBlackMat(): OpenCVMat {
  return fakeMat(new Uint8Array(IMG_SIZE * IMG_SIZE).fill(0));
}

/**
 * Mat where only the specified quadrant (0=TL,1=TR,2=BL,3=BR) of each cell's
 * inner patch is black; everything else is white.
 * subres=6 → margin=1, inner=4, halfInner=2.
 */
function quadrantBlackMat(quadrant: 0 | 1 | 2 | 3): OpenCVMat {
  const data = new Uint8Array(IMG_SIZE * IMG_SIZE).fill(255);
  const margin = 1, halfInner = 2;
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const y0 = row * SUBRES + margin;
      const x0 = col * SUBRES + margin;
      const dyStart = quadrant >= 2 ? halfInner : 0;
      const dxStart = quadrant % 2 === 1 ? halfInner : 0;
      for (let dy = dyStart; dy < dyStart + halfInner; dy++) {
        for (let dx = dxStart; dx < dxStart + halfInner; dx++) {
          data[(y0 + dy) * IMG_SIZE + (x0 + dx)] = 0;
        }
      }
    }
  }
  return fakeMat(data);
}

// ---------------------------------------------------------------------------
// isCageTotalContour
// ---------------------------------------------------------------------------

const SUBRES_FULL = 128; // diagnostic values were captured at this subres

describe('isCageTotalContour', () => {
  it('accepts a real digit contour ("20" left digit, fillRatio 0.81)', () => {
    expect(isCageTotalContour(24, 30, 581, SUBRES_FULL, 0.3)).toBe(true);
  });

  it('accepts a real digit contour ("20" right digit, fillRatio 0.50)', () => {
    expect(isCageTotalContour(20, 30, 299.5, SUBRES_FULL, 0.3)).toBe(true);
  });

  it('accepts a real digit contour ("11" first digit, fillRatio 0.53)', () => {
    expect(isCageTotalContour(13, 31, 214, SUBRES_FULL, 0.3)).toBe(true);
  });

  it('accepts a real digit contour ("11" second digit, fillRatio 0.51)', () => {
    expect(isCageTotalContour(14, 30, 214.5, SUBRES_FULL, 0.3)).toBe(true);
  });

  it('rejects a dashed border-line segment (fillRatio 0.15) despite passing size check', () => {
    expect(isCageTotalContour(11, 52, 84, SUBRES_FULL, 0.3)).toBe(false);
  });

  it('rejects a contour outside the size range regardless of fill ratio', () => {
    // width=5 is below minW (subres >> 4 = 8), even with a solid fill
    expect(isCageTotalContour(5, 20, 100, SUBRES_FULL, 0.3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeQuadSums
// ---------------------------------------------------------------------------

describe('computeQuadSums', () => {
  it('all-white image gives [0,0,0,0] (no ink)', () => {
    expect(computeQuadSums(allWhiteMat(), SUBRES)).toEqual([0, 0, 0, 0]);
  });

  it('all-black image gives equal non-zero quads', () => {
    const [tl, tr, bl, br] = computeQuadSums(allBlackMat(), SUBRES);
    expect(tl).toBeGreaterThan(0);
    expect(tl).toBeCloseTo(tr!);
    expect(tl).toBeCloseTo(bl!);
    expect(tl).toBeCloseTo(br!);
  });

  it('TL-only black makes tl >> other quads', () => {
    const [tl, tr, bl, br] = computeQuadSums(quadrantBlackMat(0), SUBRES);
    expect(tl).toBeGreaterThan(0);
    expect(tr).toBe(0);
    expect(bl).toBe(0);
    expect(br).toBe(0);
  });

  it('TR-only black makes tr >> other quads', () => {
    const [tl, tr, bl, br] = computeQuadSums(quadrantBlackMat(1), SUBRES);
    expect(tl).toBe(0);
    expect(tr).toBeGreaterThan(0);
    expect(bl).toBe(0);
    expect(br).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectPuzzleType
// ---------------------------------------------------------------------------

describe('detectPuzzleType', () => {
  it('all-white image (no ink, total=0) returns killer', () => {
    expect(detectPuzzleType(allWhiteMat(), SUBRES, 0.5)).toBe('killer');
  });

  it('uniform ink (equal quads, maxFraction=0.25) returns classic', () => {
    expect(detectPuzzleType(allBlackMat(), SUBRES, 0.5)).toBe('classic');
  });

  it('TL-dominant ink (maxFraction=1.0) returns killer', () => {
    expect(detectPuzzleType(quadrantBlackMat(0), SUBRES, 0.5)).toBe('killer');
  });

  it('threshold boundary: maxFraction exactly at threshold returns killer', () => {
    // Uniform ink → maxFraction = 0.25; threshold = 0.25 → killer
    expect(detectPuzzleType(allBlackMat(), SUBRES, 0.25)).toBe('killer');
  });
});

// ---------------------------------------------------------------------------
// detectRotation
// ---------------------------------------------------------------------------

describe('detectRotation', () => {
  it('all-white image (total=0) returns 0', () => {
    expect(detectRotation(allWhiteMat(), SUBRES, 0.5)).toBe(0);
  });

  it('uniform ink (dominant=TL quadrant 0) returns 0 regardless of dominance', () => {
    // All quads equal → dominant index = 0 (first wins) → always returns 0
    expect(detectRotation(allBlackMat(), SUBRES, 0.5)).toBe(0);
  });

  it('TR-dominant (quadrant 1) above threshold returns rot90_k=1', () => {
    expect(detectRotation(quadrantBlackMat(1), SUBRES, 0.5)).toBe(1);
  });

  it('BL-dominant (quadrant 2) above threshold returns rot90_k=3', () => {
    expect(detectRotation(quadrantBlackMat(2), SUBRES, 0.5)).toBe(3);
  });

  it('BR-dominant (quadrant 3) above threshold returns rot90_k=2', () => {
    expect(detectRotation(quadrantBlackMat(3), SUBRES, 0.5)).toBe(2);
  });

  it('TR-dominant but below threshold returns 0', () => {
    expect(detectRotation(quadrantBlackMat(1), SUBRES, 1.1)).toBe(0);
  });
});
