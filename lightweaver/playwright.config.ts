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
  // Desktop only. A phone profile deliberately does NOT live here: two scripts
  // in ci:browser-smoke (`test:show`, `test:screen-recovery`) run playwright
  // WITHOUT --project, so any project added to this file is picked up
  // implicitly and runs specs never written for it. Adding Pixel 5 here failed
  // browser smoke on four show-screen tests that click controls sitting behind
  // the mobile drawer. The phone lens lives in tests/mobile-playwright.config.ts
  // and is run deliberately, never implicitly.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
