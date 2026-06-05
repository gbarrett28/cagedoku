import type { GitHubAction, ReportBase } from '../report.js';
import type { CandidateGrid } from '../grid.js';

export interface StallStateExport extends ReportBase {
  readonly reportType: 'stall';
  readonly puzzleType: 'killer' | 'classic';
  readonly stalledCandidates: CandidateGrid;
}

export namespace StallStateExport {
  export function is(value: unknown): value is StallStateExport {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (v['reportType'] !== 'stall') return false;
    if (typeof v['reportedAt'] !== 'string') return false;
    if (typeof v['appVersion'] !== 'string') return false;
    if (typeof v['userAgent'] !== 'string') return false;
    if (v['puzzleType'] !== 'killer' && v['puzzleType'] !== 'classic') return false;
    if (!isStallCandidates(v['stalledCandidates'])) return false;
    return true;
  }

  function isStallCandidates(value: unknown): boolean {
    if (!Array.isArray(value) || value.length !== 9) return false;
    for (const row of value as unknown[]) {
      if (!Array.isArray(row) || (row as unknown[]).length !== 9) return false;
      for (const cell of row as unknown[]) {
        if (!Array.isArray(cell) || (cell as unknown[]).length === 0) return false;
        for (const d of cell as unknown[]) {
          if (typeof d !== 'number') return false;
        }
      }
    }
    return true;
  }

  export function storageKey(r: StallStateExport, uuid: string): string {
    return `stall/${r.reportedAt}-${uuid}.json`;
  }

  export function r2Metadata(r: StallStateExport): Record<string, string> {
    return { appVersion: r.appVersion, puzzleType: r.puzzleType };
  }

  export function githubAction(r: StallStateExport, key: string): GitHubAction {
    const solved = (r.stalledCandidates as number[][][]).flat().filter(c => c.length === 1).length;
    return {
      kind: 'comment',
      body:
        `**Stall state** — ${solved}/81 cells solved at stall (${r.puzzleType}), ` +
        `app ${r.appVersion}, ${r.reportedAt}\n` +
        `R2 key: \`${key}\``,
    };
  }
}
