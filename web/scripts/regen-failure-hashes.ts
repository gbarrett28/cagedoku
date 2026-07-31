// Regenerates the bundled model's known-model-failure-hashes-*.json baseline
// against corpus_train.json. Run after any retrain that changes
// web/public/num_recogniser.bin -- the pinned baseline in
// numberRecognition.test.ts otherwise flags every shifted misprediction as
// an "unexpected new failure" even when overall accuracy improved.
//
// Usage (from web/): npx vite-node scripts/regen-failure-hashes.ts

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { HogRecogniser, loadNumRecogniser } from '../src/image/numberRecognition';

interface TrainingSample { digit: number; pixels?: number[]; recognitionPixels?: number[] }
interface TrainingFile { samples: TrainingSample[] }

const pub = join(process.cwd(), 'public');
const bin = readFileSync(join(pub, 'num_recogniser.bin'));
const manifest = JSON.parse(readFileSync(join(pub, 'num_recogniser.json'), 'utf-8'));
const rec = loadNumRecogniser(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), manifest);

const hashesFile = rec instanceof HogRecogniser
  ? 'known-model-failure-hashes-hog.json'
  : 'known-model-failure-hashes-pca_rbf.json';

const trainFile: TrainingFile = JSON.parse(
  readFileSync(join(process.cwd(), 'corpus_train.json'), 'utf-8'),
);
const samples = trainFile.samples;

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

const imgs = samples.map(s => new Uint8Array(canonicalPixels(s)));
const results = rec.recognise(imgs);
const failureHashes = new Set<string>();
for (let i = 0; i < samples.length; i++) {
  if (results[i]!.label !== samples[i]!.digit) {
    failureHashes.add(sha256(canonicalPixels(samples[i]!)));
  }
}

const sorted = [...failureHashes].sort();
writeFileSync(join(process.cwd(), hashesFile), JSON.stringify(sorted, null, 2) + '\n');
console.log(`Wrote ${sorted.length} failure hashes to ${hashesFile} (${samples.length} samples checked)`);
