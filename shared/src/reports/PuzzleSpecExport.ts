import type { GitHubAction } from '../report.js';

export interface PuzzleSpecExport {
  readonly reportType: 'puzzle-spec';
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly puzzleType: 'killer';
  readonly regions: readonly (readonly number[])[];
  readonly cageTotals: readonly (readonly number[])[];
  readonly borderX: readonly (readonly boolean[])[];
  readonly borderY: readonly (readonly boolean[])[];
}

export namespace PuzzleSpecExport {
  export function is(value: unknown): value is PuzzleSpecExport {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (v['reportType'] !== 'puzzle-spec') return false;
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

  export function storageKey(r: PuzzleSpecExport, uuid: string): string {
    return `puzzle-spec/${r.exportedAt}-${uuid}.json`;
  }

  export function r2Metadata(r: PuzzleSpecExport): Record<string, string> {
    return { appVersion: r.appVersion, puzzleType: r.puzzleType };
  }

  export function githubAction(r: PuzzleSpecExport, key: string): GitHubAction {
    return {
      kind: 'comment',
      body:
        `**Puzzle spec** — requires backtracking (${r.puzzleType}), ` +
        `app ${r.appVersion}, ${r.exportedAt}\n` +
        `R2 key: \`${key}\``,
    };
  }
}
