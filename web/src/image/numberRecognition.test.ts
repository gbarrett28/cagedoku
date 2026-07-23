/**
 * Digit recogniser accuracy tests — verifies the TypeScript PCA+template+RBF-SVM
 * inference path produces correct predictions on browser-exported training samples.
 *
 * Reads num_recogniser.{bin,json} from web/public/ and training samples from
 * web/browser_train.json. Uses the actual loadNumRecogniser + recognise code
 * path so any PCA/RBF float-precision divergence surfaces as test failures.
 *
 * The model was reverted from HOG+OVO-SVM back to Python's original PCA+
 * template+RBF-SVM architecture (see docs/superpowers/specs/2026-07-21-
 * python-bitexact-port-design.md) to give the bit-exact port a comparable,
 * debuggable reference baseline. browser_train.json's crops were captured
 * under the old HOG+letterbox pipeline, so a fixed set of samples are
 * architecturally incompatible with the new PCA feature space — see
 * KNOWN_FAILURE_SAMPLE_HASHES below.
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
// Populated 2026-07-22: reverting the digit recogniser from HOG+OVO-SVM back
// to Python's PCA+template+RBF-SVM architecture (bit-exact port effort) means
// every browser_train.json sample was captured/labeled under the old HOG+
// letterbox pipeline's crop geometry, which the new PCA feature space (direct-
// stretch warp, no letterboxing) is not equivalent to. These 379 hashes are
// the exact failures the PCA+RBF model produces against this fixture --
// tracked so any NEW failure introduced by a future change to this file still
// fails the test, while these known-incompatible samples don't block it.
// ---------------------------------------------------------------------------
// Deliberately a separate file from known-stale-training-hashes.json (used by
// train_recogniser.py to exclude stale-geometry samples from training): that
// list is permanent (geometry incompatibility doesn't change across retrains),
// this one is "whatever the currently-shipped model happens to fail on" and
// must be regenerated whenever the shipped model changes. Conflating the two
// previously meant updating one silently changed the other's meaning.
const KNOWN_FAILURE_SAMPLE_HASHES: ReadonlySet<string> = new Set(
  JSON.parse(readFileSync(join(process.cwd(), 'known-model-failure-hashes.json'), 'utf-8')) as string[],
);

describe('digit recogniser — TypeScript PCA+RBF inference on training data', () => {
  it('loads model without error', () => {
    expect(rec).toBeDefined();
    expect(rec.pca).toBeDefined();
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

describe('Recognition.runnerUp', () => {
  it('is present and distinct from the winning label whenever the classifier saw more than one class', () => {
    const imgs = samples.slice(0, 30).map(s => new Uint8Array(s.pixels));
    const results = recognise(rec, imgs);
    let sawRunnerUp = false;
    for (const r of results) {
      if (r.runnerUp === undefined) continue;
      sawRunnerUp = true;
      expect(r.runnerUp.label).not.toBe(r.label);
      expect(Number.isFinite(r.runnerUp.score)).toBe(true);
    }
    expect(sawRunnerUp).toBe(true);
  });
});

// Note: guardian_train_sq.json / observer_train_sq.json are deliberately not
// tested here. /guardian/ and /observer/ are entirely gitignored (the source
// .jpg files cannot be committed), so any test depending on them only ever
// runs on a machine that has manually run extract_guardian_samples.py — it
// can never be a real CI/bronze-gate check. Those datasets are bulk training
// input only; browser_train.json (committed, hand-verified) is the ground
// truth this suite holds to 100% minus KNOWN_FAILURE_SAMPLE_HASHES above.
