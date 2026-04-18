/**
 * Tests for image/borderClustering.ts — pure-logic helpers.
 *
 * Covers: boundaryKind, stripFeatures, and clusterBorders with synthetic images.
 * All tests are dependency-free (no OpenCV) and run in the standard Vitest
 * node environment.
 */

import { describe, expect, it } from 'vitest';
import {
  boundaryKind,
  BoundaryKind,
  stripFeatures,
  clusterBorders,
} from './borderClustering.js';
import type { GrayImage } from './borderClustering.js';
import { defaultImagePipelineConfig, subres as cfgSubres } from './config.js';

// ---------------------------------------------------------------------------
// boundaryKind
// ---------------------------------------------------------------------------

describe('boundaryKind', () => {
  it('classifies box boundaries at gapIdx 2 and 5', () => {
    expect(boundaryKind(2)).toBe(BoundaryKind.BOX);
    expect(boundaryKind(5)).toBe(BoundaryKind.BOX);
  });

  it('classifies all other gaps as cell boundaries', () => {
    for (const g of [0, 1, 3, 4, 6, 7]) {
      expect(boundaryKind(g)).toBe(BoundaryKind.CELL);
    }
  });
});

// ---------------------------------------------------------------------------
// stripFeatures
// ---------------------------------------------------------------------------

describe('stripFeatures', () => {
  it('returns all same value for a uniform strip', () => {
    const strip = new Uint8Array(20).fill(128);
    const [p5, p25, p50, avg] = stripFeatures(strip);
    expect(p5).toBeCloseTo(128);
    expect(p25).toBeCloseTo(128);
    expect(p50).toBeCloseTo(128);
    expect(avg).toBeCloseTo(128);
  });

  it('computes correct percentiles for [0,50,100,150,200]', () => {
    // Sorted values: [0, 50, 100, 150, 200], n=5, indices 0-4.
    // p5:  idx = 0.05 * 4 = 0.2  → 0 + 50*0.2 = 10
    // p25: idx = 0.25 * 4 = 1.0  → 50
    // p50: idx = 0.50 * 4 = 2.0  → 100
    // mean = (0+50+100+150+200)/5 = 100
    const strip = new Uint8Array([0, 50, 100, 150, 200]);
    const [p5, p25, p50, avg] = stripFeatures(strip);
    expect(p5).toBeCloseTo(10);
    expect(p25).toBeCloseTo(50);
    expect(p50).toBeCloseTo(100);
    expect(avg).toBeCloseTo(100);
  });

  it('returns all 0 for an all-zero strip', () => {
    const strip = new Uint8Array(10).fill(0);
    expect(stripFeatures(strip)).toEqual([0, 0, 0, 0]);
  });

  it('handles a 2-element strip', () => {
    // sorted [0, 200]; n=2, indices 0..1
    // p5:  idx=0.05*1=0.05 → 0+200*0.05=10
    // p25: idx=0.25*1=0.25 → 0+200*0.25=50
    // p50: idx=0.50*1=0.50 → 0+200*0.50=100
    // mean = (0+200)/2 = 100
    const strip = new Uint8Array([200, 0]); // unsorted input
    const [p5, p25, p50, avg] = stripFeatures(strip);
    expect(p5).toBeCloseTo(10);
    expect(p25).toBeCloseTo(50);
    expect(p50).toBeCloseTo(100);
    expect(avg).toBeCloseTo(100);
  });
});

// ---------------------------------------------------------------------------
// clusterBorders — synthetic image tests
// ---------------------------------------------------------------------------

/** Build a solid-white synthetic GrayImage. */
function whiteImage(size: number): GrayImage {
  return { data: new Uint8Array(size * size).fill(255), size };
}

/**
 * Build a synthetic image where horizontal borders at the specified rowGap
 * indices are dark (cage borders) and everything else is white.
 *
 * The dark band spans the full sampling region around the boundary:
 *   boundary = (gapIdx + 1) * subres
 *   dark band = [boundary - subres/2, boundary + subres/2)
 */
function imageWithDarkHBorders(size: number, subres: number, darkGaps: number[]): GrayImage {
  const data = new Uint8Array(size * size).fill(255);
  const halfBand = (subres / 2) | 0;
  for (const g of darkGaps) {
    const boundary = (g + 1) * subres;
    for (let row = boundary - halfBand; row < boundary + halfBand; row++) {
      if (row < 0 || row >= size) continue;
      for (let col = 0; col < size; col++) {
        data[row * size + col] = 30; // dark ink colour
      }
    }
  }
  return { data, size };
}

describe('clusterBorders', () => {
  const config = defaultImagePipelineConfig();
  const subres = cfgSubres(config); // e.g. 50
  const size = subres * 9;

  it('returns 0.5 for all borders when confidence is all-zero (no anchors)', () => {
    const img = whiteImage(size);
    const conf = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    const [bxProb, byProb] = clusterBorders(img, conf, subres, config.borderClustering);

    for (let c = 0; c < 9; c++)
      for (let g = 0; g < 8; g++)
        expect(bxProb[c][g]).toBe(0.5);
    for (let g = 0; g < 8; g++)
      for (let r = 0; r < 9; r++)
        expect(byProb[g][r]).toBe(0.5);
  });

  it('classifies clearly dark horizontal borders as cage borders when anchored', () => {
    // Cage total at row=1, col=1 → anchors the horizontal border above it (gapIdx=0).
    // Make all horizontal borders at gapIdx=0 dark; everything else white.
    const img = imageWithDarkHBorders(size, subres, [0, 1, 2, 3, 4, 5, 6, 7]);

    // Confidence anchors: high confidence at row=1, col=1 through row=8, col=1.
    const conf = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    // Cage total cells in row 1 have high confidence — anchors horizontal borders above them.
    for (let c = 0; c < 9; c++) conf[c][1] = 1.0;

    const [bxProb] = clusterBorders(img, conf, subres, config.borderClustering);

    // All horizontal borders should be identified as cage borders (=1.0)
    // since all borders are equally dark and all anchors point to cage.
    for (let c = 0; c < 9; c++)
      for (let g = 0; g < 8; g++)
        expect(bxProb[c][g]).toBe(1.0);
  });

  it('classifies dark BOX horizontal borders as cage when anchored at those rows', () => {
    // Only the box-boundary horizontal borders are dark (gapIdx 2 and 5).
    const img = imageWithDarkHBorders(size, subres, [2, 5]);

    // cageTotalConfidence is indexed [row][col].
    // Setting row=3 and row=6 (all columns) gives H anchors at gapIdx=2 and 5 respectively
    // (anchorKey(true, row-1, col)), which are in the BOX group and in the dark cluster.
    // This ensures polarity resolves to dark=cage (not light=cage).
    const conf = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    conf[3] = new Array<number>(9).fill(1.0); // row=3 → H anchors at gapIdx=2 (BOX, dark)
    conf[6] = new Array<number>(9).fill(1.0); // row=6 → H anchors at gapIdx=5 (BOX, dark)

    const [bxProb] = clusterBorders(img, conf, subres, config.borderClustering);

    // BOX group: H borders at gapIdx=2 and 5 are dark → cage (1.0);
    //            V borders at gapIdx=2 and 5 are white → non-cage (0.0).
    for (let c = 0; c < 9; c++) {
      expect(bxProb[c][2]).toBe(1.0);
      expect(bxProb[c][5]).toBe(1.0);
    }

    // CELL group is not tested here — with all-white CELL features and no clear
    // CELL anchor separation, the polarity is undefined in this scenario.
  });
});
