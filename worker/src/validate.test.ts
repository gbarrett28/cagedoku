import { describe, it, expect } from 'vitest';
import { isTrainingExport } from './validate.js';

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
