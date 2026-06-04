/**
 * kernelise-stall-fixtures.ts
 *
 * One-time migration script: for each *.stall.json in web/stall-fixtures/,
 * run kernel analysis and replace the file with per-kernel fixture files.
 *
 * Usage: npx vite-node scripts/kernelise-stall-fixtures.ts
 *
 * A kernel is a stall state from which no further single-cell pin creates a
 * new distinct stall — the fully-constrained "hard core" of the puzzle.
 * Kernels are strictly better fixtures than the raw stall: they represent the
 * hardest remaining position and avoid inflating the hard list with the same
 * puzzle at different levels of constraint.
 *
 * If no kernels are found (budget exhausted), the original file is left as-is.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solve } from '../src/engine/index.js';
import { analyseKernels } from '../src/engine/kernelAnalysis.js';
import type { StallFixtureFile } from '../src/engine/rules/stallFixtureFile.js';

/** Generous budget — this runs offline, not in a real-time browser session. */
const KERNEL_BUDGET = 10_000;

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../stall-fixtures',
);

const fixtureFiles = fs
  .readdirSync(fixturesDir)
  .filter(f => f.endsWith('.stall.json'));

if (fixtureFiles.length === 0) {
  console.log('No stall fixtures found — nothing to do.');
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
let converted = 0;
let skipped = 0;

for (const filename of fixtureFiles) {
  const filePath = path.join(fixturesDir, filename);
  const fixture = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StallFixtureFile;

  // Obtain the solution — needed by analyseKernels to know which digit to pin.
  const solveResult = solve(fixture.spec, fixture.givenDigits?.map(row => [...row]));
  const solution: number[][] = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => [...solveResult.board.cands(r, c)][0]!),
  );

  console.log(`\n${fixture.name}: running kernel analysis (budget=${KERNEL_BUDGET})…`);
  const kernelResult = analyseKernels(
    fixture.spec,
    fixture.stalledCandidates,
    solution,
    KERNEL_BUDGET,
  );

  if (kernelResult.budgetExhausted) {
    console.warn(`  budget exhausted after ${kernelResult.nodesExplored} nodes — leaving original`);
    skipped++;
    continue;
  }

  if (kernelResult.kernelStates.length === 0) {
    console.log(`  no kernels found — leaving original`);
    skipped++;
    continue;
  }

  console.log(`  found ${kernelResult.kernelStates.length} kernel(s)`);

  // Write one fixture per kernel, then delete the original.
  for (let i = 0; i < kernelResult.kernelStates.length; i++) {
    const ks = kernelResult.kernelStates[i]!;
    const kernelName = `${fixture.name}-k${i + 1}`;
    const unsolvedCells = ks.flat().filter(c => c.length > 1).length;
    const totalCandidates = ks.flat()
      .filter(c => c.length > 1)
      .reduce((sum, c) => sum + c.length, 0);

    const kernelFixture: StallFixtureFile = {
      version: 1,
      source: fixture.source,
      name: kernelName,
      addedAt: today,
      puzzleType: fixture.puzzleType,
      ...(fixture.imagePath !== undefined && { imagePath: fixture.imagePath }),
      spec: fixture.spec,
      ...(fixture.givenDigits !== undefined && { givenDigits: fixture.givenDigits }),
      stalledCandidates: ks,
      unsolvedCells,
      totalCandidates,
    };

    const outPath = path.join(fixturesDir, `${kernelName}.stall.json`);
    fs.writeFileSync(outPath, JSON.stringify(kernelFixture, null, 2));
    console.log(`  wrote ${kernelName} (${unsolvedCells} unsolved, ${totalCandidates} candidates)`);
  }

  fs.unlinkSync(filePath);
  console.log(`  deleted original: ${filename}`);
  converted++;
}

console.log(`\nDone. ${converted} fixture(s) kernelised, ${skipped} left as-is.`);
