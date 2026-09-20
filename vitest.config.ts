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
    include: ['tests/**/*.test.ts'],
    coverage: { reporter: ['text', 'html'], include: ['apps/**/*.ts', 'packages/**/*.ts'] },
  },
});
