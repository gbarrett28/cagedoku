/**
 * A rule-bug stall fixture: a complete `SerializedPuzzleState` (full turn
 * history, golden solution, cage data) where a specific rule produced a wrong
 * elimination or failed to fire. Used by the nightly regression action and
 * stored under rule-fixtures/<ruleName>/ in R2.
 *
 * `state` is `unknown` here (rather than importing `SerializedPuzzleState`
 * from `web/`) so `shared/` stays independent of `web/`-specific types — see
 * `PuzzleState.serialize`/`deserialize` in `web/src/session/types.ts`, which
 * is the only place that produces/consumes this shape.
 */
export interface RuleBugFixture {
  readonly version: 2;
  /** 'issue' = bootstrapped from a GitHub bug report; 'r2' = from RuleBugReport;
   *  'trigger-miss' = from TriggerMissReport. */
  readonly source: 'issue' | 'r2' | 'trigger-miss';
  readonly name: string;
  readonly addedAt: string;
  readonly issueNumber?: number;
  readonly ruleName: string;
  readonly puzzleType: 'killer' | 'classic';
  /** Trigger context that should have fired, for 'trigger-miss' fixtures. */
  readonly missedContext?: string;
  /** A `SerializedPuzzleState` — replay via `PuzzleState.deserialize` + `buildEngine`. */
  readonly state: unknown;
}

export interface FixtureRecord {
  readonly key: string;
  readonly fixture: RuleBugFixture;
}

/**
 * A stable identity for a fixture's puzzle state, independent of `name`,
 * `addedAt` and `source`. Used to deduplicate fixtures fetched from R2 —
 * many reports describe the same underlying turn history.
 */
export function fixtureFingerprint(f: RuleBugFixture): string {
  return JSON.stringify([f.ruleName, f.state]);
}

/** Serialise a fixture to a TypeScript object literal suitable for index.ts. */
export function fixtureToTypeScript(f: RuleBugFixture): string {
  return `  {
    version: ${f.version},
    source: '${f.source}',
    name: '${f.name}',
    addedAt: '${f.addedAt}',
    puzzleType: '${f.puzzleType}',${f.issueNumber !== undefined ? `\n    issueNumber: ${f.issueNumber},` : ''}
    ruleName: '${f.ruleName}',${f.missedContext !== undefined ? `\n    missedContext: ${JSON.stringify(f.missedContext)},` : ''}
    state: ${JSON.stringify(f.state)},
  },`;
}
