import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCanonicalCrops, validateModel } from './validate-model.js';

interface LegacyTrainingSample {
  readonly digit: number;
  readonly pixels: readonly number[];
}

interface LegacyTrainingFile {
  readonly samples: readonly LegacyTrainingSample[];
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeTempJson(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'validate-model-'));
  tempDirs.push(dir);
  const path = join(dir, 'samples.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('validateModel', () => {
  it('loads the committed HOG/RBF model and classifies two canonical samples', () => {
    const pub = join(process.cwd(), 'public');
    const training = JSON.parse(
      readFileSync(join(process.cwd(), 'browser_train.json'), 'utf8'),
    ) as LegacyTrainingFile;
    const samples = training.samples.slice(0, 2).map(sample => ({
      digit: sample.digit,
      recognitionPixels: sample.pixels,
    }));

    expect(validateModel(
      join(pub, 'num_recogniser.bin'),
      join(pub, 'num_recogniser.json'),
      samples,
    )).toEqual({ total: 2, correct: 2, errors: [] });
  });

  it('reads canonical audit crops from schema-v2 recognitionPixels', () => {
    const recognitionPixels = Array<number>(64 * 64).fill(37);
    const path = writeTempJson({
      reportType: 'training-export',
      schemaVersion: 2,
      exportedAt: '2026-07-29T00:00:00.000Z',
      appVersion: 'test',
      puzzleType: 'classic',
      subres: 64,
      thumbnailSize: 64,
      sampleCount: 1,
      samples: [{
        digit: 3,
        sourceRect: [4, 5, 3, 7],
        sourceWidth: 3,
        sourceHeight: 7,
        sourcePixels: Array<number>(3 * 7).fill(11),
        recognitionPixels,
        warpStrategy: 'letterbox',
      }],
    });

    const [sample] = readCanonicalCrops(path);
    expect(sample?.digit).toBe(3);
    expect(sample?.recognitionPixels).toEqual(recognitionPixels);
    expect(sample).not.toHaveProperty('sourcePixels');
  });


  it('rejects files that are not schema-v2 training exports', () => {
    const path = writeTempJson({
      samples: [{ digit: 1, pixels: Array<number>(64 * 64).fill(0) }],
    });

    expect(() => readCanonicalCrops(path)).toThrow('Expected schema-v2 training export');
  });

  it('rejects non-canonical recognition pixel lengths before inference', () => {
    const pub = join(process.cwd(), 'public');

    expect(() => validateModel(
      join(pub, 'num_recogniser.bin'),
      join(pub, 'num_recogniser.json'),
      [{ digit: 1, recognitionPixels: [0] }],
    )).toThrow('sample 0 recognitionPixels must contain 4096 bytes');
  });
});
