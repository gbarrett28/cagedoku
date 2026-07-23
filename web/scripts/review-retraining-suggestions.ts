#!/usr/bin/env vite-node
/**
 * Manual review tool for retraining_suggestions: dumps each pending
 * suggestion's crop as a PNG plus a manifest for a human to eyeball, then
 * lets the reviewer approve/reject by id. Never auto-approves anything.
 *
 * Usage:
 *   npx vite-node scripts/review-retraining-suggestions.ts --dump [--out DIR]
 *   npx vite-node scripts/review-retraining-suggestions.ts --approve 12 15 20
 *   npx vite-node scripts/review-retraining-suggestions.ts --reject 8
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { openDb } from './corpus-db.js';
import type Database from 'better-sqlite3';

export interface ManifestEntry {
  id: number;
  puzzlePath: string;
  row: number;
  col: number;
  predictedLabel: number;
  suggestedLabel: number;
  confidenceTier: string;
  pngPath: string;
}

export function dumpPendingSuggestions(db: Database.Database, outDir: string): ManifestEntry[] {
  fs.mkdirSync(outDir, { recursive: true });
  const rows = db.prepare(`
    SELECT rs.id, p.path AS puzzle_path, rs.row, rs.col, rs.predicted_label,
           rs.suggested_label, rs.confidence_tier, rs.crop_pixels
    FROM retraining_suggestions rs
    JOIN puzzles p ON p.content_hash = rs.puzzle_hash
    WHERE rs.status = 'pending'
    ORDER BY rs.confidence_tier DESC, rs.id
  `).all() as Array<{
    id: number; puzzle_path: string; row: number; col: number;
    predicted_label: number; suggested_label: number; confidence_tier: string; crop_pixels: string;
  }>;

  const manifest: ManifestEntry[] = [];
  for (const r of rows) {
    const pixels: number[] = JSON.parse(r.crop_pixels);
    const png = new PNG({ width: 64, height: 64, colorType: 0 });
    for (let i = 0; i < pixels.length; i++) png.data[i] = pixels[i]!;
    const pngPath = path.join(outDir, `${r.id}_pred${r.predicted_label}_suggest${r.suggested_label}.png`);
    fs.writeFileSync(pngPath, PNG.sync.write(png));
    manifest.push({
      id: r.id, puzzlePath: r.puzzle_path, row: r.row, col: r.col,
      predictedLabel: r.predicted_label, suggestedLabel: r.suggested_label,
      confidenceTier: r.confidence_tier, pngPath,
    });
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function setSuggestionStatus(db: Database.Database, id: number, status: 'approved' | 'rejected'): void {
  db.prepare('UPDATE retraining_suggestions SET status = ? WHERE id = ?').run(status, id);
}

function main(): void {
  const args = process.argv.slice(2);
  const db = openDb();
  if (args.includes('--dump')) {
    const outIdx = args.indexOf('--out');
    const outDir = outIdx >= 0 ? args[outIdx + 1]! : 'retraining-review';
    const manifest = dumpPendingSuggestions(db, outDir);
    console.log(`Dumped ${manifest.length} pending suggestions to ${outDir}/ (see manifest.json)`);
  } else if (args.includes('--approve') || args.includes('--reject')) {
    const status = args.includes('--approve') ? 'approved' : 'rejected';
    const flagIdx = args.indexOf(status === 'approved' ? '--approve' : '--reject');
    for (const idStr of args.slice(flagIdx + 1)) {
      const id = Number(idStr);
      if (!Number.isInteger(id)) break;
      setSuggestionStatus(db, id, status);
      console.log(`${id}: ${status}`);
    }
  } else {
    console.error('Usage: --dump [--out DIR] | --approve ID... | --reject ID...');
    process.exit(1);
  }
}

// vite-node consumes the target script path as its own CLI argument and never
// re-exposes it via process.argv/import.meta.url matching, so the usual
// "am I the entry point" check doesn't work under it. Vitest sets VITEST=true
// for every test process, including when this module is only imported (not
// run directly) by review-retraining-suggestions.test.ts -- that's the one
// case main() must not run automatically.
if (process.env['VITEST'] === undefined) main();
