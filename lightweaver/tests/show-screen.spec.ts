import { test, expect } from '@playwright/test';

async function installShowStubs(page: any) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('show-test-initialized')) {
      localStorage.clear();
      sessionStorage.setItem('show-test-initialized', 'true');
    }
    (window as any).__audioReads = 0;
    (window as any).__frames = [];

    class FakeAudioContext {
      sampleRate = 48000;
      state = 'running';
      destination = {};
      createAnalyser() {
        const analyser: any = {
          context: this,
          fftSize: 2048,
          smoothingTimeConstant: 0,
          connect() {},
          disconnect() {},
          get frequencyBinCount() { return this.fftSize / 2; },
          getByteFrequencyData(values: Uint8Array) {
            (window as any).__audioReads += 1;
            const pulse = 64 + ((window as any).__audioReads % 32);
            values.fill(pulse);
          },
        };
        return analyser;
      }
      createMediaElementSource() { return { connect() {}, disconnect() {} }; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      resume() { this.state = 'running'; return Promise.resolve(); }
      close() { this.state = 'closed'; return Promise.resolve(); }
    }
    (window as any).AudioContext = FakeAudioContext;
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value() { (this as any).__playing = true; return Promise.resolve(); },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value() { (this as any).__playing = false; },
    });
    (URL as any).createObjectURL = () => 'blob:show-song';
    (URL as any).revokeObjectURL = () => {};

    class FakeWebSocket {
      static OPEN = 1;
      readyState = 0;
      bufferedAmount = 0;
      onopen: null | (() => void) = null;
      onclose: null | (() => void) = null;
      constructor() {
        setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
      }
      send(payload: string) { (window as any).__frames.push(JSON.parse(payload)); }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    (window as any).WebSocket = FakeWebSocket;
  });
}

async function openShow(page: any) {
  await installShowStubs(page);
  await page.goto('/#screen=show', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('show-stage')).toBeVisible();
}

async function mutateSavedLayout(page: any, mutate: (layout: any) => void) {
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('lw_autosave_v3'))).not.toBeNull();
  await page.evaluate((source) => {
    const project = JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}');
    // eslint-disable-next-line no-eval
    const apply = (0, eval)(`(${source})`);
    apply(project.layout);
    localStorage.setItem('lw_autosave_v3', JSON.stringify(project));
  }, mutate.toString());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('show-stage')).toBeVisible();
}

test('uses a connected layout by default and switches the active template', async ({ page }) => {
  await openShow(page);

  await expect(page.getByTestId('show-template-mandala')).toBeVisible();
  await expect(page.getByTestId('show-template-connected')).toBeVisible();
  await expect(page.getByTestId('show-stage')).toHaveAttribute('data-template', 'connected');

  await page.getByTestId('show-template-mandala').click();
  await expect(page.getByTestId('show-stage')).toHaveAttribute('data-template', 'mandala');
  await expect(page.getByTestId('show-stage')).toHaveAttribute('data-frame-size', '675');

  await page.getByTestId('show-template-connected').click();
  await expect(page.getByTestId('show-stage')).toHaveAttribute('data-template', 'connected');
});

test('falls back to the Mandala with an inline explanation when no connected pixels are usable', async ({ page }) => {
  await openShow(page);
  await mutateSavedLayout(page, layout => {
    layout.hidden = Object.fromEntries(layout.strips.map((strip: any) => [strip.id, true]));
  });

  await expect(page.getByTestId('show-stage')).toHaveAttribute('data-template', 'mandala');
  await expect(page.getByTestId('show-template-connected')).toBeDisabled();
  await expect(page.getByText(/connected layout.*no visible pixels/i)).toBeVisible();
});

test('connected preview and physical frames preserve sample positions, length, and output order', async ({ page }) => {
  await openShow(page);
  await mutateSavedLayout(page, layout => {
    layout.hidden = {};
    layout.strips = [
      { id: 'alpha', pixels: [{ x: 0, y: 0 }, { x: 100, y: 50 }] },
      { id: 'beta', pixels: [{ x: 25, y: 100 }] },
    ];
    layout.patchBoard = { rows: [], chain: { rowIds: [] } };
  });

  const stage = page.getByTestId('show-stage');
  await expect(stage).toHaveAttribute('data-template', 'connected');
  await expect(stage).toHaveAttribute('data-frame-size', '3');
  // Project migration gives authored strips their stable strip-N ids while
  // preserving the authored strip/pixel sequence.
  await expect(stage).toHaveAttribute('data-output-order', 'strip-1:0,strip-1:1,strip-2:0');
  await expect(stage).toHaveAttribute('data-sample-positions', '-1.000:-1.000,1.000:0.000,-0.500:1.000');

  await page.getByRole('button', { name: 'Play on the lights' }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__frames.length)).toBeGreaterThan(0);
  const streamed = await page.evaluate(() => (window as any).__frames.at(-1).seg[0].i);
  expect(streamed).toHaveLength(3);
});

test('pausing a loaded song freezes analysis and preview frames, then resumes in place', async ({ page }) => {
  await openShow(page);
  const input = page.getByTestId('show-song-input');
  await input.setInputFiles({ name: 'fixture.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFFfixture') });

  await expect(page.getByTestId('show-pause')).toHaveText('Pause song');
  await expect(page.getByTestId('show-transport-state')).toHaveText('playing');
  await expect.poll(async () => page.evaluate(() => (window as any).__audioReads)).toBeGreaterThan(2);

  await page.getByTestId('show-pause').click();
  await expect(page.getByTestId('show-pause')).toHaveText('Resume song');
  await expect(page.getByTestId('show-transport-state')).toHaveText('paused');
  const paused = await page.getByTestId('show-stage').evaluate((node: HTMLElement) => ({
    frame: node.dataset.frameVersion,
    reads: (window as any).__audioReads,
  }));
  await page.waitForTimeout(250);
  await expect(page.getByTestId('show-stage')).toHaveAttribute('data-frame-version', paused.frame || '');
  expect(await page.evaluate(() => (window as any).__audioReads)).toBe(paused.reads);

  await page.getByTestId('show-pause').click();
  await expect(page.getByTestId('show-transport-state')).toHaveText('playing');
  await expect.poll(async () => page.getByTestId('show-stage').getAttribute('data-frame-version')).not.toBe(paused.frame);
  await expect.poll(async () => page.evaluate(() => (window as any).__audioReads)).toBeGreaterThan(paused.reads);
});
