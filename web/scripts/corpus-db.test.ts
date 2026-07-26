import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addGroundTruth, claimEvaluation, completeEvaluation, getCorpora, getPuzzle,
  insertCellRead, insertPuzzle, insertRetrainingSuggestion, openDb, upsertCorpus,
  type CellReadRow, type CtEvalExtras, type RetrainingSuggestionRow,
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
  it('creates all five tables', () => {
    const db = tmpDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
    ).map(r => r.name).filter(n => !n.startsWith('sqlite_'));
    expect(names).toEqual(['cell_reads', 'corpora', 'evaluations', 'puzzles', 'retraining_suggestions']);
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
    completeEvaluation(db, claim!.id, 'done', 'clean', null, 'killer', 1234, null);
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
    completeEvaluation(db, first!.id, 'done', 'clean', null, 'killer', 100, null);
    const second = claimEvaluation(db, 'git222', 1);
    expect(second).toBeDefined();
  });

  it('stores spec_hash in the evaluations row', () => {
    const db = tmpDb();
    insertPuzzle(db, 'aabbcc', '/p.jpg', 'test', 'killer');
    const claim = claimEvaluation(db, 'gitabc', 1);
    completeEvaluation(db, claim!.id, 'done', 'clean', null, 'killer', 1234, 'deadbeef');
    const row = db.prepare(
      'SELECT spec_hash FROM evaluations WHERE id=?',
    ).get(claim!.id) as { spec_hash: string };
    expect(row.spec_hash).toBe('deadbeef');
    db.close();
  });

  it('drops the dead centroid columns on open', () => {
    const db = tmpDb();
    const cols = (db.prepare('PRAGMA table_info(evaluations)').all() as { name: string }[]).map(r => r.name);
    expect(cols).not.toContain('cell_centroid_dist_sq');
    expect(cols).not.toContain('box_centroid_dist_sq');
    db.close();
  });

  it('stores CtEvalExtras columns', () => {
    const db = tmpDb();
    insertPuzzle(db, 'aabbcc', '/p.jpg', 'test', 'killer');
    const claim = claimEvaluation(db, 'gitabc', 1)!;
    const extras: CtEvalExtras = {
      liveMats: 3, heapBytes: 1_000_000, allocBytes: 500_000,
      ctD1Count: 81, ctD2Count: 120, ctType: 'killer',
      ctOrientation: 0, quadSumOrientation: 0,
      ctBorderAgreement: 0.97, ctBorderFp: 2, ctBorderFn: 1,
      ctDigitAgreement: 0.95,
      detectedBigApple: false, specError: null, fallbackUsed: false,
      parseElapsedMs: 800, solveElapsedMs: 200,
    };
    completeEvaluation(db, claim.id, 'done', 'clean', null, 'killer', 1234, null, extras);
    const row = db.prepare('SELECT * FROM evaluations WHERE id=?').get(claim.id) as Record<string, unknown>;
    expect(row['live_mats']).toBe(3);
    expect(row['heap_bytes']).toBe(1_000_000);
    expect(row['alloc_bytes']).toBe(500_000);
    expect(row['ct_d1_count']).toBe(81);
    expect(row['ct_d2_count']).toBe(120);
    expect(row['ct_type']).toBe('killer');
    expect(row['ct_orientation']).toBeCloseTo(0);
    expect(row['quad_sum_orientation']).toBeCloseTo(0);
    expect(row['ct_border_agreement']).toBeCloseTo(0.97);
    expect(row['ct_border_fp']).toBe(2);
    expect(row['ct_border_fn']).toBe(1);
    expect(row['ct_digit_agreement']).toBeCloseTo(0.95);
    expect(row['detected_big_apple']).toBe(0);
    expect(row['spec_error']).toBeNull();
    expect(row['fallback_used']).toBe(0);
    expect(row['parse_elapsed_ms']).toBe(800);
    expect(row['solve_elapsed_ms']).toBe(200);
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

describe('retraining_suggestions table', () => {
  it('creates the table and accepts a pending suggestion', () => {
    const db = tmpDb();
    insertPuzzle(db, 'hash123', '/path/to/img.jpg', 'guardian', 'classic');
    insertRetrainingSuggestion(db, {
      puzzleHash: 'hash123',
      gitHash: 'test-hash',
      row: 1, col: 0,
      predictedLabel: 7, suggestedLabel: 2,
      confidenceTier: 'proven_unique',
      cropPixels: new Array(64 * 64).fill(0),
    });
    const row = db.prepare('SELECT * FROM retraining_suggestions WHERE puzzle_hash = ?').get('hash123') as
      { status: string; predicted_label: number; suggested_label: number } | undefined;
    expect(row?.status).toBe('pending');
    expect(row?.predicted_label).toBe(7);
    expect(row?.suggested_label).toBe(2);
    db.close();
  });

  it('is safe to call multiple times for the same puzzle/cell (append, not upsert)', () => {
    const db = tmpDb();
    insertPuzzle(db, 'hashA', '/path/a.jpg', 'guardian', 'classic');
    const row: RetrainingSuggestionRow = {
      puzzleHash: 'hashA', gitHash: 'g1', row: 0, col: 0,
      predictedLabel: 7, suggestedLabel: 2,
      confidenceTier: 'proven_unique', cropPixels: [0],
    };
    insertRetrainingSuggestion(db, row);
    insertRetrainingSuggestion(db, row);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM retraining_suggestions').get() as { n: number }).n;
    expect(count).toBe(2); // by design: every run's findings are recorded, review script dedupes by judgement
    db.close();
  });
});


describe('cell_reads (generalized from given_digit_reads)', () => {
  it('inserts and reads back a cage-total-digit row', () => {
    const db = tmpDb();
    insertPuzzle(db, 'p1', '/x.jpg', 'guardian', 'killer');
    const row: CellReadRow = {
      puzzleHash: 'p1', gitHash: 'h1', cellType: 'cage_total_digit',
      row: 0, col: 0, digitIndex: 1, predictedLabel: 6, confident: true,
      clashesWith: [], cropPixels: [0, 1], hogFeatures: [0.1], holeFeatures: [0.2],
    };
    insertCellRead(db, row);
    const saved = db.prepare('SELECT * FROM cell_reads WHERE puzzle_hash = ?').get('p1') as {
      cell_type: string; digit_index: number; hog_features: string; hole_features: string;
    };
    expect(saved.cell_type).toBe('cage_total_digit');
    expect(saved.digit_index).toBe(1);
    expect(JSON.parse(saved.hog_features)).toEqual([0.1]);
    expect(JSON.parse(saved.hole_features)).toEqual([0.2]);
    db.close();
  });

  it('defaults digit_index to 0 for a given-digit row', () => {
    const db = tmpDb();
    insertPuzzle(db, 'p2', '/y.jpg', 'guardian', 'classic');
    insertCellRead(db, {
      puzzleHash: 'p2', gitHash: 'h1', cellType: 'given_digit',
      row: 3, col: 4, digitIndex: 0, predictedLabel: 7, confident: false,
      clashesWith: [{ row: 3, col: 8 }], cropPixels: [], hogFeatures: [], holeFeatures: [],
    });
    const saved = db.prepare('SELECT * FROM cell_reads WHERE puzzle_hash = ?').get('p2') as {
      digit_index: number; clashes_with: string;
    };
    expect(saved.digit_index).toBe(0);
    expect(JSON.parse(saved.clashes_with)).toEqual([{ row: 3, col: 8 }]);
    db.close();
  });
});

describe('evaluations border/cage-total structure columns', () => {
  it('adds border_x, border_y, cage_totals columns', () => {
    const db = tmpDb();
    const cols = (db.prepare('PRAGMA table_info(evaluations)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['border_x', 'border_y', 'cage_totals']));
    db.close();
  });
});
