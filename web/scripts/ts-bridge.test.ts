import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

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

describe('ts-bridge --op predict', () => {
  it('returns a prediction per crop using the currently deployed model', () => {
    const blank = new Array(64 * 64).fill(0);
    const payload = JSON.stringify({ crops: [blank] });
    const out = runBridge(
      ['--op', 'predict',
       '--model-bin', path.resolve(__dirname, '../public/num_recogniser.bin'),
       '--model-json', path.resolve(__dirname, '../public/num_recogniser.json')],
      payload,
    );
    const parsed = JSON.parse(out) as { predictions: Array<{ label: number; confident: boolean }> };
    expect(parsed.predictions).toHaveLength(1);
    expect(typeof parsed.predictions[0]!.label).toBe('number');
  });
});
