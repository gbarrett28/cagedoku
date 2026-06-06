import type { Grid, CandidateGrid } from './grid.js';

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

/** Fields shared by reports that contain a full puzzle board state. */
export interface PuzzleRuleReport extends ReportBase {
  readonly ruleName: string;
  readonly stalledCandidates: CandidateGrid;
  readonly goldenSolution: Grid;
  readonly puzzleType: 'killer' | 'classic';
  readonly regions: Grid;
  readonly cageTotals: Grid;
}

/**
 * Structured data needed to reproduce a rule-level bug or miss in a test
 * or in the app. Returned by namespace reproduce() functions.
 */
export interface ReproductionBundle {
  readonly ruleName: string;
  readonly puzzleType: 'killer' | 'classic';
  readonly regions: Grid;
  readonly cageTotals: Grid;
  readonly stalledCandidates: CandidateGrid;
  readonly goldenSolution: Grid;
}
