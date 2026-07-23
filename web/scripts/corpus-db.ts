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
    CREATE TABLE IF NOT EXISTS retraining_suggestions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      puzzle_hash       TEXT NOT NULL REFERENCES puzzles(content_hash),
      git_hash          TEXT NOT NULL,
      row               INTEGER NOT NULL,
      col               INTEGER NOT NULL,
      predicted_label   INTEGER NOT NULL,
      suggested_label   INTEGER NOT NULL,
      confidence_tier   TEXT NOT NULL,
      crop_pixels       TEXT NOT NULL, -- JSON array, flattened 64x64
      status            TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Migrations for columns added after initial schema
  const puzzleCols = (db.prepare('PRAGMA table_info(puzzles)').all() as { name: string }[]).map(r => r.name);
  if (!puzzleCols.includes('corpus')) {
    db.exec("ALTER TABLE puzzles ADD COLUMN corpus TEXT NOT NULL DEFAULT ''");
  }
  const evalCols = (db.prepare('PRAGMA table_info(evaluations)').all() as { name: string }[]).map(r => r.name);
  if (!evalCols.includes('spec_hash')) {
    db.exec('ALTER TABLE evaluations ADD COLUMN spec_hash TEXT');
  }
  // Drop columns that no longer exist (populated by __detectPuzzleDebug which was removed)
  for (const dead of ['cell_centroid_dist_sq', 'box_centroid_dist_sq'] as const) {
    if (evalCols.includes(dead)) {
      db.exec(`ALTER TABLE evaluations DROP COLUMN ${dead}`);
    }
  }
  // Add all measurement columns introduced after the initial schema
  const newCols: Array<[string, string]> = [
    ['live_mats',            'INTEGER'],
    ['heap_bytes',           'INTEGER'],
    ['alloc_bytes',          'INTEGER'],
    ['ct_d1_count',          'INTEGER'],
    ['ct_d2_count',          'INTEGER'],
    ['ct_type',              'TEXT'],
    ['ct_orientation',       'REAL'],
    ['quad_sum_orientation', 'REAL'],
    ['ct_border_agreement',  'REAL'],
    ['ct_border_fp',         'INTEGER'],
    ['ct_border_fn',         'INTEGER'],
    ['ct_digit_agreement',   'REAL'],
    ['detected_big_apple',   'INTEGER'],
    ['spec_error',           'TEXT'],
    ['fallback_used',        'INTEGER'],
    ['parse_elapsed_ms',     'INTEGER'],
    ['solve_elapsed_ms',     'INTEGER'],
  ];
  for (const [col, type] of newCols) {
    if (!evalCols.includes(col)) {
      db.exec(`ALTER TABLE evaluations ADD COLUMN ${col} ${type}`);
    }
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


export interface RetrainingSuggestionRow {
  puzzleHash: string;
  gitHash: string;
  row: number;
  col: number;
  predictedLabel: number;
  suggestedLabel: number;
  confidenceTier: 'proven_unique' | 'feasible_only';
  cropPixels: number[];
}

export function insertRetrainingSuggestion(db: Database.Database, s: RetrainingSuggestionRow): void {
  db.prepare(`
    INSERT INTO retraining_suggestions
      (puzzle_hash, git_hash, row, col, predicted_label, suggested_label, confidence_tier, crop_pixels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.puzzleHash, s.gitHash, s.row, s.col,
    s.predictedLabel, s.suggestedLabel, s.confidenceTier,
    JSON.stringify(s.cropPixels),
  );
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

/** All optional per-run measurements stored alongside the core outcome fields. */
export interface CtEvalExtras {
  // WASM heap monitors (set by installCvMonitors)
  readonly liveMats?: number | null;
  readonly heapBytes?: number | null;
  readonly allocBytes?: number | null;
  // Contour-tree parallel-path diagnostics (Sprints 1–4; killer only for orientation/border/digit)
  readonly ctD1Count?: number | null;
  readonly ctD2Count?: number | null;
  readonly ctType?: string | null;
  readonly ctOrientation?: number | null;
  readonly quadSumOrientation?: number | null;
  readonly ctBorderAgreement?: number | null;
  readonly ctBorderFp?: number | null;
  readonly ctBorderFn?: number | null;
  readonly ctDigitAgreement?: number | null;
  // Outcome flags
  readonly detectedBigApple?: boolean | null;
  readonly specError?: string | null;
  readonly fallbackUsed?: boolean | null;
  // Timing (browser-measured)
  readonly parseElapsedMs?: number | null;
  readonly solveElapsedMs?: number | null;
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
  extras: CtEvalExtras = {},
): void {
  const e = extras;
  db.prepare(`
    UPDATE evaluations
    SET status = ?, bucket = ?, reason = ?, detected_type = ?,
        elapsed_ms = ?, spec_hash = ?,
        live_mats = ?, heap_bytes = ?, alloc_bytes = ?,
        ct_d1_count = ?, ct_d2_count = ?, ct_type = ?,
        ct_orientation = ?, quad_sum_orientation = ?,
        ct_border_agreement = ?, ct_border_fp = ?, ct_border_fn = ?,
        ct_digit_agreement = ?,
        detected_big_apple = ?, spec_error = ?, fallback_used = ?,
        parse_elapsed_ms = ?, solve_elapsed_ms = ?,
        finished_at = datetime('now')
    WHERE id = ?
  `).run(
    status, bucket, reason, detectedType, elapsedMs, specHash,
    e.liveMats ?? null, e.heapBytes ?? null, e.allocBytes ?? null,
    e.ctD1Count ?? null, e.ctD2Count ?? null, e.ctType ?? null,
    e.ctOrientation ?? null, e.quadSumOrientation ?? null,
    e.ctBorderAgreement ?? null, e.ctBorderFp ?? null, e.ctBorderFn ?? null,
    e.ctDigitAgreement ?? null,
    e.detectedBigApple == null ? null : (e.detectedBigApple ? 1 : 0),
    e.specError ?? null,
    e.fallbackUsed == null ? null : (e.fallbackUsed ? 1 : 0),
    e.parseElapsedMs ?? null, e.solveElapsedMs ?? null,
    id,
  );
}
