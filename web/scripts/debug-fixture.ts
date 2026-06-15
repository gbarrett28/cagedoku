#!/usr/bin/env vite-node
/**
 * Inspect rule-bug fixture(s): replay against real cage geometry and report
 * which active rules (if any) produce a golden-contradicting elimination,
 * including cross-attribution (a rule other than fixture.ruleName).
 *
 * Usage (from web/):
 *   npx vite-node scripts/debug-fixture.ts <name-substring-or-ruleName>
 *
 * See docs/debugging-fixtures.md.
 */

import { ruleBugFixtures } from '../src/engine/rules/__fixtures__/index.js';
import { boardFromFixture } from '../src/engine/rules/__fixtures__/replay.js';
import { defaultRules } from '../src/engine/rules/index.js';
import { DISABLED_RULES } from '../src/engine/rules/disabled-rules.js';
import { findTriggerMisses } from '../src/engine/triggerValidator.js';

const query = process.argv[2];
if (!query) {
  console.error('Usage: npx vite-node scripts/debug-fixture.ts <name-substring-or-ruleName>');
  process.exit(1);
}

const matches = ruleBugFixtures.filter(f => f.name.includes(query) || f.ruleName === query);
if (matches.length === 0) {
  console.error(`No fixtures match "${query}"`);
  process.exit(1);
}

const activeRules = defaultRules().filter(r => !DISABLED_RULES.includes(r.name));

for (const fixture of matches) {
  console.log(`\n=== ${fixture.name} ===`);
  console.log(`  ruleName: ${fixture.ruleName}, source: ${fixture.source}, puzzleType: ${fixture.puzzleType}`);
  console.log(`  unsolvedCells: ${fixture.unsolvedCells}, totalCandidates: ${fixture.totalCandidates}`);

  const board = boardFromFixture(fixture);
  const { violations, misses } = findTriggerMisses(board, activeRules, fixture.goldenSolution);

  if (violations.length === 0) {
    console.log('  No golden-contradicting eliminations found.');
  } else {
    for (const v of violations) {
      const cross = v.ruleName === fixture.ruleName ? '' : ' (CROSS-ATTRIBUTION: different rule than fixture.ruleName)';
      console.log(`  VIOLATION by ${v.ruleName} at ${v.missedContext}${cross}`);
      for (const e of v.offendingEliminations) {
        console.log(`    cell [${e.cell[0]},${e.cell[1]}] digit ${e.digit}`);
      }
    }
  }

  if (misses.length > 0) {
    console.log(`  ${misses.length} trigger miss(es):`);
    for (const m of misses) {
      console.log(`    ${m.ruleName} at ${m.missedContext}: ${m.eliminations.length} elimination(s)`);
    }
  }
}
