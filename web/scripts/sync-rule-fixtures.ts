#!/usr/bin/env vite-node
/**
 * Fetch new rule-bug stall fixtures from the Cloudflare Worker R2 bucket and
 * write them into web/src/engine/rules/__fixtures__/index.ts, for developers
 * to debug and turn into regression tests.
 *
 * Fixtures are deduplicated by the underlying puzzle state (see
 * `fixtureFingerprint`), since many reports describe the same stall.
 *
 * Every newly-added fixture's name is also appended to
 * `__fixtures__/needs-triage.ts`, so its regression test is skipped (via
 * `shouldSkipFixture`) until a human reviews it.
 *
 * This script never disables rules — `disabled-rules.ts` is maintained by
 * hand. A rule producing eliminations that contradict the golden solution is
 * already suppressed at runtime by SolverEngine's `onViolation` handling
 * (see session/engine.ts), so no elimination from a buggy rule is ever
 * applied; this script's job is purely to surface fixtures for debugging.
 *
 * Every fetched fixture's R2 key — new or already-synced duplicate — is
 * written to /tmp/rule-fixture-keys.txt, one per line, so the calling
 * workflow can delete them from R2 once this script's changes are committed.
 * See .github/workflows/rule-regression.yml.
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
import type { RuleBugFixture, FixtureRecord } from '../../shared/src/fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, '..');
const FIXTURES_FILE = join(WEB_ROOT, 'src', 'engine', 'rules', '__fixtures__', 'index.ts');
const NEEDS_TRIAGE_FILE = join(WEB_ROOT, 'src', 'engine', 'rules', '__fixtures__', 'needs-triage.ts');
const FETCHED_KEYS_FILE = '/tmp/rule-fixture-keys.txt';

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

async function fetchFixturesForRule(ruleName: string): Promise<FixtureRecord[]> {
  const url = `${WORKER_URL}/rule-fixtures/${ruleName}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  GET ${url} → ${res.status}, skipping`);
    return [];
  }
  return res.json() as Promise<FixtureRecord[]>;
}

/** Insert TS source just before the final `];` of a `readonly X[] = [ ... ];` array literal. */
function insertBeforeClosingBracket(content: string, entries: string): string {
  const insertPoint = content.lastIndexOf('];');
  if (insertPoint < 0) {
    console.error('Could not find closing `];`');
    process.exit(1);
  }
  return content.slice(0, insertPoint) + entries + '\n' + content.slice(insertPoint);
}

function appendFixtures(newFixtures: readonly RuleBugFixture[]): void {
  const content = readFileSync(FIXTURES_FILE, 'utf8');
  const entries = newFixtures.map(fixtureToTypeScript).join('\n');
  writeFileSync(FIXTURES_FILE, insertBeforeClosingBracket(content, entries));
}

function appendNeedsTriage(names: readonly string[]): void {
  const content = readFileSync(NEEDS_TRIAGE_FILE, 'utf8');
  const entries = names.map(name => `  ${JSON.stringify(name)},`).join('\n');
  writeFileSync(NEEDS_TRIAGE_FILE, insertBeforeClosingBracket(content, entries));
}

async function main(): Promise<void> {
  const seenFingerprints = new Set(ruleBugFixtures.map(fixtureFingerprint));
  console.log(`Existing fixtures: ${ruleBugFixtures.length}`);
  console.log(`Checking ${RULE_NAMES.length} rules from defaultRules()`);

  // Fetch fixtures from R2. Every key fetched (new or already-synced
  // duplicate) is recorded for the workflow to drain from R2 afterwards.
  const newFixtures: RuleBugFixture[] = [];
  const fetchedKeys: string[] = [];
  for (const ruleName of RULE_NAMES) {
    process.stdout.write(`Fetching rule-fixtures/${ruleName}... `);
    const records = await fetchFixturesForRule(ruleName);
    const fresh: RuleBugFixture[] = [];
    for (const { key, fixture } of records) {
      fetchedKeys.push(key);
      const fp = fixtureFingerprint(fixture);
      if (seenFingerprints.has(fp)) continue;
      seenFingerprints.add(fp);
      fresh.push(fixture);
    }
    console.log(`${records.length} total, ${fresh.length} new`);
    newFixtures.push(...fresh);
  }

  if (fetchedKeys.length > 0) {
    writeFileSync(FETCHED_KEYS_FILE, fetchedKeys.join('\n') + '\n');
    console.log(`Wrote ${fetchedKeys.length} fetched key(s) to ${FETCHED_KEYS_FILE}`);
  }

  if (newFixtures.length === 0) {
    console.log('No new fixtures. Nothing to update.');
    return;
  }

  appendFixtures(newFixtures);
  appendNeedsTriage(newFixtures.map(f => f.name));
  console.log(`Wrote ${newFixtures.length} new fixture(s) to __fixtures__/index.ts and needs-triage.ts`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
