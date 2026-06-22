import { defineConfig } from '@playwright/test';

// Stress-test config — used by scripts/run-stress-test.sh only.
// Matches only stress.spec.ts; all other specs are excluded.
// Uses the production build (vite preview) like playwright.config.ts.
export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/stress.spec.ts'],
  // fullyParallel distributes individual tests across workers even within a
  // single file — essential here since all 500 tests live in stress.spec.ts.
  fullyParallel: true,
  timeout: 45_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:4173',
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
