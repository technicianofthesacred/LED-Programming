import { test, expect, type Page } from '@playwright/test';
import { openControls, patternTile } from './helpers/pattern-lab.ts';

// Choosing a pattern used to acknowledge nothing at all until the first frame
// arrived, so a tap read as "the screen ignored me" and the honest response was to
// tap again — which is what made a healthy renderer look like a crashing one.
//
// The acknowledgement added here is FEEDBACK, never a lock. The renderer is
// latest-wins by design and rapid switching is safe, so anything that blocked or
// gated the next tap would make the screen feel slower than the thing it is
// reporting on. These specs assert both halves: it is visible, and it is not a gate.

declare global {
  interface Window { __LW_HOLD_TAP_FRAMES__: { hold: boolean }; }
}

// Withhold frame replies so the "working" window can be observed deliberately
// instead of raced against a renderer that answers in about a millisecond.
async function holdFrames(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const control = { hold: false };
    class HeldWorker extends NativeWorker {
      set onmessage(handler: ((this: Worker, ev: MessageEvent) => unknown) | null) {
        super.onmessage = handler
          ? function wrapped(this: Worker, event: MessageEvent) {
            if (control.hold && (event.data as { type?: string })?.type === 'frame') return;
            handler.call(this, event);
          }
          : null;
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: HeldWorker });
    Object.defineProperty(window, '__LW_HOLD_TAP_FRAMES__', { configurable: true, value: control });
  });
}

test('a tap is acknowledged on the tile and above the artwork, and clears on the first frame', async ({ page }) => {
  await holdFrames(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await openControls(page);
  await page.evaluate(() => { window.__LW_HOLD_TAP_FRAMES__.hold = true; });
  await patternTile(page, 'aurora').click();

  await expect(page.locator('[data-testid="pattern-lab-tile"][data-pattern-id="aurora"][data-working="true"]'))
    .toHaveCount(1);
  await expect(patternTile(page, 'aurora')).toHaveAttribute('aria-busy', 'true');
  // The preview bar says it too, because a phone's controls sheet settles onto
  // Sculpt on choosing and takes the tapped tile off screen.
  await expect(page.locator('.plab-preview-bar')).toHaveAttribute('data-working', 'true');
  await expect(page.getByTestId('pattern-lab-preview-status')).toContainText('Preparing this pattern');

  await page.evaluate(() => { window.__LW_HOLD_TAP_FRAMES__.hold = false; });
  await expect(page.locator('[data-testid="pattern-lab-tile"][data-working="true"]')).toHaveCount(0);
  await expect(page.locator('.plab-preview-bar')).not.toHaveAttribute('data-working', 'true');
});

test('the working state never gates the next tap', async ({ page }) => {
  await holdFrames(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await openControls(page);
  await page.evaluate(() => { window.__LW_HOLD_TAP_FRAMES__.hold = true; });

  await patternTile(page, 'aurora').click();
  await expect(patternTile(page, 'aurora')).toHaveAttribute('data-working', 'true');
  // Every other tile stays pressable while one is working — no disabled state, no
  // overlay over the hit area, no modal.
  await expect(patternTile(page, 'ocean')).toBeEnabled();
  await openControls(page);
  await patternTile(page, 'ocean').click();
  await expect(patternTile(page, 'ocean')).toHaveAttribute('data-working', 'true');
  await expect(patternTile(page, 'aurora')).not.toHaveAttribute('data-working', 'true');
  await expect(page.locator('[data-testid="pattern-lab-tile"][data-working="true"]')).toHaveCount(1);

  await page.evaluate(() => { window.__LW_HOLD_TAP_FRAMES__.hold = false; });
  await expect(page.getByTestId('pattern-lab-mapped-preview'))
    .toHaveAttribute('data-worker-state', /frame|rendering/);
  await expect(page.locator('[data-testid="pattern-lab-tile"][data-working="true"]')).toHaveCount(0);
});
