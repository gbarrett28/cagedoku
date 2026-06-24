import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Pre-installed browser path in the Claude Code cloud environment.
// Revision 1194 matches @playwright/test@1.56.x.
// Remove once the environment is updated to provide revision 1217+ (see issue #134).
// Only set when that path actually exists -- local (non-cloud) machines have no
// such directory and must fall back to Playwright's own default browser cache,
// populated by `npx playwright install`.
if (existsSync('/opt/pw-browsers')) {
  process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= '/opt/pw-browsers';
}

export default defineConfig({
  testDir: './e2e',
  // flow.spec.ts uses window.__testLoad which is a DEV-only hook — run it via
  // playwright.dev.config.ts against `vite dev` instead.
  testIgnore: ['**/flow.spec.ts', '**/stress.spec.ts'],
  timeout: 10_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:4173',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  // Serve the production build via `vite preview` — no HMR WebSocket, no
  // per-module TypeScript transformation, single-bundle load. E2E tests
  // should validate the artefact that gets deployed, not the dev server.
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
