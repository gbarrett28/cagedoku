/**
 * Post-build script: patch public/sw.js with the hashed JS/CSS bundle names
 * emitted by Vite, then copy the patched version into dist/.
 *
 * Run after `vite build`:
 *   node scripts/generate-sw.js
 *
 * Reads:  dist/.vite/manifest.json  (Vite asset manifest)
 * Reads:  public/sw.js              (SW template)
 * Writes: dist/sw.js                (final SW with correct asset list)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Read the Vite manifest.
const manifestPath = join(root, 'dist', '.vite', 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
} catch {
  console.error(`[generate-sw] Cannot read manifest at ${manifestPath}`);
  process.exit(1);
}

// Collect all hashed asset paths from the manifest.
const hashedAssets = Object.values(manifest)
  .flatMap(entry => {
    const files = [entry.file];
    if (entry.css) files.push(...entry.css);
    return files;
  })
  .map(f => `./${f}`);

// Stable, unique list.
const allAssets = [...new Set([
  './',
  './styles.css',
  './opencv.js',
  './num_recogniser.bin',
  './num_recogniser.json',
  ...hashedAssets,
])];

// Read the SW template.
const swTemplate = readFileSync(join(root, 'public', 'sw.js'), 'utf-8');

// Replace the PRECACHE_ASSETS array literal.
const assetLiteral = allAssets.map(a => `  '${a}',`).join('\n');
const patched = swTemplate.replace(
  /const PRECACHE_ASSETS = \[[\s\S]*?\];/,
  `const PRECACHE_ASSETS = [\n${assetLiteral}\n];`,
);

const outPath = join(root, 'dist', 'sw.js');
writeFileSync(outPath, patched, 'utf-8');
console.log(`[generate-sw] Written ${outPath} with ${allAssets.length} precache entries.`);
