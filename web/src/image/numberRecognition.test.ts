/**
 * Production HOG/hole-feature RBF-SVM accuracy tests.
 *
 * Reads num_recogniser.{bin,json} from web/public/ and training samples from
 * web/corpus_train.json. Uses the actual loadNumRecogniser + recognise path
 * so model-format or inference regressions fail at the deployed boundary.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { activeRecogniser, HogRecogniser, PcaRecogniser, loadNumRecogniser, pcaProject, classMeanProject, centerByCentroid, allowedDigitsForPosition, rbfPredictWithConfidence } from './numberRecognition.js';
import type { NumRecogniser, PcaProjection, ClassMeanReduction, RBFClassifier } from './numberRecognition.js';

// ---------------------------------------------------------------------------
// Load model and training data once for the suite
// ---------------------------------------------------------------------------

interface TrainingSample {
  digit: number;
  pixels?: number[];
  recognitionPixels?: number[];
}
interface TrainingFile {
  sampleCount: number;
  samples: TrainingSample[];
}

let rec: NumRecogniser;
let samples: TrainingSample[];
let KNOWN_FAILURE_SAMPLE_HASHES: ReadonlySet<string>;

beforeAll(() => {
  const pub = join(process.cwd(), 'public');
  const bin = readFileSync(join(pub, 'num_recogniser.bin'));
  const manifest = JSON.parse(readFileSync(join(pub, 'num_recogniser.json'), 'utf-8'));
  rec = loadNumRecogniser(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), manifest);

  const hashesFile = rec instanceof HogRecogniser
    ? 'known-model-failure-hashes-hog.json'
    : 'known-model-failure-hashes-pca_rbf.json';
  KNOWN_FAILURE_SAMPLE_HASHES = new Set(
    JSON.parse(readFileSync(join(process.cwd(), hashesFile), 'utf-8')) as string[],
  );

  const trainFile: TrainingFile = JSON.parse(
    readFileSync(join(process.cwd(), 'corpus_train.json'), 'utf-8'),
  );
  samples = trainFile.samples;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(pixels: number[]): string {
  return createHash('sha256').update(Buffer.from(pixels)).digest('hex');
}


function canonicalPixels(sample: TrainingSample): number[] {
  const pixels = sample.recognitionPixels ?? sample.pixels;
  if (pixels?.length !== 64 * 64) {
    throw new Error('Training sample has no canonical 64x64 recognition pixels');
  }
  return pixels;
}

function runOnSamples(subset: TrainingSample[]): { correct: number; total: number; errors: string[] } {
  const imgs = subset.map(s => new Uint8Array(canonicalPixels(s)));
  const results = rec.recognise(imgs);
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
  const imgs = subset.map(s => new Uint8Array(canonicalPixels(s)));
  const results = rec.recognise(imgs);
  const unexpected: string[] = [];
  for (let i = 0; i < subset.length; i++) {
    if (results[i]!.label !== subset[i]!.digit) {
      const hash = sha256(canonicalPixels(subset[i]!));
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
// corpus_train.json samples are frozen, already-cropped 64x64 pixel arrays
// exported from corpus.db's cell_reads (warp_strategy-tagged, single
// evaluation run) -- there is no raw image to re-crop, so no future crop fix
// can retroactively repair these. Identified by content hash (sha256 of the
// raw pixel array), not array index -- index is not stable across dedup or
// regeneration of this fixture, hash identity is. See
// scripts/_export_corpus_training_data.py and
// killer_sudoku/training/digit_corrections.json for how this set was built
// (report-browser-train-failures.ts, before/after the dedup + retrain).
//
// The HOG/RBF allowlist records the exact samples the currently shipped model
// misclassifies so that any additional failure remains a regression.
// ---------------------------------------------------------------------------
// Deliberately a separate file from known-stale-training-hashes.json (used by
// train_recogniser.py to exclude stale-geometry samples from training): that
// list is permanent (geometry incompatibility doesn't change across retrains),
// this one is "whatever the currently-shipped model happens to fail on" and
// must be regenerated whenever the shipped model changes. Conflating the two
// previously meant updating one silently changed the other's meaning.
// ---------------------------------------------------------------------------
describe('digit recogniser — bundled model inference on training data', () => {
  it('loads model without error', () => {
    expect(rec instanceof HogRecogniser || rec instanceof PcaRecogniser).toBe(true);
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

    // total - KNOWN_FAILURE_SAMPLE_HASHES.size undercounts the floor when
    // multiple samples share a hash (duplicate crop content in
    // browser_train.json): each still counts as one real failure even
    // though its hash only occupies one Set slot. Count samples actually
    // covered by the known-failure set instead of the set's own size.
    const knownCoveredCount = samples.filter(s => KNOWN_FAILURE_SAMPLE_HASHES.has(sha256(canonicalPixels(s)))).length;
    const floor = total - knownCoveredCount;
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
    // Stratified across all 10 digit classes (400 samples/digit, in order)
    // rather than the first 30 -- those are all digit 0, and the PCA
    // recogniser's template fast-path now resolves nearly all of them
    // without falling back to the RBF/runnerUp path, which would make this
    // assertion flaky against future threshold/margin tuning.
    const stratified = Array.from({ length: 10 }, (_, d) => samples.slice(d * 400, d * 400 + 3)).flat();
    const imgs = stratified.map(s => new Uint8Array(canonicalPixels(s)));
    const results = rec.recognise(imgs);
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

// Historical guardian_train_sq.json / observer_train_sq.json bulk datasets are
// deliberately not tested here because neither their gitignored source images nor
// their retired extraction workflow is available in CI. corpus_train.json is the
// committed, corpus.db-sourced ground truth this suite holds to 100% minus
// KNOWN_FAILURE_SAMPLE_HASHES above.

describe('PcaRecogniser template-match candidate restriction', () => {
  // Note: a test asserting that excluding the true digit forces the *final*
  // result into the allowed set belongs in Task 5, not here -- until the RBF
  // fallback also respects allowedLabels, a crop the (correctly, per this
  // task) restricted template stage rejects can still fall through to an
  // unrestricted RBF call that predicts the excluded label anyway. This task
  // only covers the template stage in isolation.
  it('restricting to a singleton set containing only the true digit still confidently resolves it via the template fast path', () => {
    if (!(rec instanceof PcaRecogniser)) return; // this suite is PCA-model-specific
    const zeroSample = samples.find(s => s.digit === 0);
    if (!zeroSample) throw new Error('expected at least one digit-0 sample in corpus_train.json');
    const img = new Uint8Array(canonicalPixels(zeroSample));

    const unrestricted = rec.recognise([img]);
    expect(unrestricted[0]!.label).toBe(0);
    expect(unrestricted[0]!.confident).toBe(true);

    const restricted = rec.recognise([img], [new Set([0])]);
    expect(restricted[0]!.label).toBe(0);
    expect(restricted[0]!.confident).toBe(true);
  });

  it('an undefined entry in allowedLabels leaves that crop unrestricted', () => {
    if (!(rec instanceof PcaRecogniser)) return;
    const zeroSample = samples.find(s => s.digit === 0)!;
    const img = new Uint8Array(canonicalPixels(zeroSample));
    const result = rec.recognise([img], [undefined]);
    expect(result[0]!.label).toBe(0);
  });

  it('recognise() is deterministic when allowedLabels is omitted', () => {
    const zeroSample = samples.find(s => s.digit === 0)!;
    const img = new Uint8Array(canonicalPixels(zeroSample));
    const withParam = rec.recognise([img]);
    const withoutParam = rec.recognise([img]);
    expect(withParam).toEqual(withoutParam);
  });

  it('a crop that needs RBF fallback also respects the restriction end-to-end', () => {
    if (!(rec instanceof PcaRecogniser)) return;
    const nineSample = samples.find(s => s.digit === 9)!;
    const img = new Uint8Array(canonicalPixels(nineSample));
    const restricted = rec.recognise([img], [new Set([0, 1, 2])]);
    expect([0, 1, 2]).toContain(restricted[0]!.label);
  });

  it('a batch with mixed restricted/unrestricted crops resolves each independently', () => {
    if (!(rec instanceof PcaRecogniser)) return;
    const zero = samples.find(s => s.digit === 0)!;
    const one = samples.find(s => s.digit === 1)!;
    const imgs = [new Uint8Array(canonicalPixels(zero)), new Uint8Array(canonicalPixels(one))];
    const results = rec.recognise(imgs, [new Set([5, 6, 7]), undefined]);
    expect([5, 6, 7]).toContain(results[0]!.label);
    expect(results[1]!.label).toBe(1); // unrestricted crop unaffected
  });
});

describe('ovoVote / rbfPredictWithConfidence candidate restriction', () => {
  let classifier: RBFClassifier;

  beforeAll(() => {
    if (!(rec instanceof PcaRecogniser)) throw new Error('expected PCA model in public/');
    classifier = (rec as unknown as { classifier: RBFClassifier }).classifier;
  });

  it('restricting to a singleton class returns it directly with full confidence, no vote computation needed', () => {
    const nFeatures = classifier.nFeatures;
    const x = new Float64Array(nFeatures); // arbitrary all-zero input -- singleton shortcut shouldn't even look at it
    const result = rbfPredictWithConfidence(classifier, x, 1, 0.5, new Set([7]));
    expect(result[0]!.label).toBe(7);
    expect(result[0]!.confident).toBe(true);
  });

  it('an empty allowed set (defensive case) is treated as unrestricted', () => {
    const nFeatures = classifier.nFeatures;
    const x = new Float64Array(nFeatures);
    const restricted = rbfPredictWithConfidence(classifier, x, 1, 0.5, new Set());
    const unrestricted = rbfPredictWithConfidence(classifier, x, 1, 0.5);
    expect(restricted[0]!.label).toBe(unrestricted[0]!.label);
  });
});

describe('allowedDigitsForPosition', () => {
  it('single-digit total: cage size 2 (range [3,17]) restricts to 3-9', () => {
    const allowed = allowedDigitsForPosition(2, 0, 1);
    expect([...allowed].sort()).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it('two-digit total, tens position: cage size 2 (range [3,17]) restricts to {1}', () => {
    // Only 10-17 are 2-digit totals in [3,17]; tens digit is always 1.
    const allowed = allowedDigitsForPosition(2, 0, 2);
    expect([...allowed]).toEqual([1]);
  });

  it('two-digit total, units position: cage size 2 restricts to 0-7', () => {
    // 10..17 -> units digits 0,1,2,3,4,5,6,7
    const allowed = allowedDigitsForPosition(2, 1, 2);
    expect([...allowed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('cage size 9 must total exactly 45: tens={4}, units={5}', () => {
    expect([...allowedDigitsForPosition(9, 0, 2)]).toEqual([4]);
    expect([...allowedDigitsForPosition(9, 1, 2)]).toEqual([5]);
  });

  it('falls back to unrestricted (0-9) when digitCount matches no valid total', () => {
    // Cage size 1's range is [1,9] -- no 2-digit total is possible, so a
    // (wrongly) detected digitCount=2 must not produce an impossible-to-satisfy
    // empty restriction.
    const allowed = allowedDigitsForPosition(1, 0, 2);
    expect([...allowed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('loadNumRecogniser class dispatch', () => {
  it.each(['pca_rbf', 'linear'])('rejects unsupported classifier_type "%s" explicitly', classifierType => {
    expect(() => loadNumRecogniser(new ArrayBuffer(0), {
      classifier_type: classifierType,
      arrays: {},
    })).toThrow(`Unsupported classifier type: ${classifierType}`);
  });

  it.each(['stretch', 'letterbox'] as const)(
    'loads the model warp strategy "%s" for production recognition',
    warpStrategy => {
      const pub = join(process.cwd(), 'public');
      const bin = readFileSync(join(pub, 'num_recogniser.bin'));
      const manifest = JSON.parse(readFileSync(join(pub, 'num_recogniser.json'), 'utf-8'));
      const loaded = loadNumRecogniser(
        bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
        { ...manifest, warp_strategy: warpStrategy },
      );

      expect(loaded.warpStrategy).toBe(warpStrategy);
    },
  );

  it.each([
    [undefined, 'binary'],
    ['binary', 'binary'],
    ['gray', 'gray'],
  ] as const)('loads recognition_input_mode %s as %s', (manifestMode, expected) => {
    const pub = join(process.cwd(), 'public');
    const bin = readFileSync(join(pub, 'num_recogniser.bin'));
    const manifest = JSON.parse(readFileSync(join(pub, 'num_recogniser.json'), 'utf-8'));
    const loaded = loadNumRecogniser(
      bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
      { ...manifest, recognition_input_mode: manifestMode },
    );
    expect(loaded.inputMode).toBe(expected);
  });

  it('rejects an unsupported model recognition input mode', () => {
    const pub = join(process.cwd(), 'public');
    const bin = readFileSync(join(pub, 'num_recogniser.bin'));
    const manifest = JSON.parse(readFileSync(join(pub, 'num_recogniser.json'), 'utf-8'));
    expect(() => loadNumRecogniser(
      bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
      { ...manifest, recognition_input_mode: 'adaptive' },
    )).toThrow('Unsupported recognition input mode: adaptive');
  });

  it('rejects a missing or unsupported model warp strategy', () => {
    expect(() => loadNumRecogniser(new ArrayBuffer(0), {
      classifier_type: 'rbf',
      arrays: {},
    })).toThrow('Unsupported warp strategy: undefined');
    expect(() => loadNumRecogniser(new ArrayBuffer(0), {
      classifier_type: 'rbf',
      warp_strategy: 'diagonal',
      arrays: {},
    })).toThrow('Unsupported warp strategy: diagonal');
  });

  it('throws a clear error from activeRecogniser() before any recogniser is set', () => {
    // This test file never calls setActiveRecogniser -- splitNum/readClassicDigits'
    // real crop behaviour needs a genuine OpenCV.js Mat, which vitest doesn't load
    // (see the plan's note on Playwright covering that instead); this only verifies
    // the guard message itself.
    expect(() => activeRecogniser()).toThrow('No recogniser loaded');
  });
});


describe('PcaRecogniser', () => {
  function buildManifest(templatePixels: number[][], templateLabels: number[]): { buf: ArrayBuffer; manifest: unknown } {
    const arrays: Record<string, { dtype: string; shape: number[]; offset: number; byteLength: number }> = {};
    const chunks: ArrayBufferView[] = [];
    let offset = 0;
    const push = (name: string, arr: Float64Array | Int32Array, shape: number[]): void => {
      arrays[name] = {
        dtype: arr instanceof Int32Array ? 'int32' : 'float64',
        shape, offset, byteLength: arr.byteLength,
      };
      chunks.push(arr);
      offset += arr.byteLength;
    };

    const nFeatures = templatePixels[0]!.length;
    push('rbf_support_vectors', Float64Array.from([0]), [1, 1]);
    push('rbf_dual_coef', Float64Array.from([1]), [1, 1]);
    push('rbf_intercept', Float64Array.from([0]), [1]);
    push('rbf_n_support', Int32Array.from([1]), [1]);
    push('rbf_gamma', Float64Array.from([1]), [1]);
    push('classes', Int32Array.from(templateLabels), [templateLabels.length]);
    push('confidence_threshold', Float64Array.from([0.7]), [1]);
    push('cm_mean_of_means', new Float64Array(nFeatures), [nFeatures]);
    push('cm_between_components', Float64Array.from([1, ...new Array<number>(nFeatures - 1).fill(0)]), [1, nFeatures]);
    push('template_pixels', Float64Array.from(templatePixels.flat()), [templatePixels.length, nFeatures]);
    push('template_labels', Int32Array.from(templateLabels), [templateLabels.length]);

    const buf = new ArrayBuffer(offset);
    const bytes = new Uint8Array(buf);
    let cursor = 0;
    for (const arr of chunks) {
      bytes.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), cursor);
      cursor += arr.byteLength;
    }
    return {
      buf,
      manifest: { classifier_type: 'rbf', recogniser_type: 'pca', warp_strategy: 'letterbox-centered', arrays },
    };
  }

  it('returns a template label directly when a crop matches confidently', () => {
    // Non-constant template patterns so normalized cross-correlation is
    // defined (a constant vector has zero variance, forcing score to 0).
    const { buf, manifest } = buildManifest(
      [[0, 10, 0, 10], [10, 0, 10, 0]],
      [1, 7],
    );
    const loaded = loadNumRecogniser(buf, manifest as Parameters<typeof loadNumRecogniser>[1]);

    expect(loaded).toBeInstanceOf(PcaRecogniser);
    const [result] = loaded.recognise([Uint8Array.from([0, 10, 0, 10])]);

    expect(result).toEqual(expect.objectContaining({ label: 1, confident: true }));
  });
});

describe('pcaProject', () => {
  it('projects (x - mean) onto each component row, per sample', () => {
    const pca: PcaProjection = {
      mean: Float64Array.from([1, 2, 3]),
      components: Float64Array.from([
        1, 0, 0, // component 0 reads off (x - mean)[0]
        0, 1, 0, // component 1 reads off (x - mean)[1]
      ]),
      nComponents: 2,
      nFeatures: 3,
    };
    const x = Float64Array.from([
      2, 4, 6, // sample 0: (x - mean) = [1, 2, 3]
      1, 2, 3, // sample 1: (x - mean) = [0, 0, 0]
    ]);
    expect(Array.from(pcaProject(x, 2, pca))).toEqual([1, 2, 0, 0]);
  });

  it('loads an optional pca_mean/pca_components pair from the manifest', () => {
    const arrays: Record<string, { dtype: string; shape: number[]; offset: number; byteLength: number }> = {};
    const chunks: ArrayBufferView[] = [];
    let offset = 0;
    const push = (name: string, arr: Float64Array | Int32Array, shape: number[]): void => {
      arrays[name] = {
        dtype: arr instanceof Int32Array ? 'int32' : 'float64',
        shape, offset, byteLength: arr.byteLength,
      };
      chunks.push(arr);
      offset += arr.byteLength;
    };
    push('hog_win_size', Int32Array.from([64]), [1]);
    push('hog_cell_size', Int32Array.from([8]), [1]);
    push('hog_block_size', Int32Array.from([16]), [1]);
    push('hog_block_stride', Int32Array.from([8]), [1]);
    push('hog_nbins', Int32Array.from([9]), [1]);
    push('rbf_support_vectors', Float64Array.from([0, 0]), [1, 2]);
    push('rbf_dual_coef', Float64Array.from([1]), [1, 1]);
    push('rbf_intercept', Float64Array.from([0]), [1]);
    push('rbf_n_support', Int32Array.from([1]), [1]);
    push('rbf_gamma', Float64Array.from([1]), [1]);
    push('classes', Int32Array.from([0, 1]), [2]);
    push('confidence_threshold', Float64Array.from([0.7]), [1]);
    push('pca_mean', Float64Array.from([1, 2]), [2]);
    push('pca_components', Float64Array.from([1, 0, 0, 1]), [2, 2]);

    const buf = new ArrayBuffer(offset);
    const bytes = new Uint8Array(buf);
    let cursor = 0;
    for (const arr of chunks) {
      bytes.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), cursor);
      cursor += arr.byteLength;
    }

    const loaded = loadNumRecogniser(buf, { classifier_type: 'rbf', warp_strategy: 'letterbox', arrays });
    expect(loaded).toBeInstanceOf(HogRecogniser);
  });
});

describe('classMeanProject', () => {
  it('projects onto the between-class directions only when no residual is configured', () => {
    const reduction: ClassMeanReduction = {
      meanOfMeans: Float64Array.from([1, 2, 3]),
      betweenComponents: Float64Array.from([
        1, 0, 0,
        0, 1, 0,
      ]),
      nBetween: 2,
      nFeatures: 3,
    };
    const x = Float64Array.from([
      2, 4, 6, // (x - mean) = [1, 2, 3] -> [1, 2]
      1, 2, 3, // (x - mean) = [0, 0, 0] -> [0, 0]
    ]);
    expect(Array.from(classMeanProject(x, 2, reduction))).toEqual([1, 2, 0, 0]);
  });

  it('appends residual-PCA components computed on the orthogonal complement of the between-class directions', () => {
    // Single between-class direction along feature 0; residual PCA (also a
    // single component) reads off feature 1 of what's left after removing it.
    const reduction: ClassMeanReduction = {
      meanOfMeans: Float64Array.from([0, 0, 0]),
      betweenComponents: Float64Array.from([1, 0, 0]),
      nBetween: 1,
      nFeatures: 3,
      residualMean: Float64Array.from([0, 0, 0]),
      residualComponents: Float64Array.from([0, 1, 0]),
      nResidual: 1,
    };
    const x = Float64Array.from([5, 7, 9]); // between: 5; residual after removing feature 0: [0,7,9] -> reads 7
    expect(Array.from(classMeanProject(x, 1, reduction))).toEqual([5, 7]);
  });
});

describe('centerByCentroid', () => {
  it('shifts an off-center ink blob to the canvas center', () => {
    const size = 8;
    const img = new Uint8Array(size * size);
    // A single 2x2 ink block in the top-left corner (centroid at roughly (0.5,0.5)).
    img[0 * size + 0] = 255; img[0 * size + 1] = 255;
    img[1 * size + 0] = 255; img[1 * size + 1] = 255;

    const centered = centerByCentroid(img, size);

    let sx = 0, sy = 0, mass = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = centered[y * size + x]!;
        if (v > 0) { sx += x * v; sy += y * v; mass += v; }
      }
    }
    expect(mass).toBeGreaterThan(0);
    const cx = sx / mass, cy = sy / mass;
    const canvasCenter = (size - 1) / 2;
    expect(Math.abs(cx - canvasCenter)).toBeLessThanOrEqual(1);
    expect(Math.abs(cy - canvasCenter)).toBeLessThanOrEqual(1);
  });

  it('leaves total ink mass unchanged for an already-centered blob', () => {
    const size = 8;
    const img = new Uint8Array(size * size);
    img[3 * size + 3] = 255; img[3 * size + 4] = 255;
    img[4 * size + 3] = 255; img[4 * size + 4] = 255;
    const centered = centerByCentroid(img, size);
    const totalBefore = img.reduce((a, b) => a + b, 0);
    const totalAfter = centered.reduce((a, b) => a + b, 0);
    expect(totalAfter).toBe(totalBefore);
  });

  it('returns an all-zero image unchanged (no ink, no centroid)', () => {
    const size = 8;
    const img = new Uint8Array(size * size);
    const centered = centerByCentroid(img, size);
    expect(centered.every(v => v === 0)).toBe(true);
  });
});
