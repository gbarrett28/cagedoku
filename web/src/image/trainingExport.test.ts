import { describe, it, expect, vi } from 'vitest';
import { extractTrainingData } from './trainingExport.js';

describe('extractTrainingData', () => {
  function cageGrid(row: number, col: number, total: number): number[][] {
    const g = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    g[row]![col] = total;
    return g;
  }

  function sourceCrop(x: number, y: number, width: number, height: number, fill: number) {
    return { x, y, width, height, pixels: new Uint8Array(width * height).fill(fill) };
  }

  it('exports schema-v2 raw and deployed evidence for a single digit', () => {
    const recognitionPixels = new Uint8Array(64 * 64).fill(128);
    const thumbs = new Map([['0,0', [recognitionPixels]]]);
    const sources = new Map([['0,0', [sourceCrop(7, 11, 3, 2, 42)]]]);
    const exp = extractTrainingData(thumbs, sources, cageGrid(0, 0, 5), 'killer', 28, 'letterbox');

    expect(exp.schemaVersion).toBe(2);
    expect(exp.sampleCount).toBe(1);
    expect(exp.samples[0]).toEqual({
      digit: 5,
      sourceRect: [7, 11, 3, 2],
      sourceWidth: 3,
      sourceHeight: 2,
      sourcePixels: [42, 42, 42, 42, 42, 42],
      recognitionPixels: Array.from(recognitionPixels),
      warpStrategy: 'letterbox',
    });
  });

  it('keeps raw crops, thumbnails, and digit indexes aligned for a two-digit total', () => {
    const px1 = new Uint8Array(64 * 64).fill(10);
    const px2 = new Uint8Array(64 * 64).fill(20);
    const thumbs = new Map([['0,3', [px1, px2]]]);
    const sources = new Map([['0,3', [sourceCrop(4, 5, 2, 3, 1), sourceCrop(6, 5, 4, 3, 2)]]]);
    const exp = extractTrainingData(thumbs, sources, cageGrid(0, 3, 15), 'killer', 28, 'letterbox');

    expect(exp.samples.map(sample => sample.digit)).toEqual([1, 5]);
    expect(exp.samples.map(sample => sample.sourceRect)).toEqual([[4, 5, 2, 3], [6, 5, 4, 3]]);
    expect(exp.samples.map(sample => sample.recognitionPixels[0])).toEqual([10, 20]);
  });

  it('skips cells where total is 0', () => {
    const thumbs = new Map([['2,2', [new Uint8Array(64 * 64)]]]);
    const sources = new Map([['2,2', [sourceCrop(1, 1, 1, 1, 255)]]]);
    const empty = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    const exp = extractTrainingData(thumbs, sources, empty, 'killer', 28, 'letterbox');
    expect(exp.sampleCount).toBe(0);
  });

  it('skips and warns when digit evidence counts do not align', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const thumbs = new Map([['0,0', [new Uint8Array(64 * 64), new Uint8Array(64 * 64)]]]);
    const sources = new Map([['0,0', [sourceCrop(1, 1, 1, 1, 255)]]]);
    const exp = extractTrainingData(thumbs, sources, cageGrid(0, 0, 15), 'killer', 28, 'letterbox');
    expect(exp.sampleCount).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('passes metadata and the selected warp strategy through', () => {
    const exp = extractTrainingData(new Map(), new Map(), cageGrid(0, 0, 0), 'classic', 32, 'stretch');
    expect(exp.puzzleType).toBe('classic');
    expect(exp.subres).toBe(32);
    expect(exp.reportType).toBe('training-export');
    expect(exp.thumbnailSize).toBe(64);
    expect(exp.schemaVersion).toBe(2);
  });
});
