import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getCorpora, getPuzzle, openDb } from './corpus-db.js';
import { hashFile, populateCorpus } from './populate-corpus.js';

let tmpDir = '';
let dbPath = '';
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const suffix of ['', '-shm', '-wal']) {
    const f = dbPath + suffix;
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore EBUSY on Windows */ }
  }
});

function makeTmpCorpus(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-test-'));
  const obs = path.join(tmpDir, 'observer');
  const cls = path.join(tmpDir, 'classic_observer');
  fs.mkdirSync(obs);
  fs.mkdirSync(cls);
  fs.writeFileSync(path.join(obs, 'puzzle_0.jpg'), 'fake-jpg-content-A');
  fs.writeFileSync(path.join(obs, 'puzzle_1.jpg'), 'fake-jpg-content-B');
  // Same bytes as puzzle_0 but in classic_observer — conflict
  fs.writeFileSync(path.join(cls, 'puzzle_dup.jpg'), 'fake-jpg-content-A');
  // Unique classic puzzle
  fs.writeFileSync(path.join(cls, 'puzzle_2.jpg'), 'fake-jpg-content-C');
  return tmpDir;
}

function tmpDb(repoRoot: string): ReturnType<typeof openDb> {
  dbPath = path.join(os.tmpdir(), `populate-test-${Date.now()}-${Math.random()}.db`);
  return openDb(dbPath);
}

describe('hashFile', () => {
  it('returns a 64-character hex string', () => {
    const f = path.join(os.tmpdir(), `hash-test-${Date.now()}.bin`);
    fs.writeFileSync(f, 'hello');
    const h = hashFile(f);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    fs.unlinkSync(f);
  });

  it('returns the same hash for identical content', () => {
    const f1 = path.join(os.tmpdir(), `hash-test-${Date.now()}-1.bin`);
    const f2 = path.join(os.tmpdir(), `hash-test-${Date.now()}-2.bin`);
    fs.writeFileSync(f1, 'same content');
    fs.writeFileSync(f2, 'same content');
    expect(hashFile(f1)).toBe(hashFile(f2));
    fs.unlinkSync(f1);
    fs.unlinkSync(f2);
  });
});

describe('populateCorpus', () => {
  it('adds distinct puzzles, nulls ground_truth on conflict, and writes corpora rows', () => {
    const repoRoot = makeTmpCorpus();
    const db = tmpDb(repoRoot);
    const result = populateCorpus(db, repoRoot);
    // A (killer), B (killer), C (classic) — dup A in classic is a conflict, not a new puzzle
    expect(result.added).toBe(3);
    expect(result.known).toBe(0);
    expect(result.conflicts).toBe(1);
    // The conflicted puzzle (content A) should have ground_truth nulled to become a hold-out
    const hashA = createHash('sha256').update('fake-jpg-content-A').digest('hex');
    expect(getPuzzle(db, hashA)!.ground_truth).toEqual(['classic', 'killer']);
    const corpora = getCorpora(db);
    expect(corpora).toHaveLength(2); // observer + classic_observer (guardian/classic_guardian absent)
    expect(corpora.map(r => r.ground_truth).sort()).toEqual(['classic', 'killer']);
    db.close();
  });

  it('finds jpg files in subdirectories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-test-'));
    const subdir = path.join(root, 'classic_observer', 'easy');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, 'puzzle_sub.jpg'), 'fake-jpg-sub');
    dbPath = path.join(os.tmpdir(), `populate-test-${Date.now()}-${Math.random()}.db`);
    const db = openDb(dbPath);
    const result = populateCorpus(db, root);
    expect(result.added).toBe(1);
    const corpora = getCorpora(db);
    expect(corpora[0]!.file_count).toBe(1);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is idempotent — second run adds nothing new', () => {
    const repoRoot = makeTmpCorpus();
    const db = tmpDb(repoRoot);
    populateCorpus(db, repoRoot);
    const second = populateCorpus(db, repoRoot);
    expect(second.added).toBe(0);
    expect(second.conflicts).toBe(0); // already null, not re-flagged
    // known = B + C + A(from observer) + A(from classic_observer) = 4
    expect(second.known).toBe(4);
    db.close();
  });
});
