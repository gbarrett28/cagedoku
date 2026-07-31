import type { GitHubAction } from '../report.js';

export interface TrainingSample {
  readonly digit: number;
  readonly sourceRect: readonly [number, number, number, number];
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly sourcePixels: readonly number[];
  readonly recognitionPixels: readonly number[];
  readonly warpStrategy: 'stretch' | 'letterbox' | 'letterbox-centered';
}

export interface TrainingExport {
  readonly reportType: 'training-export';
  readonly schemaVersion: 2;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly puzzleType: 'killer' | 'classic';
  readonly subres: number;
  readonly thumbnailSize: number;
  readonly sampleCount: number;
  readonly samples: readonly TrainingSample[];
}

export namespace TrainingExport {
  export function is(value: unknown): value is TrainingExport {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (v['reportType'] !== 'training-export' || v['schemaVersion'] !== 2) return false;
    if (typeof v['exportedAt'] !== 'string') return false;
    if (typeof v['appVersion'] !== 'string') return false;
    if (v['puzzleType'] !== 'killer' && v['puzzleType'] !== 'classic') return false;
    if (typeof v['subres'] !== 'number') return false;
    if (v['thumbnailSize'] !== 64) return false;
    if (typeof v['sampleCount'] !== 'number') return false;
    if (!Array.isArray(v['samples'])) return false;
    if (v['sampleCount'] !== (v['samples'] as unknown[]).length) return false;
    return (v['samples'] as unknown[]).every(isSample);
  }

  function isByteArray(value: unknown, expectedLength: number): value is number[] {
    return Array.isArray(value)
      && value.length === expectedLength
      && value.every(pixel => typeof pixel === 'number' && Number.isInteger(pixel) && pixel >= 0 && pixel <= 255);
  }

  function isSample(value: unknown): value is TrainingSample {
    if (typeof value !== 'object' || value === null) return false;
    const s = value as Record<string, unknown>;
    if (typeof s['digit'] !== 'number' || !Number.isInteger(s['digit']) || s['digit'] < 0 || s['digit'] > 9) return false;
    if (!Array.isArray(s['sourceRect']) || s['sourceRect'].length !== 4) return false;
    if (!(s['sourceRect'] as unknown[]).every(coordinate => typeof coordinate === 'number' && Number.isInteger(coordinate))) return false;
    const sourceWidth = s['sourceWidth'];
    const sourceHeight = s['sourceHeight'];
    if (typeof sourceWidth !== 'number' || !Number.isInteger(sourceWidth) || sourceWidth <= 0) return false;
    if (typeof sourceHeight !== 'number' || !Number.isInteger(sourceHeight) || sourceHeight <= 0) return false;
    const [, , rectWidth, rectHeight] = s['sourceRect'] as number[];
    if (rectWidth !== sourceWidth || rectHeight !== sourceHeight) return false;
    if (!isByteArray(s['sourcePixels'], sourceWidth * sourceHeight)) return false;
    if (!isByteArray(s['recognitionPixels'], 64 * 64)) return false;
    if (s['warpStrategy'] !== 'stretch' && s['warpStrategy'] !== 'letterbox' && s['warpStrategy'] !== 'letterbox-centered') return false;
    return true;
  }

  export function storageKey(r: TrainingExport, uuid: string): string {
    return `training/${r.exportedAt}-${uuid}.json`;
  }

  export function r2Metadata(r: TrainingExport): Record<string, string> {
    return { appVersion: r.appVersion, puzzleType: r.puzzleType, sampleCount: String(r.sampleCount) };
  }

  export function githubAction(r: TrainingExport, key: string): GitHubAction {
    return {
      kind: 'comment',
      body:
        `**New upload** — ${r.sampleCount} samples (${r.puzzleType}), ` +
        `app ${r.appVersion}, ${r.exportedAt}\n` +
        `R2 key: \`${key}\``,
    };
  }
}
