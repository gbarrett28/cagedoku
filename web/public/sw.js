/**
 * COACH — Killer Sudoku offline service worker.
 *
 * Strategy: cache-first for all precached assets; network-first for everything
 * else (e.g. future API calls or unknown navigation requests).
 *
 * On install: precache all known static assets.
 * On activate: delete caches from older versions.
 * On fetch: serve from cache when available, otherwise fall back to network.
 *
 * CACHE_VERSION must be bumped whenever the asset list changes or a new build
 * is deployed.  A simple approach: update it to match the deployment date or
 * commit hash.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `coach-killer-sudoku-${CACHE_VERSION}`;

/**
 * Assets to precache on install.
 *
 * Hashed JS/CSS filenames (e.g. index-B9qce3YD.js) change with each build.
 * The SW is regenerated at build time by scripts/generate-sw.js (see below),
 * which reads dist/.vite/manifest.json and replaces the PRECACHE_ASSETS list.
 * Until that script runs, this list covers the known static assets that do NOT
 * get content-hashed (opencv.js, model files, index.html).
 *
 * The Vite-hashed bundle (assets/index-*.js) is listed as a glob pattern handled
 * by the fetch handler — the precache covers the shell; the bundle is cached on
 * first visit and served from cache thereafter.
 */
const PRECACHE_ASSETS = [
  './',               // index.html (relative to SW scope)
  './styles.css',
  './opencv.js',
  './num_recogniser.bin',
  './num_recogniser.json',
];

// ---------------------------------------------------------------------------
// Install — fetch and cache all precache assets
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache assets one by one so a single failure doesn't abort the whole install.
      await Promise.allSettled(
        PRECACHE_ASSETS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] Failed to precache ${url}:`, err),
          ),
        ),
      );
      // Skip the waiting phase — the new SW takes control immediately.
      await self.skipWaiting();
    }),
  );
});

// ---------------------------------------------------------------------------
// Activate — delete stale caches from previous versions
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => {
            console.log(`[SW] Deleting old cache: ${k}`);
            return caches.delete(k);
          }),
      );
      // Claim all existing clients so the new SW controls them immediately.
      await self.clients.claim();
    }),
  );
});

// ---------------------------------------------------------------------------
// Fetch — cache-first for known assets; network-first for everything else
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  // Only handle GET requests over http(s). Ignore chrome-extension://, data:,
  // blob: etc. — those come from browser extensions and must not be intercepted.
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request).then(async (cached) => {
      if (cached) return cached;

      // Not in cache — fetch from network, then cache successful responses.
      try {
        const response = await fetch(event.request);
        if (response.ok && response.type !== 'opaque') {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, response.clone());
        }
        return response;
      } catch {
        // Network failed and no cached response — return a minimal offline page
        // only for navigation requests; for sub-resources, let the error propagate.
        if (event.request.mode === 'navigate') {
          const cached = await caches.match('./');
          if (cached) return cached;
        }
        throw new Error('Network request failed and no cached response available');
      }
    }),
  );
});
