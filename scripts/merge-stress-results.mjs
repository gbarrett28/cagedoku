#!/usr/bin/env node
/**
 * Merge per-worker eval_results_*.json files into a single eval_report.json.
 *
 * Usage: node scripts/merge-stress-results.mjs <puzzle-dir>
 *
 * Reads all eval_results_<pid>.json files from <puzzle-dir>, combines them
 * into eval_report.json with aggregate stats and a prioritised work_queue,
 * prints a summary, and removes the worker files.
 */

import fs from 'fs';
import path from 'path';

const puzzleDir = process.argv[2];
if (!puzzleDir) {
  console.error('Usage: merge-stress-results.mjs <puzzle-dir>');
  process.exit(1);
}

const workerFiles = fs.readdirSync(puzzleDir)
  .filter(f => /^eval_results_\d+\.json$/.test(f))
  .map(f => path.join(puzzleDir, f));

if (workerFiles.length === 0) {
  console.error(`No eval_results_*.json files found in ${puzzleDir}`);
  process.exit(1);
}

const allResults = workerFiles
  .flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')))
  .sort((a, b) => a.file.localeCompare(b.file));

const total               = allResults.length;
const pipelineOk          = allResults.filter(r => r.pipeline_ok).length;
const solutionFound       = allResults.filter(r => r.solution_found).length;
const backtrackerRequired = allResults.filter(r => r.backtracker_required).length;
const pipelineErrors      = allResults.filter(r => !r.pipeline_ok).length;

// work_queue: backtracker puzzles sorted easiest-first
// (fewest unsolved cells, then fewest total candidates)
// These are the most tractable rule gaps: one new rule may place the digit.
const workQueue = allResults
  .filter(r => r.backtracker_required)
  .sort((a, b) => a.unsolved_cells - b.unsolved_cells || a.total_candidates - b.total_candidates)
  .map(r => ({ file: r.file, unsolved_cells: r.unsolved_cells, total_candidates: r.total_candidates }));

const report = {
  timestamp: new Date().toISOString(),
  source: path.basename(puzzleDir),
  total,
  pipeline_ok: pipelineOk,
  solution_found: solutionFound,
  backtracker_required: backtrackerRequired,
  pipeline_errors: pipelineErrors,
  work_queue: workQueue,
  per_image: Object.fromEntries(allResults.map(r => [r.file, r])),
};

const reportPath = path.join(puzzleDir, 'eval_report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

// Print summary
const pct = n => `(${(100 * n / total).toFixed(1)}%)`;
console.log(`\nStress test complete — ${path.basename(puzzleDir)} (${pipelineOk}/${total} pipeline OK)`);
console.log(`  Solution found:       ${String(solutionFound).padStart(5)}  ${pct(solutionFound)}`);
console.log(`  Backtracker required: ${String(backtrackerRequired).padStart(5)}  ${pct(backtrackerRequired)}`);
console.log(`  Pipeline errors:      ${String(pipelineErrors).padStart(5)}`);

if (workQueue.length > 0) {
  console.log('\nRule engine work queue (easiest first):');
  workQueue.slice(0, 10).forEach(r =>
    console.log(`  ${r.file.padEnd(35)} — ${r.unsolved_cells} unsolved, ${r.total_candidates} candidates`),
  );
  if (workQueue.length > 10) console.log(`  ... (${workQueue.length - 10} more)`);
}

console.log(`\nReport: ${reportPath}`);

// Clean up per-worker files
workerFiles.forEach(f => fs.unlinkSync(f));
