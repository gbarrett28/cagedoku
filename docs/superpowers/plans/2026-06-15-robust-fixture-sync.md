# Robust Rule-Bug Fixture Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the nightly "Sync rule-bug fixtures" workflow from failing forever whenever a freshly-reported fixture currently fails its own regression test, and drain the R2 bucket of fixtures once they've been safely committed.

**Architecture:** The worker's `GET /rule-fixtures/:ruleName` now returns each fixture paired with its R2 key. The sync script unconditionally records every newly-seen fixture's name in a new `needs-triage.ts` skip-list (checked by a new `shouldSkipFixture` helper used in `regression.test.ts`), so the bronze gate always passes for fixture-related reasons. After a successful commit/push, a new workflow step deletes every fetched fixture (new and duplicate) from R2 via the existing `_r2_delete.py` script and `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` secrets.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers + Miniflare, GitHub Actions, Python/boto3 (`scripts/_r2_delete.py`).

---

## Task 1: Add `FixtureRecord` type to shared fixture module

**Files:**
- Modify: `shared/src/fixture.ts`

- [ ] **Step 1: Add the `FixtureRecord` interface**

Open `shared/src/fixture.ts`. After the closing brace of the `RuleBugFixture` interface (after line 26, before the `fixtureFingerprint` function), add:

```ts
/**
 * One fixture as returned by `GET /rule-fixtures/:ruleName`, paired with its
 * R2 object key so a sync can delete it from R2 once it has been committed.
 */
export interface FixtureRecord {
  readonly key: string;
  readonly fixture: RuleBugFixture;
}
```

- [ ] **Step 2: Type-check**

Run from repo root:
```bash
cd web && npx tsc --noEmit
```
Expected: no errors (the new type isn't used yet, so this just confirms the file still parses).

- [ ] **Step 3: Commit**

```bash
git add shared/src/fixture.ts
git commit -m "feat: add FixtureRecord type for keyed fixture sync"
```

---

## Task 2: Worker GET /rule-fixtures/:ruleName returns `{key, fixture}[]`

**Files:**
- Modify: `worker/src/index.ts`
- Test: `worker/src/index.test.ts`

- [ ] **Step 1: Update the failing test first**

In `worker/src/index.test.ts`, replace the existing test (around line 156):

```ts
  it('GET /rule-fixtures/:ruleName returns 200 with JSON array', async () => {
    const env = await makeEnv();
    await env.TRAINING_BUCKET.put('rule-fixtures/TwoStringKite/fix-1.json', JSON.stringify({ name: 'fix-1' }));

    const req = new Request('https://worker.example.com/rule-fixtures/TwoStringKite', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({ name: 'fix-1' });
  });
```

with:

```ts
  it('GET /rule-fixtures/:ruleName returns 200 with an array of {key, fixture}', async () => {
    const env = await makeEnv();
    await env.TRAINING_BUCKET.put('rule-fixtures/TwoStringKite/fix-1.json', JSON.stringify({ name: 'fix-1' }));

    const req = new Request('https://worker.example.com/rule-fixtures/TwoStringKite', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { key: string; fixture: unknown }[];
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({ key: 'rule-fixtures/TwoStringKite/fix-1.json', fixture: { name: 'fix-1' } });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd worker && npm test -- -t "GET /rule-fixtures"
```
Expected: FAIL — `body[0]` is `{ name: 'fix-1' }`, not `{ key: ..., fixture: { name: 'fix-1' } }`.

- [ ] **Step 3: Update the worker handler**

In `worker/src/index.ts`, replace the GET handler (lines 37–53):

```ts
    // GET /rule-fixtures/:ruleName — list R2 fixtures for the named rule.
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/rule-fixtures\/([A-Za-z0-9_-]+)$/);
      if (!match) return new Response('Not found', { status: 404 });
      const ruleName = match[1]!;
      const listed = await env.TRAINING_BUCKET.list({ prefix: `rule-fixtures/${ruleName}/` });
      const fixtures: unknown[] = [];
      for (const obj of listed.objects) {
        const r2obj = await env.TRAINING_BUCKET.get(obj.key);
        if (r2obj) fixtures.push(await r2obj.json());
      }
      return new Response(JSON.stringify(fixtures), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
```

with:

```ts
    // GET /rule-fixtures/:ruleName — list R2 fixtures for the named rule,
    // each paired with its R2 key so a later sync can delete it once committed.
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/rule-fixtures\/([A-Za-z0-9_-]+)$/);
      if (!match) return new Response('Not found', { status: 404 });
      const ruleName = match[1]!;
      const listed = await env.TRAINING_BUCKET.list({ prefix: `rule-fixtures/${ruleName}/` });
      const records: { key: string; fixture: unknown }[] = [];
      for (const obj of listed.objects) {
        const r2obj = await env.TRAINING_BUCKET.get(obj.key);
        if (r2obj) records.push({ key: obj.key, fixture: await r2obj.json() });
      }
      return new Response(JSON.stringify(records), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd worker && npm test
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.ts worker/src/index.test.ts
git commit -m "feat: worker GET /rule-fixtures returns {key, fixture} pairs"
```

---

## Task 3: Create the `needs-triage.ts` skip-list

**Files:**
- Create: `web/src/engine/rules/__fixtures__/needs-triage.ts`

- [ ] **Step 1: Create the file**

```ts
/**
 * Fixture names freshly synced from R2, not yet reviewed by a human.
 *
 * Populated automatically by `npx vite-node web/scripts/sync-rule-fixtures.ts`.
 * During periodic review of each entry: remove it if the fixture's rule now
 * produces no golden-contradicting elimination (it becomes a live regression
 * test); move it to `KNOWN_FAILING_FIXTURES` in `regression.test.ts` if
 * there's a real, still-open rule bug worth tracking; or delete the fixture
 * entry from `index.ts` entirely if it's unactionable — its R2 copy has
 * already been deleted by the sync workflow, so it cannot resurface.
 */
export const NEEDS_TRIAGE_FIXTURES: readonly string[] = [];
```

- [ ] **Step 2: Type-check**

```bash
cd web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/engine/rules/__fixtures__/needs-triage.ts
git commit -m "feat: add needs-triage fixture skip-list"
```

---

## Task 4: Add `shouldSkipFixture` policy helper (TDD)

**Files:**
- Create: `web/src/engine/rules/__fixtures__/skipPolicy.ts`
- Test: `web/src/engine/rules/__fixtures__/skipPolicy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/engine/rules/__fixtures__/skipPolicy.test.ts`:

```ts
/**
 * Tests for shouldSkipFixture.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RuleBugFixture } from '../../../../../shared/src/fixture.js';
import type { SolverRule } from '../../rule.js';

vi.mock('./needs-triage.js', () => ({
  NEEDS_TRIAGE_FIXTURES: ['Triage-r2-2026-01-01T00-00-00-000Z'],
}));

import { shouldSkipFixture } from './skipPolicy.js';

function makeFixture(overrides: Partial<RuleBugFixture> = {}): RuleBugFixture {
  return {
    version: 2,
    source: 'r2',
    name: 'Example-r2-2026-01-01T00-00-00-000Z',
    addedAt: '2026-01-01',
    ruleName: 'NakedPair',
    puzzleType: 'classic',
    state: null,
    ...overrides,
  };
}

const nakedPairRule = { name: 'NakedPair' } as SolverRule;

describe('shouldSkipFixture', () => {
  it('skips when no matching rule is found', () => {
    expect(shouldSkipFixture(makeFixture(), undefined, [])).toBe(true);
  });

  it('does not skip a fixture with a matching rule and no triage/known-failing entry', () => {
    expect(shouldSkipFixture(makeFixture(), nakedPairRule, [])).toBe(false);
  });

  it('skips a fixture listed in knownFailingFixtures', () => {
    const fixture = makeFixture({ name: 'KnownBad-r2-2026-01-01T00-00-00-000Z' });
    expect(shouldSkipFixture(fixture, nakedPairRule, ['KnownBad-r2-2026-01-01T00-00-00-000Z'])).toBe(true);
  });

  it('skips a fixture for a globally disabled rule', () => {
    const fixture = makeFixture({ ruleName: 'UniqueRectangle' });
    const rule = { name: 'UniqueRectangle' } as SolverRule;
    expect(shouldSkipFixture(fixture, rule, [])).toBe(true);
  });

  it('skips a fixture listed in NEEDS_TRIAGE_FIXTURES', () => {
    const fixture = makeFixture({ name: 'Triage-r2-2026-01-01T00-00-00-000Z' });
    expect(shouldSkipFixture(fixture, nakedPairRule, [])).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd web && npx vitest run src/engine/rules/__fixtures__/skipPolicy.test.ts
```
Expected: FAIL — `skipPolicy.ts` (and `./needs-triage.js`, already created in Task 3) — the import of `shouldSkipFixture` from `./skipPolicy.js` fails because the module doesn't exist yet.

- [ ] **Step 3: Implement `skipPolicy.ts`**

Create `web/src/engine/rules/__fixtures__/skipPolicy.ts`:

```ts
/**
 * Shared skip policy for rule-bug fixture regression tests.
 */

import type { RuleBugFixture } from '../../../../../shared/src/fixture.js';
import type { SolverRule } from '../../rule.js';
import { DISABLED_RULES } from '../disabled-rules.js';
import { NEEDS_TRIAGE_FIXTURES } from './needs-triage.js';

/**
 * Whether a rule-bug fixture's regression test should be skipped: no matching
 * rule, the rule is globally disabled, the fixture has a tracked open bug
 * (`knownFailingFixtures`), or it's freshly synced and not yet triaged.
 */
export function shouldSkipFixture(
  fixture: RuleBugFixture,
  rule: SolverRule | undefined,
  knownFailingFixtures: readonly string[],
): boolean {
  return !rule
    || DISABLED_RULES.includes(fixture.ruleName)
    || knownFailingFixtures.includes(fixture.name)
    || NEEDS_TRIAGE_FIXTURES.includes(fixture.name);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web && npx vitest run src/engine/rules/__fixtures__/skipPolicy.test.ts
```
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/engine/rules/__fixtures__/skipPolicy.ts web/src/engine/rules/__fixtures__/skipPolicy.test.ts
git commit -m "feat: add shouldSkipFixture policy helper"
```

---

## Task 5: Use `shouldSkipFixture` in `regression.test.ts`

**Files:**
- Modify: `web/src/engine/rules/__fixtures__/regression.test.ts`

- [ ] **Step 1: Update the skip logic**

Replace the full contents of `web/src/engine/rules/__fixtures__/regression.test.ts`:

```ts
/**
 * Generic regression gate for rule-bug fixtures: replays each fixture's
 * serialized session against its own rule and asserts no
 * golden-contradicting elimination. See docs/debugging-fixtures.md.
 */

import { describe, expect, it } from 'vitest';
import { ruleBugFixtures } from './index.js';
import { boardFromFixture } from './replay.js';
import { defaultRules } from '../index.js';
import { findTriggerMisses } from '../../triggerValidator.js';
import { shouldSkipFixture } from './skipPolicy.js';

/**
 * Fixtures with a known, still-reproducing violation in their own rule,
 * tracked as a separate bug rather than blocking this generic gate.
 *
 * Remove an entry once the underlying rule bug is fixed.
 */
const KNOWN_FAILING_FIXTURES: readonly string[] = [];

describe('rule-bug fixture regression', () => {
  if (ruleBugFixtures.length === 0) {
    it.skip('no fixtures recorded', () => {});
  }

  const rules = defaultRules();
  for (const fixture of ruleBugFixtures) {
    const rule = rules.find(r => r.name === fixture.ruleName);
    const itFixture = shouldSkipFixture(fixture, rule, KNOWN_FAILING_FIXTURES) ? it.skip : it;
    itFixture(`${fixture.name}: ${fixture.ruleName} produces no golden-contradicting elimination`, () => {
      const { board, state } = boardFromFixture(fixture);
      const { violations } = findTriggerMisses(board, [rule!], state.goldenSolution);
      expect(violations).toEqual([]);
    });
  }
});
```

This is a behavior-preserving refactor (the same four conditions are now
evaluated by `shouldSkipFixture`, plus the new `NEEDS_TRIAGE_FIXTURES` check).
`ruleBugFixtures` is currently empty, so the only observable test is the
`it.skip('no fixtures recorded', ...)` placeholder — unchanged.

- [ ] **Step 2: Run the full web test suite**

```bash
cd web && npm test
```
Expected: all tests PASS (same count as before this task).

- [ ] **Step 3: Commit**

```bash
git add web/src/engine/rules/__fixtures__/regression.test.ts
git commit -m "refactor: regression.test.ts uses shouldSkipFixture"
```

---

## Task 6: Rewrite `sync-rule-fixtures.ts`

**Files:**
- Modify: `web/scripts/sync-rule-fixtures.ts`

This script is CI-only (no unit tests); verification is via `tsc` and a manual
dry run against a fake worker response shape.

- [ ] **Step 1: Replace the file contents**

Replace the full contents of `web/scripts/sync-rule-fixtures.ts`:

```ts
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
```

- [ ] **Step 2: Type-check**

```bash
cd web && npx tsc -p tsconfig.node.json --noEmit
```
Expected: no errors.

- [ ] **Step 3: Manual dry run against a fake worker**

Verify the script's fetch/parse/write logic end-to-end without needing real
credentials, using Node's built-in `http` module as a stub worker:

```bash
cd /home/user/cagedoku
node --input-type=module -e "
import http from 'node:http';
const fixture = {
  version: 2, source: 'r2', name: 'DryRun-r2-2026-01-01T00-00-00-000Z',
  addedAt: '2026-01-01', ruleName: 'NakedPair', puzzleType: 'classic', state: null,
};
const server = http.createServer((req, res) => {
  if (req.url === '/rule-fixtures/NakedPair') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ key: 'rule-fixtures/NakedPair/dry-run.json', fixture }]));
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end('[]');
  }
});
server.listen(8787, () => console.log('stub worker on :8787'));
" &
sleep 1
TRAINING_WORKER_URL=http://localhost:8787 npx vite-node web/scripts/sync-rule-fixtures.ts
kill %1
```

Expected output includes:
```
Fetching rule-fixtures/NakedPair... 1 total, 1 new
Wrote N fetched key(s) to /tmp/rule-fixture-keys.txt
Wrote 1 new fixture(s) to __fixtures__/index.ts and needs-triage.ts
```

Then inspect the results:
```bash
cat /tmp/rule-fixture-keys.txt
tail -5 web/src/engine/rules/__fixtures__/index.ts
tail -5 web/src/engine/rules/__fixtures__/needs-triage.ts
```

`/tmp/rule-fixture-keys.txt` should contain `rule-fixtures/NakedPair/dry-run.json`
(and similar lines for every other rule, since the stub returns `[]` for them
— giving 0 fetched keys for those). `index.ts` should have a new entry with
`name: 'DryRun-r2-2026-01-01T00-00-00-000Z'`, and `needs-triage.ts` should have
`'DryRun-r2-2026-01-01T00-00-00-000Z'` in its array.

**Revert the dry-run changes** (they were only to verify the script):

```bash
git checkout web/src/engine/rules/__fixtures__/index.ts web/src/engine/rules/__fixtures__/needs-triage.ts
rm -f /tmp/rule-fixture-keys.txt
```

- [ ] **Step 4: Run the full web test suite**

```bash
cd web && npm test
```
Expected: all tests PASS (index.ts/needs-triage.ts are back to their committed state).

- [ ] **Step 5: Commit**

```bash
git add web/scripts/sync-rule-fixtures.ts
git commit -m "feat: sync-rule-fixtures writes needs-triage + R2 key manifest"
```

---

## Task 7: Drain R2 after a successful sync

**Files:**
- Modify: `.github/workflows/rule-regression.yml`

- [ ] **Step 1: Update the workflow**

Replace the full contents of `.github/workflows/rule-regression.yml`:

```yaml
name: Sync rule-bug fixtures

on:
  schedule:
    # Run nightly at 03:00 UTC
    - cron: '0 3 * * *'
  # Allow manual trigger from the Actions tab
  workflow_dispatch:

permissions:
  contents: write

jobs:
  sync-rule-fixtures:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          # Push back to master; needs a token with write access
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: web/package-lock.json

      - name: Install dependencies
        working-directory: web
        run: npm ci

      - name: Fetch new fixtures from worker
        env:
          TRAINING_WORKER_URL: ${{ secrets.TRAINING_WORKER_URL }}
        run: npx vite-node web/scripts/sync-rule-fixtures.ts

      - name: Bronze gate
        working-directory: web
        run: |
          npx tsc --noEmit
          npx tsc -p tsconfig.node.json --noEmit
          npm test

      - name: Commit and push
        run: |
          git config user.email "actions@github.com"
          git config user.name "GitHub Actions"
          git add web/src/engine/rules/__fixtures__/index.ts web/src/engine/rules/__fixtures__/needs-triage.ts
          if git diff --cached --quiet; then
            echo "Nothing to commit."
          else
            git commit -m "chore: sync rule-bug fixtures"
            git push
          fi

      - name: Set up Python
        if: success()
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Drain synced fixtures from R2
        if: success()
        env:
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
        run: |
          if [ -s /tmp/rule-fixture-keys.txt ]; then
            pip install --quiet boto3
            python3 scripts/_r2_delete.py cagedoku-training < /tmp/rule-fixture-keys.txt
          else
            echo "No fixtures fetched; nothing to drain."
          fi
```

Changes from the current file:
- "Commit and push" now also stages `needs-triage.ts`.
- Two new steps run `if: success()` (i.e. only when the bronze gate and commit
  step both succeeded): set up Python, then delete every fixture key recorded
  in `/tmp/rule-fixture-keys.txt` from R2 via the existing `_r2_delete.py`
  script and `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` secrets (same secrets
  already used by `retrain.yml` and `puzzle-spec-review.yml`).

- [ ] **Step 2: Validate YAML syntax**

```bash
cd /home/user/cagedoku && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/rule-regression.yml'))" && echo OK
```
Expected: `OK`. (If `pyyaml` isn't installed: `pip install --quiet pyyaml` first.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/rule-regression.yml
git commit -m "feat: drain synced rule-bug fixtures from R2 after successful sync"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run the bronze gate**

```bash
bash scripts/run-bronze-gate.sh
```
Expected: `tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, and `npm test`
(both `web/` and `worker/`, if the script covers both — otherwise run
`cd worker && npm test` separately) all pass.

- [ ] **Step 2: Run worker tests explicitly**

```bash
cd worker && npm test
```
Expected: all PASS, including the updated `GET /rule-fixtures/:ruleName` test.

- [ ] **Step 3: Confirm working tree is clean**

```bash
git status --short
```
Expected: empty (everything committed in Tasks 1–7).
