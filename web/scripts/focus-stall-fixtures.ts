/**
 * Generates "focused" stall fixtures for every committed source fixture.
 *
 * For each source fixture, this script performs a DFS (depth-first search)
 * over the space of stall states reachable by pinning one unsolved cell at a
 * time to its ground-truth solution value and re-running the full killer engine.
 *
 * The DFS finds "kernel" states — stall states where no single-cell pin
 * produces a new (distinct) stall state. Every pin from a kernel either solves
 * the puzzle outright or reaches an already-discovered stall state. DFS
 * explores deep paths first, so the most focused kernels (fewest unsolved cells,
 * most cells already determined) are discovered early.
 *
 * After the full search, up to MAX_KERNELS of the most focused kernels are
 * written to web/stall-fixtures/ as
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
 *
 * After the DFS, ambiguity is detected via kernel intersection: the set of cell
 * positions that are unsolved in EVERY kernel. These "always-stuck" cells are checked
 * for ambiguity first (O(|intersection| × distinct_patterns) solver calls — typically
 * just 1–2 calls even for large puzzles). Any kernel containing a confirmed-ambiguous
 * intersection cell is discarded in O(1). Remaining kernels get a per-cell fallback
 * check only for non-intersection cells (near-zero cost for well-formed puzzles).
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

/** Maximum focused fixtures emitted per source fixture. Only the most focused
 *  (fewest unsolved cells) kernels are kept; deeper DFS paths surface these first. */
const MAX_KERNELS = 20;

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
  // 2. DFS over stall states to find kernel states.
  //
  //    A kernel state is a stall from which no single-cell pin (to the
  //    ground-truth digit) produces a new, distinct stall state.
  //
  //    DFS (stack / pop) explores deep paths first so the most focused
  //    kernels (fewest unsolved cells) tend to be found early. The loop
  //    exits as soon as MAX_KERNELS unambiguous kernels are collected.
  //
  //    Ambiguity check (per kernel, not per source):
  //    Ambiguity is detected after the DFS via kernel intersection (see step 3).
  //
  //    stack   — states yet to be processed (LIFO).
  //    seen    — JSON keys of all states ever pushed onto the stack.
  //    kernels — all kernel states found (including potentially ambiguous ones).
  // -----------------------------------------------------------------------
  type StackEntry = { state: number[][][]; depth: number };
  const seen = new Set<string>();
  const stack: StackEntry[] = [];
  const kernels: Array<{ sc: number[][][]; unsolvedCells: number; totalCandidates: number; depth: number }> = [];

  const sourceKey = JSON.stringify(fixture.stalledCandidates);
  seen.add(sourceKey);
  stack.push({ state: fixture.stalledCandidates.map(row => row.map(cell => [...cell])), depth: 0 });

  while (stack.length > 0) {
    const { state: current, depth } = stack.pop()!; // DFS: LIFO
    let isKernel = true;

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (current[r]![c]!.length <= 1) continue;

        const pinned: number[][][] = current.map(row => row.map(cell => [...cell]));
        pinned[r]![c] = [solution[r]![c]!];

        const result = solveFromCandidates(fixture.spec, pinned);
        if (!result.usedBacktracking) continue; // pin solved the puzzle

        isKernel = false;

        const sc = result.stalledCandidates!;
        const key = JSON.stringify(sc);
        if (seen.has(key)) continue;

        seen.add(key);
        stack.push({ state: sc.map(row => row.map(cell => [...cell])), depth: depth + 1 });
      }
    }

    if (!isKernel || JSON.stringify(current) === sourceKey) continue;

    const unsolvedCells = current.flat().filter(cell => cell.length > 1).length;
    const totalCandidates = current
      .flat()
      .filter(cell => cell.length > 1)
      .reduce((sum, cell) => sum + cell.length, 0);
    kernels.push({ sc: current, unsolvedCells, totalCandidates, depth });
  }

  if (kernels.length === 0) {
    console.log(`none — ${seen.size - 1} DFS nodes explored`);
    continue;
  }

  // -----------------------------------------------------------------------
  // 3. Intersection-based ambiguity filter.
  //
  //    Compute the intersection of unsolved cell positions across all kernels.
  //    Cells in the intersection are "always stuck" — no DFS path resolved them.
  //    Check each intersection cell for ambiguity using the distinct non-solution
  //    candidate patterns that appear across kernels (typically 1–2 patterns per
  //    cell, far fewer than a full per-kernel scan). If a cell in the intersection
  //    is ambiguous it affects every kernel → discard all kernels containing it
  //    in one pass (fast path). Non-intersection cells that are individually
  //    ambiguous in some kernels are caught by the slow-path fallback.
  //
  //    Cost for a fully ambiguous source (like a classic with OCR-dropped digits):
  //      O(|intersection| × distinct_patterns) solver calls — e.g. 2 for this puzzle.
  //    Cost for a well-formed single-solution source:
  //      O(|intersection|) checks all pass → O(kernels × non-intersection cells)
  //      fallback checks also all pass → 0 kernels discarded.
  // -----------------------------------------------------------------------

  // Build intersection: set of (r,c) positions unsolved in every kernel.
  let cellIntersection: Set<string> | null = null;
  for (const { sc } of kernels) {
    const here = new Set<string>();
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (sc[r]![c]!.length > 1) here.add(`${r},${c}`);
    if (cellIntersection === null) { cellIntersection = here; continue; }
    for (const k of cellIntersection) if (!here.has(k)) cellIntersection.delete(k);
  }
  cellIntersection ??= new Set<string>();

  // For each intersection cell, test each distinct non-solution candidate pattern.
  const ambiguousCellKeys = new Set<string>();
  for (const cellKey of cellIntersection) {
    const [r, c] = cellKey.split(',').map(Number) as [number, number];
    const testedPatterns = new Set<string>();
    for (const { sc } of kernels) {
      if (ambiguousCellKeys.has(cellKey)) break;
      if (sc[r]![c]!.length <= 1) continue;
      const altCands = sc[r]![c]!.filter(d => d !== solution[r]![c]!);
      if (altCands.length === 0) continue;
      const patternKey = altCands.join(',');
      if (testedPatterns.has(patternKey)) continue;
      testedPatterns.add(patternKey);
      const testGrid = sc.map(row => row.map(cell => [...cell]));
      testGrid[r]![c] = altCands;
      const altResult = solveFromCandidates(fixture.spec, testGrid);
      let allSolved = true;
      for (let rr = 0; rr < 9 && allSolved; rr++)
        for (let cc = 0; cc < 9 && allSolved; cc++)
          if (altResult.board.cands(rr, cc).size !== 1) allSolved = false;
      if (allSolved) ambiguousCellKeys.add(cellKey);
    }
  }

  // Filter kernels: fast path via known ambiguous cells, slow-path fallback for the rest.
  let ambiguousCount = 0;
  const goodKernels: typeof kernels = [];
  for (const kernel of kernels) {
    const { sc } = kernel;

    // Fast path: kernel contains a known-ambiguous intersection cell.
    let hasKnownAmbiguity = false;
    for (const cellKey of ambiguousCellKeys) {
      const [r, c] = cellKey.split(',').map(Number) as [number, number];
      if (sc[r]![c]!.length > 1) { hasKnownAmbiguity = true; break; }
    }
    if (hasKnownAmbiguity) { ambiguousCount++; continue; }

    // Slow path: per-kernel check for non-intersection cells (rare for OCR-ambiguous puzzles).
    let kernelAmbiguous = false;
    for (let r = 0; r < 9 && !kernelAmbiguous; r++) {
      for (let c = 0; c < 9 && !kernelAmbiguous; c++) {
        if (sc[r]![c]!.length <= 1) continue;
        if (cellIntersection.has(`${r},${c}`)) continue; // already checked above
        const altCands = sc[r]![c]!.filter(d => d !== solution[r]![c]!);
        if (altCands.length === 0) continue;
        const testGrid = sc.map(row => row.map(cell => [...cell]));
        testGrid[r]![c] = altCands;
        const altResult = solveFromCandidates(fixture.spec, testGrid);
        let allSolved = true;
        for (let rr = 0; rr < 9 && allSolved; rr++)
          for (let cc = 0; cc < 9 && allSolved; cc++)
            if (altResult.board.cands(rr, cc).size !== 1) allSolved = false;
        if (allSolved) kernelAmbiguous = true;
      }
    }
    if (kernelAmbiguous) { ambiguousCount++; continue; }

    goodKernels.push(kernel);
  }

  if (goodKernels.length === 0) {
    const ambigDetail = ambiguousCellKeys.size > 0
      ? ` via intersection {${[...ambiguousCellKeys].map(k => { const [r,c] = k.split(','); return `r${+r+1}c${+c+1}`; }).join(',')}}`
      : '';
    console.log(`none (${ambiguousCount} kernels discarded as ambiguous${ambigDetail}) — ${seen.size - 1} DFS nodes explored`);
    continue;
  }

  // -----------------------------------------------------------------------
  // 4. Sort by (unsolvedCells ASC, totalCandidates ASC) and keep MAX_KERNELS.
  // -----------------------------------------------------------------------
  goodKernels.sort((a, b) => a.unsolvedCells - b.unsolvedCells || a.totalCandidates - b.totalCandidates);
  const kept = goodKernels.slice(0, MAX_KERNELS);

  // -----------------------------------------------------------------------
  // 5. Write focused fixtures to web/stall-fixtures/.
  // -----------------------------------------------------------------------
  kept.forEach(({ sc, unsolvedCells, totalCandidates }, idx) => {
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

  const trimMsg = goodKernels.length > MAX_KERNELS ? `, ${goodKernels.length - kept.length} trimmed` : '';
  const ambigMsg = ambiguousCount > 0 ? `, ${ambiguousCount} ambiguous` : '';
  console.log(`${kept.length} kernel(s) written (${seen.size - 1} DFS nodes explored${ambigMsg}${trimMsg})`);
  totalWritten += kept.length;
}

console.log(`\nDone. ${totalWritten} focused fixtures written across ${sourceFixtures.length} source fixtures.`);
