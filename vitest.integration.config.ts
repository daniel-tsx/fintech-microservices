import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@ledgerflow/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      '@ledgerflow/platform': fileURLToPath(new URL('./packages/platform/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.integration.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
