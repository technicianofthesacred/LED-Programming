import { defineConfig, devices } from '@playwright/test';
import { testPort as port, testBaseURL } from './tests/testPort.mjs';
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  // The canonical release suite runs hundreds of browser scenarios serially.
  // Keep assertions tolerant of transient host load while individual actions
  // retain Playwright's normal timeouts and still fail closed.
  expect: { timeout: 15_000 },
  use: {
    baseURL: testBaseURL,
    // Keep same-origin API fixtures authoritative even if a developer has a
    // previously installed Studio service worker in a reused browser profile.
    serviceWorkers: 'block',
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    port,
    // Safe to reuse: the port is derived from this checkout's path, so any
    // server already on it belongs to this workspace. See tests/testPort.mjs.
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // The owner uses a phone. A suite that only ever drove Desktop Chrome is
    // how mobile-only defects (like the inner-scroll-container overflow in
    // Pattern Lab) shipped without a single red test — see
    // todo/plans/patternlab-rebuild.md §7 Phase 1.
    { name: 'Mobile Chrome', use: { ...devices['Pixel 5'] } },
  ],
});
