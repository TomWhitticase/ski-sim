import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Pipeline outputs are served as static assets, e.g. /val-thorens/manifest.json
  publicDir: fileURLToPath(new URL('../data/processed', import.meta.url)),
  build: { target: 'es2023' },
  server: { port: 5173 },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
