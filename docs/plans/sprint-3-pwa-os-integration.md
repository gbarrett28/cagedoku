# Plan: Seamless Input — Sprint 3 (PWA OS Integration)

Adds Web Share Target (mobile long-press → Share) and File Handling API
(desktop right-click → Open with). Both require the PWA to be installed
(Sprint 2 prerequisite).

---

## Implementation

### Web Share Target

- [x] **Add `share_target` to `web/public/manifest.webmanifest`**
  ```json
  "share_target": {
    "action": "/share-target",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "files": [{ "name": "image", "accept": ["image/*"] }]
    }
  }
  ```

- [x] **Service worker: intercept POST `/share-target`** (`web/public/sw.js`)
  - In the `fetch` handler, check `event.request.method === 'POST'` and
    `new URL(event.request.url).pathname === '/share-target'`
  - Open an IndexedDB database `coach-share-inbox`, object store `pending`
  - Read `FormData` from the request, get the image `File` from `formData.get('image')`
  - Convert to `ArrayBuffer`, store as `{ buffer, name, type }` at key `'item'`
  - `event.respondWith(Response.redirect('/', 303))`

- [x] **Page: consume shared image on load** (`web/src/main.ts`)
  - `checkShareInbox()` — async function, called once inside `DOMContentLoaded`
  - Opens `coach-share-inbox` IndexedDB, reads key `'item'`, deletes it
  - Reconstructs `new File([buffer], name, { type })`, calls `void handleProcess(file)`
  - Guard: only run when OpenCV is ready (`cvReady` flag); if not ready, store the
    file in a module-level `pendingShareFile` variable and process it once CV loads

- [x] **`/share-target` URL — dev server** (`web/vite.config.ts`)
  - The SW redirect handles production; in dev the Vite dev server will 404 on
    `/share-target` before the SW intercepts it. Add a tiny Vite plugin middleware
    that redirects `POST /share-target` to `GET /` so manual testing in dev works.

### File Handling API

- [x] **Add `file_handlers` to `web/public/manifest.webmanifest`**
  ```json
  "file_handlers": [
    {
      "action": "/",
      "accept": { "image/*": [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"] }
    }
  ]
  ```

- [x] **`launchQueue` consumer** (`web/src/main.ts`)
  - Add `LaunchQueue` / `LaunchParams` interface declarations (not in TS lib)
  - Inside `DOMContentLoaded`, after CV-ready setup:
    ```ts
    if ('launchQueue' in window) {
      (window as WindowWithLaunchQueue).launchQueue.setConsumer(async params => {
        if (!params.files.length) return;
        const file = await params.files[0].getFile();
        void handleProcess(file);
      });
    }
    ```
  - Guard: if CV is not yet ready when the consumer fires, store in
    `pendingShareFile` (same variable as the share-inbox path) and process on
    CV-ready

- [x] **Shared `pendingShareFile` variable** (`web/src/main.ts`)
  - `let pendingShareFile: File | null = null`
  - In the CV-ready callback: if `pendingShareFile !== null`, call
    `void handleProcess(pendingShareFile)` then null it out

### Service worker bump

- [x] **Bump `CACHE_VERSION` to `v5`** in `web/public/sw.js` (manifest changed)

### Docs

- [ ] **Update `docs/ui.md`** — new section "OS Integration" documenting share target
  and file handler flows, browser support matrix from the spec

## Tests

- [x] **Unit test: `checkShareInbox`**
  - Mock IndexedDB; verify that a stored `{ buffer, name, type }` entry causes
    `handleProcess` to be called with a `File` of the correct name and type
  - Verify the entry is deleted after consumption

- [x] **Unit test: `launchQueue` consumer**
  - Mock `window.launchQueue.setConsumer`; verify that a `FileSystemFileHandle`
    with a `.getFile()` that resolves to an image `File` causes `handleProcess`
    to be called

- [ ] **Manual smoke test checklist** (cannot be automated in CI)
  - [ ] Android: install PWA, long-press image in Chrome → Share → COACH → app
        opens and processes the image
  - [ ] Desktop Chrome: install PWA, right-click image file → Open with → COACH →
        app opens and processes the image

## Gate

- [x] Run `bash scripts/run-bronze-gate.sh` — all checks pass
- [ ] Commit on `claude/seamless-puzzle-analysis-xljer`

---

## After all three sprints

- [ ] Run silver gate: `bash scripts/run-silver-gate.sh`
- [ ] Incorporate spec `docs/specs/seamless-puzzle-input.md` details into
  `docs/ui.md` (Upload Screen section + new OS Integration section)
- [ ] Delete `docs/specs/seamless-puzzle-input.md`
- [ ] Delete this plan and `sprint-1-paste-drop.md` and `sprint-2-pwa-foundation.md`
