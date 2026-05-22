/**
 * Digit recogniser accuracy tests — verifies the TypeScript HOG+LinearSVC
 * inference path produces correct predictions on browser-exported training samples.
 *
 * Reads num_recogniser.{bin,json} from web/public/ and training samples from
 * web/browser_train.json.  Uses the actual loadNumRecogniser + recognise code
 * path so any HOG float-precision divergence surfaces as test failures.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadNumRecogniser, recognise, squarePadSrc } from './numberRecognition.js';
import type { NumRecogniser } from './numberRecognition.js';

// ---------------------------------------------------------------------------
// squarePadSrc — pure geometry, no OpenCV needed
// ---------------------------------------------------------------------------

describe('squarePadSrc', () => {
  it('square input: corners are unchanged', () => {
    expect(squarePadSrc(10, 20, 30, 30)).toEqual([
      [10, 20], [40, 20], [40, 50], [10, 50],
    ]);
  });

  it('tall input (bh > bw): pads width symmetrically', () => {
    // ax=10, ay=20, bw=10, bh=30 → side=30, cx=15, cy=35
    expect(squarePadSrc(10, 20, 10, 30)).toEqual([
      [0, 20], [30, 20], [30, 50], [0, 50],
    ]);
  });

  it('wide input (bw > bh): pads height symmetrically', () => {
    // ax=10, ay=20, bw=30, bh=10 → side=30, cx=25, cy=25
    expect(squarePadSrc(10, 20, 30, 10)).toEqual([
      [10, 10], [40, 10], [40, 40], [10, 40],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Load model and training data once for the suite
// ---------------------------------------------------------------------------

interface TrainingSample {
  digit: number;
  pixels: number[];
}
interface TrainingFile {
  sampleCount: number;
  samples: TrainingSample[];
}

let rec: NumRecogniser;
let samples: TrainingSample[];

beforeAll(() => {
  const pub = join(process.cwd(), 'public');
  const bin = readFileSync(join(pub, 'num_recogniser.bin'));
  const manifest = JSON.parse(readFileSync(join(pub, 'num_recogniser.json'), 'utf-8'));
  rec = loadNumRecogniser(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), manifest);

  const trainFile: TrainingFile = JSON.parse(
    readFileSync(join(process.cwd(), 'browser_train.json'), 'utf-8'),
  );
  samples = trainFile.samples;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runOnSamples(subset: TrainingSample[]): { correct: number; total: number; errors: string[] } {
  const imgs = subset.map(s => new Uint8Array(s.pixels));
  const results = recognise(rec, imgs);
  let correct = 0;
  const errors: string[] = [];
  for (let i = 0; i < subset.length; i++) {
    if (results[i]!.label === subset[i]!.digit) {
      correct++;
    } else {
      errors.push(`sample ${i}: expected ${subset[i]!.digit}, got ${results[i]!.label} (confident=${results[i]!.confident})`);
    }
  }
  return { correct, total: subset.length, errors };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('digit recogniser — TypeScript HOG inference on training data', () => {
  it('loads model without error', () => {
    expect(rec).toBeDefined();
    expect(rec.hog).toBeDefined();
    expect(rec.classifier).toBeDefined();
  });

  it('achieves 100% accuracy on all training samples', () => {
    const { correct, total, errors } = runOnSamples(samples);
    const pct = ((correct / total) * 100).toFixed(1);
    if (errors.length > 0) {
      console.error(`\nMispredictions (${errors.length}/${total}):`);
      errors.forEach(e => console.error('  ' + e));
    }
    console.log(`\nAccuracy: ${correct}/${total} (${pct}%)`);
    expect(correct, `Expected 100% accuracy; failures:\n${errors.join('\n')}`).toBe(total);
  });

  it('reports per-digit accuracy', () => {
    const byDigit = new Map<number, TrainingSample[]>();
    for (const s of samples) {
      if (!byDigit.has(s.digit)) byDigit.set(s.digit, []);
      byDigit.get(s.digit)!.push(s);
    }
    const rows: string[] = [];
    let allPass = true;
    for (const [digit, group] of [...byDigit.entries()].sort((a, b) => a[0] - b[0])) {
      const { correct, total } = runOnSamples(group);
      const pct = ((correct / total) * 100).toFixed(0);
      rows.push(`  digit ${digit}: ${correct}/${total} (${pct}%)`);
      if (correct < total) allPass = false;
    }
    console.log('\nPer-digit accuracy:\n' + rows.join('\n'));
    expect(allPass).toBe(true);
  });
});
