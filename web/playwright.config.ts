import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // flow.spec.ts uses window.__testLoad which is a DEV-only hook — run it via
  // playwright.dev.config.ts against `vite dev` instead.
  testIgnore: ['**/flow.spec.ts'],
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
