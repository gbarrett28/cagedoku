/**
 * One-off script: generate stall fixtures for the 9 known Guardian killer sudoku stall puzzles.
 *
 * The guardian/*.json files have cage_totals, border_x, border_y but no regions.
 * This script reconstructs regions from borders using union-find, then runs the
 * solver directly (no browser/Playwright required).
 *
 * Run from web/:
 *   npx vite-node scripts/generate-guardian-stall-fixtures.ts <guardian-dir> <output-dir>
 *
 * This script is for one-time use and can be deleted after the fixtures are committed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { solve } from '../src/engine/index.js';
import type { PuzzleSpec } from '../src/solver/puzzleSpec.js';
import type { StallFixtureFile } from '../src/engine/rules/stallFixtureFile.js';

// ---------------------------------------------------------------------------
// Union-find for region computation
// ---------------------------------------------------------------------------

function computeRegions(
  borderX: boolean[][],  // [col][rowGap] — wall between rows rowGap and rowGap+1 in col
  borderY: boolean[][],  // [colGap][row] — wall between cols colGap and colGap+1 in row
): number[][] {
  const parent: number[] = Array.from({ length: 81 }, (_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      // Merge with right neighbour if no vertical wall between col and col+1
      if (col < 8 && !borderY[col]![row]!) {
        union(row * 9 + col, row * 9 + col + 1);
      }
      // Merge with below neighbour if no horizontal wall between row and row+1
      if (row < 8 && !borderX[col]![row]!) {
        union(row * 9 + col, (row + 1) * 9 + col);
      }
    }
  }

  // Assign 1-based region IDs to each union-find component
  const regionIds = new Map<number, number>();
  let nextId = 1;
  const regions: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const root = find(row * 9 + col);
      if (!regionIds.has(root)) regionIds.set(root, nextId++);
      regions[row]![col] = regionIds.get(root)!;
    }
  }
  return regions;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface GuardianJson {
  cage_totals: number[][];
  border_x: boolean[][];
  border_y: boolean[][];
}

const [guardianDir, outputDir] = process.argv.slice(2);
if (!guardianDir || !outputDir) {
  console.error(
    'Usage: npx vite-node scripts/generate-guardian-stall-fixtures.ts <guardian-dir> <output-dir>',
  );
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

const jsonFiles = fs
  .readdirSync(guardianDir)
  .filter(f => f.startsWith('killer_sudoku_') && f.endsWith('.json') && !f.includes('eval'))
  .sort();

const today = new Date().toISOString().slice(0, 10);
let stalled = 0;
let solved = 0;

for (const filename of jsonFiles) {
  const filePath = path.join(guardianDir, filename);
  const name = path.basename(filename, '.json');

  let raw: GuardianJson;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as GuardianJson;
  } catch {
    console.warn(`${name}: failed to parse — skipping`);
    continue;
  }

  const borderX = raw.border_x as boolean[][];
  const borderY = raw.border_y as boolean[][];
  const cageTotals = raw.cage_totals as number[][];
  const regions = computeRegions(borderX, borderY);

  const spec: PuzzleSpec = { regions, cageTotals, borderX, borderY };
  const result = solve(spec);

  if (!result.usedBacktracking) {
    solved++;
    continue;
  }

  const sc = result.stalledCandidates ?? [];
  const unsolvedCells = sc.flat().filter(c => c.length > 1).length;
  const totalCandidates = sc
    .flat()
    .filter(c => c.length > 1)
    .reduce((sum, c) => sum + c.length, 0);

  // Repo-root-relative image path
  const relDir = path.relative(path.join(process.cwd(), '..'), guardianDir).replace(/\\/g, '/');
  const imagePath = `${relDir}/${name}.jpg`;

  const fixture: StallFixtureFile = {
    version: 1,
    source: 'guardian',
    name,
    addedAt: today,
    puzzleType: 'killer',
    imagePath,
    spec,
    stalledCandidates: sc,
    unsolvedCells,
    totalCandidates,
  };

  const outPath = path.join(outputDir, `${name}.stall.json`);
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`${name}: stalled (${unsolvedCells} unsolved, ${totalCandidates} candidates) → ${outPath}`);
  stalled++;
}

console.log(`\nDone. ${stalled} stalled, ${solved} already solved (of ${jsonFiles.length} total).`);
