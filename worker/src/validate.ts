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

export interface PuzzleSpecExport {
  version: 2;
  exportedAt: string;
  appVersion: string;
  puzzleType: 'killer';
  regions: number[][];
  cageTotals: number[][];
  borderX: boolean[][];
  borderY: boolean[][];
}

export function isPuzzleSpecExport(value: unknown): value is PuzzleSpecExport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 2) return false;
  if (typeof v['exportedAt'] !== 'string') return false;
  if (typeof v['appVersion'] !== 'string') return false;
  if (v['puzzleType'] !== 'killer') return false;
  if (!is9x9NumberGrid(v['regions'])) return false;
  if (!is9x9NumberGrid(v['cageTotals'])) return false;
  if (!isBorderX(v['borderX'])) return false;
  if (!isBorderY(v['borderY'])) return false;
  return true;
}

function is9x9NumberGrid(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 9) return false;
  for (const row of value as unknown[]) {
    if (!Array.isArray(row) || (row as unknown[]).length !== 9) return false;
    for (const cell of row as unknown[]) {
      if (typeof cell !== 'number') return false;
    }
  }
  return true;
}

function isBorderX(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 9) return false;
  for (const col of value as unknown[]) {
    if (!Array.isArray(col) || (col as unknown[]).length !== 8) return false;
    for (const cell of col as unknown[]) {
      if (typeof cell !== 'boolean') return false;
    }
  }
  return true;
}

function isBorderY(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 8) return false;
  for (const colGap of value as unknown[]) {
    if (!Array.isArray(colGap) || (colGap as unknown[]).length !== 9) return false;
    for (const cell of colGap as unknown[]) {
      if (typeof cell !== 'boolean') return false;
    }
  }
  return true;
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

export interface FeedbackReport {
  version: 3;
  reportedAt: string;
  appVersion: string;
  feedbackType: 'bug' | 'enhancement';
  bugCategory?: 'wrong-behaviour' | 'inaccurate-description';
  description: string;
  expected?: string;
  actionLog: string;
  puzzleSpec: unknown;
  userAgent: string;
  viewport: string;
  config: { alwaysApplyRules: string[]; autoPlacementDelay: number };
}

export function isFeedbackReport(value: unknown): value is FeedbackReport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 3) return false;
  if (typeof v['reportedAt'] !== 'string') return false;
  if (typeof v['appVersion'] !== 'string') return false;
  if (v['feedbackType'] !== 'bug' && v['feedbackType'] !== 'enhancement') return false;
  if (v['feedbackType'] === 'bug' && v['bugCategory'] !== undefined &&
      v['bugCategory'] !== 'wrong-behaviour' && v['bugCategory'] !== 'inaccurate-description') return false;
  if (typeof v['description'] !== 'string') return false;
  if (v['expected'] !== undefined && typeof v['expected'] !== 'string') return false;
  if (typeof v['actionLog'] !== 'string') return false;
  if (typeof v['userAgent'] !== 'string') return false;
  if (typeof v['viewport'] !== 'string') return false;
  if (typeof v['config'] !== 'object' || v['config'] === null) return false;
  return true;
}
