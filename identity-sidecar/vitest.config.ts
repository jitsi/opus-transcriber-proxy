import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Model-loading tests need headroom; unit tests stay fast.
    testTimeout: 120_000,
  },
});
