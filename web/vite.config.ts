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

// In dev mode, serve stall fixture metadata and full fixture JSON for the dev panel.
// Two endpoints:
//   GET /dev/stall-fixtures        — sorted metadata list (all fields except spec + stalledCandidates)
//   GET /dev/stall-fixtures/:name  — full fixture JSON for one fixture
// Both endpoints are absent in production builds (apply: 'serve').
const stallFixturesPlugin: Plugin = {
  name: 'stall-fixtures',
  apply: 'serve',
  configureServer(server) {
    const fixturesDir = path.resolve(import.meta.dirname, 'stall-fixtures');

    server.middlewares.use('/dev/stall-fixtures', (req, res) => {
      const url = req.url ?? '/';

      // Strip leading slash to get the fixture name (empty string = list endpoint)
      const name = url.replace(/^\//, '').split('?')[0] ?? '';

      if (name === '') {
        // List endpoint — return sorted metadata (omit spec and stalledCandidates)
        try {
          const files = fs
            .readdirSync(fixturesDir)
            .filter((f) => f.endsWith('.stall.json'));

          const metadata = files
            .map((f) => {
              const fixture = JSON.parse(
                fs.readFileSync(path.join(fixturesDir, f), 'utf-8'),
              ) as StallFixtureFile;
              const { spec: _spec, stalledCandidates: _sc, ...meta } = fixture;
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

      // Individual fixture endpoint — path traversal protection
      if (name.includes('/') || name.includes('..')) {
        res.statusCode = 400;
        res.end('{"error":"Invalid fixture name"}');
        return;
      }

      const fixturePath = path.join(fixturesDir, `${name}.stall.json`);
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
};

export default defineConfig({
  plugins: [devSwPoisonPill, stallFixturesPlugin],
  define: {
    // Injected at dev-server start / build time; displayed in the version banner
    // so it's always clear which code revision is running in the browser.
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
