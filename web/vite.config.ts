import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

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

export default defineConfig({
  plugins: [devSwPoisonPill],
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
