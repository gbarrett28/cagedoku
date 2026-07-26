import fs from 'node:fs';
import { hogExtract, loadNumRecogniser, DEFAULT_HOG_PARAMS } from '../src/image/numberRecognition.js';
import { extractHoleFeatures } from '../src/image/holeFeatures.js';
import { solve } from '../src/engine/index.js';
import type { PuzzleSpec } from '../src/solver/puzzleSpec.js';

const HOG_PARAMS = DEFAULT_HOG_PARAMS;

interface Args {
  op: string;
  input: string | null;
  output: string | null;
  modelBin: string | null;
  modelJson: string | null;
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
  if (!op) throw new Error('--op is required (extract-features | predict)');
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const payload = JSON.parse(readPayload(args.input));
  let result: string;
  if (args.op === 'extract-features') {
    result = runExtractFeatures(payload);
  } else if (args.op === 'predict') {
    if (!args.modelBin || !args.modelJson) {
      throw new Error('--op predict requires --model-bin and --model-json');
    }
    result = runPredict(payload, args.modelBin, args.modelJson);
  } else if (args.op === 'solve') {
    result = runSolve(payload);
  } else {
    throw new Error(`unknown --op '${args.op}' (expected extract-features | predict | solve)`);
  }
  writeResult(args.output, result);
}

main();
