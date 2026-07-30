import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { warpRawDigitCrop } from '../src/image/numberRecognition.js';
import type { OpenCVModule } from '../src/image/opencv.js';
import { loadNodeOpenCv } from './node-opencv.js';

const BRIDGE = path.resolve(__dirname, 'ts-bridge.ts');

function runBridge(args: string[], stdin: string): string {
  // shell: true so 'npx' resolves via PATH lookup on Windows (npx.cmd) as
  // well as POSIX shells, without hardcoding a platform-specific binary name.
  return execFileSync('npx', ['tsx', BRIDGE, ...args], {
    input: stdin,
    encoding: 'utf-8',
    shell: true,
  });
}

describe('ts-bridge --op extract-features', () => {
  it('returns HOG and hole feature vectors of the expected length, one row per crop', () => {
    const blank = new Array(64 * 64).fill(0);
    const payload = JSON.stringify({ crops: [blank, blank] });
    const out = runBridge(['--op', 'extract-features'], payload);
    const parsed = JSON.parse(out) as { hog: number[][]; hole: number[][] };
    expect(parsed.hog).toHaveLength(2);
    expect(parsed.hog[0]).toHaveLength(1764);
    expect(parsed.hole).toHaveLength(2);
    expect(parsed.hole[0]).toHaveLength(5);
  });
});

describe('ts-bridge --op warp-crops', () => {
  let cv: OpenCVModule;

  beforeAll(async () => {
    cv = await loadNodeOpenCv();
  });

  it.each(['stretch', 'letterbox'] as const)(
    'matches direct production %s warping byte-for-byte',
    strategy => {
      const width = 5;
      const height = 3;
      const pixels = [
        0, 0, 255, 0, 0,
        0, 255, 255, 255, 0,
        255, 0, 255, 0, 255,
      ];
      const size = 8;
      const payload = JSON.stringify({
        crops: [{ width, height, pixels }],
        strategy,
        size,
      });

      const out = runBridge(['--op', 'warp-crops'], payload);
      const parsed = JSON.parse(out) as { crops: number[][] };
      const direct = warpRawDigitCrop(cv, {
        x: 0,
        y: 0,
        width,
        height,
        pixels: Uint8Array.from(pixels),
      }, strategy, size);

      expect(parsed.crops).toEqual([Array.from(direct)]);
    },
  );
});

describe('retired ts-bridge operations', () => {
  it.each(['predict', 'solve'])('rejects --op %s as unknown', op => {
    expect(() => runBridge(['--op', op], '{}')).toThrow('Unknown --op');
  });
});
