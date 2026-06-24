#!/usr/bin/env vite-node
/**
 * Persistent stdin/stdout JSON-lines bridge exposing production's real
 * digit-blob detection (isDigitSizedContour + real cv.findContours) to
 * extract_guardian_samples.py, so offline training-data extraction never
 * re-implements contour detection separately from the live recognition path.
 *
 * Usage (from web/, normally spawned as a long-lived subprocess by
 * extract_guardian_samples.py — not run interactively):
 *   npx vite-node scripts/find-digit-blobs-server.ts
 *
 * Protocol: newline-delimited JSON over stdio, exactly one response line per
 * request line, in order (no request IDs — the channel is strictly
 * request/response, never pipelined).
 *   Request:  {"w": number, "h": number, "subres": number, "pixels": "<base64>"}
 *     pixels = raw row-major uint8 ROI buffer, length w*h, ink=255/background=0.
 *   Response: {"blobs": [[x, y, w, h], ...]} — sorted left-to-right by x.
 */
import { createInterface } from 'node:readline';
import NodeModule from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDigitSizedContour } from '../src/image/numberRecognition.js';
import type { BRect } from '../src/image/numberRecognition.js';
import type { OpenCVModule, OpenCVMat, OpenCVMatVector } from '../src/image/opencv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads opencv.js under plain Node by compiling it directly as CommonJS via
 * Module._compile, bypassing Node's extension-based ESM/CJS resolution
 * (which would otherwise treat this "type": "module" package's .js files as
 * ESM and choke on the script's implicit `Module = {}` global).
 */
function loadCvAsCjs(absPath: string): unknown {
  const code = fs.readFileSync(absPath, 'utf8');
  const mod = new NodeModule(absPath);
  mod.filename = absPath;
  mod.paths = NodeModule._nodeModulePaths(path.dirname(absPath));
  (mod as unknown as { _compile(code: string, filename: string): void })._compile(code, absPath);
  return mod.exports;
}

interface BlobRequest {
  readonly w: number;
  readonly h: number;
  readonly subres: number;
  readonly pixels: string;
}

function findBlobs(cv: OpenCVModule, req: BlobRequest): BRect[] {
  const buf = Buffer.from(req.pixels, 'base64');
  const mat = cv.matFromArray(req.h, req.w, cv.CV_8UC1, Array.from(buf));
  const contours: OpenCVMatVector = new cv.MatVector();
  const hierarchy: OpenCVMat = new cv.Mat();
  cv.findContours(mat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const blobs: BRect[] = [];
  for (let i = 0; i < contours.size(); i++) {
    const r = cv.boundingRect(contours.get(i));
    const br: BRect = [r.x, r.y, r.width, r.height];
    if (isDigitSizedContour(br[2], br[3], req.subres)) blobs.push(br);
  }
  blobs.sort((a, b) => a[0] - b[0]);

  mat.delete();
  contours.delete();
  hierarchy.delete();
  return blobs;
}

async function main(): Promise<void> {
  const cvPath = path.resolve(__dirname, '../public/opencv.js');
  const cv = (await Promise.resolve(loadCvAsCjs(cvPath))) as OpenCVModule;

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    const req = JSON.parse(line) as BlobRequest;
    const blobs = findBlobs(cv, req);
    process.stdout.write(JSON.stringify({ blobs }) + '\n');
  }
}

main().catch((err: unknown) => {
  console.error('[find-digit-blobs-server] fatal:', err);
  process.exit(1);
});
