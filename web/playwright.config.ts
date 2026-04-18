import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 10_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    // Capture screenshots and traces on failure for diagnosis.
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  // Dev server is started manually; do not auto-start here.
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
