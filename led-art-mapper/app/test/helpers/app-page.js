import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));

// Vite coerces `port: 0` back to its own default 5173, so asking it for an
// ephemeral port silently hands every caller the same well-known one and then
// leans on the non-strict fallback to shuffle collisions away. Take a port from
// the OS ourselves and pin Vite to it, so a busy 5173 can never quietly move
// the app out from under a test.
function claimFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// One Vite dev server and one Chromium page for a test file. The mapper's
// browser tests only read a served module graph — they never edit a file and
// wait for HMR — so the 500 ms polling watcher vite.config.js turns on for
// `npm run dev` is pure stat-sweeping here, and it competes with the browser
// launch on a small CI runner.
export async function openAppPage() {
  const port = await claimFreePort();
  const server = await createServer({
    root: appRoot,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port, strictPort: true, watch: { usePolling: false } },
  });
  await server.listen();

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    return {
      page,
      async close() {
        await browser.close();
        await server.close();
      },
    };
  } catch (err) {
    // A browser that never came up would otherwise leave the dev server —
    // and its port — held for the rest of the run.
    await browser?.close();
    await server.close();
    throw explainBrowserLaunchFailure(err);
  }
}

// Two ways this fails that are not the mapper's fault, and both look exactly
// like six broken tests unless someone reads the stack. Each has cost a day:
// the missing binary took down a release on 2026-08-04, and the sandbox denial
// was mistaken for a flaky test for months.
export function explainBrowserLaunchFailure(err) {
  const text = String(err?.message || err);

  if (/bootstrap_check_in|mach_port_rendezvous|MachPortRendezvousServer/.test(text)) {
    err.message = [
      'Chromium could not start because the sandbox denied it a mach port.',
      'This is the environment, NOT a failing test — the same command passes',
      'with the sandbox disabled. Re-run it outside the sandbox before',
      'concluding anything about the mapper.',
      '',
      text,
    ].join('\n');
    return err;
  }

  if (/Executable doesn't exist|playwright install/.test(text)) {
    err.message = [
      'Chromium is not installed for Playwright on this machine.',
      'This package declares @playwright/test but installs no browser of its',
      'own — it borrows the one lightweaver\'s CI lane installs. Run:',
      '  npx playwright install chromium',
      '',
      text,
    ].join('\n');
    return err;
  }

  return err;
}
