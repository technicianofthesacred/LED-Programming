import { test as base, expect, type Page } from '@playwright/test';

// One shared answer to a trap that has now bitten this suite in two waves.
//
// Project export runs through the single download implementation
// (src/lib/downloadFile.js via src/lib/projectTransfer.js), which PREFERS the
// File System Access save picker. Headless Chromium exposes
// `showSaveFilePicker` — `typeof` really is "function", in a secure context —
// but can never show a native dialog, so the call throws AbortError
// immediately. `downloadTextFile` treats AbortError as "the owner cancelled"
// and RETURNS rather than falling through to `downloadWithAnchor`, so no
// download event is ever emitted and `page.waitForEvent('download')` waits out
// its full timeout.
//
// Measured on one machine, seconds apart, at load average 15.6 — so this is
// not the host being busy, which was the first explanation everyone reached
// for: as shipped, no download after 12005ms; with this stub, downloaded in
// 76ms. Deterministic, not flaky.
//
// Removing the picker is not papering over the difference: it is the real code
// path for every Firefox and Safari user, whose browsers have no File System
// Access API, so these specs exercise something true rather than a
// Chromium-only branch. The product's AbortError handling is deliberately left
// alone — in a real browser the click carries user activation, the dialog does
// open, and AbortError genuinely means the owner cancelled, where returning
// false is the correct behaviour. It cannot tell that case apart from "no
// dialog is possible", and breaking the real one to suit headless would be the
// wrong trade.
//
// show-screen, workflow and layout-send-to-card each discovered this
// separately and grew their own copy of the stub; this module is that same
// fix, in one place, for every spec that observes a download.
export async function stubSaveFilePicker(page: Page) {
  await page.addInitScript(() => { (window as any).showSaveFilePicker = undefined; });
}

// Drop-in for `import { test, expect } from '@playwright/test'`. Every page
// this hands out already has the picker stubbed, before the first navigation.
// Pages built by hand from `browser.newContext()` do not go through this
// fixture — call `stubSaveFilePicker` on those directly.
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await stubSaveFilePicker(page);
    await use(page);
  },
});

export { expect };
