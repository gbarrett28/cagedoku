/**
 * Digit recogniser accuracy tests — verifies the TypeScript HOG+LinearSVC
 * inference path produces correct predictions on browser-exported training samples.
 *
 * Reads num_recogniser.{bin,json} from web/public/ and training samples from
 * web/browser_train.json.  Uses the actual loadNumRecogniser + recognise code
 * path so any HOG float-precision divergence surfaces as test failures.
 */

import { createHash } from 'node:crypto';
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

function sha256(pixels: number[]): string {
  return createHash('sha256').update(Buffer.from(pixels)).digest('hex');
}

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

/** Failures whose content hash is not in KNOWN_FAILURE_SAMPLE_HASHES -- a regression. */
function unexpectedFailures(subset: TrainingSample[]): string[] {
  const imgs = subset.map(s => new Uint8Array(s.pixels));
  const results = recognise(rec, imgs);
  const unexpected: string[] = [];
  for (let i = 0; i < subset.length; i++) {
    if (results[i]!.label !== subset[i]!.digit) {
      const hash = sha256(subset[i]!.pixels);
      if (!KNOWN_FAILURE_SAMPLE_HASHES.has(hash)) {
        unexpected.push(
          `sample ${i}: expected ${subset[i]!.digit}, got ${results[i]!.label} (hash=${hash})`,
        );
      }
    }
  }
  return unexpected;
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
// can retroactively repair these. Identified by content hash (sha256 of the
// raw pixel array), not array index -- index is not stable across dedup or
// regeneration of this fixture, hash identity is. See docs/image-pipeline.md's
// Training Pipeline section for how this set was captured
// (report-browser-train-failures.ts, before/after the dedup + retrain).
//
// Currently empty: the contour-based bulk-extraction fix (Sprint 3) improved
// the trained model enough that even the previously-hard duplicate-"7" cases
// now classify correctly, and the dedup + retrain (Sprint 4) introduced no
// new failures (verified: 0/8362 pre-dedup, 0/2899 post-dedup). Kept as
// infrastructure rather than removed -- a future browser_train.json export
// could reintroduce genuinely hard cases, and hash identity is the right
// way to track them when that happens.
// ---------------------------------------------------------------------------
const KNOWN_FAILURE_SAMPLE_HASHES: ReadonlySet<string> = new Set([]);

describe('digit recogniser — TypeScript HOG inference on training data', () => {
  it('loads model without error', () => {
    expect(rec).toBeDefined();
    expect(rec.hog).toBeDefined();
    expect(rec.classifier).toBeDefined();
  });

  it('achieves at least total - knownFailures.size accuracy, with no unexpected failures', () => {
    const { correct, total, errors } = runOnSamples(samples);
    const pct = ((correct / total) * 100).toFixed(1);
    if (errors.length > 0) {
      console.error(`\nMispredictions (${errors.length}/${total}):`);
      errors.forEach(e => console.error('  ' + e));
    }
    console.log(`\nAccuracy: ${correct}/${total} (${pct}%)`);

    const unexpected = unexpectedFailures(samples);
    expect(unexpected, `Unexpected new failures (hash not in KNOWN_FAILURE_SAMPLE_HASHES):\n${unexpected.join('\n')}`)
      .toEqual([]);

    const floor = total - KNOWN_FAILURE_SAMPLE_HASHES.size;
    expect(correct, `Expected at least ${floor}/${total} correct; failures:\n${errors.join('\n')}`)
      .toBeGreaterThanOrEqual(floor);
  });

  it('reports per-digit accuracy with no unexpected failures in any digit group', () => {
    const byDigit = new Map<number, TrainingSample[]>();
    for (const s of samples) {
      if (!byDigit.has(s.digit)) byDigit.set(s.digit, []);
      byDigit.get(s.digit)!.push(s);
    }
    const rows: string[] = [];
    const allUnexpected: string[] = [];
    for (const [digit, group] of [...byDigit.entries()].sort((a, b) => a[0] - b[0])) {
      const { correct, total } = runOnSamples(group);
      const pct = ((correct / total) * 100).toFixed(0);
      rows.push(`  digit ${digit}: ${correct}/${total} (${pct}%)`);
      allUnexpected.push(...unexpectedFailures(group));
    }
    console.log('\nPer-digit accuracy:\n' + rows.join('\n'));
    expect(allUnexpected, `Unexpected failures:\n${allUnexpected.join('\n')}`).toEqual([]);
  });
});

// Note: guardian_train_sq.json / observer_train_sq.json are deliberately not
// tested here. /guardian/ and /observer/ are entirely gitignored (the source
// .jpg files cannot be committed), so any test depending on them only ever
// runs on a machine that has manually run extract_guardian_samples.py — it
// can never be a real CI/bronze-gate check. Those datasets are bulk training
// input only; browser_train.json (committed, hand-verified) is the ground
// truth this suite holds to 100%.
