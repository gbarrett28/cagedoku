/**
 * A rule-bug stall fixture: a puzzle state where a specific rule produced a
 * wrong elimination or failed to fire. Used by the nightly regression action
 * and stored under rule-fixtures/<ruleName>/ in R2.
 */
export interface RuleBugFixture {
  readonly version: 1;
  /** 'issue' = bootstrapped from a GitHub bug report; 'r2' = from RuleBugReport;
   *  'trigger-miss' = from TriggerMissReport. */
  readonly source: 'issue' | 'r2' | 'trigger-miss';
  readonly name: string;
  readonly addedAt: string;
  readonly puzzleType: 'killer' | 'classic';
  readonly issueNumber?: number;
  readonly ruleName: string;
  readonly regions: readonly (readonly number[])[];
  readonly cageTotals: readonly (readonly number[])[];
  readonly stalledCandidates: readonly (readonly (readonly number[])[])[];
  readonly goldenSolution: readonly (readonly number[])[];
  readonly unsolvedCells: number;
  readonly totalCandidates: number;
}

/**
 * A stable identity for a fixture's puzzle state, independent of `name`,
 * `addedAt` and `source`. Used to deduplicate fixtures fetched from R2 —
 * many reports describe the same underlying stall.
 */
export function fixtureFingerprint(f: RuleBugFixture): string {
  return JSON.stringify([f.ruleName, f.regions, f.cageTotals, f.stalledCandidates, f.goldenSolution]);
}

/** Serialise a fixture to a TypeScript object literal suitable for index.ts. */
export function fixtureToTypeScript(f: RuleBugFixture): string {
  return `  {
    version: ${f.version},
    source: '${f.source}',
    name: '${f.name}',
    addedAt: '${f.addedAt}',
    puzzleType: '${f.puzzleType}',${f.issueNumber !== undefined ? `\n    issueNumber: ${f.issueNumber},` : ''}
    ruleName: '${f.ruleName}',
    regions: ${JSON.stringify(f.regions)},
    cageTotals: ${JSON.stringify(f.cageTotals)},
    stalledCandidates: ${JSON.stringify(f.stalledCandidates)},
    goldenSolution: ${JSON.stringify(f.goldenSolution)},
    unsolvedCells: ${f.unsolvedCells},
    totalCandidates: ${f.totalCandidates},
  },`;
}
