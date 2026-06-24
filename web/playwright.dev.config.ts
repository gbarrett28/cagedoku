/**
 * Playwright config for dev-server tests (http://localhost:5173).
 *
 * Used by e2e/flow.spec.ts which relies on window.__testLoad — a hook
 * exposed only in dev builds (import.meta.env.DEV). These tests exercise
 * the full review→confirm→playing UI flow without OpenCV or a real puzzle
 * image, and complete in under 30 seconds.
 *
 * Run: npx playwright test --config playwright.dev.config.ts
 */

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
  testMatch: 'flow.spec.ts',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
