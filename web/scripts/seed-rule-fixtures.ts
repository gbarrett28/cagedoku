/**
 * One-time script that generates rule-bug fixture data from GitHub issue reports.
 *
 * For each issue, it:
 * 1. Reconstructs the puzzle spec from the reported givenDigits + regions/cageTotals.
 * 2. Runs the rule engine WITHOUT the buggy rule until stall — the stall state is where
 *    the buggy rule would need to fire.
 * 3. Obtains the golden (correct) solution via MRV backtracking from the stall state.
 * 4. Writes the fixture record to web/src/engine/rules/__fixtures__/index.ts.
 *
 * Run from web/:
 *   npx vite-node scripts/seed-rule-fixtures.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BoardState, SolverEngine, defaultRules, mrvBacktrack } from '../src/engine/index.js';
import type { Cell, Elimination } from '../src/engine/types.js';
import { dataToSpec } from '../src/session/specUtils.js';
import type { RuleBugFixture } from '../src/engine/rules/ruleBugFixture.js';

// ---------------------------------------------------------------------------
// Issue puzzle data
// ---------------------------------------------------------------------------

const STANDARD_REGIONS = Array.from({ length: 9 }, (_, r) => new Array<number>(9).fill(r + 1));
const STANDARD_CAGE_TOTALS = Array.from({ length: 9 }, (_, r) =>
  Array.from({ length: 9 }, (_, c) => (c === 0 ? 45 : 0)));

const ISSUES: Array<{
  issueNumber: number;
  ruleName: string;
  givenDigits: number[][];
}> = [
  {
    issueNumber: 122,
    ruleName: 'TwoStringKite',
    givenDigits: [
      [0,5,0,0,0,0,0,8,0],
      [0,0,1,0,3,0,0,0,6],
      [0,0,7,2,6,8,0,0,0],
      [0,3,0,1,0,0,5,0,0],
      [0,0,0,0,5,0,9,3,0],
      [5,0,9,0,0,7,6,0,0],
      [2,1,0,6,0,0,8,5,0],
      [0,0,5,0,0,2,0,0,1],
      [7,0,3,9,0,0,0,0,0],
    ],
  },
  {
    issueNumber: 124,
    ruleName: 'UniqueRectangle',
    givenDigits: [
      [0,0,6,0,1,0,7,0,0],
      [5,1,0,0,3,9,6,0,0],
      [0,9,0,0,0,0,0,1,5],
      [8,0,7,0,0,0,0,9,0],
      [3,0,0,2,0,0,0,5,1],
      [0,0,0,9,6,0,0,0,0],
      [9,3,0,0,0,5,0,0,4],
      [0,0,5,0,0,0,9,6,0],
      [6,0,1,0,9,3,0,7,0],
    ],
  },
  {
    issueNumber: 126,
    ruleName: 'UniqueRectangle',
    givenDigits: [
      [0,0,0,0,0,0,0,0,0],
      [7,0,6,0,5,0,0,3,0],
      [3,5,1,0,0,2,0,0,0],
      [0,0,2,6,1,0,4,0,0],
      [0,8,0,7,0,3,0,1,0],
      [0,0,0,0,2,4,0,0,0],
      [0,4,0,0,0,7,3,2,0],
      [0,0,3,0,4,0,1,0,0],
      [0,0,0,0,0,0,8,5,0],
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedGivenDigits(engine: SolverEngine, board: BoardState, givenDigits: number[][]): void {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const d = givenDigits[r]![c]!;
      if (d > 0) {
        const elims: Elimination[] = [];
        for (let other = 1; other <= 9; other++) {
          if (other !== d && board.cands(r, c).has(other))
            elims.push({ cell: [r, c] as Cell, digit: other });
        }
        if (elims.length) engine.applyEliminations(elims);
      }
    }
  }
}

function snapshotCandidates(board: BoardState): number[][][] {
  return Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => [...board.cands(r, c)].sort((a, b) => a - b)));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const outFile = path.resolve(import.meta.dirname, '..', 'src', 'engine', 'rules', '__fixtures__', 'index.ts');
const today = new Date().toISOString().slice(0, 10);

const fixtures: RuleBugFixture[] = [];

for (const issue of ISSUES) {
  console.log(`\nProcessing issue ${issue.issueNumber} (${issue.ruleName})…`);

  const spec = dataToSpec({
    regions: STANDARD_REGIONS,
    cageTotals: STANDARD_CAGE_TOTALS,
  });

  // Stall at the auto-apply rules level — the same state the user saw before
  // they applied a hint. TwoStringKite and UniqueRectangle are hint-only rules;
  // the user's auto-apply set was: NakedSingle, CellSolutionElimination,
  // CageCandidateFilter, SolutionMapFilter.
  const AUTO_APPLY = new Set(['NakedSingle', 'CellSolutionElimination', 'CageCandidateFilter', 'SolutionMapFilter']);
  const board = new BoardState(spec, { includeVirtualCages: false });
  const autoRules = defaultRules().filter(r => AUTO_APPLY.has(r.name));
  const engine = new SolverEngine(board, autoRules);
  seedGivenDigits(engine, board, issue.givenDigits);
  engine.solve();

  const stalledCandidates = snapshotCandidates(board);
  const unsolvedCells = stalledCandidates.flat().filter(c => c.length > 1).length;
  const totalCandidates = stalledCandidates
    .flat()
    .filter(c => c.length > 1)
    .reduce((s, c) => s + c.length, 0);

  console.log(`  stall: ${unsolvedCells} unsolved cells, ${totalCandidates} total candidates`);

  // Get the true golden solution via MRV backtracking from the stall state.
  const goldenSolution = mrvBacktrack(board);
  if (goldenSolution === null) {
    console.error(`  ERROR: backtracker could not solve issue ${issue.issueNumber}!`);
    process.exit(1);
  }

  console.log(`  golden: ${goldenSolution.flat().filter(d => d > 0).length}/81 cells`);

  fixtures.push({
    version: 1,
    source: 'issue',
    name: `${issue.ruleName.charAt(0).toLowerCase()}${issue.ruleName.slice(1)}-issue-${issue.issueNumber}`,
    addedAt: today,
    puzzleType: 'classic',
    issueNumber: issue.issueNumber,
    ruleName: issue.ruleName,
    regions: STANDARD_REGIONS,
    cageTotals: STANDARD_CAGE_TOTALS,
    stalledCandidates,
    goldenSolution,
    unsolvedCells,
    totalCandidates,
  });
}

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

fs.mkdirSync(path.dirname(outFile), { recursive: true });

const lines: string[] = [
  '/**',
  ' * Rule-bug stall fixtures bootstrapped from GitHub bug reports.',
  ' *',
  ' * Each entry represents a puzzle state where the named rule produced an',
  ' * elimination that contradicted the known golden solution.',
  ' *',
  ' * Generated by: npx vite-node scripts/seed-rule-fixtures.ts',
  ' * Do not edit by hand — re-run the script to regenerate.',
  ' */',
  '',
  "import type { RuleBugFixture } from '../ruleBugFixture.js';",
  '',
  'export const ruleBugFixtures: readonly RuleBugFixture[] = [',
];

for (const f of fixtures) {
  lines.push('  {');
  lines.push(`    version: 1,`);
  lines.push(`    source: '${f.source}',`);
  lines.push(`    name: '${f.name}',`);
  lines.push(`    addedAt: '${f.addedAt}',`);
  lines.push(`    puzzleType: '${f.puzzleType}',`);
  if (f.issueNumber !== undefined) lines.push(`    issueNumber: ${f.issueNumber},`);
  lines.push(`    ruleName: '${f.ruleName}',`);
  lines.push(`    regions: ${JSON.stringify(f.regions)},`);
  lines.push(`    cageTotals: ${JSON.stringify(f.cageTotals)},`);
  lines.push(`    stalledCandidates: ${JSON.stringify(f.stalledCandidates)},`);
  lines.push(`    goldenSolution: ${JSON.stringify(f.goldenSolution)},`);
  lines.push(`    unsolvedCells: ${f.unsolvedCells},`);
  lines.push(`    totalCandidates: ${f.totalCandidates},`);
  lines.push('  },');
}

lines.push('];');
lines.push('');

fs.writeFileSync(outFile, lines.join('\n'));
console.log(`\nWrote ${fixtures.length} fixture(s) to ${outFile}`);
