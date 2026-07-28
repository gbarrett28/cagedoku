import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getEvaluationOutcomeRows } from './corpus-db.js';

export type EvaluationBucket = 'clean' | 'backtracked' | 'notSolved';

export interface EvaluationOutcome {
  readonly puzzleHash: string;
  readonly path: string;
  readonly bucket: EvaluationBucket;
  readonly reason: string | null;
  readonly specHash: string | null;
}

export interface EvaluationReport {
  readonly version: 1;
  readonly modelSha256: string;
  readonly outcomes: readonly EvaluationOutcome[];
}

export interface EvaluationRegression {
  readonly baseline: EvaluationOutcome;
  readonly current: EvaluationOutcome;
}

export interface EmitEvaluationResult {
  readonly exitCode: 0 | 1;
  readonly regressions: readonly EvaluationRegression[];
}

const BUCKET_RANK: Readonly<Record<EvaluationBucket, number>> = {
  clean: 2,
  backtracked: 1,
  notSolved: 0,
};

function textOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function outcomePathOrder(a: EvaluationOutcome, b: EvaluationOutcome): number {
  return textOrder(a.path, b.path) || textOrder(a.puzzleHash, b.puzzleHash);
}

export function compareEvaluationReports(
  baseline: EvaluationReport,
  current: EvaluationReport,
): readonly EvaluationRegression[] {
  const currentByHash = new Map(current.outcomes.map(outcome => [outcome.puzzleHash, outcome]));
  const regressions: EvaluationRegression[] = [];
  for (const oldOutcome of baseline.outcomes) {
    const newOutcome = currentByHash.get(oldOutcome.puzzleHash);
    if (newOutcome !== undefined && BUCKET_RANK[newOutcome.bucket] < BUCKET_RANK[oldOutcome.bucket]) {
      regressions.push({ baseline: oldOutcome, current: newOutcome });
    }
  }
  return regressions.sort((a, b) => outcomePathOrder(a.current, b.current));
}

function collectPuzzleFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectPuzzleFiles(entryPath));
    } else if (/\.(?:jpe?g|png)$/i.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files.sort(textOrder);
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function ingestPuzzleDirectory(
  db: Database.Database,
  puzzleDir: string,
): { readonly scanned: number; readonly added: number } {
  const root = path.resolve(puzzleDir);
  const files = collectPuzzleFiles(root);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO puzzles (content_hash, path, corpus, ground_truth) VALUES (?, ?, ?, '[]')",
  );
  let added = 0;
  const transaction = db.transaction(() => {
    for (const filePath of files) {
      added += insert.run(sha256File(filePath), filePath, path.basename(root)).changes;
    }
  });
  transaction();
  return { scanned: files.length, added };
}

function normalizeBucket(bucket: string | null): EvaluationBucket {
  if (bucket === 'clean' || bucket === 'backtracked') return bucket;
  return 'notSolved';
}

export function buildEvaluationReport(
  db: Database.Database,
  gitHash: string,
  modelPath: string,
  puzzleRoot?: string,
): EvaluationReport {
  const root = puzzleRoot === undefined ? undefined : path.resolve(puzzleRoot);
  const outcomes = getEvaluationOutcomeRows(db, gitHash).map(row => ({
    puzzleHash: row.puzzleHash,
    path: root === undefined ? row.path : path.relative(root, row.path).replaceAll('\\', '/'),
    bucket: normalizeBucket(row.bucket),
    reason: row.reason,
    specHash: row.specHash,
  } satisfies EvaluationOutcome));
  return {
    version: 1,
    modelSha256: sha256File(modelPath),
    outcomes,
  };
}

function isOutcome(value: unknown): value is EvaluationOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item['puzzleHash'] === 'string'
    && typeof item['path'] === 'string'
    && (item['bucket'] === 'clean' || item['bucket'] === 'backtracked' || item['bucket'] === 'notSolved')
    && (item['reason'] === null || typeof item['reason'] === 'string')
    && (item['specHash'] === null || typeof item['specHash'] === 'string');
}

export function readEvaluationReport(reportPath: string): EvaluationReport {
  const value: unknown = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid evaluation report: ${reportPath}`);
  }
  const report = value as Record<string, unknown>;
  if (report['version'] !== 1
      || typeof report['modelSha256'] !== 'string'
      || !/^[0-9a-f]{64}$/.test(report['modelSha256'])
      || !Array.isArray(report['outcomes'])
      || !report['outcomes'].every(isOutcome)) {
    throw new Error(`Invalid evaluation report: ${reportPath}`);
  }
  return report as unknown as EvaluationReport;
}

export function emitEvaluationReport(
  report: EvaluationReport,
  reportOut?: string,
  compareReport?: string,
): EmitEvaluationResult {
  if (reportOut !== undefined) {
    fs.writeFileSync(reportOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  const regressions = compareReport === undefined
    ? []
    : compareEvaluationReports(readEvaluationReport(compareReport), report);
  return { exitCode: regressions.length === 0 ? 0 : 1, regressions };
}
