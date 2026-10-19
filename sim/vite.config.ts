import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves the site under /<repo>/ (set by the deploy workflow).
  base: process.env.SIM_BASE ?? '/',
  // Pipeline outputs are served as static assets, e.g. /les-3-vallees/manifest.json
  publicDir: fileURLToPath(new URL('../data/processed', import.meta.url)),
  build: { target: 'es2023' },
  server: { port: 5173 },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
