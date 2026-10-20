import { defineConfig } from '@playwright/test';

// Each worktree runs its own dev server, so the port is configurable.
const port = Number(process.env.SIM_PORT ?? 5173);

export default defineConfig({
  testDir: 'e2e',
  // One browser at a time: each renders the whole resort on the GPU, and parallel
  // instances starve each other, which breaks the real-time physics assertions.
  workers: 1,
  timeout: 120_000,
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${port}`,
    // The tests were written for first person with every label and piste colour on;
    // the player's defaults (third person, all off) are checked in menu.spec.ts.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://localhost:${port}`,
          localStorage: [
            { name: 'ski-sim.view', value: 'first-person' },
            {
              name: 'ski-sim.labels',
              value: JSON.stringify({ lift: true, peak: true, restaurant: true, pistes: true }),
            },
          ],
        },
      ],
    },
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
