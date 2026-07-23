import { afterEach, describe, it, expect } from 'vitest';
import { existsSync, rmSync, unlinkSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { openDb, insertPuzzle, insertRetrainingSuggestion } from './corpus-db.js';
import { dumpPendingSuggestions, setSuggestionStatus } from './review-retraining-suggestions.js';

let dbPath = '';
afterEach(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = dbPath + suffix;
    try { if (f && existsSync(f)) unlinkSync(f); } catch { /* ignore EBUSY on Windows */ }
  }
});
function tmpDb(): ReturnType<typeof openDb> {
  dbPath = path.join(os.tmpdir(), `review-test-${Date.now()}-${Math.random()}.db`);
  return openDb(dbPath);
}

describe('review-retraining-suggestions', () => {
  it('dumps a PNG per pending suggestion and a manifest listing them', () => {
    const db = tmpDb();
    insertPuzzle(db, 'hashA', '/path/a.jpg', 'guardian', 'classic');
    insertRetrainingSuggestion(db, {
      puzzleHash: 'hashA', gitHash: 'g1', row: 1, col: 0,
      predictedLabel: 7, suggestedLabel: 2,
      confidenceTier: 'proven_unique', cropPixels: new Array(64 * 64).fill(255),
    });
    const outDir = path.join(os.tmpdir(), `review-out-test-${Date.now()}`);
    const manifest = dumpPendingSuggestions(db, outDir);
    expect(manifest).toHaveLength(1);
    expect(existsSync(manifest[0]!.pngPath)).toBe(true);
    rmSync(outDir, { recursive: true, force: true });
    db.close();
  });

  it('dumped PNG faithfully round-trips every pixel of the crop, including the bottom rows', () => {
    const db = tmpDb();
    insertPuzzle(db, 'hashA', '/path/a.jpg', 'guardian', 'classic');
    // Distinct value per pixel so a shifted/interleaved write is detectable,
    // not just "some data made it into the file".
    const cropPixels = Array.from({ length: 64 * 64 }, (_, i) => i % 256);
    insertRetrainingSuggestion(db, {
      puzzleHash: 'hashA', gitHash: 'g1', row: 1, col: 0,
      predictedLabel: 7, suggestedLabel: 2,
      confidenceTier: 'proven_unique', cropPixels,
    });
    const outDir = path.join(os.tmpdir(), `review-out-test-${Date.now()}`);
    const manifest = dumpPendingSuggestions(db, outDir);
    const decoded = PNG.sync.read(readFileSync(manifest[0]!.pngPath));
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(64);
    for (const i of [0, 1, 4095, 64 * 32 + 10, 64 * 63 + 63]) {
      const v = cropPixels[i]!;
      expect(decoded.data[i * 4]).toBe(v);
      expect(decoded.data[i * 4 + 1]).toBe(v);
      expect(decoded.data[i * 4 + 2]).toBe(v);
      expect(decoded.data[i * 4 + 3]).toBe(255);
    }
    rmSync(outDir, { recursive: true, force: true });
    db.close();
  });

  it('setSuggestionStatus updates status and is idempotent', () => {
    const db = tmpDb();
    insertPuzzle(db, 'hashA', '/path/a.jpg', 'guardian', 'classic');
    insertRetrainingSuggestion(db, {
      puzzleHash: 'hashA', gitHash: 'g1', row: 1, col: 0,
      predictedLabel: 7, suggestedLabel: 2,
      confidenceTier: 'proven_unique', cropPixels: [0],
    });
    const id = (db.prepare('SELECT id FROM retraining_suggestions').get() as { id: number }).id;
    setSuggestionStatus(db, id, 'approved');
    const row = db.prepare('SELECT status FROM retraining_suggestions WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('approved');
    db.close();
  });
});
