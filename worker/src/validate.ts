export interface TrainingSample {
  digit: number;
  pixels: number[];
}

export interface TrainingExport {
  version: 1;
  exportedAt: string;
  appVersion: string;
  puzzleType: 'killer' | 'classic';
  subres: number;
  thumbnailSize: number;
  sampleCount: number;
  samples: TrainingSample[];
}

export function isTrainingExport(value: unknown): value is TrainingExport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;

  if (v['version'] !== 1) return false;
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
