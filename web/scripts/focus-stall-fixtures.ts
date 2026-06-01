/**
 * Generates "focused" stall fixtures for every committed source fixture.
 *
 * For each source fixture, this script performs a BFS (breadth-first search)
 * over the space of stall states reachable by pinning one unsolved cell at a
 * time to its ground-truth solution value and re-running the full killer engine.
 *
 * The BFS finds "kernel" states — stall states where no single-cell pin
 * produces a new (distinct) stall state. Every pin from a kernel either solves
 * the puzzle outright or reaches an already-discovered stall state. These are
 * the most focused, hardest-to-crack positions in the fixture's solving tree.
 *
 * Kernel fixtures are written to web/stall-fixtures/ as
 *   <source-name>-f<NNN>.stall.json
 * where NNN is a zero-padded index assigned after sorting kernel states by
 * (unsolvedCells ASC, totalCandidates ASC).
 *
 * Source fixtures are skipped when:
 *  - unsolvedCells >= MAX_UNSOLVED_THRESHOLD (almost certainly corrupted cage totals), or
 *  - stalledCandidates have a unit conflict — two solved cells in the same row, column,
 *    or box share a digit, meaning cage rules double-placed it due to an OCR error.
 *    Such boards are ambiguous: after pinning all but one cell, the last cell retains
 *    two "valid" candidates that CellSolutionElimination cannot eliminate, because the
 *    duplicated digit was never absent from the unit. These are not genuine rule gaps.
 *  - spec has two non-zero cage-head cells in the same region (hasMultipleCageTotals).
 *    This indicates an OCR error where a digit was read from an adjacent cage and placed
 *    inside an existing cage's region. The cage rules operate on structurally invalid
 *    totals, so any stall state is not a genuine rule gap.
 *  - the puzzle has multiple valid solutions. Classic puzzles with OCR-dropped given
 *    digits may be under-constrained; excluding any one solution digit from an unsolved
 *    cell still leads to a fully-solved board, meaning a second solution exists.
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
import { hasMultipleCageTotals } from '../src/image/validation.js';

const fixturesDir = path.resolve(import.meta.dirname, '..', 'stall-fixtures');
const today = new Date().toISOString().slice(0, 10);

/** Source fixtures with this many or more unsolved cells at stall are almost
 *  certainly corrupted by an OCR misread (cage totals wrong). A well-formed
 *  killer sudoku never has ≥ 50 cells unsolved after a full rule-engine pass. */
const MAX_UNSOLVED_THRESHOLD = 50;

/**
 * Returns true if any row, column, or box contains two solved cells (length === 1)
 * with the same digit. This indicates a corrupted source fixture: OCR-wrong cage
 * totals caused cage rules to place the same digit twice in a unit.
 *
 * Why this matters for focused generation: when a unit has a duplicated solved digit,
 * the missing digit is never confirmed in that unit. After pinning all but one cell,
 * the last unsolved cell retains two valid candidates (neither the duplicated digit
 * nor the missing one can be eliminated by CellSolutionElimination). The rule engine
 * stalls with 1 unsolved cell — not a real rule gap, just an ambiguous corrupted state.
 */
function hasUnitConflict(candidates: number[][][]): boolean {
  // Rows
  for (let r = 0; r < 9; r++) {
    const seen = new Set<number>();
    for (let c = 0; c < 9; c++) {
      const cell = candidates[r]![c]!;
      if (cell.length !== 1) continue;
      const d = cell[0]!;
      if (seen.has(d)) return true;
      seen.add(d);
    }
  }
  // Columns
  for (let c = 0; c < 9; c++) {
    const seen = new Set<number>();
    for (let r = 0; r < 9; r++) {
      const cell = candidates[r]![c]!;
      if (cell.length !== 1) continue;
      const d = cell[0]!;
      if (seen.has(d)) return true;
      seen.add(d);
    }
  }
  // Boxes
  for (let b = 0; b < 9; b++) {
    const seen = new Set<number>();
    const rOff = Math.floor(b / 3) * 3;
    const cOff = (b % 3) * 3;
    for (let dr = 0; dr < 3; dr++) {
      for (let dc = 0; dc < 3; dc++) {
        const cell = candidates[rOff + dr]![cOff + dc]!;
        if (cell.length !== 1) continue;
        const d = cell[0]!;
        if (seen.has(d)) return true;
        seen.add(d);
      }
    }
  }
  return false;
}

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

console.log(`Processing ${sourceFixtures.length} source fixtures (skip if ≥${MAX_UNSOLVED_THRESHOLD} unsolved, unit conflict, or multiple cage totals)...`);

let totalWritten = 0;

for (const fixture of sourceFixtures) {
  // Skip fixtures with suspiciously many unsolved cells — OCR error in cage totals.
  if (fixture.unsolvedCells >= MAX_UNSOLVED_THRESHOLD) {
    console.log(`  ${fixture.name}: SKIPPED (${fixture.unsolvedCells} unsolved — likely OCR error)`);
    continue;
  }

  // Skip fixtures whose stalledCandidates have a unit conflict (same digit confirmed
  // twice in one row, column, or box). This indicates OCR-corrupted cage totals caused
  // cage rules to double-place a digit, leaving the board in an invalid state. Focused
  // fixtures generated from such sources are not genuine rule gaps — the puzzle is
  // ambiguous and the rule engine correctly cannot resolve the remaining cells.
  if (hasUnitConflict(fixture.stalledCandidates)) {
    console.log(`  ${fixture.name}: SKIPPED (unit conflict in stalledCandidates — corrupted source)`);
    continue;
  }

  // Skip fixtures whose spec has two non-zero cage totals in the same region.
  // This is a structural OCR error: the digit scanner read a total from an adjacent
  // cage and placed it inside an existing cage's region. These puzzles are not
  // genuine rule gaps — the cage rules operate on wrong totals from the start.
  const multiTotalError = hasMultipleCageTotals(fixture.spec);
  if (multiTotalError !== null) {
    console.log(`  ${fixture.name}: SKIPPED (multiple cage totals — ${multiTotalError})`);
    continue;
  }

  process.stdout.write(`  ${fixture.name} (${fixture.unsolvedCells} unsolved)... `);

  // -----------------------------------------------------------------------
  // 1. Get the ground-truth solution via the full solver (uses backtracking).
  //    After solve(), every cell in result.board.cands(r, c) is a single-
  //    element set containing the correct digit.
  //    For classic fixtures, pass givenDigits so the solver finds the
  //    specific puzzle's unique solution rather than an arbitrary valid sudoku.
  // -----------------------------------------------------------------------
  const givenDigits = fixture.givenDigits
    ? fixture.givenDigits.map(row => [...row])
    : undefined;
  const solutionResult = solve(fixture.spec, givenDigits);
  const solution: number[][] = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => [...solutionResult.board.cands(r, c)][0]!),
  );

  // -----------------------------------------------------------------------
  // 2. Multi-solution check: exclude the ground-truth digit from each unsolved
  //    cell in turn. If any exclusion still yields a fully-solved board there
  //    is a second valid solution — the puzzle is ambiguous (likely OCR-dropped
  //    given digits) and must be skipped.
  // -----------------------------------------------------------------------
  let isMultiSolution = false;
  for (let r = 0; r < 9 && !isMultiSolution; r++) {
    for (let c = 0; c < 9 && !isMultiSolution; c++) {
      if (fixture.stalledCandidates[r]![c]!.length <= 1) continue;
      const solDigit = solution[r]![c]!;
      const altCellCands = fixture.stalledCandidates[r]![c]!.filter(d => d !== solDigit);
      if (altCellCands.length === 0) continue; // only candidate was the solution digit
      const altCands = fixture.stalledCandidates.map(row => row.map(cell => [...cell]));
      altCands[r]![c] = altCellCands;
      const altResult = solveFromCandidates(fixture.spec, altCands);
      // Board is fully solved if every cell has exactly one candidate remaining.
      let allSolved = true;
      for (let rr = 0; rr < 9 && allSolved; rr++) {
        for (let cc = 0; cc < 9 && allSolved; cc++) {
          if (altResult.board.cands(rr, cc).size !== 1) allSolved = false;
        }
      }
      if (allSolved) isMultiSolution = true;
    }
  }
  if (isMultiSolution) {
    console.log(`SKIPPED (multiple solutions — likely OCR-dropped given digits)`);
    continue;
  }

  // -----------------------------------------------------------------------
  // 3. BFS over stall states to find kernel states.
  //
  //    A kernel state is a stall from which no single-cell pin (to the
  //    ground-truth digit) produces a new, distinct stall state. Every pin
  //    from a kernel either solves the puzzle or reaches a state already
  //    encountered in the BFS.
  //
  //    frontier — states yet to be processed.
  //    seen     — JSON keys of all states ever added to the frontier.
  //    kernels  — collected kernel states to write as focused fixtures.
  // -----------------------------------------------------------------------
  const seen = new Set<string>();
  const frontier: number[][][][] = [];
  const kernels: Array<{ sc: number[][][]; unsolvedCells: number; totalCandidates: number }> = [];

  const sourceKey = JSON.stringify(fixture.stalledCandidates);
  seen.add(sourceKey);
  frontier.push(fixture.stalledCandidates.map(row => row.map(cell => [...cell])));

  while (frontier.length > 0) {
    const current = frontier.shift()!;
    let isKernel = true; // will be cleared if any pin produces a new stall

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (current[r]![c]!.length <= 1) continue; // already solved cell

        // Pin this cell to its ground-truth digit.
        const pinned: number[][][] = current.map(row => row.map(cell => [...cell]));
        pinned[r]![c] = [solution[r]![c]!];

        const result = solveFromCandidates(fixture.spec, pinned);
        if (!result.usedBacktracking) continue; // pin solved the puzzle — no child stall

        // This pin produced a stall — current is not a kernel.
        isKernel = false;

        const sc = result.stalledCandidates!;
        const key = JSON.stringify(sc);
        if (seen.has(key)) continue; // already in the BFS graph

        seen.add(key);
        frontier.push(sc.map(row => row.map(cell => [...cell])));
      }
    }

    // Kernel states are emitted as focused fixtures, excluding the source itself.
    if (isKernel && JSON.stringify(current) !== sourceKey) {
      const unsolvedCells = current.flat().filter(cell => cell.length > 1).length;
      const totalCandidates = current
        .flat()
        .filter(cell => cell.length > 1)
        .reduce((sum, cell) => sum + cell.length, 0);
      kernels.push({ sc: current, unsolvedCells, totalCandidates });
    }
  }

  if (kernels.length === 0) {
    console.log('none');
    continue;
  }

  // -----------------------------------------------------------------------
  // 4. Sort by (unsolvedCells ASC, totalCandidates ASC) for stable indices.
  // -----------------------------------------------------------------------
  kernels.sort((a, b) => a.unsolvedCells - b.unsolvedCells || a.totalCandidates - b.totalCandidates);

  // -----------------------------------------------------------------------
  // 5. Write focused fixtures to web/stall-fixtures/.
  // -----------------------------------------------------------------------
  kernels.forEach(({ sc, unsolvedCells, totalCandidates }, idx) => {
    const idxStr = String(idx).padStart(3, '0');
    const name = `${fixture.name}-f${idxStr}`;
    const focusedFixture: StallFixtureFile = {
      version: 1,
      source: 'focused',
      name,
      addedAt: today,
      puzzleType: fixture.puzzleType,
      spec: fixture.spec,
      ...(fixture.givenDigits !== undefined && { givenDigits: fixture.givenDigits }),
      stalledCandidates: sc,
      unsolvedCells,
      totalCandidates,
    };
    const outPath = path.join(fixturesDir, `${name}.stall.json`);
    fs.writeFileSync(outPath, JSON.stringify(focusedFixture, null, 2));
  });

  console.log(`${kernels.length} kernel state(s) (${seen.size - 1} BFS nodes explored)`);
  totalWritten += kernels.length;
}

console.log(`\nDone. ${totalWritten} focused fixtures written across ${sourceFixtures.length} source fixtures.`);
