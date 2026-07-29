import fs from 'node:fs';
import {
  DEFAULT_HOG_PARAMS,
  hogExtract,
  loadNumRecogniser,
  warpRawDigitCrop,
} from '../src/image/numberRecognition.js';
import type { RawDigitCrop, WarpStrategy } from '../src/image/numberRecognition.js';
import { extractHoleFeatures } from '../src/image/holeFeatures.js';
import { solve } from '../src/engine/index.js';
import type { PuzzleSpec } from '../src/solver/puzzleSpec.js';
import { loadNodeOpenCv } from './node-opencv.js';

const HOG_PARAMS = DEFAULT_HOG_PARAMS;

interface Args {
  op: string;
  input: string | null;
  output: string | null;
  modelBin: string | null;
  modelJson: string | null;
}

interface RawCropPayload {
  readonly width: number;
  readonly height: number;
  readonly pixels: number[];
}

interface WarpCropsPayload {
  readonly crops: RawCropPayload[];
  readonly strategy: WarpStrategy;
  readonly size: number;
}

function parseArgs(argv: string[]): Args {
  let op = '';
  let input: string | null = null;
  let output: string | null = null;
  let modelBin: string | null = null;
  let modelJson: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--op') op = argv[++i]!;
    else if (argv[i] === '--input') input = argv[++i]!;
    else if (argv[i] === '--output') output = argv[++i]!;
    else if (argv[i] === '--model-bin') modelBin = argv[++i]!;
    else if (argv[i] === '--model-json') modelJson = argv[++i]!;
  }
  if (!op) throw new Error('--op is required (warp-crops | extract-features | predict | solve)');
  return { op, input, output, modelBin, modelJson };
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
  const nHog = hogFeat.length / imgs.length;
  const nHole = holeFeat.length / imgs.length;
  const hog: number[][] = [];
  const hole: number[][] = [];
  for (let i = 0; i < imgs.length; i++) {
    hog.push(Array.from(hogFeat.subarray(i * nHog, (i + 1) * nHog)));
    hole.push(Array.from(holeFeat.subarray(i * nHole, (i + 1) * nHole)));
  }
  return JSON.stringify({ hog, hole });
}

function parseWarpCropsPayload(value: unknown): WarpCropsPayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('warp-crops payload must be an object');
  }
  const payload = value as Partial<WarpCropsPayload>;
  if (payload.strategy !== 'stretch' && payload.strategy !== 'letterbox') {
    throw new Error(`warp-crops strategy must be stretch or letterbox, got ${String(payload.strategy)}`);
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
  return payload as WarpCropsPayload;
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
  const warped = crops.map(crop => warpRawDigitCrop(cv, crop, payload.strategy, payload.size));
  const expectedLength = payload.size * payload.size;
  for (const [index, crop] of warped.entries()) {
    if (crop.length !== expectedLength) {
      throw new Error(`warp-crops crop ${index} returned ${crop.length} pixels, expected ${expectedLength}`);
    }
  }
  return JSON.stringify({ crops: warped.map(crop => Array.from(crop)) });
}

function runPredict(
  payload: { crops: number[][] },
  modelBinPath: string,
  modelJsonPath: string,
): string {
  const binBuffer = fs.readFileSync(modelBinPath).buffer;
  const manifestJson = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8'));
  const recogniser = loadNumRecogniser(binBuffer, manifestJson);
  const imgs = toUint8Crops(payload.crops);
  const recognitions = recogniser.recognise(imgs);
  return JSON.stringify({
    predictions: recognitions.map(r => ({
      label: r.label,
      confident: r.confident,
      runnerUp: r.runnerUp ?? null,
    })),
  });
}

function runSolve(payload: PuzzleSpec & { givenDigits?: number[][] }): string {
  const { board, usedBacktracking } = solve(payload, payload.givenDigits);
  const out: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  let solved = true;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cands = board.cands(r, c);
      if (cands.size === 1) out[r]![c] = [...cands][0]!;
      else solved = false;
    }
  }
  return JSON.stringify({ solved, board: out, usedBacktracking });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const payload: unknown = JSON.parse(readPayload(args.input));
  let result: string;
  if (args.op === 'warp-crops') {
    result = await runWarpCrops(payload);
  } else if (args.op === 'extract-features') {
    result = runExtractFeatures(payload as { crops: number[][] });
  } else if (args.op === 'predict') {
    if (!args.modelBin || !args.modelJson) {
      throw new Error('--op predict requires --model-bin and --model-json');
    }
    result = runPredict(payload as { crops: number[][] }, args.modelBin, args.modelJson);
  } else if (args.op === 'solve') {
    result = runSolve(payload as PuzzleSpec & { givenDigits?: number[][] });
  } else {
    throw new Error(`unknown --op '${args.op}' (expected warp-crops | extract-features | predict | solve)`);
  }
  writeResult(args.output, result);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
