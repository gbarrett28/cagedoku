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
 *
 * Note: if the process is killed (SIGKILL/crash), in-flight evaluation rows
 * are left as status='running'. They will not be re-claimed for the same
 * git hash. Use a fresh --git-hash to re-evaluate them.
 */
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { DEFAULT_DB_PATH, claimEvaluation, completeEvaluation, openDb } from './corpus-db.js';
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
  readonly dumpContoursDir: string | null;
}


interface UploadOutcomeJson {
  readonly bucket: 'clean' | 'backtracked' | 'notSolved';
  readonly reason: string;
  readonly puzzleType: string | null;
  readonly detectedBigApple: boolean;
  readonly specHash: string | null;
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
  let dumpContoursDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workers') workers = Number(argv[++i]);
    else if (argv[i] === '--limit') limit = Number(argv[++i]);
    else if (argv[i] === '--base-url') baseUrl = argv[++i]!;
    else if (argv[i] === '--git-hash') gitHash = argv[++i]!;
    else if (argv[i] === '--db-path') dbPath = argv[++i]!;
    else if (argv[i] === '--filter') filter = argv[++i];
    else if (argv[i] === '--dump-contours') dumpContoursDir = argv[++i] ?? null;
  }
  return { workers, limit, baseUrl, gitHash, dbPath, filter, dumpContoursDir };
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
  dumpContoursDir: string | null,
  counts: BucketCounts,
  progress: { done: number; total: number },
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

    try {
      const outcomePromise = new Promise<UploadOutcomeJson>(r => {
        resolveOutcome = r;
      });
      const timeoutPromise = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('outcome timeout')), DEFAULT_TIMEOUT_MS),
      );

      await page.locator('#file-input').setInputFiles(puzzle.path);
      const outcome = await Promise.race([outcomePromise, timeoutPromise]);

      bucket = outcome.bucket;
      reason = outcome.reason;
      detectedType = outcome.puzzleType;
      specHash = outcome.specHash;
      counts[outcome.bucket]++;

      if (dumpContoursDir !== null) {
        const patches = await page.evaluate(() => {
          // Runs in the browser. Accesses the contour tree exposed by inpImage.ts.
          type ContourNode = [number[][], [number, number, number, number], number, ContourNode[]];
          const tree = (window as any).__lastContourTree as ContourNode[] | undefined;
          const subres = (window as any).__lastSubres as number | undefined;
          if (!tree || !subres) return [];

          function renderMask(pts: number[][], children: number[][][], size: number): number[] {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const [x, y] of pts) {
              if (x! < minX) minX = x!;
              if (y! < minY) minY = y!;
              if (x! > maxX) maxX = x!;
              if (y! > maxY) maxY = y!;
            }
            const bw = maxX - minX || 1;
            const bh = maxY - minY || 1;
            const scale = Math.min((size - 2) / bw, (size - 2) / bh);
            const offX = ((size - 2) - bw * scale) / 2 + 1;
            const offY = ((size - 2) - bh * scale) / 2 + 1;
            function tx(p: number[]): [number, number] {
              return [(p[0]! - minX) * scale + offX, (p[1]! - minY) * scale + offY];
            }
            const data = new Uint8Array(size * size);
            function fill(poly: number[][], color: number): void {
              const tpoly = poly.map(tx);
              for (let row = 0; row < size; row++) {
                const crossings: number[] = [];
                for (let i = 0; i < tpoly.length; i++) {
                  const [x1, y1] = tpoly[i]!;
                  const [x2, y2] = tpoly[(i + 1) % tpoly.length]!;
                  if ((y1! <= row && y2! > row) || (y2! <= row && y1! > row)) {
                    crossings.push(x1! + ((row - y1!) / (y2! - y1!)) * (x2! - x1!));
                  }
                }
                crossings.sort((a, b) => a - b);
                for (let i = 0; i + 1 < crossings.length; i += 2) {
                  const left = Math.max(0, Math.ceil(crossings[i]!));
                  const right = Math.min(size - 1, Math.floor(crossings[i + 1]!));
                  for (let col = left; col <= right; col++) {
                    data[row * size + col] = color;
                  }
                }
              }
            }
            fill(pts, 255);
            for (const hole of children) fill(hole, 0);
            return Array.from(data);
          }

          const minW = subres >> 4;
          const minH = subres >> 3;
          const maxW = (subres * 7) >> 3;
          const maxH = (subres * 7) >> 3;
          const results: { pixels: number[]; depth: number; fillRatio: number; w: number; h: number }[] = [];

          function visit(nodes: ContourNode[], depth: number): void {
            for (const [pts, br, area, children] of nodes) {
              const [, , w, h] = br;
              if (depth >= 2 && w >= minW && w <= maxW && h >= minH && h <= maxH) {
                const childPts = children.map(c => c[0]);
                const pixels = renderMask(pts, childPts, 64);
                results.push({ pixels, depth, fillRatio: area / (w * h), w, h });
              }
              visit(children, depth + 1);
            }
          }
          visit(tree, 0);
          return results;
        });

        const outPath = path.join(dumpContoursDir, `${claim.puzzle_hash}.json`);
        fs.writeFileSync(outPath, JSON.stringify({ path: puzzle.path, contours: patches }));
      }
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



    completeEvaluation(
      db, claim.id, status, bucket, reason, detectedType, Date.now() - startMs, specHash,
    );
    progress.done++;

    const { clean, backtracked, notSolved, timeout, failed } = counts;
    console.log(
      `[${progress.done}/${progress.total}] clean: ${clean} | backtracked: ${backtracked} | notSolved: ${notSolved} | timeout: ${timeout} | failed: ${failed}`,
    );
  }

  await page.close();
}

async function main(): Promise<void> {
  const { workers, limit, baseUrl, gitHash, dbPath, filter, dumpContoursDir } = parseArgs(process.argv.slice(2));
  if (dumpContoursDir !== null) fs.mkdirSync(dumpContoursDir, { recursive: true });
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
        runWorker(browser, baseUrl, db, gitHash, i + 1, limit, filter, dumpContoursDir, counts, progress),
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