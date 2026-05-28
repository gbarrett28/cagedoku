#!/usr/bin/env node
/**
 * Fetch new rule-bug stall fixtures from the Cloudflare Worker R2 bucket and
 * write them into web/src/engine/rules/__fixtures__/index.ts.
 *
 * Also updates web/src/engine/rules/disabled-rules.ts to include any rule that
 * has at least one fixture (so the rule is excluded from deployed builds until
 * a developer fixes it and removes its name from the disabled list).
 *
 * Usage (from the repo root):
 *   TRAINING_WORKER_URL=https://... node web/scripts/sync-rule-fixtures.js
 *
 * The TRAINING_WORKER_URL env var must point to the Cloudflare Worker's base URL.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const WEB_ROOT = join(__dirname, '..');
const FIXTURES_FILE = join(WEB_ROOT, 'src', 'engine', 'rules', '__fixtures__', 'index.ts');
const DISABLED_FILE = join(WEB_ROOT, 'src', 'engine', 'rules', 'disabled-rules.ts');

const WORKER_URL = process.env['TRAINING_WORKER_URL'] ?? '';
if (!WORKER_URL) {
  console.error('TRAINING_WORKER_URL environment variable is required');
  process.exit(1);
}

const RULE_NAMES = [
  'NakedSingle', 'CellSolutionElimination', 'HiddenSingle', 'LinearElimination',
  'CageCandidateFilter', 'CageIntersection', 'SolutionMapFilter', 'MustContain',
  'MustContainOutie', 'DeltaConstraint', 'SumPairConstraint', 'NakedPair',
  'HiddenPair', 'NakedHiddenTriple', 'NakedHiddenQuad', 'PointingPairs',
  'LockedCandidates', 'CageConfinement', 'UnitPartitionFilter', 'XWing',
  'Swordfish', 'Jellyfish', 'XYWing', 'UniqueRectangle', 'SimpleColouring',
  'XYZWing', 'WWing', 'Skyscraper', 'TwoStringKite',
];

function fixtureToTs(f) {
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

async function fetchFixturesForRule(ruleName) {
  const url = `${WORKER_URL}/rule-fixtures/${ruleName}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  GET ${url} → ${res.status}, skipping`);
    return [];
  }
  return res.json();
}

async function main() {
  const fixturesContent = readFileSync(FIXTURES_FILE, 'utf8');
  const disabledContent = readFileSync(DISABLED_FILE, 'utf8');

  // Extract existing fixture names to avoid duplicates
  const existingNames = new Set(
    [...fixturesContent.matchAll(/name:\s*'([^']+)'/g)].map(m => m[1])
  );
  console.log(`Existing fixtures: ${existingNames.size}`);

  // Fetch new fixtures from R2
  let newFixtures = [];
  for (const ruleName of RULE_NAMES) {
    process.stdout.write(`Fetching rule-fixtures/${ruleName}... `);
    const fixtures = await fetchFixturesForRule(ruleName);
    const fresh = fixtures.filter(f => !existingNames.has(f.name));
    console.log(`${fixtures.length} total, ${fresh.length} new`);
    newFixtures.push(...fresh);
  }

  if (newFixtures.length === 0) {
    console.log('No new fixtures. Nothing to update.');
    return;
  }

  // Append new fixtures to index.ts (before the closing `];`)
  const insertPoint = fixturesContent.lastIndexOf('];');
  if (insertPoint < 0) {
    console.error('Could not find closing `];` in fixtures index.ts');
    process.exit(1);
  }
  const newEntries = newFixtures.map(fixtureToTs).join('\n');
  const updatedFixtures =
    fixturesContent.slice(0, insertPoint) +
    newEntries + '\n' +
    fixturesContent.slice(insertPoint);
  writeFileSync(FIXTURES_FILE, updatedFixtures);
  console.log(`Wrote ${newFixtures.length} new fixture(s) to __fixtures__/index.ts`);

  // Update disabled-rules.ts: add any rules that have fixtures and are not yet disabled
  const rulesWithNewFixtures = [...new Set(newFixtures.map(f => f.ruleName))];
  const currentDisabled = [...disabledContent.matchAll(/'([^']+)'/g)].map(m => m[1]);
  const toAdd = rulesWithNewFixtures.filter(r => !currentDisabled.includes(r));
  if (toAdd.length > 0) {
    const allDisabled = [...currentDisabled, ...toAdd];
    const newDisabledContent =
      `export const DISABLED_RULES: readonly string[] = [${allDisabled.map(r => `'${r}'`).join(', ')}];\n`;
    writeFileSync(DISABLED_FILE, newDisabledContent);
    console.log(`Added to disabled-rules.ts: ${toAdd.join(', ')}`);
  } else {
    console.log('No new rules to disable.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
