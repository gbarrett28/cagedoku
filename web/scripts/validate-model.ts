import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TrainingExport } from '../../shared/src/reports/TrainingExport.js';
import { loadNumRecogniser } from '../src/image/numberRecognition.js';

const CANONICAL_PIXEL_COUNT = 64 * 64;

export interface CanonicalAuditCrop {
  readonly digit: number;
  readonly recognitionPixels: readonly number[];
}

export interface ModelValidationResult {
  readonly total: number;
  readonly correct: number;
  readonly errors: readonly string[];
}

export function readCanonicalCrops(path: string): readonly CanonicalAuditCrop[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!TrainingExport.is(parsed)) {
    throw new Error(`Expected schema-v2 training export: ${path}`);
  }
  return parsed.samples.map(({ digit, recognitionPixels }) => ({
    digit,
    recognitionPixels,
  }));
}

function canonicalBytes(sample: CanonicalAuditCrop, index: number): Uint8Array {
  if (sample.recognitionPixels.length !== CANONICAL_PIXEL_COUNT) {
    throw new Error(`sample ${index} recognitionPixels must contain ${CANONICAL_PIXEL_COUNT} bytes`);
  }
  if (!sample.recognitionPixels.every(
    pixel => Number.isInteger(pixel) && pixel >= 0 && pixel <= 255,
  )) {
    throw new Error(`sample ${index} recognitionPixels must contain only bytes`);
  }
  if (!Number.isInteger(sample.digit) || sample.digit < 0 || sample.digit > 9) {
    throw new Error(`sample ${index} digit must be an integer from 0 to 9`);
  }
  return Uint8Array.from(sample.recognitionPixels);
}

export function validateModel(
  modelBinPath: string,
  modelJsonPath: string,
  canonicalCrops: readonly CanonicalAuditCrop[],
): ModelValidationResult {
  const bin = readFileSync(modelBinPath);
  const manifest = JSON.parse(
    readFileSync(modelJsonPath, 'utf8'),
  ) as Parameters<typeof loadNumRecogniser>[1];
  const recogniser = loadNumRecogniser(
    bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
    manifest,
  );
  const recognitions = recogniser.recognise(
    canonicalCrops.map((sample, index) => canonicalBytes(sample, index)),
  );

  let correct = 0;
  const errors: string[] = [];
  for (const [index, recognition] of recognitions.entries()) {
    const expected = canonicalCrops[index]!.digit;
    if (recognition.label === expected) {
      correct++;
    } else {
      errors.push(`sample ${index}: expected ${expected}, got ${recognition.label}`);
    }
  }
  return { total: canonicalCrops.length, correct, errors };
}

function runCli(args: readonly string[]): number {
  if (args.length !== 3) {
    throw new Error('Usage: validate-model MODEL_BIN MODEL_JSON TRAINING_EXPORT_JSON');
  }
  const [modelBinPath, modelJsonPath, samplesPath] = args as [string, string, string];
  const result = validateModel(
    modelBinPath,
    modelJsonPath,
    readCanonicalCrops(samplesPath),
  );
  console.log(JSON.stringify(result, null, 2));
  return result.errors.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
