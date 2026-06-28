#!/usr/bin/env vite-node
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { addGroundTruth, getPuzzle, insertPuzzle, openDb, upsertCorpus } from './corpus-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const CORPORA: ReadonlyArray<{ readonly dir: string; readonly corpus: string; readonly groundTruth: 'killer' | 'classic' }> = [
  { dir: 'guardian',         corpus: 'guardian', groundTruth: 'killer'  },
  { dir: 'observer',         corpus: 'observer', groundTruth: 'killer'  },
  { dir: 'classic_observer', corpus: 'observer', groundTruth: 'classic' },
  { dir: 'classic_guardian', corpus: 'guardian', groundTruth: 'classic' },
];

export function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function collectJpgFiles(dirPath: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJpgFiles(full));
    } else if (entry.name.toLowerCase().endsWith('.jpg')) {
      results.push(full);
    }
  }
  return results.sort();
}

export interface PopulateResult {
  readonly added: number;
  readonly known: number;
  readonly conflicts: number;
}

export function populateCorpus(db: Database.Database, repoRoot: string): PopulateResult {
  let added = 0;
  let known = 0;
  let conflicts = 0;
  for (const { dir, corpus, groundTruth } of CORPORA) {
    const dirPath = path.join(repoRoot, dir);
    if (!fs.existsSync(dirPath)) continue;
    const files = collectJpgFiles(dirPath);
    for (const filePath of files) {
      const hash = hashFile(filePath);
      const existing = getPuzzle(db, hash);
      if (existing === undefined) {
        insertPuzzle(db, hash, filePath, corpus, groundTruth);
        added++;
      } else if (!existing.ground_truth.includes(groundTruth)) {
        addGroundTruth(db, hash, groundTruth);
        console.warn(`CONFLICT (hold-out): ${hash.slice(0, 8)}… labels now ${JSON.stringify(getPuzzle(db, hash)!.ground_truth)}`);
        conflicts++;
      } else {
        known++;
      }
    }
    upsertCorpus(db, dirPath, groundTruth, files.length);
  }
  return { added, known, conflicts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const result = populateCorpus(db, REPO_ROOT);
  console.log(`Done: ${result.added} new, ${result.known} already known, ${result.conflicts} conflicts (hold-out)`);
  db.close();
}
