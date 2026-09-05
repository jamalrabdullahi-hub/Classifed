import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests share one database schema, so they must not race each
    // other. Unit tests are unaffected — they touch nothing shared.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
