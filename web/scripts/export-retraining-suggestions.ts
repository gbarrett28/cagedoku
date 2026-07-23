#!/usr/bin/env vite-node
/**
 * Converts corpus.db's approved retraining_suggestions rows into a
 * TrainingExport-compatible JSON file — the same shape
 * web/src/image/trainingExport.ts produces and web/train_recogniser.py's
 * load_training_file already consumes. Only status='approved' rows are
 * included; nothing here retrains a model or touches num_recogniser.npz.
 *
 * Usage:
 *   npx vite-node scripts/export-retraining-suggestions.ts --out corrections.json
 */
import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import { openDb } from './corpus-db.js';

export interface RetrainingExport {
  reportType: 'retraining-suggestions-export';
  exportedAt: string;
  thumbnailSize: number;
  sampleCount: number;
  samples: Array<{ digit: number; pixels: number[] }>;
}

export function exportApprovedSuggestions(db: Database.Database): RetrainingExport {
  const rows = db.prepare(`
    SELECT suggested_label, crop_pixels FROM retraining_suggestions WHERE status = 'approved'
  `).all() as Array<{ suggested_label: number; crop_pixels: string }>;

  const samples = rows.map(r => ({ digit: r.suggested_label, pixels: JSON.parse(r.crop_pixels) as number[] }));
  return {
    reportType: 'retraining-suggestions-export' as const,
    exportedAt: new Date().toISOString(),
    thumbnailSize: 64,
    sampleCount: samples.length,
    samples,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1]! : 'retraining-suggestions-export.json';
  const db = openDb();
  const result = exportApprovedSuggestions(db);
  fs.writeFileSync(outPath, JSON.stringify(result));
  console.log(`Wrote ${result.sampleCount} approved samples to ${outPath}`);
}

// vite-node consumes the target script path as its own CLI argument and never
// re-exposes it via process.argv/import.meta.url matching, so the usual
// "am I the entry point" check doesn't work under it. Vitest sets VITEST=true
// for every test process, including when this module is only imported (not
// run directly) by export-retraining-suggestions.test.ts -- that's the one
// case main() must not run automatically.
if (process.env['VITEST'] === undefined) main();
