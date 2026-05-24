/**
 * Generates "focused" stall fixtures for every committed source fixture.
 *
 * For each source fixture (processed simplest-first by unsolvedCells ASC,
 * totalCandidates ASC), this script does a single pass: it reveals each
 * unsolved cell one at a time (pinning it to the ground-truth solution value),
 * re-runs the full killer engine via solveFromCandidates, and collects every
 * distinct stall state that emerges. One pass only — no recursion into the
 * discovered focused states.
 *
 * Focused fixtures are written to web/stall-fixtures/ as
 *   <source-name>-f<NNN>.stall.json
 * where NNN is a zero-padded index assigned after sorting focused states by
 * (unsolvedCells ASC, totalCandidates ASC).
 *
 * Source fixtures with unsolvedCells >= MAX_UNSOLVED_THRESHOLD are skipped —
 * they are almost certainly corrupted by OCR misreads in the cage totals.
 *
 * Focused files are gitignored and regenerated on every CI deploy so they
 * always reflect the current rule engine.
 *
 * Run from web/:
 *   npx vite-node scripts/focus-stall-fixtures.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { solve, solveFromCandidates } from '../src/engine/index.js';
import type { StallFixtureFile } from '../src/engine/rules/stallFixtureFile.js';

const fixturesDir = path.resolve(import.meta.dirname, '..', 'stall-fixtures');
const today = new Date().toISOString().slice(0, 10);

/** Source fixtures with this many or more unsolved cells at stall are almost
 *  certainly corrupted by an OCR misread (cage totals wrong). A well-formed
 *  killer sudoku never has ≥ 50 cells unsolved after a full rule-engine pass. */
const MAX_UNSOLVED_THRESHOLD = 50;

/** Focused states with fewer than this many unsolved cells are discarded.
 *  1 unsolved cell is impossible in valid killer sudoku (the last cell is
 *  always forced by elimination), so any such state comes from a corrupted
 *  source fixture and is not a useful rule-gap example. */
const MIN_UNSOLVED_CELLS = 2;

// ---------------------------------------------------------------------------
// Load source fixtures.
// A source fixture has no '-f' substring before '.stall.json'.
// Previously generated focused fixtures are excluded so the script is
// idempotent: running it twice produces the same output.
// ---------------------------------------------------------------------------

const sourceFiles = fs
  .readdirSync(fixturesDir)
  .filter(f => f.endsWith('.stall.json') && !f.includes('-f'))
  .sort();

const sourceFixtures: StallFixtureFile[] = sourceFiles.map(f =>
  JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf-8')) as StallFixtureFile,
);

// Process simplest first so the most targeted fixtures are generated first.
sourceFixtures.sort(
  (a, b) => a.unsolvedCells - b.unsolvedCells || a.totalCandidates - b.totalCandidates,
);

console.log(`Processing ${sourceFixtures.length} source fixtures (skip if ≥${MAX_UNSOLVED_THRESHOLD} unsolved)...`);

let totalWritten = 0;

for (const fixture of sourceFixtures) {
  // Skip fixtures with suspiciously many unsolved cells — OCR error in cage totals.
  if (fixture.unsolvedCells >= MAX_UNSOLVED_THRESHOLD) {
    console.log(`  ${fixture.name}: SKIPPED (${fixture.unsolvedCells} unsolved — likely OCR error)`);
    continue;
  }

  process.stdout.write(`  ${fixture.name} (${fixture.unsolvedCells} unsolved)... `);

  // -----------------------------------------------------------------------
  // 1. Get the ground-truth solution via the full solver (uses backtracking).
  //    After solve(), every cell in result.board.cands(r, c) is a single-
  //    element set containing the correct digit.
  // -----------------------------------------------------------------------
  const solutionResult = solve(fixture.spec);
  const solution: number[][] = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => [...solutionResult.board.cands(r, c)][0]!),
  );

  // -----------------------------------------------------------------------
  // 2. Single pass: pin each unsolved cell to its solution value, re-run the
  //    engine, and collect any new stall states that emerge.
  //
  //    seen    — canonical JSON keys for deduplication across pins.
  //    focused — collected stall states to write.
  // -----------------------------------------------------------------------
  const seen = new Set<string>();
  const focused: Array<{ sc: number[][][]; unsolvedCells: number; totalCandidates: number }> = [];

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if ((fixture.stalledCandidates[r]![c]!).length <= 1) continue; // already solved

      // Pin this cell to its ground-truth digit.
      const pinned: number[][][] = fixture.stalledCandidates.map(row => row.map(cell => [...cell]));
      pinned[r]![c] = [solution[r]![c]!];

      const result = solveFromCandidates(fixture.spec, pinned);
      if (!result.usedBacktracking) continue; // pin solved the puzzle

      const sc = result.stalledCandidates!;
      const key = JSON.stringify(sc);
      if (seen.has(key)) continue;

      seen.add(key);
      const unsolvedCells = sc.flat().filter(cell => cell.length > 1).length;
      if (unsolvedCells < MIN_UNSOLVED_CELLS) continue; // impossible in valid sudoku — OCR artifact
      const totalCandidates = sc
        .flat()
        .filter(cell => cell.length > 1)
        .reduce((sum, cell) => sum + cell.length, 0);
      focused.push({ sc, unsolvedCells, totalCandidates });
    }
  }

  if (focused.length === 0) {
    console.log('none');
    continue;
  }

  // -----------------------------------------------------------------------
  // 3. Sort by (unsolvedCells ASC, totalCandidates ASC) for stable indices.
  // -----------------------------------------------------------------------
  focused.sort((a, b) => a.unsolvedCells - b.unsolvedCells || a.totalCandidates - b.totalCandidates);

  // -----------------------------------------------------------------------
  // 4. Write focused fixtures to web/stall-fixtures/.
  // -----------------------------------------------------------------------
  focused.forEach(({ sc, unsolvedCells, totalCandidates }, idx) => {
    const idxStr = String(idx).padStart(3, '0');
    const name = `${fixture.name}-f${idxStr}`;
    const focusedFixture: StallFixtureFile = {
      version: 1,
      source: 'focused',
      name,
      addedAt: today,
      puzzleType: fixture.puzzleType,
      spec: fixture.spec,
      stalledCandidates: sc,
      unsolvedCells,
      totalCandidates,
    };
    const outPath = path.join(fixturesDir, `${name}.stall.json`);
    fs.writeFileSync(outPath, JSON.stringify(focusedFixture, null, 2));
  });

  console.log(`${focused.length} focused state(s)`);
  totalWritten += focused.length;
}

console.log(`\nDone. ${totalWritten} focused fixtures written across ${sourceFixtures.length} source fixtures.`);
