import { defineConfig } from '@playwright/test';

// Another worktree's dev server may own 5173; SIM_PORT picks a different one.
const port = process.env.SIM_PORT ?? '5173';

export default defineConfig({
  testDir: 'e2e',
  // One browser at a time: each renders the whole resort on the GPU, and parallel
  // instances starve each other, which breaks the real-time physics assertions.
  workers: 1,
  timeout: 120_000,
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1600, height: 900 },
    launchOptions: {
      // Use the real GPU in headless Chromium so WebGPU is available.
      args: [
        '--enable-gpu',
        '--enable-unsafe-webgpu',
        '--use-angle=metal',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  webServer: {
    command: `pnpm dev --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
  },
});
