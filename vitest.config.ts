import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    server: {
      deps: {
        // Vite's builtin list predates node:sqlite, so without this it tries
        // to resolve it as a package on disk and the suite fails to load.
        external: [/^node:sqlite$/],
      },
    },
  },
  ssr: {
    external: ['node:sqlite'],
  },
});
