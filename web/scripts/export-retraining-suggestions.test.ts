import { afterEach, describe, it, expect } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, insertPuzzle, insertRetrainingSuggestion } from './corpus-db.js';
import { exportApprovedSuggestions } from './export-retraining-suggestions.js';

let dbPath = '';
afterEach(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = dbPath + suffix;
    try { if (f && existsSync(f)) unlinkSync(f); } catch { /* ignore EBUSY on Windows */ }
  }
});
function tmpDb(): ReturnType<typeof openDb> {
  dbPath = path.join(os.tmpdir(), `export-test-${Date.now()}-${Math.random()}.db`);
  return openDb(dbPath);
}

describe('exportApprovedSuggestions', () => {
  it('exports only approved rows, in TrainingExport-compatible shape', () => {
    const db = tmpDb();
    insertPuzzle(db, 'hashA', '/path/a.jpg', 'guardian', 'classic');
    insertRetrainingSuggestion(db, {
      puzzleHash: 'hashA', gitHash: 'g1', row: 1, col: 0,
      predictedLabel: 7, suggestedLabel: 2,
      confidenceTier: 'proven_unique', cropPixels: new Array(64 * 64).fill(9),
    });
    insertRetrainingSuggestion(db, {
      puzzleHash: 'hashA', gitHash: 'g1', row: 0, col: 6,
      predictedLabel: 7, suggestedLabel: 2,
      confidenceTier: 'proven_unique', cropPixels: new Array(64 * 64).fill(3),
    });
    const [id1] = db.prepare("SELECT id FROM retraining_suggestions ORDER BY id").all() as { id: number }[];

    const result = exportApprovedSuggestions(db); // 0 approved yet
    expect(result.samples).toHaveLength(0);

    db.prepare("UPDATE retraining_suggestions SET status = 'approved' WHERE id = ?").run(id1!.id);
    const result2 = exportApprovedSuggestions(db);
    expect(result2.samples).toHaveLength(1);
    expect(result2.samples[0]).toEqual({ digit: 2, pixels: new Array(64 * 64).fill(9) });
    expect(result2.thumbnailSize).toBe(64);
    db.close();
  });
});
