import type { GitHubAction } from '../report.js';

export interface TrainingSample {
  readonly digit: number;
  readonly pixels: readonly number[];
}

export interface TrainingExport {
  readonly reportType: 'training-export';
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
    if (v['reportType'] !== 'training-export') return false;
    if (typeof v['exportedAt'] !== 'string') return false;
    if (typeof v['appVersion'] !== 'string') return false;
    if (v['puzzleType'] !== 'killer' && v['puzzleType'] !== 'classic') return false;
    if (typeof v['subres'] !== 'number') return false;
    if (typeof v['thumbnailSize'] !== 'number') return false;
    if (typeof v['sampleCount'] !== 'number') return false;
    if (!Array.isArray(v['samples'])) return false;
    if (v['sampleCount'] !== (v['samples'] as unknown[]).length) return false;
    for (const s of v['samples'] as unknown[]) {
      if (!isSample(s)) return false;
    }
    return true;
  }

  function isSample(value: unknown): value is TrainingSample {
    if (typeof value !== 'object' || value === null) return false;
    const s = value as Record<string, unknown>;
    if (typeof s['digit'] !== 'number' || s['digit'] < 0 || s['digit'] > 9) return false;
    if (!Array.isArray(s['pixels'])) return false;
    if ((s['pixels'] as unknown[]).length !== 4096) return false;
    for (const p of s['pixels'] as unknown[]) {
      if (typeof p !== 'number' || p < 0 || p > 255) return false;
    }
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
