import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import type { StallFixtureFile } from './src/engine/rules/stallFixtureFile.js';

// In dev mode, serve a "poison pill" sw.js at the HTTP level (before the old SW
// can intercept the request). The pill installs immediately via skipWaiting(),
// claims all clients, then unregisters itself. One refresh after starting the
// dev server leaves no SW active, so Vite's HMR module fetches are never blocked.
//
// Why not transformIndexHtml? The old SW caches index.html, so injected scripts
// never reach the browser. Why not patching public/sw.js? Chrome caches SW scripts
// in its HTTP cache for up to 24 h, so the updated bytes may not be picked up
// until the next update check. The middleware runs at Node's HTTP layer and always
// wins.
const devSwPoisonPill: Plugin = {
  name: 'dev-sw-poison-pill',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/sw.js', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'no-store');
      // The pill installs itself, unregisters, then navigates all open windows
      // so the user never has to manually press refresh — the page reloads itself
      // once the old SW is gone.
      res.end([
        'self.addEventListener("install", () => self.skipWaiting());',
        'self.addEventListener("activate", async () => {',
        '  await self.clients.claim();',
        '  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });',
        '  await self.registration.unregister();',
        '  wins.forEach(w => w.navigate(w.url).catch(() => {}));',
        '});',
      ].join('\n'));
    });
  },
};

// Serve stall fixture metadata and full fixture JSON.
// In dev mode: connect middleware at /stall-fixtures/{index.json,<name>.stall.json}
// In production build: generateBundle emits the same files into dist/stall-fixtures/.
// URL scheme is identical in both modes so main.ts fetch calls are unconditional.
const stallFixturesPlugin: Plugin = {
  name: 'stall-fixtures',
  // No apply: 'serve' — configureServer fires only in serve mode anyway;
  // generateBundle fires only in build mode. Both hooks are needed.
  configureServer(server) {
    const fixturesDir = path.resolve(import.meta.dirname, 'stall-fixtures');

    server.middlewares.use('/stall-fixtures', (req, res) => {
      const url = req.url ?? '/';
      const segment = url.replace(/^\//, '').split('?')[0] ?? '';

      if (segment === 'index.json') {
        // Metadata list — omit spec and stalledCandidates
        try {
          const files = fs
            .readdirSync(fixturesDir)
            .filter((f) => f.endsWith('.stall.json'));

          const metadata = files
            .map((f) => {
              const fixture = JSON.parse(
                fs.readFileSync(path.join(fixturesDir, f), 'utf-8'),
              ) as StallFixtureFile;
              const { spec: _spec, stalledCandidates: _sc, givenDigits: _gd, ...meta } = fixture;
              return meta;
            })
            .sort(
              (a, b) =>
                a.unsolvedCells - b.unsolvedCells ||
                a.totalCandidates - b.totalCandidates,
            );

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(metadata));
        } catch {
          res.statusCode = 500;
          res.end('{"error":"Failed to read stall fixtures"}');
        }
        return;
      }

      // Individual fixture — must end with .stall.json, no path traversal
      if (
        !segment.endsWith('.stall.json') ||
        segment.includes('/') ||
        segment.includes('..')
      ) {
        res.statusCode = 404;
        res.end('{"error":"Not found"}');
        return;
      }

      const fixturePath = path.join(fixturesDir, segment);
      if (!fs.existsSync(fixturePath)) {
        res.statusCode = 404;
        res.end('{"error":"Fixture not found"}');
        return;
      }

      try {
        res.setHeader('Content-Type', 'application/json');
        res.end(fs.readFileSync(fixturePath, 'utf-8'));
      } catch {
        res.statusCode = 500;
        res.end('{"error":"Failed to read fixture"}');
      }
    });
  },

  generateBundle() {
    // Emit each fixture file and a sorted index into dist/stall-fixtures/.
    const fixturesDir = path.resolve(import.meta.dirname, 'stall-fixtures');
    const files = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.stall.json'));

    const metadata: Array<Omit<StallFixtureFile, 'spec' | 'stalledCandidates' | 'givenDigits'>> = [];

    for (const filename of files) {
      const content = fs.readFileSync(path.join(fixturesDir, filename), 'utf-8');
      const fixture = JSON.parse(content) as StallFixtureFile;
      this.emitFile({ type: 'asset', fileName: `stall-fixtures/${filename}`, source: content });
      const { spec: _spec, stalledCandidates: _sc, givenDigits: _gd, ...meta } = fixture;
      metadata.push(meta);
    }

    metadata.sort(
      (a, b) => a.unsolvedCells - b.unsolvedCells || a.totalCandidates - b.totalCandidates,
    );

    this.emitFile({
      type: 'asset',
      fileName: 'stall-fixtures/index.json',
      source: JSON.stringify(metadata),
    });
  },
};

// In dev mode, redirect POST /share-target to GET / so the flow can be tested
// without a real service worker. The SW handles this intercept in production.
const devShareTargetPlugin: Plugin = {
  name: 'dev-share-target',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/share-target', (req, res, next) => {
      if (req.method !== 'POST') { next(); return; }
      res.writeHead(303, { Location: '/' });
      res.end();
    });
  },
};

export default defineConfig({
  plugins: [devSwPoisonPill, devShareTargetPlugin, stallFixturesPlugin],
  define: {
    // Anchors the running code to an exact commit, unlike a build-process
    // timestamp -- which reflects whenever the CI "build" step happened to
    // run (after checkout/install/test), not the code's actual revision, and
    // has caused real confusion diagnosing which model a live report came
    // from. Falls back to 'unknown' outside a git checkout (e.g. some CI
    // artifact contexts).
    __GIT_HASH__: JSON.stringify(
      (() => {
        try {
          return execSync('git rev-parse --short HEAD').toString().trim();
        } catch {
          return 'unknown';
        }
      })()
    ),
    // Injected at dev-server start / build time; displayed alongside the git
    // hash in the version banner as a coarse human-readable freshness signal.
    __BUILD_TIME__: JSON.stringify(
      new Date().toISOString().slice(0, 16).replace('T', ' ')
    ),
  },
  base: './', // relative paths for GitHub Pages subpath deployment
  // Treat .bin files (num_recogniser.bin) as static assets, not JS modules.
  assetsInclude: ['**/*.bin'],
  build: {
    target: 'es2022',
    // Emit a manifest.json so tooling can discover the hashed asset names.
    manifest: true,
  },
  optimizeDeps: {
    // Prevent Vite's pre-bundler from trying to analyse opencv.js.
    exclude: ['opencv.js'],
  },
});
