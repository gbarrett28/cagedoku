/**
 * check-puzzle-specs.ts
 *
 * CLI script (run via `npx vite-node scripts/check-puzzle-specs.ts <input-dir> <output-dir>`).
 *
 * For each *.json in <input-dir>:
 *   1. Validates the shape matches PuzzleSpecExport (version 2, puzzleType killer).
 *   2. Runs solve(spec) via the engine.
 *   3. If usedBacktracking: writes a StallFixtureFile JSON to <output-dir>/<name>.stall.json.
 *   4. If solved cleanly: logs "<name>: now solves without backtracking — skipping".
 *
 * Name derivation: r2-${basename.replace(/:/g, '-')} where basename is the filename
 * without extension (e.g. "2026-05-24T10:00:00.000Z-abc12345" → "r2-2026-05-24T10-00-00.000Z-abc12345").
 *
 * Used by .github/workflows/puzzle-spec-review.yml to process R2 puzzle-spec uploads.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { solve } from '../src/engine/index.js';
import type { PuzzleSpec } from '../src/solver/puzzleSpec.js';
import type { StallFixtureFile } from '../src/engine/rules/stallFixtureFile.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isNumberGrid(val: unknown, rows: number, cols: number): val is number[][] {
  if (!Array.isArray(val) || val.length !== rows) return false;
  for (const row of val) {
    if (!Array.isArray(row) || row.length !== cols) return false;
    if (!row.every(x => typeof x === 'number')) return false;
  }
  return true;
}

function isBoolGrid(val: unknown, rows: number, cols: number): val is boolean[][] {
  if (!Array.isArray(val) || val.length !== rows) return false;
  for (const row of val) {
    if (!Array.isArray(row) || row.length !== cols) return false;
    if (!row.every(x => typeof x === 'boolean')) return false;
  }
  return true;
}

/** Returns the PuzzleSpec if valid, or a rejection reason string. */
function validateSpec(data: unknown): PuzzleSpec | string {
  if (typeof data !== 'object' || data === null) return 'not an object';
  const d = data as Record<string, unknown>;
  if (d['version'] !== 2) return `version must be 2 (got ${String(d['version'])})`;
  if (d['puzzleType'] !== 'killer') return `puzzleType must be "killer" (got ${String(d['puzzleType'])})`;
  if (!isNumberGrid(d['regions'], 9, 9)) return 'regions must be a 9×9 number array';
  if (!isNumberGrid(d['cageTotals'], 9, 9)) return 'cageTotals must be a 9×9 number array';
  // borderX[col][rowGap]: 9 cols × 8 row-gaps
  if (!isBoolGrid(d['borderX'], 9, 8)) return 'borderX must be a 9×8 boolean array';
  // borderY[colGap][row]: 8 col-gaps × 9 rows
  if (!isBoolGrid(d['borderY'], 8, 9)) return 'borderY must be an 8×9 boolean array';
  return {
    regions: d['regions'] as number[][],
    cageTotals: d['cageTotals'] as number[][],
    borderX: d['borderX'] as boolean[][],
    borderY: d['borderY'] as boolean[][],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [inputDir, outputDir] = process.argv.slice(2);
if (!inputDir || !outputDir) {
  console.error('Usage: npx vite-node scripts/check-puzzle-specs.ts <input-dir> <output-dir>');
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

const jsonFiles = fs.readdirSync(inputDir).filter(f => f.endsWith('.json'));
if (jsonFiles.length === 0) {
  console.log('No JSON files found in input directory — nothing to process.');
  process.exit(0);
}

// Pre-load existing fixtures in the output directory for deduplication.
// Key: JSON.stringify([regions, cageTotals]) — two specs with the same layout are the same puzzle.
function specKey(spec: { regions: number[][]; cageTotals: number[][] }): string {
  return JSON.stringify([spec.regions, spec.cageTotals]);
}

const existingKeys = new Set<string>();
for (const f of fs.readdirSync(outputDir).filter(f => f.endsWith('.stall.json'))) {
  try {
    const existing = JSON.parse(
      fs.readFileSync(path.join(outputDir, f), 'utf-8'),
    ) as StallFixtureFile;
    existingKeys.add(specKey(existing.spec));
  } catch {
    // Ignore malformed existing fixtures
  }
}

let stalled = 0;
let skipped = 0;
let duplicate = 0;
let invalid = 0;
const today = new Date().toISOString().slice(0, 10);

for (const filename of jsonFiles) {
  const filePath = path.join(inputDir, filename);
  const basename = path.basename(filename, '.json');
  const name = `r2-${basename.replace(/:/g, '-')}`;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`${name}: failed to parse JSON — ${String(err)}`);
    invalid++;
    continue;
  }

  const specOrError = validateSpec(raw);
  if (typeof specOrError === 'string') {
    console.warn(`${name}: invalid spec — ${specOrError}`);
    invalid++;
    continue;
  }

  const spec = specOrError;
  const result = solve(spec);

  if (!result.usedBacktracking) {
    console.log(`${name}: now solves without backtracking — skipping`);
    skipped++;
    continue;
  }

  // Deduplicate: skip if a fixture with the same puzzle layout already exists.
  if (existingKeys.has(specKey(spec))) {
    console.log(`${name}: duplicate of an existing fixture — skipping`);
    duplicate++;
    continue;
  }

  const sc = result.stalledCandidates ?? [];
  const unsolvedCells = sc.flat().filter(c => c.length > 1).length;
  const totalCandidates = sc.flat().filter(c => c.length > 1).reduce((sum, c) => sum + c.length, 0);

  const fixture: StallFixtureFile = {
    version: 1,
    source: 'r2',
    name,
    addedAt: today,
    puzzleType: 'killer',
    spec,
    stalledCandidates: sc,
    unsolvedCells,
    totalCandidates,
  };

  const outPath = path.join(outputDir, `${name}.stall.json`);
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  existingKeys.add(specKey(spec)); // prevent same puzzle appearing twice in one run
  console.log(`${name}: stalled (${unsolvedCells} unsolved, ${totalCandidates} candidates) → ${outPath}`);
  stalled++;
}

console.log(
  `\nDone. ${stalled} stalled, ${skipped} already solved, ${duplicate} duplicate, ${invalid} invalid.`,
);
