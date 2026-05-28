/**
 * Rule-bug stall fixture — a puzzle state where a specific rule produced an
 * elimination that contradicted the known golden solution.
 *
 * Files live in web/src/engine/rules/__fixtures__/index.ts.
 * Regression tests in each rule's test file assert that the rule no longer
 * makes a wrong elimination on these fixtures.
 */
export interface RuleBugFixture {
  /** Always 1 for this format. */
  version: 1;
  /** Origin: 'issue' (bootstrapped from a GitHub bug report) or 'r2' (from the automated pipeline). */
  source: 'issue' | 'r2';
  /** Unique identifier for this fixture. */
  name: string;
  /** ISO date when the fixture was created. */
  addedAt: string;
  puzzleType: 'killer' | 'classic';
  /** GitHub issue number, if bootstrapped from a bug report. */
  issueNumber?: number;
  /** The rule that produced the wrong elimination. */
  ruleName: string;
  /** Row-major 9×9 regions grid — regions[row][col] = 1-based cage index. */
  regions: number[][];
  /** Row-major 9×9 cage totals — cageTotals[row][col] = sum at cage head, 0 elsewhere. */
  cageTotals: number[][];
  /**
   * 9×9 candidate grid at the moment before the buggy elimination, after all
   * safe rules have run. Each cell is a sorted array of remaining candidates;
   * single-element = solved cell.
   */
  stalledCandidates: number[][][];
  /** The correct complete solution for this puzzle, 0-based row-major [row][col]. */
  goldenSolution: number[][];
  /** Count of cells with more than one candidate. */
  unsolvedCells: number;
  /** Sum of candidate-list lengths across unsolved cells. */
  totalCandidates: number;
}
