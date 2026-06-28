import Database from 'better-sqlite3';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = path.resolve(__dirname, '../../corpus.db');

export interface PuzzleRow {
  readonly content_hash: string;
  readonly path: string;
  readonly corpus: string;
  // Sorted JSON array of known ground-truth labels for this image.
  // [] = no label assigned yet
  // ['killer'] or ['classic'] = unambiguous
  // ['classic','killer'] = seen in corpora with contradictory labels (hold-out set)
  readonly ground_truth: readonly string[];
}

export interface ClaimedEvaluation {
  readonly id: number;
  readonly puzzle_hash: string;
}

export interface CorpusRow {
  readonly dir_path: string;
  readonly ground_truth: string;
  readonly file_count: number;
  readonly last_scanned: string;
}

export function openDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS puzzles (
      content_hash  TEXT PRIMARY KEY,
      path          TEXT NOT NULL,
      corpus        TEXT NOT NULL DEFAULT '',
      ground_truth  TEXT NOT NULL DEFAULT '[]'  -- sorted JSON string[]
    );
    CREATE TABLE IF NOT EXISTS evaluations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      puzzle_hash   TEXT NOT NULL REFERENCES puzzles(content_hash),
      git_hash      TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'running',
      worker_id     INTEGER,
      bucket        TEXT,
      reason        TEXT,
      detected_type TEXT,
      elapsed_ms    INTEGER,
      spec_hash     TEXT,
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS corpora (
      dir_path      TEXT PRIMARY KEY,
      ground_truth  TEXT NOT NULL,
      file_count    INTEGER NOT NULL,
      last_scanned  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Migrations for columns added after initial schema
  const puzzleCols = (db.prepare("PRAGMA table_info(puzzles)").all() as { name: string }[]).map(r => r.name);
  if (!puzzleCols.includes('corpus')) {
    db.exec("ALTER TABLE puzzles ADD COLUMN corpus TEXT NOT NULL DEFAULT ''");
  }
  const evalCols = (db.prepare("PRAGMA table_info(evaluations)").all() as { name: string }[]).map(r => r.name);
  if (!evalCols.includes('spec_hash')) {
    db.exec('ALTER TABLE evaluations ADD COLUMN spec_hash TEXT');
  }
  if (!evalCols.includes('cell_centroid_dist_sq')) {
    db.exec('ALTER TABLE evaluations ADD COLUMN cell_centroid_dist_sq REAL');
  }
  if (!evalCols.includes('box_centroid_dist_sq')) {
    db.exec('ALTER TABLE evaluations ADD COLUMN box_centroid_dist_sq REAL');
  }
  return db;
}

function parsePuzzleRow(
  raw: { content_hash: string; path: string; corpus: string; ground_truth: string } | undefined,
): PuzzleRow | undefined {
  if (raw === undefined) return undefined;
  return { ...raw, ground_truth: JSON.parse(raw.ground_truth) as string[] };
}

export function insertPuzzle(
  db: Database.Database,
  contentHash: string,
  filePath: string,
  corpus: string,
  groundTruth: 'killer' | 'classic',
): void {
  db.prepare(
    'INSERT OR IGNORE INTO puzzles (content_hash, path, corpus, ground_truth) VALUES (?, ?, ?, ?)',
  ).run(contentHash, filePath, corpus, JSON.stringify([groundTruth]));
}

export function addGroundTruth(
  db: Database.Database,
  contentHash: string,
  label: 'killer' | 'classic',
): void {
  const existing = getPuzzle(db, contentHash);
  if (!existing || existing.ground_truth.includes(label)) return;
  const updated = [...existing.ground_truth, label].sort();
  db.prepare('UPDATE puzzles SET ground_truth = ? WHERE content_hash = ?').run(
    JSON.stringify(updated), contentHash,
  );
}

export function getPuzzle(db: Database.Database, contentHash: string): PuzzleRow | undefined {
  return parsePuzzleRow(
    db.prepare('SELECT * FROM puzzles WHERE content_hash = ?').get(contentHash) as
      { content_hash: string; path: string; corpus: string; ground_truth: string } | undefined,
  );
}

export function upsertCorpus(
  db: Database.Database,
  dirPath: string,
  groundTruth: 'killer' | 'classic',
  fileCount: number,
): void {
  db.prepare(`
    INSERT INTO corpora (dir_path, ground_truth, file_count, last_scanned)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (dir_path) DO UPDATE SET
      ground_truth = excluded.ground_truth,
      file_count   = excluded.file_count,
      last_scanned = excluded.last_scanned
  `).run(dirPath, groundTruth, fileCount);
}

export function getCorpora(db: Database.Database): CorpusRow[] {
  return db.prepare('SELECT * FROM corpora ORDER BY dir_path').all() as CorpusRow[];
}

export function claimEvaluation(
  db: Database.Database,
  gitHash: string,
  workerId: number,
  sqlFilter?: string,
): ClaimedEvaluation | undefined {
  const filterClause = sqlFilter ? `AND ${sqlFilter}` : '';
  return db.prepare(`
    INSERT INTO evaluations (puzzle_hash, git_hash, worker_id)
    SELECT content_hash, ?, ?
    FROM puzzles
    WHERE content_hash NOT IN (SELECT puzzle_hash FROM evaluations WHERE git_hash = ?)
    ${filterClause}
    LIMIT 1
    RETURNING id, puzzle_hash
  `).get(gitHash, workerId, gitHash) as ClaimedEvaluation | undefined;
}

export function completeEvaluation(
  db: Database.Database,
  id: number,
  status: 'done' | 'failed',
  bucket: string,
  reason: string | null,
  detectedType: string | null,
  elapsedMs: number,
  specHash: string | null,
  cellCentroidDistSq: number | null,
  boxCentroidDistSq: number | null,
): void {
  db.prepare(`
    UPDATE evaluations
    SET status = ?, bucket = ?, reason = ?, detected_type = ?,
        elapsed_ms = ?, spec_hash = ?,
        cell_centroid_dist_sq = ?, box_centroid_dist_sq = ?,
        finished_at = datetime('now')
    WHERE id = ?
  `).run(status, bucket, reason, detectedType, elapsedMs, specHash,
         cellCentroidDistSq, boxCentroidDistSq, id);
}
