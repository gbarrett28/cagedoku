#!/usr/bin/env vite-node
/**
 * Fetch new rule-bug stall fixtures from the Cloudflare Worker R2 bucket and
 * write them into web/src/engine/rules/__fixtures__/index.ts.
 *
 * Also updates web/src/engine/rules/disabled-rules.ts to include any rule that
 * has at least one fixture (so the rule is excluded from deployed builds until
 * a developer fixes it and removes its name from the disabled list).
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
import { fixtureToTypeScript } from '../../shared/src/fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, '..');
const FIXTURES_FILE = join(WEB_ROOT, 'src', 'engine', 'rules', '__fixtures__', 'index.ts');
const DISABLED_FILE = join(WEB_ROOT, 'src', 'engine', 'rules', 'disabled-rules.ts');

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

async function fetchFixturesForRule(ruleName: string): Promise<unknown[]> {
  const url = `${WORKER_URL}/rule-fixtures/${ruleName}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  GET ${url} → ${res.status}, skipping`);
    return [];
  }
  return res.json() as Promise<unknown[]>;
}

async function main(): Promise<void> {
  const fixturesContent = readFileSync(FIXTURES_FILE, 'utf8');
  const disabledContent = readFileSync(DISABLED_FILE, 'utf8');

  // Extract existing fixture names to avoid duplicates
  const existingNames = new Set(
    [...fixturesContent.matchAll(/name:\s*'([^']+)'/g)].map(m => m[1]),
  );
  console.log(`Existing fixtures: ${existingNames.size}`);
  console.log(`Checking ${RULE_NAMES.length} rules from defaultRules()`);

  // Fetch new fixtures from R2
  const newFixtures: unknown[] = [];
  for (const ruleName of RULE_NAMES) {
    process.stdout.write(`Fetching rule-fixtures/${ruleName}... `);
    const fixtures = await fetchFixturesForRule(ruleName);
    const fresh = (fixtures as Array<{ name: string }>).filter(f => !existingNames.has(f.name));
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
  const newEntries = (newFixtures as Parameters<typeof fixtureToTypeScript>[0][]).map(fixtureToTypeScript).join('\n');
  const updatedFixtures =
    fixturesContent.slice(0, insertPoint) +
    newEntries + '\n' +
    fixturesContent.slice(insertPoint);
  writeFileSync(FIXTURES_FILE, updatedFixtures);
  console.log(`Wrote ${newFixtures.length} new fixture(s) to __fixtures__/index.ts`);

  // Update disabled-rules.ts: only disable rules that have source:'r2' fixtures (wrong eliminations
  // proved by the golden solution). trigger-miss fixtures mean a predecessor rule failed to set a
  // trigger — the named rule itself is correct and must not be disabled.
  const ruleBugFixtures = (newFixtures as Array<{ source: string; ruleName: string }>).filter(f => f.source === 'r2');
  const rulesWithNewFixtures = [...new Set(ruleBugFixtures.map(f => f.ruleName))];
  const currentDisabled = [...disabledContent.matchAll(/'([^']+)'/g)].map(m => m[1] as string);
  const toAdd = rulesWithNewFixtures.filter(r => !currentDisabled.includes(r));
  if (toAdd.length > 0) {
    const allDisabled = [...currentDisabled, ...toAdd];
    const replacement = `export const DISABLED_RULES: readonly string[] = [${allDisabled.map(r => `'${r}'`).join(', ')}];`;
    const newDisabledContent = disabledContent.replace(
      /export const DISABLED_RULES: readonly string\[\] = \[.*?\];/s,
      replacement,
    );
    writeFileSync(DISABLED_FILE, newDisabledContent);
    console.log(`Added to disabled-rules.ts: ${toAdd.join(', ')}`);
  } else {
    console.log('No new rules to disable.');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
