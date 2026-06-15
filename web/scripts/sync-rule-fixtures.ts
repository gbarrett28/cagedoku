#!/usr/bin/env vite-node
/**
 * Fetch new rule-bug stall fixtures from the Cloudflare Worker R2 bucket and
 * write them into web/src/engine/rules/__fixtures__/index.ts, for developers
 * to debug and turn into regression tests.
 *
 * Fixtures are deduplicated by the underlying puzzle state (see
 * `fixtureFingerprint`), since many reports describe the same stall.
 *
 * This script never disables rules — `disabled-rules.ts` is maintained by
 * hand. A rule producing eliminations that contradict the golden solution is
 * already suppressed at runtime by SolverEngine's `onViolation` handling
 * (see session/engine.ts), so no elimination from a buggy rule is ever
 * applied; this script's job is purely to surface fixtures for debugging.
 *
 * Usage (from the repo root):
 *   TRAINING_WORKER_URL=https://... npx vite-node web/scripts/sync-rule-fixtures.ts
 *
 * The TRAINING_WORKER_URL env var must point to the Cloudflare Worker's base URL.
 * Rule names are derived dynamically from defaultRules() — no hardcoded list.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRules } from '../src/engine/rules/index.js';
import { ruleBugFixtures } from '../src/engine/rules/__fixtures__/index.js';
import { fixtureToTypeScript, fixtureFingerprint } from '../../shared/src/fixture.js';
import type { RuleBugFixture } from '../../shared/src/fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, '..');
const FIXTURES_FILE = join(WEB_ROOT, 'src', 'engine', 'rules', '__fixtures__', 'index.ts');

const WORKER_URL = process.env['TRAINING_WORKER_URL'] ?? '';
if (!WORKER_URL) {
  console.error('TRAINING_WORKER_URL environment variable is required');
  process.exit(1);
}

// CellSolutionElimination was merged into NakedSingle (87ec19b); never fetch its
// fixtures because the regression test structure doesn't apply to propagation-only rules.
const EXCLUDED_FROM_SYNC = new Set(['CellSolutionElimination']);

const RULE_NAMES = defaultRules()
  .map(r => r.name)
  .filter(n => !EXCLUDED_FROM_SYNC.has(n));

async function fetchFixturesForRule(ruleName: string): Promise<RuleBugFixture[]> {
  const url = `${WORKER_URL}/rule-fixtures/${ruleName}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  GET ${url} → ${res.status}, skipping`);
    return [];
  }
  return res.json() as Promise<RuleBugFixture[]>;
}

async function main(): Promise<void> {
  const fixturesContent = readFileSync(FIXTURES_FILE, 'utf8');

  const seenFingerprints = new Set(ruleBugFixtures.map(fixtureFingerprint));
  console.log(`Existing fixtures: ${ruleBugFixtures.length}`);
  console.log(`Checking ${RULE_NAMES.length} rules from defaultRules()`);

  // Fetch new fixtures from R2, deduplicating by puzzle state.
  const newFixtures: RuleBugFixture[] = [];
  for (const ruleName of RULE_NAMES) {
    process.stdout.write(`Fetching rule-fixtures/${ruleName}... `);
    const fixtures = await fetchFixturesForRule(ruleName);
    const fresh: RuleBugFixture[] = [];
    for (const f of fixtures) {
      const fp = fixtureFingerprint(f);
      if (seenFingerprints.has(fp)) continue;
      seenFingerprints.add(fp);
      fresh.push(f);
    }
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
  const newEntries = newFixtures.map(fixtureToTypeScript).join('\n');
  const updatedFixtures =
    fixturesContent.slice(0, insertPoint) +
    newEntries + '\n' +
    fixturesContent.slice(insertPoint);
  writeFileSync(FIXTURES_FILE, updatedFixtures);
  console.log(`Wrote ${newFixtures.length} new fixture(s) to __fixtures__/index.ts`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
