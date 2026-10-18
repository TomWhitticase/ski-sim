import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // One browser at a time: each renders the whole resort on the GPU, and parallel
  // instances starve each other, which breaks the real-time physics assertions.
  workers: 1,
  timeout: 120_000,
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:5173',
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
    command: 'pnpm dev --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
});
