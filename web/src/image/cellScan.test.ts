/**
 * Tests for image/cellScan.ts — computeQuadSums, detectPuzzleType, detectRotation.
 *
 * These functions accept an OpenCVMat but only read .data (Uint8Array) and .cols,
 * so we can exercise them with a plain fake Mat — no OpenCV WASM needed.
 */

import { describe, expect, it } from 'vitest';
import {
  computeQuadSums, detectPuzzleType, detectRotation, isCageTotalContour,
  cageConfFromContours, thresholdMargin, pickBestThreshold, calibrateCageTotalThreshold,
} from './cellScan.js';
import type { ContourMetrics, ThresholdCandidateResult } from './cellScan.js';
import type { GrayImage } from './borderClustering.js';
import { defaultImagePipelineConfig, subres as cfgSubres } from './config.js';
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
// cageConfFromContours
// ---------------------------------------------------------------------------

describe('cageConfFromContours', () => {
  /** Build a 9x9 grid of empty contour lists. */
  function emptyContours(): ContourMetrics[][][] {
    return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => []));
  }

  it('returns all-zero when no cell has any contours', () => {
    const result = cageConfFromContours(emptyContours(), SUBRES_FULL, 0.3);
    for (const row of result) for (const v of row) expect(v).toBe(0);
  });

  it('returns 1.0 for a cell with a real-digit contour (fillRatio 0.81) at threshold 0.3', () => {
    const contours = emptyContours();
    contours[0]![0] = [{ width: 24, height: 30, area: 581 }]; // fillRatio ~0.81
    const result = cageConfFromContours(contours, SUBRES_FULL, 0.3);
    expect(result[0]![0]).toBe(1.0);
    expect(result[0]![1]).toBe(0);
  });

  it('returns 0.0 for a cell with only a dash-segment contour (fillRatio 0.15) at threshold 0.3', () => {
    const contours = emptyContours();
    contours[0]![0] = [{ width: 11, height: 52, area: 84 }]; // fillRatio ~0.15
    const result = cageConfFromContours(contours, SUBRES_FULL, 0.3);
    expect(result[0]![0]).toBe(0);
  });

  it('returns 1.0 for the same dash-segment contour at threshold 0.10 (lower than its fillRatio)', () => {
    const contours = emptyContours();
    contours[0]![0] = [{ width: 11, height: 52, area: 84 }]; // fillRatio ~0.15
    const result = cageConfFromContours(contours, SUBRES_FULL, 0.10);
    expect(result[0]![0]).toBe(1.0);
  });

  it('returns 1.0 if any contour in a cell passes, even if others do not', () => {
    const contours = emptyContours();
    contours[3]![4] = [
      { width: 11, height: 52, area: 84 },   // fillRatio ~0.15, fails at 0.3
      { width: 24, height: 30, area: 581 },  // fillRatio ~0.81, passes at 0.3
    ];
    const result = cageConfFromContours(contours, SUBRES_FULL, 0.3);
    expect(result[3]![4]).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// thresholdMargin
// ---------------------------------------------------------------------------

describe('thresholdMargin', () => {
  function emptyContours(): ContourMetrics[][][] {
    return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => []));
  }

  it('returns Infinity when there are no contours', () => {
    expect(thresholdMargin(emptyContours(), SUBRES_FULL, 0.3)).toBe(Infinity);
  });

  it('returns the distance from threshold to a single contour fillRatio', () => {
    const contours = emptyContours();
    contours[0]![0] = [{ width: 24, height: 30, area: 581 }]; // fillRatio ~0.8069
    const margin = thresholdMargin(contours, SUBRES_FULL, 0.3);
    expect(margin).toBeCloseTo(581 / (24 * 30) - 0.3, 5);
  });

  it('returns the minimum distance across multiple contours', () => {
    const contours = emptyContours();
    // fillRatios: ~0.1615 (dash) and ~0.8069 (digit)
    contours[0]![0] = [{ width: 11, height: 52, area: 84 }];
    contours[0]![1] = [{ width: 24, height: 30, area: 581 }];
    const margin = thresholdMargin(contours, SUBRES_FULL, 0.3);
    const dashRatio = 84 / (11 * 52);
    const digitRatio = 581 / (24 * 30);
    expect(margin).toBeCloseTo(Math.min(Math.abs(dashRatio - 0.3), Math.abs(digitRatio - 0.3)), 5);
  });
});

// ---------------------------------------------------------------------------
// pickBestThreshold
// ---------------------------------------------------------------------------

describe('pickBestThreshold', () => {
  it('returns null when no candidate is valid', () => {
    const results: ThresholdCandidateResult[] = [
      { threshold: 0.1, valid: false, margin: 0.05 },
      { threshold: 0.3, valid: false, margin: 0.20 },
    ];
    expect(pickBestThreshold(results)).toBeNull();
  });

  it('returns the only valid candidate', () => {
    const results: ThresholdCandidateResult[] = [
      { threshold: 0.1, valid: false, margin: 0.20 },
      { threshold: 0.3, valid: true, margin: 0.05 },
    ];
    expect(pickBestThreshold(results)).toBe(0.3);
  });

  it('returns the valid candidate with the largest margin', () => {
    const results: ThresholdCandidateResult[] = [
      { threshold: 0.1, valid: true, margin: 0.05 },
      { threshold: 0.3, valid: true, margin: 0.20 },
      { threshold: 0.5, valid: true, margin: 0.10 },
    ];
    expect(pickBestThreshold(results)).toBe(0.3);
  });

  it('ignores invalid candidates even if they have the largest margin', () => {
    const results: ThresholdCandidateResult[] = [
      { threshold: 0.1, valid: true, margin: 0.05 },
      { threshold: 0.3, valid: false, margin: 0.99 },
    ];
    expect(pickBestThreshold(results)).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// calibrateCageTotalThreshold
// ---------------------------------------------------------------------------

describe('calibrateCageTotalThreshold', () => {
  const config = defaultImagePipelineConfig();
  const subres = cfgSubres(config); // 128
  const size = subres * 9;

  /** All 81 cells have one contour with fillRatio ~0.2 (w=20,h=20,area=80). */
  function uniformContours(): ContourMetrics[][][] {
    return Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, () => [{ width: 20, height: 20, area: 80 }]),
    );
  }

  /**
   * Image where every horizontal AND vertical inter-cell border band is dark
   * (cage-border ink), everything else white.
   */
  function imageWithAllDarkBorders(): GrayImage {
    const data = new Uint8Array(size * size).fill(255);
    const halfBand = (subres / 2) | 0;
    for (let g = 0; g < 8; g++) {
      const boundary = (g + 1) * subres;
      for (let i = boundary - halfBand; i < boundary + halfBand; i++) {
        if (i < 0 || i >= size) continue;
        for (let j = 0; j < size; j++) {
          data[i * size + j] = 30; // horizontal band
          data[j * size + i] = 30; // vertical band
        }
      }
    }
    return { data, size };
  }

  it('picks the lower candidate when it yields a valid 81-cage geometry and the higher does not', () => {
    // At threshold 0.1, fillRatio 0.2 >= 0.1 -> cageConf all 1.0 -> every cell is
    // its own cage head; with all borders dark and all anchors confident,
    // clusterBorders should classify all inner borders as cage walls -> valid.
    // At threshold 0.5, fillRatio 0.2 < 0.5 -> cageConf all 0.0 -> no cage heads
    // at all -> validateCageGeometry returns false (unassigned regions).
    const result = calibrateCageTotalThreshold(
      uniformContours(),
      imageWithAllDarkBorders(),
      subres,
      [0.1, 0.5],
      config.borderClustering,
      config.cellScan.anchorConfidenceThreshold,
      0.3, // fallbackThreshold
    );

    expect(result.fallbackUsed).toBe(false);
    expect(result.threshold).toBe(0.1);
    expect(result.candidateResults).toHaveLength(2);
    expect(result.candidateResults[0]!.threshold).toBe(0.1);
    expect(result.candidateResults[0]!.valid).toBe(true);
    expect(result.candidateResults[0]!.margin).toBeCloseTo(0.1, 5);
    expect(result.candidateResults[1]!.valid).toBe(false);
    for (const row of result.cageConf) for (const v of row) expect(v).toBe(1.0);
  });

  it('falls back to fallbackThreshold when no candidate is valid', () => {
    // fillRatio 0.2 < both 0.4 and 0.5 -> cageConf all 0.0 for both candidates
    // -> validateCageGeometry false for both -> fallback to 0.3.
    const result = calibrateCageTotalThreshold(
      uniformContours(),
      imageWithAllDarkBorders(),
      subres,
      [0.4, 0.5],
      config.borderClustering,
      config.cellScan.anchorConfidenceThreshold,
      0.3, // fallbackThreshold
    );

    expect(result.fallbackUsed).toBe(true);
    expect(result.threshold).toBe(0.3);
    expect(result.candidateResults).toHaveLength(2);
    expect(result.candidateResults.every(c => !c.valid)).toBe(true);
    // fillRatio 0.2 < 0.3 -> cageConf still all 0 at the fallback threshold too.
    for (const row of result.cageConf) for (const v of row) expect(v).toBe(0.0);
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
