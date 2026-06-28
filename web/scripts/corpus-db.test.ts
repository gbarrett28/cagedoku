import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addGroundTruth, claimEvaluation, completeEvaluation, getCorpora, getPuzzle,
  insertPuzzle, openDb, upsertCorpus,
} from './corpus-db.js';

let dbPath = '';
afterEach(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = dbPath + suffix;
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore EBUSY on Windows */ }
  }
});
function tmpDb(): ReturnType<typeof openDb> {
  dbPath = path.join(os.tmpdir(), `corpus-test-${Date.now()}-${Math.random()}.db`);
  return openDb(dbPath);
}

describe('openDb', () => {
  it('creates all three tables', () => {
    const db = tmpDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
    ).map(r => r.name).filter(n => !n.startsWith('sqlite_'));
    expect(names).toEqual(['corpora', 'evaluations', 'puzzles']);
    db.close();
  });

  it('is idempotent — re-opening does not throw', () => {
    const db = tmpDb();
    db.close();
    expect(() => { const db2 = openDb(dbPath); db2.close(); }).not.toThrow();
  });
});

describe('insertPuzzle / getPuzzle', () => {
  it('round-trips a row with a single-element ground_truth array', () => {
    const db = tmpDb();
    insertPuzzle(db, 'aabbcc', '/path/to/puzzle.jpg', 'test', 'killer');
    expect(getPuzzle(db, 'aabbcc')).toEqual({
      content_hash: 'aabbcc', path: '/path/to/puzzle.jpg', corpus: 'test', ground_truth: ['killer'],
    });
    db.close();
  });

  it('INSERT OR IGNORE does not overwrite an existing row', () => {
    const db = tmpDb();
    insertPuzzle(db, 'aabbcc', '/first.jpg', 'test', 'killer');
    insertPuzzle(db, 'aabbcc', '/second.jpg', 'test', 'killer');
    expect(getPuzzle(db, 'aabbcc')!.path).toBe('/first.jpg');
    db.close();
  });

  it('returns undefined for an unknown hash', () => {
    const db = tmpDb();
    expect(getPuzzle(db, 'nosuchhash')).toBeUndefined();
    db.close();
  });
});

describe('addGroundTruth', () => {
  it('appends a new label and sorts the array', () => {
    const db = tmpDb();
    insertPuzzle(db, 'aabbcc', '/p.jpg', 'test', 'killer');
    addGroundTruth(db, 'aabbcc', 'classic');
    expect(getPuzzle(db, 'aabbcc')!.ground_truth).toEqual(['classic', 'killer']);
    db.close();
  });

  it('is idempotent — adding an already-present label does not duplicate it', () => {
    const db = tmpDb();
    insertPuzzle(db, 'aabbcc', '/p.jpg', 'test', 'killer');
    addGroundTruth(db, 'aabbcc', 'killer');
    expect(getPuzzle(db, 'aabbcc')!.ground_truth).toEqual(['killer']);
    db.close();
  });
});

describe('claimEvaluation / completeEvaluation', () => {
  it('claims an unclaimed puzzle and marks it done', () => {
    const db = tmpDb();
    insertPuzzle(db, 'aabbcc', '/p.jpg', 'test', 'killer');
    const claim = claimEvaluation(db, 'gitabc', 1);
    expect(claim).toBeDefined();
    expect(claim!.puzzle_hash).toBe('aabbcc');
    completeEvaluation(db, claim!.id, 'done', 'clean', null, 'killer', 1234, null, null, null);
    const row = db.prepare(
      'SELECT status, bucket FROM evaluations WHERE id=?',
    ).get(claim!.id) as { status: string; bucket: string };
    expect(row.status).toBe('done');
    expect(row.bucket).toBe('clean');
    db.close();
  });

  it('does not claim the same puzzle twice for the same git_hash', () => {
    const db = tmpDb();
    insertPuzzle(db, 'aabbcc', '/p.jpg', 'test', 'killer');
    claimEvaluation(db, 'gitabc', 1);
    const second = claimEvaluation(db, 'gitabc', 2);
    expect(second).toBeUndefined();
    db.close();
  });

  it('allows claiming the same puzzle for a different git_hash', () => {
    const db = tmpDb();
    insertPuzzle(db, 'aabbcc', '/p.jpg', 'test', 'killer');
    const first = claimEvaluation(db, 'git111', 1);
    completeEvaluation(db, first!.id, 'done', 'clean', null, 'killer', 100, null, null, null);
    const second = claimEvaluation(db, 'git222', 1);
    expect(second).toBeDefined();
  });

  it('stores spec_hash in the evaluations row', () => {
    const db = tmpDb();
    insertPuzzle(db, 'aabbcc', '/p.jpg', 'test', 'killer');
    const claim = claimEvaluation(db, 'gitabc', 1);
    completeEvaluation(db, claim!.id, 'done', 'clean', null, 'killer', 1234, 'deadbeef', null, null);
    const row = db.prepare(
      'SELECT spec_hash FROM evaluations WHERE id=?',
    ).get(claim!.id) as { spec_hash: string };
    expect(row.spec_hash).toBe('deadbeef');
    db.close();
  });

  it('stores cell_centroid_dist_sq and box_centroid_dist_sq', () => {
    const db = tmpDb();
    insertPuzzle(db, 'aabbcc', '/p.jpg', 'test', 'killer');
    const claim = claimEvaluation(db, 'gitabc', 1);
    completeEvaluation(db, claim!.id, 'done', 'clean', null, 'killer', 1234, null, 2.34, 1.12);
    const row = db.prepare(
      'SELECT cell_centroid_dist_sq, box_centroid_dist_sq FROM evaluations WHERE id=?',
    ).get(claim!.id) as { cell_centroid_dist_sq: number; box_centroid_dist_sq: number };
    expect(row.cell_centroid_dist_sq).toBeCloseTo(2.34);
    expect(row.box_centroid_dist_sq).toBeCloseTo(1.12);
    db.close();
  });
});

describe('upsertCorpus / getCorpora', () => {
  it('records a scanned directory', () => {
    const db = tmpDb();
    upsertCorpus(db, '/repo/observer', 'killer', 424);
    const rows = getCorpora(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dir_path: '/repo/observer', ground_truth: 'killer', file_count: 424 });
    db.close();
  });

  it('updates file_count and last_scanned on re-scan', () => {
    const db = tmpDb();
    upsertCorpus(db, '/repo/observer', 'killer', 424);
    upsertCorpus(db, '/repo/observer', 'killer', 430);
    expect(getCorpora(db)[0]!.file_count).toBe(430);
    db.close();
  });

  it('records multiple directories in dir_path order', () => {
    const db = tmpDb();
    upsertCorpus(db, '/repo/observer', 'killer', 424);
    upsertCorpus(db, '/repo/classic_observer', 'classic', 504);
    expect(getCorpora(db).map(r => r.ground_truth)).toEqual(['classic', 'killer']);
    db.close();
  });
});
