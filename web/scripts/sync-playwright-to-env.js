#!/usr/bin/env node
/**
 * Detects the Chromium revision pre-installed at PLAYWRIGHT_BROWSERS_PATH
 * (default /opt/pw-browsers) and installs the matching @playwright/test
 * version if the current install doesn't already use that revision.
 *
 * Safe on any machine: exits immediately when the path doesn't exist or
 * contains no chromium_headless_shell-* directory.
 *
 * Called automatically by the Claude Code session-start hook so that
 * Playwright self-heals whenever the cloud environment updates its browser.
 * See docs/architecture.md § "E2E Test Environment" and issue #134.
 */

import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, '..');
const PW_PATH = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers';

function log(msg) { console.log(`[sync-playwright] ${msg}`); }

// ── 1. Detect the highest chromium-headless-shell revision available ──────────

if (!existsSync(PW_PATH)) process.exit(0);

const revMatches = readdirSync(PW_PATH)
  .map(d => ({ dir: d, m: d.match(/^chromium_headless_shell-(\d+)$/) }))
  .filter(x => x.m)
  .sort((a, b) => parseInt(b.m[1], 10) - parseInt(a.m[1], 10));

if (revMatches.length === 0) process.exit(0);

const availableRevision = parseInt(revMatches[0].m[1], 10);

// ── 2. Check if the current install already uses that revision ────────────────

const currentBrowsersPath = join(WEB_ROOT, 'node_modules', 'playwright-core', 'browsers.json');
if (existsSync(currentBrowsersPath)) {
  const current = JSON.parse(readFileSync(currentBrowsersPath, 'utf8'));
  const hs = current.browsers?.find(b => b.name === 'chromium-headless-shell');
  if (hs && parseInt(hs.revision, 10) === availableRevision) {
    log(`Already at chromium revision ${availableRevision}. Nothing to do.`);
    process.exit(0);
  }
}

log(`Available chromium revision: ${availableRevision}`);
log('Searching npm for matching @playwright/test version...');

// ── 3. Find the latest @playwright/test version that uses availableRevision ───
//
// Chromium revisions increase monotonically with Playwright version, so we
// scan stable versions from newest to oldest and stop as soon as the checked
// revision drops below the target.

const allVersions = JSON.parse(
  execSync('npm info playwright-core versions --json', { cwd: WEB_ROOT, encoding: 'utf8' }),
);
const stable = allVersions
  .filter(v => /^\d+\.\d+\.\d+$/.test(v))
  .sort((a, b) => {
    const parse = v => v.split('.').map(Number);
    const [pa, pb] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return 0;
  });

function revisionForVersion(version) {
  const tmp = mkdtempSync(join(tmpdir(), 'pw-rev-'));
  try {
    execSync(
      `npm pack playwright-core@${version} --pack-destination ${tmp} --quiet 2>/dev/null`,
      { cwd: WEB_ROOT },
    );
    const tarball = readdirSync(tmp).find(f => f.endsWith('.tgz'));
    if (!tarball) return null;
    const content = execSync(
      `tar xOf ${join(tmp, tarball)} package/browsers.json`,
      { encoding: 'utf8' },
    );
    const hs = JSON.parse(content).browsers?.find(b => b.name === 'chromium-headless-shell');
    return hs ? parseInt(hs.revision, 10) : null;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

let foundVersion = null;
for (const ver of stable) {
  process.stdout.write(`  checking ${ver}...\r`);
  const rev = revisionForVersion(ver);
  if (rev === null) continue;
  if (rev === availableRevision) {
    foundVersion = ver; // keep scanning: a later patch might also use this revision
    continue;
  }
  if (rev < availableRevision) break; // monotonically decreasing — won't find it now
}
process.stdout.write('\n');

if (!foundVersion) {
  log(`No matching version found for revision ${availableRevision} — skipping.`);
  process.exit(0);
}

// ── 4. Install the matched version ───────────────────────────────────────────

log(`Match: @playwright/test@${foundVersion} → chromium revision ${availableRevision}`);
log('Installing...');
execSync(`npm install --save-dev "@playwright/test@${foundVersion}"`, {
  cwd: WEB_ROOT,
  stdio: 'inherit',
});
log(`Done. @playwright/test is now ${foundVersion}.`);
