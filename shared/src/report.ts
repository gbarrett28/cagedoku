/**
 * GitHub notification produced by a report. 'comment' posts to the tracking
 * issue; 'issue' opens a new GitHub issue.
 */
export type GitHubAction =
  | { readonly kind: 'comment'; readonly body: string }
  | { readonly kind: 'issue'; readonly title: string; readonly body: string; readonly labels: readonly string[] };

/** Fields shared by all reports that carry puzzle-level metadata. */
export interface ReportBase {
  readonly reportType: string;
  readonly reportedAt: string;
  readonly appVersion: string;
  readonly userAgent: string;
}

/**
 * Fields shared by reports that contain a full puzzle board state.
 *
 * `state` is a `SerializedPuzzleState` (see `web/src/session/types.ts`'s
 * `PuzzleState.serialize`) — the full turn history plus golden solution and
 * cage data needed to replay the session via `PuzzleState.deserialize` +
 * `buildEngine`. Typed `unknown` so `shared/` stays independent of `web/`.
 */
export interface PuzzleRuleReport extends ReportBase {
  readonly ruleName: string;
  readonly puzzleType: 'killer' | 'classic' | 'bigapple';
  readonly state: unknown;
}

/**
 * Structured data needed to reproduce a rule-level bug or miss in a test
 * or in the app. Returned by namespace reproduce() functions.
 */
export interface ReproductionBundle {
  readonly ruleName: string;
  readonly puzzleType: 'killer' | 'classic' | 'bigapple';
  readonly state: unknown;
}
