#!/usr/bin/env vite-node
/**
 * Dumps raw contour trees from a sample of clean corpus puzzles.
 * Requires: npm run build && npm run preview (in another terminal)
 *
 * Run from web/:
 *   npx vite-node --script scripts/dump-contour-trees.ts [--limit N] [--out-dir DIR]
 */
import { chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_DB_PATH } from './corpus-db.js';
import { waitForPipelineReady } from '../e2e/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_PER_BUCKET = 50;
const BASE_URL = 'http://localhost:4173';
const GIT_HASH = 'ae4889612a2e16931eac88eebef576968af6e1ba';

type BRect = [number, number, number, number];
type ContourNode = [pts: number[][], br: BRect, area: number, children: ContourNode[]];

interface ContourDump {
  puzzle_hash: string;
  corpus: string;
  ground_truth: string;
  detected_type: string;
  bucket: string;
  subres: number;
  tree: ContourNode[];
  selectedNumbers: BRect[];
  outerGridBR: BRect | null;
  borderX: boolean[][] | null;
  borderY: boolean[][] | null;
  cageTotals: number[][] | null;
  givenDigits: (number | null)[][] | null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limitPerBucket = limitIdx >= 0 ? Number(args[limitIdx + 1]) : SAMPLES_PER_BUCKET;
  const outIdx = args.indexOf('--out-dir');
  const outDir = outIdx >= 0 ? args[outIdx + 1]! : path.resolve(__dirname, '../../contour-dumps');
  fs.mkdirSync(outDir, { recursive: true });

  const db = openDb(DEFAULT_DB_PATH);

  // Select clean/backtracked puzzles per (corpus × ground_truth) where pipeline detected correctly.
  // Limit per group is applied in JS below.
  const rows = db.prepare(`
    SELECT p.content_hash, p.path, p.corpus,
           json_extract(p.ground_truth, '$[0]') as gt,
           e.detected_type, e.bucket
    FROM evaluations e
    JOIN puzzles p ON p.content_hash = e.puzzle_hash
    WHERE e.git_hash = ?
      AND e.status = 'done'
      AND e.bucket IN ('clean', 'backtracked')
      AND e.detected_type = json_extract(p.ground_truth, '$[0]')
    GROUP BY p.corpus, json_extract(p.ground_truth, '$[0]'), p.content_hash
    ORDER BY p.content_hash
  `).all(GIT_HASH) as Array<{
    content_hash: string; path: string; corpus: string;
    gt: string; detected_type: string; bucket: string;
  }>;

  // Cap each (corpus × ground_truth) group to limitPerBucket.
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.corpus}|${row.gt}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }
  const sample: typeof rows = [];
  for (const group of grouped.values()) {
    sample.push(...group.slice(0, limitPerBucket));
  }
  db.close();

  console.log(`[dump-contour-trees] ${sample.length} puzzles selected`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('coach_tutorial_suppressed', 'true');
    HTMLDialogElement.prototype.showModal = () => {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__reportContourTree = true;
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await waitForPipelineReady(page, 90_000);

  let resolveOutcome: ((o: unknown) => void) | null = null;
  await page.exposeFunction('__reportOutcome', (o: unknown) => {
    resolveOutcome?.(o);
    resolveOutcome = null;
  });

  let done = 0;
  for (const row of sample) {
    const outPath = path.join(outDir, `${row.content_hash}.json`);
    if (fs.existsSync(outPath)) { done++; continue; }

    const outcomePromise = new Promise<unknown>(r => { resolveOutcome = r; });
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000));

    await page.locator('#file-input').setInputFiles(row.path);
    let outcome: Record<string, unknown>;
    try {
      outcome = await Promise.race([outcomePromise, timeout]) as Record<string, unknown>;
    } catch {
      console.warn(`[dump-contour-trees] timeout: ${row.content_hash}`);
      continue;
    }

    if (!outcome['contourTree']) {
      console.warn(`[dump-contour-trees] no contour tree in outcome for ${row.content_hash}`);
      continue;
    }

    const dump: ContourDump = {
      puzzle_hash: row.content_hash,
      corpus: row.corpus,
      ground_truth: row.gt,
      detected_type: row.detected_type,
      bucket: row.bucket,
      subres: 128,
      tree: outcome['contourTree'] as ContourNode[],
      selectedNumbers: (outcome['selectedNumbers'] as BRect[] | undefined) ?? [],
      outerGridBR: (outcome['outerGridBR'] as BRect | null | undefined) ?? null,
      borderX: (outcome['borderX'] as boolean[][] | null | undefined) ?? null,
      borderY: (outcome['borderY'] as boolean[][] | null | undefined) ?? null,
      cageTotals: (outcome['cageTotals'] as number[][] | null | undefined) ?? null,
      givenDigits: outcome['givenDigits']
        ? (outcome['givenDigits'] as number[][]).map(r => r.map(v => v === 0 ? null : v))
        : null,
    };
    fs.writeFileSync(outPath, JSON.stringify(dump));
    done++;
    console.log(`[${done}/${sample.length}] ${row.corpus}/${row.gt} ${row.content_hash.slice(0, 8)}`);
  }

  await browser.close();
  console.log(`[dump-contour-trees] done — ${done} files in ${outDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
