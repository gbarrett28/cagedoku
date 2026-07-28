#!/usr/bin/env vite-node
/**
 * Corpus evaluation: runs the production TS pipeline (OCR + solve) against
 * every puzzle in corpus.db, to measure regression against real-world images.
 * Manual/occasional tool — the source images are gitignored.
 *
 * Requires a running production preview server in another terminal:
 *   npm run build && npm run preview
 *
 * Run from web/:
 *   npx vite-node --script scripts/evaluate-corpus.ts [options]
 *
 * Options:
 *   --workers N       Playwright worker count (default 4; each ~400MB RAM)
 *   --limit N         Stop after N total evaluations (development shortcut)
 *   --base-url URL    App URL (default http://localhost:4173)
 *   --git-hash SHA    Git commit to tag results against (default: current HEAD)
 *   --db-path PATH    Path to corpus.db (default: ../../corpus.db)
 *   --stop-on-fail [N]  Stop all workers once N puzzles (default 1) have
 *                        landed in notSolved/timeout/failed (i.e. didn't solve)
 *
 * Note: if the process is killed (SIGKILL/crash), in-flight evaluation rows
 * are left as status='running'. They will not be re-claimed for the same
 * git hash. Use a fresh --git-hash to re-evaluate them.
 */
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  DEFAULT_DB_PATH, claimEvaluation, completeEvaluation, insertRetrainingSuggestion, insertCellRead,
  openDb, type CtEvalExtras,
} from './corpus-db.js';
import { waitForPipelineReady } from '../e2e/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_WORKERS = 4;
const DEFAULT_TIMEOUT_MS = 30_000;

interface Args {
  readonly workers: number;
  readonly limit: number | null;
  readonly baseUrl: string;
  readonly gitHash: string;
  readonly dbPath: string;
  readonly filter: string | undefined;
  readonly stopOnFailCount: number | null;
}


interface UploadOutcomeJson {
  readonly bucket: 'clean' | 'backtracked' | 'notSolved';
  readonly reason: string;
  readonly puzzleType: string | null;
  readonly detectedBigApple: boolean;
  readonly specHash: string | null;
  readonly fallbackUsed: boolean;
  readonly specError: string | null;
  readonly parseElapsedMs: number;
  readonly solveElapsedMs: number;
  readonly liveMats?: number;
  readonly heapBytes?: number;
  readonly allocBytes?: number;
  readonly retrainingSuggestions?: ReadonlyArray<{
    readonly row: number;
    readonly col: number;
    readonly predictedLabel: number;
    readonly suggestedLabel: number;
    readonly confidenceTier: 'proven_unique' | 'feasible_only';
    readonly crop: number[];
  }>;
  readonly givenDigitReads?: ReadonlyArray<{
    readonly row: number;
    readonly col: number;
    readonly predictedLabel: number;
    readonly confident: boolean;
    readonly clashesWith: ReadonlyArray<{ readonly row: number; readonly col: number }>;
    readonly sourceX: number;
    readonly sourceY: number;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly sourcePixels: number[];
    readonly recognitionPixels: number[];
    readonly warpStrategy: 'stretch' | 'letterbox';
    readonly hogFeatures?: number[];
    readonly holeFeatures?: number[];
  }>;
  readonly cageTotalReads?: ReadonlyArray<{
    readonly row: number;
    readonly col: number;
    readonly digitIndex: number;
    readonly predictedLabel: number;
    readonly confident: boolean;
    readonly sourceX: number;
    readonly sourceY: number;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly sourcePixels: number[];
    readonly recognitionPixels: number[];
    readonly warpStrategy: 'stretch' | 'letterbox';
    readonly hogFeatures?: number[];
    readonly holeFeatures?: number[];
  }>;
}

interface BucketCounts {
  clean: number;
  backtracked: number;
  notSolved: number;
  timeout: number;
  failed: number;
}

let activeBrowser: Browser | null = null;
let shuttingDown = false;

function parseArgs(argv: readonly string[]): Args {
  let workers = DEFAULT_WORKERS;
  let limit: number | null = null;
  let baseUrl = 'http://localhost:4173';
  let gitHash = execSync('git rev-parse HEAD', { cwd: path.resolve(__dirname, '../..') })
    .toString()
    .trim();
  let dbPath = DEFAULT_DB_PATH;
  let filter: string | undefined;
  let stopOnFailCount: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workers') workers = Number(argv[++i]);
    else if (argv[i] === '--limit') limit = Number(argv[++i]);
    else if (argv[i] === '--base-url') baseUrl = argv[++i]!;
    else if (argv[i] === '--git-hash') gitHash = argv[++i]!;
    else if (argv[i] === '--db-path') dbPath = argv[++i]!;
    else if (argv[i] === '--filter') filter = argv[++i];
    else if (argv[i] === '--stop-on-fail') {
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) {
        stopOnFailCount = Number(next);
        i++;
      } else {
        stopOnFailCount = 1;
      }
    }
  }
  return { workers, limit, baseUrl, gitHash, dbPath, filter, stopOnFailCount };
}

async function checkServerReachable(baseUrl: string): Promise<void> {
  try {
    await fetch(baseUrl);
  } catch {
    throw new Error(
      `Cannot reach ${baseUrl} -- run \`npm run build && npm run preview\` in another terminal first.`,
    );
  }
}

async function makeWarmPage(browser: Browser, baseUrl: string): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('coach_tutorial_suppressed', 'true'));
  // Neutralize <dialog>.showModal() -- training-consent-modal (and any other modal) would
  // otherwise intercept pointer events for the worker's entire run.
  await page.addInitScript(() => {
    HTMLDialogElement.prototype.showModal = () => {};
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 90_000);
  return page;
}

async function runWorker(
  browser: Browser,
  baseUrl: string,
  db: ReturnType<typeof openDb>,
  gitHash: string,
  workerId: number,
  limit: number | null,
  filter: string | undefined,
  counts: BucketCounts,
  progress: { done: number; total: number },
  stopOnFailCount: number | null,
): Promise<void> {
  const page = await makeWarmPage(browser, baseUrl);

  // One-shot resolver: set before each upload, fired by __reportOutcome, nulled after.
  let resolveOutcome: ((o: UploadOutcomeJson) => void) | null = null;
  await page.exposeFunction('__reportOutcome', (o: UploadOutcomeJson) => {
    resolveOutcome?.(o);
    resolveOutcome = null;
  });

  while (!shuttingDown) {
    if (limit !== null && progress.done >= limit) break;

    const claim = claimEvaluation(db, gitHash, workerId, filter);
    if (claim === undefined) break;

    const puzzle = db
      .prepare('SELECT path FROM puzzles WHERE content_hash = ?')
      .get(claim.puzzle_hash) as { path: string } | undefined;
    if (puzzle === undefined) {
      completeEvaluation(db, claim.id, 'failed', 'error', 'puzzle path not found', null, 0, null);
      continue;
    }

    const startMs = Date.now();
    let status: 'done' | 'failed' = 'done';
    let bucket = 'notSolved';
    let reason: string | null = null;
    let detectedType: string | null = null;
    let specHash: string | null = null;
    let outcome: UploadOutcomeJson | undefined;
    let liveMats: number | undefined;
    let heapBytes: number | undefined;
    let allocBytes: number | undefined;
    let fallbackUsed: boolean | undefined;
    let specError: string | null | undefined;
    let parseElapsedMs: number | undefined;
    let solveElapsedMs: number | undefined;

    try {
      const outcomePromise = new Promise<UploadOutcomeJson>(r => {
        resolveOutcome = r;
      });
      const timeoutPromise = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('outcome timeout')), DEFAULT_TIMEOUT_MS),
      );

      await page.locator('#file-input').setInputFiles(puzzle.path);
      outcome = await Promise.race([outcomePromise, timeoutPromise]);

      bucket = outcome.bucket;
      reason = outcome.reason;
      detectedType = outcome.puzzleType;
      specHash = outcome.specHash;
      counts[outcome.bucket]++;
      ({ liveMats, heapBytes, allocBytes,
         fallbackUsed, specError, parseElapsedMs, solveElapsedMs } = outcome);
    } catch (e) {
      status = 'failed';
      const message = String(e);
      if (message.includes('outcome timeout')) {
        bucket = 'timeout';
        counts.timeout++;
      } else {
        bucket = 'error';
        reason = message;
        counts.failed++;
      }
    }

    const extras: CtEvalExtras = {
      liveMats:           liveMats           ?? null,
      heapBytes:          heapBytes          ?? null,
      allocBytes:         allocBytes         ?? null,
      detectedBigApple:   outcome?.detectedBigApple ?? null,
      specError:          specError          ?? null,
      fallbackUsed:       fallbackUsed       ?? null,
      parseElapsedMs:     parseElapsedMs     ?? null,
      solveElapsedMs:     solveElapsedMs     ?? null,
    };
    completeEvaluation(db, claim.id, status, bucket, reason, detectedType, Date.now() - startMs, specHash, extras);

    for (const s of outcome?.retrainingSuggestions ?? []) {
      insertRetrainingSuggestion(db, {
        puzzleHash: claim.puzzle_hash,
        gitHash,
        row: s.row,
        col: s.col,
        predictedLabel: s.predictedLabel,
        suggestedLabel: s.suggestedLabel,
        confidenceTier: s.confidenceTier,
        cropPixels: s.crop,
      });
    }

    for (const r of outcome?.givenDigitReads ?? []) {
      insertCellRead(db, {
        puzzleHash: claim.puzzle_hash,
        gitHash,
        cellType: 'given_digit',
        row: r.row,
        col: r.col,
        digitIndex: 0,
        predictedLabel: r.predictedLabel,
        confident: r.confident,
        clashesWith: r.clashesWith,
        sourceX: r.sourceX,
        sourceY: r.sourceY,
        sourceWidth: r.sourceWidth,
        sourceHeight: r.sourceHeight,
        sourcePixels: r.sourcePixels,
        recognitionPixels: r.recognitionPixels,
        warpStrategy: r.warpStrategy,
        hogFeatures: r.hogFeatures ?? [],
        holeFeatures: r.holeFeatures ?? [],
      });
    }

    for (const r of outcome?.cageTotalReads ?? []) {
      insertCellRead(db, {
        puzzleHash: claim.puzzle_hash,
        gitHash,
        cellType: 'cage_total_digit',
        row: r.row,
        col: r.col,
        digitIndex: r.digitIndex,
        predictedLabel: r.predictedLabel,
        confident: r.confident,
        clashesWith: [],
        sourceX: r.sourceX,
        sourceY: r.sourceY,
        sourceWidth: r.sourceWidth,
        sourceHeight: r.sourceHeight,
        sourcePixels: r.sourcePixels,
        recognitionPixels: r.recognitionPixels,
        warpStrategy: r.warpStrategy,
        hogFeatures: r.hogFeatures ?? [],
        holeFeatures: r.holeFeatures ?? [],
      });
    }

    progress.done++;

    const { clean, backtracked, notSolved, timeout, failed } = counts;
    console.log(
      `[${progress.done}/${progress.total}] clean: ${clean} | backtracked: ${backtracked} | notSolved: ${notSolved} | timeout: ${timeout} | failed: ${failed}`,
    );

    if (stopOnFailCount !== null && (bucket === 'notSolved' || bucket === 'timeout' || bucket === 'failed' || bucket === 'error')) {
      const failuresSoFar = notSolved + timeout + failed;
      console.log(
        `[evaluate-corpus] FAIL (${failuresSoFar}/${stopOnFailCount}): ${puzzle.path} did not solve (bucket=${bucket}, reason=${reason ?? 'n/a'})`,
      );
      if (failuresSoFar >= stopOnFailCount) {
        console.log(`\n[evaluate-corpus] STOP: reached ${stopOnFailCount} failure(s) — stopping all workers.`);
        shuttingDown = true;
        break;
      }
    }
  }

  await page.close();
}

async function main(): Promise<void> {
  const { workers, limit, baseUrl, gitHash, dbPath, filter, stopOnFailCount } = parseArgs(process.argv.slice(2));
  await checkServerReachable(baseUrl);

  const db = openDb(dbPath);

  const filterClause = filter ? `AND ${filter}` : '';
  const totalInDb = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM puzzles WHERE content_hash NOT IN (SELECT puzzle_hash FROM evaluations WHERE git_hash = ?) ${filterClause}`,
      )
      .get(gitHash) as { n: number }
  ).n;
  const total = limit !== null ? Math.min(limit, totalInDb) : totalInDb;

  if (total === 0) {
    console.log('[evaluate-corpus] No puzzles to evaluate (all already done for this git hash).');
    db.close();
    return;
  }
  const filterLabel = filter ? ` [${filter}]` : '';
  console.log(
    `[evaluate-corpus] ${total} puzzles queued${filterLabel}, ${workers} workers (git: ${gitHash.slice(0, 8)})`,
  );

  const counts: BucketCounts = { clean: 0, backtracked: 0, notSolved: 0, timeout: 0, failed: 0 };
  const progress = { done: 0, total };

  process.on('SIGINT', () => {
    console.log('\n[evaluate-corpus] Shutting down — finishing in-flight evaluations...');
    shuttingDown = true;
  });

  const browser = await chromium.launch();
  activeBrowser = browser;
  try {
    await Promise.all(
      Array.from({ length: workers }, (_, i) =>
        runWorker(browser, baseUrl, db, gitHash, i + 1, limit, filter, counts, progress, stopOnFailCount),
      ),
    );
  } finally {
    await browser.close();
    activeBrowser = null;
    db.close();
  }

  const { clean, backtracked, notSolved, timeout, failed } = counts;
  console.log('\n=== Final summary ===');
  console.log(
    `Total: ${progress.done} | clean: ${clean} | backtracked: ${backtracked} | notSolved: ${notSolved} | timeout: ${timeout} | failed: ${failed}`,
  );
}

process.on('SIGTERM', () => {
  shuttingDown = true;
  void activeBrowser?.close();
});

main().catch(e => {
  console.error('[evaluate-corpus] fatal:', e);
  process.exit(1);
});