import { describe, it, expect } from 'vitest';
import { isTrainingExport, isPuzzleSpecExport } from './validate.js';

const validSample = { digit: 3, pixels: new Array<number>(4096).fill(128) };

const validExport = {
  version: 1,
  exportedAt: '2026-05-07T00:00:00.000Z',
  appVersion: '2026-05-07 10:00',
  puzzleType: 'killer',
  subres: 128,
  thumbnailSize: 64,
  sampleCount: 1,
  samples: [validSample],
};

describe('isTrainingExport', () => {
  it('accepts a valid TrainingExport', () => {
    expect(isTrainingExport(validExport)).toBe(true);
  });

  it('accepts puzzleType classic', () => {
    expect(isTrainingExport({ ...validExport, puzzleType: 'classic' })).toBe(true);
  });

  it('accepts zero samples', () => {
    expect(isTrainingExport({ ...validExport, sampleCount: 0, samples: [] })).toBe(true);
  });

  it('rejects null', () => {
    expect(isTrainingExport(null)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isTrainingExport('string')).toBe(false);
  });

  it('rejects wrong version', () => {
    expect(isTrainingExport({ ...validExport, version: 2 })).toBe(false);
  });

  it('rejects unknown puzzleType', () => {
    expect(isTrainingExport({ ...validExport, puzzleType: 'unknown' })).toBe(false);
  });

  it('rejects when sampleCount does not match samples.length', () => {
    expect(isTrainingExport({ ...validExport, sampleCount: 99 })).toBe(false);
  });

  it('rejects missing fields', () => {
    const { samples: _s, ...noSamples } = validExport;
    expect(isTrainingExport(noSamples)).toBe(false);
  });

  it('rejects a sample with digit out of range (negative)', () => {
    expect(isTrainingExport({ ...validExport, samples: [{ digit: -1, pixels: new Array(4096).fill(0) }], sampleCount: 1 })).toBe(false);
  });

  it('rejects a sample with digit out of range (10)', () => {
    expect(isTrainingExport({ ...validExport, samples: [{ digit: 10, pixels: new Array(4096).fill(0) }], sampleCount: 1 })).toBe(false);
  });

  it('rejects a sample with wrong pixel count', () => {
    expect(isTrainingExport({ ...validExport, samples: [{ digit: 1, pixels: new Array(100).fill(0) }], sampleCount: 1 })).toBe(false);
  });

  it('rejects a sample with pixel value out of range (256)', () => {
    expect(isTrainingExport({ ...validExport, samples: [{ digit: 1, pixels: new Array(4096).fill(256) }], sampleCount: 1 })).toBe(false);
  });

  it('rejects a sample with pixel value out of range (negative)', () => {
    expect(isTrainingExport({ ...validExport, samples: [{ digit: 1, pixels: new Array(4096).fill(-1) }], sampleCount: 1 })).toBe(false);
  });

  it('rejects a sample with non-number pixel value', () => {
    const pixels = new Array(4096).fill(0);
    pixels[0] = 'not a number';
    expect(isTrainingExport({ ...validExport, samples: [{ digit: 1, pixels }], sampleCount: 1 })).toBe(false);
  });

  it('rejects a sample with non-array pixels', () => {
    expect(isTrainingExport({ ...validExport, samples: [{ digit: 1, pixels: 'bad' }], sampleCount: 1 })).toBe(false);
  });
});

const validRegions = Array.from({ length: 9 }, (_, r) =>
  Array.from({ length: 9 }, (__, c) => r * 9 + c + 1),
);
const validCageTotals = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
const validBorderX = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(false));
const validBorderY = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false));

const validPuzzleSpec = {
  version: 2,
  exportedAt: '2026-05-09T00:00:00.000Z',
  appVersion: '2026-05-09 12:00',
  puzzleType: 'killer',
  regions: validRegions,
  cageTotals: validCageTotals,
  borderX: validBorderX,
  borderY: validBorderY,
};

describe('isPuzzleSpecExport', () => {
  it('accepts a valid PuzzleSpecExport', () => {
    expect(isPuzzleSpecExport(validPuzzleSpec)).toBe(true);
  });

  it('rejects null', () => {
    expect(isPuzzleSpecExport(null)).toBe(false);
  });

  it('rejects version 1 (TrainingExport)', () => {
    expect(isPuzzleSpecExport({ ...validPuzzleSpec, version: 1 })).toBe(false);
  });

  it('rejects puzzleType classic', () => {
    expect(isPuzzleSpecExport({ ...validPuzzleSpec, puzzleType: 'classic' })).toBe(false);
  });

  it('rejects regions with wrong outer length', () => {
    expect(isPuzzleSpecExport({ ...validPuzzleSpec, regions: Array.from({ length: 8 }, () => new Array<number>(9).fill(1)) })).toBe(false);
  });

  it('rejects regions with wrong inner length', () => {
    expect(isPuzzleSpecExport({ ...validPuzzleSpec, regions: Array.from({ length: 9 }, () => new Array<number>(8).fill(1)) })).toBe(false);
  });

  it('rejects borderX with wrong outer length', () => {
    expect(isPuzzleSpecExport({ ...validPuzzleSpec, borderX: Array.from({ length: 8 }, () => new Array<boolean>(8).fill(false)) })).toBe(false);
  });

  it('rejects borderX with wrong inner length', () => {
    expect(isPuzzleSpecExport({ ...validPuzzleSpec, borderX: Array.from({ length: 9 }, () => new Array<boolean>(9).fill(false)) })).toBe(false);
  });

  it('rejects borderY with wrong outer length', () => {
    expect(isPuzzleSpecExport({ ...validPuzzleSpec, borderY: Array.from({ length: 9 }, () => new Array<boolean>(9).fill(false)) })).toBe(false);
  });

  it('rejects borderX containing non-boolean', () => {
    const badBorderX = validBorderX.map(col => [...col]);
    (badBorderX[0] as unknown as unknown[])[0] = 1;
    expect(isPuzzleSpecExport({ ...validPuzzleSpec, borderX: badBorderX })).toBe(false);
  });

  it('rejects missing fields', () => {
    const { borderY: _b, ...noBy } = validPuzzleSpec;
    expect(isPuzzleSpecExport(noBy)).toBe(false);
  });
});
