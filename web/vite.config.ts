import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
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
  test: {
    include: ['src/**/*.test.ts'],
  },
});
