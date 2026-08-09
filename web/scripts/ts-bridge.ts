import fs from 'node:fs';
import {
  DEFAULT_HOG_PARAMS,
  hogExtract,
  prepareRecognitionCrop,
} from '../src/image/numberRecognition.js';
import type { RawDigitCrop, RecognitionInputMode, WarpStrategy } from '../src/image/numberRecognition.js';
import { extractHoleFeatures } from '../src/image/holeFeatures.js';
import { extractAspectFeatures } from '../src/image/aspectFeatures.js';
import { loadNodeOpenCv } from './node-opencv.js';

const HOG_PARAMS = DEFAULT_HOG_PARAMS;

interface Args {
  op: string;
  input: string | null;
  output: string | null;
}

interface RawCropPayload {
  readonly width: number;
  readonly height: number;
  readonly pixels: number[];
}

interface WarpCropsPayload {
  readonly crops: RawCropPayload[];
  readonly strategy: WarpStrategy;
  readonly inputMode: RecognitionInputMode;
  readonly size: number;
}

function parseArgs(argv: string[]): Args {
  let op = '';
  let input: string | null = null;
  let output: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--op') op = argv[++i]!;
    else if (argv[i] === '--input') input = argv[++i]!;
    else if (argv[i] === '--output') output = argv[++i]!;
  }
  if (!op) throw new Error('--op is required (warp-crops | extract-features)');
  return { op, input, output };
}

function readPayload(inputPath: string | null): string {
  if (inputPath) return fs.readFileSync(inputPath, 'utf-8');
  return fs.readFileSync(0, 'utf-8'); // fd 0 = stdin
}

function writeResult(outputPath: string | null, json: string): void {
  if (outputPath) fs.writeFileSync(outputPath, json);
  else process.stdout.write(json);
}

function toUint8Crops(crops: number[][]): Uint8Array[] {
  return crops.map(c => Uint8Array.from(c));
}

function runExtractFeatures(payload: { crops: number[][] }): string {
  const imgs = toUint8Crops(payload.crops);
  const hogFeat = hogExtract(imgs, HOG_PARAMS);
  const holeFeat = extractHoleFeatures(imgs, HOG_PARAMS.winSize);
  const aspectFeat = extractAspectFeatures(imgs, HOG_PARAMS.winSize);
  const nHog = hogFeat.length / imgs.length;
  const nHole = holeFeat.length / imgs.length;
  const hog: number[][] = [];
  const hole: number[][] = [];
  const aspect: number[] = [];
  for (let i = 0; i < imgs.length; i++) {
    hog.push(Array.from(hogFeat.subarray(i * nHog, (i + 1) * nHog)));
    hole.push(Array.from(holeFeat.subarray(i * nHole, (i + 1) * nHole)));
    aspect.push(aspectFeat[i]!);
  }
  return JSON.stringify({ hog, hole, aspect });
}

function parseWarpCropsPayload(value: unknown): WarpCropsPayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('warp-crops payload must be an object');
  }
  const payload = value as Partial<WarpCropsPayload>;
  if (payload.strategy !== 'stretch' && payload.strategy !== 'letterbox' && payload.strategy !== 'letterbox-centered') {
    throw new Error(`warp-crops strategy must be stretch, letterbox, or letterbox-centered, got ${String(payload.strategy)}`);
  }
  const inputMode = payload.inputMode ?? 'binary';
  if (inputMode !== 'binary' && inputMode !== 'gray-inverted-contrast'
      && inputMode !== 'gray-adaptive' && inputMode !== 'gray-normalized') {
    throw new Error(`warp-crops inputMode is invalid: ${String(inputMode)}`);
  }
  if (!Number.isInteger(payload.size) || (payload.size ?? 0) <= 0) {
    throw new Error(`warp-crops size must be a positive integer, got ${String(payload.size)}`);
  }
  if (!Array.isArray(payload.crops)) {
    throw new Error('warp-crops crops must be an array');
  }
  for (const [index, crop] of payload.crops.entries()) {
    if (!Number.isInteger(crop.width) || crop.width <= 0
        || !Number.isInteger(crop.height) || crop.height <= 0) {
      throw new Error(`warp-crops crop ${index} dimensions must be positive integers`);
    }
    if (!Array.isArray(crop.pixels) || crop.pixels.length !== crop.width * crop.height) {
      throw new Error(
        `warp-crops crop ${index} expected ${crop.width * crop.height} pixels, got ${crop.pixels?.length ?? 'non-array'}`,
      );
    }
    if (crop.pixels.some(pixel => !Number.isInteger(pixel) || pixel < 0 || pixel > 255)) {
      throw new Error(`warp-crops crop ${index} pixels must be uint8 values`);
    }
  }
  return { ...payload, inputMode } as WarpCropsPayload;
}

async function runWarpCrops(value: unknown): Promise<string> {
  const payload = parseWarpCropsPayload(value);
  const cv = await loadNodeOpenCv();
  const crops = payload.crops.map((crop): RawDigitCrop => ({
    x: 0,
    y: 0,
    width: crop.width,
    height: crop.height,
    pixels: Uint8Array.from(crop.pixels),
  }));
  const warped = crops.map(crop => prepareRecognitionCrop(
    cv, crop, payload.strategy, payload.inputMode, payload.size,
  ));
  const expectedLength = payload.size * payload.size;
  for (const [index, crop] of warped.entries()) {
    if (crop.length !== expectedLength) {
      throw new Error(`warp-crops crop ${index} returned ${crop.length} pixels, expected ${expectedLength}`);
    }
  }
  return JSON.stringify({ crops: warped.map(crop => Array.from(crop)) });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const payload: unknown = JSON.parse(readPayload(args.input));

  if (args.op === 'warp-crops') {
    const result = await runWarpCrops(payload);
    writeResult(args.output, result);
    return;
  }

  if (args.op === 'extract-features') {
    writeResult(args.output, runExtractFeatures(payload));
    return;
  }

  throw new Error(
    `Unknown --op '${args.op}' (expected warp-crops | extract-features)`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
