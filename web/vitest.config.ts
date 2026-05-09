import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify('test'),
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**'],
  },
});
