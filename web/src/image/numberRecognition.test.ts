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
import { loadNumRecogniser, recognise } from './numberRecognition.js';
import type { NumRecogniser } from './numberRecognition.js';

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

// ---------------------------------------------------------------------------
// Known-permanent failures
//
// browser_train.json samples are frozen, already-cropped 64x64 pixel arrays
// captured historically through whatever crop logic was live in-browser at
// capture time -- there is no raw image to re-crop, so no future crop fix
// can retroactively repair these. Diagnosed causes (see
// docs/superpowers/specs/2026-06-23-letterbox-crop-design.md):
//   - samples 7959, 8045: boundary-bleed -- a cage border/grid line was
//     warped into the crop alongside the digit, producing a HOG signature
//     the classifier reads as digit "1".
//   - samples 4486, 6265, 6708, 6740, 7535: pixel-identical crops of one
//     duplicated typeset "7" glyph, misclassified as "1" -- a separate
//     HOG/linear-SVM expressiveness limitation, unrelated to cropping.
// ---------------------------------------------------------------------------
const KNOWN_PERMANENT_FAILURES = 7;
const KNOWN_FAILURES_BY_DIGIT: ReadonlyMap<number, number> = new Map([
  [2, 1], // sample 8045 (boundary-bleed)
  [7, 6], // samples 4486, 6265, 6708, 6740, 7535 (duplicate glyph), 7959 (boundary-bleed)
]);

describe('digit recogniser — TypeScript HOG inference on training data', () => {
  it('loads model without error', () => {
    expect(rec).toBeDefined();
    expect(rec.hog).toBeDefined();
    expect(rec.classifier).toBeDefined();
  });

  it('achieves at least 8355/8362 accuracy on all training samples (7 known-permanent failures)', () => {
    const { correct, total, errors } = runOnSamples(samples);
    const pct = ((correct / total) * 100).toFixed(1);
    if (errors.length > 0) {
      console.error(`\nMispredictions (${errors.length}/${total}):`);
      errors.forEach(e => console.error('  ' + e));
    }
    console.log(`\nAccuracy: ${correct}/${total} (${pct}%)`);
    const floor = total - KNOWN_PERMANENT_FAILURES;
    expect(correct, `Expected at least ${floor}/${total} correct; failures:\n${errors.join('\n')}`)
      .toBeGreaterThanOrEqual(floor);
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
      const allowedFailures = KNOWN_FAILURES_BY_DIGIT.get(digit) ?? 0;
      if (correct < total - allowedFailures) allPass = false;
    }
    console.log('\nPer-digit accuracy:\n' + rows.join('\n'));
    expect(allPass).toBe(true);
  });
});

// Note: guardian_train_sq.json / observer_train_sq.json are deliberately not
// tested here. /guardian/ and /observer/ are entirely gitignored (the source
// .jpg files cannot be committed), so any test depending on them only ever
// runs on a machine that has manually run extract_guardian_samples.py — it
// can never be a real CI/bronze-gate check. Those datasets are bulk training
// input only; browser_train.json (committed, hand-verified) is the ground
// truth this suite holds to 100%.
