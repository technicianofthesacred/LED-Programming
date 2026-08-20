import { defineConfig, devices } from '@playwright/test';
import { testPort as port, testBaseURL } from './testPort.mjs';

// The phone lens, deliberately OUT of playwright.config.ts.
//
// The owner uses a phone, and a suite that only ever drove Desktop Chrome is how
// mobile-only defects shipped without a single red test — the inner-scroll-container
// overflow in Pattern Lab clipped the screen title on a phone while document
// scrollWidth stayed clean, so the standard overflow assertion never saw it.
// See todo/plans/patternlab-rebuild.md §7 Phase 1.
//
// It lives in its own config because `ci:browser-smoke` runs `test:show` and
// `test:screen-recovery` WITHOUT `--project`, so every project declared in the main
// config runs implicitly. A phone profile there doubles desktop-era specs onto a
// device they were never written for. Same pattern as windowless-playwright.config.ts.
//
// Run it: npx playwright test --config tests/mobile-playwright.config.ts
//
// Converted and green on this profile: pattern-lab-isolation, -stateful, -handoff,
// -live-preview, -naming. NOT yet converted: pattern-lab-authoring, -worker, -compatibility,
// and the rest of the suite — they assume the desktop two-pane layout and never open
// the mobile controls sheet, so their locators sit behind an inert boundary.
export default defineConfig({
  testDir: '.',
  // Only the specs actually converted to work at both widths. Without this the
  // phone lens picks up all 57 spec files and reports ~700 tests, most of them
  // failing for a known reason (desktop-era locators behind the mobile sheet),
  // which makes a deliberate run worthless. ADD A FILE HERE as you convert it —
  // a green run should mean "the converted set genuinely works on a phone".
  testMatch: /pattern-lab-(isolation|stateful|handoff|live-preview|naming)\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: testBaseURL,
    serviceWorkers: 'block',
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    // Playwright runs webServer.command from the CONFIG's directory, and this
    // config lives in tests/. Without cwd, vite serves tests/ instead of the
    // app and every spec fails on a page that never mounted.
    cwd: '..',
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [
    { name: 'Mobile Chrome', use: { ...devices['Pixel 5'] } },
  ],
});
