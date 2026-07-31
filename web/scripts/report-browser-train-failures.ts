#!/usr/bin/env vite-node
/**
 * Reports every corpus_train.json sample the current model misclassifies,
 * identified by content hash (sha256 of the raw pixel array) rather than
 * array index -- hash identity survives reordering and deduplication of the
 * underlying fixture, where index does not.
 *
 * Usage (from web/):
 *   npx vite-node scripts/report-browser-train-failures.ts [path/to/corpus_train.json]
 *
 * stdout: one sha256 hex hash per line, sorted -- intended for `sort`/`comm`
 *   comparison between runs (e.g. before/after a dedup + retrain).
 * stderr: human-readable detail per failure, plus a summary count.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadNumRecogniser } from '../src/image/numberRecognition.js';

interface TrainingSample { digit: number; pixels?: number[]; recognitionPixels?: number[] }
interface TrainingFile { samples: TrainingSample[] }

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

function main(): void {
  const trainPath = resolve(process.argv[2] ?? join('corpus_train.json'));
  const pub = join('public');
  const bin = readFileSync(join(pub, 'num_recogniser.bin'));
  const manifest = JSON.parse(readFileSync(join(pub, 'num_recogniser.json'), 'utf-8'));
  const rec = loadNumRecogniser(
    bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), manifest,
  );

  const { samples }: TrainingFile = JSON.parse(readFileSync(trainPath, 'utf-8'));
  const imgs = samples.map(s => new Uint8Array(canonicalPixels(s)));
  const results = rec.recognise(imgs);

  const failureHashes: string[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (results[i]!.label !== samples[i]!.digit) {
      const hash = sha256(canonicalPixels(samples[i]!));
      failureHashes.push(hash);
      console.error(`${hash}  index=${i} expected=${samples[i]!.digit} got=${results[i]!.label}`);
    }
  }
  failureHashes.sort();
  console.error(`\n${failureHashes.length}/${samples.length} failures`);
  for (const h of failureHashes) console.log(h);
}

main();
