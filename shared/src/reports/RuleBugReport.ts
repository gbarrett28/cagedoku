import type { PuzzleRuleReport, ReproductionBundle } from '../report.js';
import type { RuleBugFixture } from '../fixture.js';

export interface RuleBugReport extends PuzzleRuleReport {
  readonly reportType: 'rule-bug';
  readonly offendingEliminations: readonly { readonly cell: readonly [number, number]; readonly digit: number }[];
}

export namespace RuleBugReport {
  export function is(value: unknown): value is RuleBugReport {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (v['reportType'] !== 'rule-bug') return false;
    if (typeof v['reportedAt'] !== 'string') return false;
    if (typeof v['appVersion'] !== 'string') return false;
    if (typeof v['userAgent'] !== 'string') return false;
    if (typeof v['ruleName'] !== 'string' || v['ruleName'].length === 0) return false;
    if (!Array.isArray(v['offendingEliminations'])) return false;
    if (v['puzzleType'] !== 'killer' && v['puzzleType'] !== 'classic') return false;
    if (typeof v['state'] !== 'object' || v['state'] === null) return false;
    return true;
  }

  export function storageKey(r: RuleBugReport, uuid: string): string {
    const timestamp = new Date(r.reportedAt).toISOString().replace(/[:.]/g, '-');
    return `rule-bugs/${r.ruleName}/${timestamp}-${uuid}.json`;
  }

  export function r2Metadata(r: RuleBugReport): Record<string, string> {
    return { appVersion: r.appVersion, ruleName: r.ruleName };
  }

  /** Rule-bug reports are silent — violations disable the rule immediately. */
  export function githubAction(_r: RuleBugReport, _key: string): null {
    return null;
  }

  export function toFixture(r: RuleBugReport): RuleBugFixture {
    const timestamp = new Date(r.reportedAt).toISOString().replace(/[:.]/g, '-');
    return {
      version: 2,
      source: 'r2',
      name: `${r.ruleName}-r2-${timestamp}`,
      addedAt: r.reportedAt.slice(0, 10),
      ruleName: r.ruleName,
      puzzleType: r.puzzleType,
      state: r.state,
    };
  }

  export function reproduce(r: RuleBugReport): ReproductionBundle {
    return {
      ruleName: r.ruleName,
      puzzleType: r.puzzleType,
      state: r.state,
    };
  }
}
