import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './corpus-db.js';
import {
  buildEvaluationReport,
  compareEvaluationReports,
  emitEvaluationReport,
  ingestPuzzleDirectory,
  type EvaluationReport,
} from './evaluation-report.js';

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluation-report-'));
  cleanupPaths.push(dir);
  return dir;
}

function report(outcomes: EvaluationReport['outcomes']): EvaluationReport {
  return { version: 1, modelSha256: 'a'.repeat(64), outcomes };
}

describe('compareEvaluationReports', () => {
  it('reports only rank drops for baseline puzzles, sorted by path', () => {
    const baseline = report([
      { puzzleHash: 'z', path: '/z.jpg', bucket: 'clean', reason: null, specHash: 'z1' },
      { puzzleHash: 'a', path: '/a.jpg', bucket: 'backtracked', reason: null, specHash: 'a1' },
      { puzzleHash: 'y', path: '/y.jpg', bucket: 'clean', reason: null, specHash: 'y1' },
      { puzzleHash: 'b', path: '/b.jpg', bucket: 'notSolved', reason: 'old', specHash: null },
    ]);
    const current = report([
      { puzzleHash: 'new', path: '/new.jpg', bucket: 'notSolved', reason: 'new', specHash: null },
      { puzzleHash: 'z', path: '/z.jpg', bucket: 'backtracked', reason: 'slower', specHash: 'z1' },
      { puzzleHash: 'a', path: '/a.jpg', bucket: 'clean', reason: null, specHash: 'a1' },
      { puzzleHash: 'y', path: '/y.jpg', bucket: 'notSolved', reason: 'failed', specHash: null },
      { puzzleHash: 'b', path: '/b.jpg', bucket: 'notSolved', reason: 'same rank', specHash: null },
    ]);

    expect(compareEvaluationReports(baseline, current).map(item => ({
      path: item.current.path,
      from: item.baseline.bucket,
      to: item.current.bucket,
    }))).toEqual([
      { path: '/y.jpg', from: 'clean', to: 'notSolved' },
      { path: '/z.jpg', from: 'clean', to: 'backtracked' },
    ]);
  });
});

describe('ingestPuzzleDirectory', () => {
  it('is content-hash idempotent and scans paths deterministically', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'b.jpg'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(dir, 'a.jpg'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(dir, 'c.png'), Buffer.from([4, 5, 6]));
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'not an image');
    const db = openDb(path.join(dir, 'corpus.db'));

    expect(ingestPuzzleDirectory(db, dir)).toEqual({ scanned: 3, added: 2 });
    expect(ingestPuzzleDirectory(db, dir)).toEqual({ scanned: 3, added: 0 });
    const paths = (db.prepare('SELECT path FROM puzzles ORDER BY path').all() as { path: string }[])
      .map(row => path.basename(row.path));
    expect(paths).toEqual(['a.jpg', 'c.png']);
    db.close();
  });
});

describe('buildEvaluationReport', () => {
  it('hashes the model and sorts normalized outcomes by path', () => {
    const dir = tempDir();
    const modelPath = path.join(dir, 'model.bin');
    fs.writeFileSync(modelPath, 'model-v1');
    const db = openDb(path.join(dir, 'corpus.db'));
    const insertPuzzle = db.prepare(
      "INSERT INTO puzzles (content_hash, path, corpus, ground_truth) VALUES (?, ?, 'test', '[]')",
    );
    insertPuzzle.run('z', path.join(dir, 'z.jpg'));
    insertPuzzle.run('a', path.join(dir, 'a.jpg'));
    db.exec(`
      INSERT INTO evaluations (puzzle_hash, git_hash, status, bucket, reason, spec_hash)
      VALUES ('z', 'g1', 'failed', 'error', 'boom', NULL),
             ('a', 'g1', 'done', 'clean', NULL, 'spec-a');
    `);

    const result = buildEvaluationReport(db, 'g1', modelPath, dir);

    expect(result.modelSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.outcomes).toEqual([
      { puzzleHash: 'a', path: 'a.jpg', bucket: 'clean', reason: null, specHash: 'spec-a' },
      { puzzleHash: 'z', path: 'z.jpg', bucket: 'notSolved', reason: 'boom', specHash: null },
    ]);
    expect(buildEvaluationReport(db, 'g1', modelPath, dir)).toEqual(result);
    db.close();
  });
});

describe('emitEvaluationReport', () => {
  it('writes deterministic JSON and returns failure only for a regression', () => {
    const dir = tempDir();
    const baselinePath = path.join(dir, 'baseline.json');
    const outputPath = path.join(dir, 'current.json');
    const baseline = report([
      { puzzleHash: 'a', path: '/a.jpg', bucket: 'clean', reason: null, specHash: 'a' },
    ]);
    const current = report([
      { puzzleHash: 'a', path: '/a.jpg', bucket: 'backtracked', reason: 'fallback', specHash: 'a' },
    ]);
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));

    const result = emitEvaluationReport(current, outputPath, baselinePath);

    expect(result.exitCode).toBe(1);
    expect(result.regressions).toHaveLength(1);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(`${JSON.stringify(current, null, 2)}\n`);
  });
});
