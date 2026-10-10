import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so tests never start the dev API plugin or read .env.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
