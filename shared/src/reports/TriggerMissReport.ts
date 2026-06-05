import type { GitHubAction, PuzzleRuleReport, ReproductionBundle } from '../report.js';
import type { RuleBugFixture } from '../fixture.js';

export interface TriggerMissReproductionBundle extends ReproductionBundle {
  readonly missedContext: string;
  readonly missedEliminations: readonly { readonly cell: readonly [number, number]; readonly digit: number }[];
}

export interface TriggerMissReport extends PuzzleRuleReport {
  readonly reportType: 'trigger-miss';
  readonly missedContext: string;
  readonly missedEliminations: readonly { readonly cell: readonly [number, number]; readonly digit: number }[];
}

export namespace TriggerMissReport {
  export function is(value: unknown): value is TriggerMissReport {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (v['reportType'] !== 'trigger-miss') return false;
    if (typeof v['reportedAt'] !== 'string') return false;
    if (typeof v['appVersion'] !== 'string') return false;
    if (typeof v['userAgent'] !== 'string') return false;
    if (typeof v['ruleName'] !== 'string' || v['ruleName'].length === 0) return false;
    if (typeof v['missedContext'] !== 'string' || v['missedContext'].length === 0) return false;
    if (!Array.isArray(v['missedEliminations'])) return false;
    if (!isStallCandidates(v['stalledCandidates'])) return false;
    if (!is9x9NumberGrid(v['goldenSolution'])) return false;
    if (v['puzzleType'] !== 'killer' && v['puzzleType'] !== 'classic') return false;
    if (!is9x9NumberGrid(v['regions'])) return false;
    if (!is9x9NumberGrid(v['cageTotals'])) return false;
    return true;
  }

  export function storageKey(r: TriggerMissReport, uuid: string): string {
    const timestamp = new Date(r.reportedAt).toISOString().replace(/[:.]/g, '-');
    return `trigger-misses/${r.ruleName}/${timestamp}-${uuid}.json`;
  }

  export function r2Metadata(r: TriggerMissReport): Record<string, string> {
    return { appVersion: r.appVersion, ruleName: r.ruleName, missedContext: r.missedContext };
  }

  export function githubAction(r: TriggerMissReport, key: string): GitHubAction {
    const elims = r.missedEliminations as { cell: [number, number]; digit: number }[];
    const elimSummary = elims.slice(0, 5)
      .map(e => `r${e.cell[0] + 1}c${e.cell[1] + 1}≠${e.digit}`)
      .join(', ');
    const more = elims.length > 5 ? ` (+${elims.length - 5} more)` : '';
    return {
      kind: 'comment',
      body:
        `**Trigger miss** — rule \`${r.ruleName}\`, context \`${r.missedContext}\` (${r.puzzleType})\n` +
        `Missed eliminations: ${elimSummary}${more}\n` +
        `App ${r.appVersion}\nR2 key: \`${key}\``,
    };
  }

  export function toFixture(r: TriggerMissReport): RuleBugFixture {
    const timestamp = new Date(r.reportedAt).toISOString().replace(/[:.]/g, '-');
    const flat = (r.stalledCandidates as number[][][]).flat();
    return {
      version: 1,
      source: 'trigger-miss',
      name: `${r.ruleName}-trigger-miss-${timestamp}`,
      addedAt: r.reportedAt.slice(0, 10),
      puzzleType: r.puzzleType,
      ruleName: r.ruleName,
      regions: r.regions,
      cageTotals: r.cageTotals,
      stalledCandidates: r.stalledCandidates,
      goldenSolution: r.goldenSolution,
      unsolvedCells: flat.filter(c => c.length > 1).length,
      totalCandidates: flat.reduce((s, c) => s + c.length, 0),
    };
  }

  export function reproduce(r: TriggerMissReport): TriggerMissReproductionBundle {
    return {
      ruleName: r.ruleName,
      puzzleType: r.puzzleType,
      regions: r.regions,
      cageTotals: r.cageTotals,
      stalledCandidates: r.stalledCandidates,
      goldenSolution: r.goldenSolution,
      missedContext: r.missedContext,
      missedEliminations: r.missedEliminations,
    };
  }
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
