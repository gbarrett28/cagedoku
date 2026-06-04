# Plan: Seamless Input — Sprint 2 (PWA Foundation)

Makes the app installable as a Progressive Web App and advertises the install
on the upload screen. Prerequisite for Sprint 3 (OS-level share/file-open).

---

## Implementation

### Icons

- [ ] **Icon generation script** (`web/scripts/generate-icons.js`)
  - Node.js script using the `canvas` npm package (add as `devDependency`)
  - Renders the existing SVG favicon design (blue rounded rect + "督" glyph) onto
    a Canvas at 192×192, 512×512, and 180×180
  - Writes `web/public/icon-192.png`, `web/public/icon-512.png`,
    `web/public/icon-maskable-512.png` (safe-zone centred on solid background),
    `web/public/apple-touch-icon.png` (180×180)
  - Add `"generate-icons": "node scripts/generate-icons.js"` to `package.json` scripts
  - Run the script once and commit the generated PNG files

### Manifest

- [ ] **Create `web/public/manifest.webmanifest`**
  ```json
  {
    "name": "COACH — Sudoku Coaching App",
    "short_name": "COACH",
    "description": "Browser-based coaching companion for killer and classic sudoku.",
    "start_url": "./",
    "display": "standalone",
    "background_color": "#ffffff",
    "theme_color": "#2563eb",
    "icons": [
      { "src": "./icon-192.png",          "sizes": "192x192",  "type": "image/png" },
      { "src": "./icon-512.png",          "sizes": "512x512",  "type": "image/png" },
      { "src": "./icon-maskable-512.png", "sizes": "512x512",  "type": "image/png", "purpose": "maskable" },
      { "src": "./apple-touch-icon.png",  "sizes": "180x180",  "type": "image/png" }
    ]
  }
  ```

### HTML head

- [ ] **Update `web/index.html`**
  - Add `<link rel="manifest" href="/manifest.webmanifest">`
  - Add `<meta name="theme-color" content="#2563eb">`
  - Add `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`
  - Add `<meta name="mobile-web-app-capable" content="yes">`
  - Add `<meta name="apple-mobile-web-app-capable" content="yes">`
  - Add `<meta name="apple-mobile-web-app-status-bar-style" content="default">`
  - Add `<meta name="apple-mobile-web-app-title" content="COACH">`

### Service worker

- [ ] **Update `web/public/sw.js` `PRECACHE_ASSETS`**
  - Add `'./manifest.webmanifest'`, `'./icon-192.png'`, `'./icon-512.png'`,
    `'./icon-maskable-512.png'`, `'./apple-touch-icon.png'`
  - Bump `CACHE_VERSION` to `v4`

### Install prompt

- [ ] **Capture `beforeinstallprompt`** (`web/src/main.ts`)
  - Module-level `let deferredInstallPrompt: BeforeInstallPromptEvent | null = null`
  - `window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt = e; showInstallBanner(); })`
  - `window.addEventListener('appinstalled', () => { hideInstallBanner(); deferredInstallPrompt = null; })`
  - Add `BeforeInstallPromptEvent` interface declaration (not in standard TS lib)

- [ ] **Install banner UI** (`web/index.html`)
  - Add inside `#upload-panel`, below the hint text:
    ```html
    <div id="install-banner" hidden>
      <span>Install app for quicker access</span>
      <button id="install-btn">Install</button>
      <button id="install-dismiss-btn" aria-label="Dismiss">✕</button>
    </div>
    ```

- [ ] **Install banner logic** (`web/src/main.ts`)
  - `showInstallBanner()`: show `#install-banner` unless
    `localStorage.getItem('coach_install_dismissed')` is set
  - `hideInstallBanner()`: hide `#install-banner`
  - `#install-btn` click: `await deferredInstallPrompt.prompt()`, hide banner
  - `#install-dismiss-btn` click: `localStorage.setItem('coach_install_dismissed', '1')`,
    hide banner

- [ ] **CSS** (`web/public/styles.css`)
  - `#install-banner` — flex row, small font, muted background, rounded, padding

### Vite config

- [ ] **Ensure manifest is copied to dist**
  - Vite copies everything in `public/` automatically — verify `manifest.webmanifest`
    appears in `dist/` after `npm run build`

### Docs

- [ ] **Update `docs/ui.md`** — Upload Screen section: document install banner
  (`#install-banner`, `#install-btn`, `#install-dismiss-btn`)

## Tests

- [ ] **Unit test: install prompt** (`web/src/main.test.ts`)
  - Verify `showInstallBanner()` does not show the banner when
    `coach_install_dismissed` is in localStorage
  - Verify banner is shown when the flag is absent

## Gate

- [ ] Run `bash scripts/run-bronze-gate.sh` — all checks pass
- [ ] Verify with `npm run build` that `dist/manifest.webmanifest` and all icon
  files are present
- [ ] Commit on `claude/seamless-puzzle-analysis-xljer`
