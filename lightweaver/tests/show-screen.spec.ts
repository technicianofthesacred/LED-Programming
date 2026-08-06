import { test, expect } from '@playwright/test';

const capturedPageErrors = new WeakMap<object, string[]>();

test.afterEach(async ({ page }) => {
  expect(capturedPageErrors.get(page) || [], 'Show emitted an uncaught page error').toEqual([]);
});

async function installShowStubs(page: any) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('show-test-initialized')) {
      localStorage.clear();
      sessionStorage.setItem('show-test-initialized', 'true');
    }
    // Show frame streaming is a hardware mutation. The real Studio requires a
    // previously paired card and re-verifies that exact identity before it
    // opens the direct WebSocket, so this fixture must model the same contract
    // instead of relying on a socket stub alone.
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1,
      id: 'lw-show-test',
      name: 'Show test card',
      hostname: '',
      address: '',
      firmwareVersion: '1.0.0',
      buildId: 'show-test',
      acknowledgedAt: '2026-07-14T00:00:00.000Z',
    }));
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (/^http:\/\/lightweaver\.local\/api\/(?:firmware-info|status)$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({
          cardId: 'lw-show-test',
          cardName: 'Show test card',
          firmwareVersion: '1.0.0',
          buildId: 'show-test',
          led: { pixels: 44 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return nativeFetch(input, init);
    };
    (window as any).__audioReads = 0;
    (window as any).__frames = [];
    (window as any).__micRequests = [];
    (window as any).__stoppedMicTracks = 0;

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia() {
          return new Promise((resolve, reject) => {
            (window as any).__micRequests.push({ resolve, reject });
          });
        },
      },
    });
    (window as any).__resolveMic = (index = 0) => {
      const track = { stop() { (window as any).__stoppedMicTracks += 1; } };
      (window as any).__micRequests[index].resolve({ getTracks: () => [track] });
    };
    (window as any).__rejectMic = (message = 'permission denied', index = 0) => {
      (window as any).__micRequests[index].reject(new Error(message));
    };

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

    // __frames logs WS MESSAGES, and one message is one CHUNK, not one frame:
    // past FRAME_CHUNK_MAX_PIXELS (416) a frame is split into messages
    // carrying a per-segment 'start' write offset, because the card silently
    // drops any payload over 4096 bytes (src/lib/frameChunking.js). The raw
    // log stays as it is — chunk structure is worth being able to inspect —
    // and these helpers give the assertions back the vocabulary they mean,
    // regrouped exactly as the firmware and tests/card-frame-stream.mjs do.
    //
    // A chunk continues the open frame only when it starts precisely where
    // that frame ended. Anything else — including a resend from pixel 0 —
    // opens a NEW frame, so a dropped or misaligned chunk surfaces as an extra
    // frame instead of being quietly stitched over.
    (window as any).__streamedFrames = () => {
      const frames: string[][] = [];
      for (const message of (window as any).__frames) {
        const segment = message.seg[0];
        const start = segment.start ?? 0;
        const open = frames.at(-1);
        if (start > 0 && open && open.length === start) open.push(...segment.i);
        else frames.push([...segment.i]);
      }
      return frames;
    };
    // An active stream re-sends its latest frame every FRAME_KEEPALIVE_MS
    // (850ms) so the card's 2s frame-source watchdog never takes the canvas
    // back mid-show. The frame log therefore keeps growing even while the show
    // is frozen — measured at one resend per ~896ms, one pump tick past the
    // threshold. Collapsing consecutive identical frames leaves the quantity a
    // frozen show must actually hold still: how many DIFFERENT frames reached
    // the card. "Rendered again" stays covered by data-frame-version and
    // "analysed again" by __audioReads, so nothing is given up here.
    (window as any).__distinctFrames = () => (window as any).__streamedFrames()
      .filter((pixels: string[], index: number, all: string[][]) => index === 0
        || pixels.join() !== all[index - 1].join());
  });
}

async function openShow(page: any) {
  const pageErrors: string[] = [];
  capturedPageErrors.set(page, pageErrors);
  page.on('pageerror', (error: Error) => pageErrors.push(error.stack || error.message));
  await installShowStubs(page);
  await page.goto('/#screen=show', { waitUntil: 'domcontentloaded' });
  const stage = page.getByTestId('show-stage');
  await expect(stage).toBeVisible({ timeout: 10_000 });
  await expect(stage).toHaveAttribute('data-frame-version', /\d+/, { timeout: 10_000 });
  expect(pageErrors, `Show page errors:\n${pageErrors.join('\n')}`).toEqual([]);
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
  await expect(page.getByTestId('show-stage')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('show-stage')).toHaveAttribute('data-frame-version', /\d+/, { timeout: 10_000 });
}

async function loadSong(page: any, name = 'fixture.wav') {
  await page.getByTestId('show-song-input').setInputFiles({
    name,
    mimeType: 'audio/wav',
    buffer: Buffer.from('RIFFfixture'),
  });
  await expect(page.getByTestId('show-transport-state')).toHaveText('playing');
}

test('uses a connected layout by default and switches the active template', async ({ page }) => {
  await openShow(page);

  await expect(page.getByTestId('show-template-mandala')).toBeVisible();
  await expect(page.getByTestId('show-template-connected')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Show layout template' })).toBeVisible();
  await expect(page.getByTestId('show-template-connected')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('show-template-mandala')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('show-stage')).toHaveAttribute('data-template', 'connected');

  await page.getByTestId('show-template-mandala').click();
  await expect(page.getByTestId('show-template-mandala')).toHaveAttribute('aria-pressed', 'true');
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

test('connected preview and frames follow split, reversed, and off physical chain addresses', async ({ page }) => {
  await openShow(page);
  await mutateSavedLayout(page, layout => {
    layout.hidden = {};
    const firstId = layout.strips[0].id;
    const secondId = layout.strips[1].id;
    layout.strips = [
      { ...layout.strips[0], pixels: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }], pixelCount: 3 },
      { ...layout.strips[1], pixels: [{ x: 0, y: 100 }, { x: 100, y: 100 }], pixelCount: 2 },
    ];
    layout.patchBoard = {
      chains: [{ id: 'main', rowIds: ['second-reverse', 'off', 'first-tail', 'first-head'] }],
      groups: [],
      patches: [
        { id: 'second-reverse', source: { type: 'strip', stripId: secondId, startLed: 1, endLed: 0 }, output: { mode: 'normal' } },
        { id: 'off', source: { type: 'off', ledCount: 1 }, output: { mode: 'off' } },
        { id: 'first-tail', source: { type: 'strip', stripId: firstId, startLed: 2, endLed: 1 }, output: { mode: 'normal' } },
        { id: 'first-head', source: { type: 'strip', stripId: firstId, startLed: 0, endLed: 0 }, output: { mode: 'normal' } },
      ],
    };
  });

  const stage = page.getByTestId('show-stage');
  await expect(stage).toHaveAttribute('data-template', 'connected');
  await expect(stage).toHaveAttribute('data-frame-size', '6');
  // Canonical physical order starts with the reversed second run, then the
  // off spacer, then the split first run tail-to-head.
  await expect(stage).toHaveAttribute('data-sample-positions', '1.000:1.000,-1.000:1.000,0.000:0.000,1.000:-1.000,0.000:-1.000,-1.000:-1.000');

  await page.getByRole('button', { name: 'Play on the lights' }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__streamedFrames().length)).toBeGreaterThan(0);
  const streamed = await page.evaluate(() => (window as any).__streamedFrames().at(-1));
  expect(streamed).toHaveLength(6);
  expect(streamed[2]).toBe('000000');
  expect(streamed.filter((pixel: string) => pixel !== '000000').length).toBeGreaterThan(0);
});

test('pausing a loaded song freezes analysis and preview frames, then resumes in place', async ({ page }) => {
  await openShow(page);
  await loadSong(page);

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

test('a rejected microphone request preserves a paused song and its selected source', async ({ page }) => {
  await openShow(page);
  await loadSong(page, 'still-playing.wav');
  await page.getByTestId('show-pause').click();
  await expect(page.getByTestId('show-transport-state')).toHaveText('paused');

  await page.getByRole('button', { name: 'Microphone' }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__micRequests.length)).toBe(1);
  await expect(page.getByTestId('show-pause')).toHaveText('Resume song');
  await expect(page.getByTestId('show-transport-state')).toHaveText('paused');

  await page.evaluate(() => (window as any).__rejectMic('permission denied'));
  await expect(page.getByText(/couldn't use the microphone: permission denied/i)).toBeVisible();
  await expect(page.getByTestId('show-pause')).toHaveText('Resume song');
  await expect(page.getByText(/hearing still-playing\.wav/i)).toBeVisible();
});

test('a late microphone result cannot replace a newer song selection', async ({ page }) => {
  await openShow(page);
  await page.getByRole('button', { name: 'Microphone' }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__micRequests.length)).toBe(1);

  await loadSong(page, 'newer.wav');
  await page.evaluate(() => (window as any).__resolveMic());

  await expect(page.getByText(/hearing newer\.wav/i)).toBeVisible();
  await expect(page.getByTestId('show-transport-state')).toHaveText('playing');
  await expect.poll(async () => page.evaluate(() => (window as any).__stoppedMicTracks)).toBe(1);
});

test('a late microphone result cannot leave Quiet mode', async ({ page }) => {
  await openShow(page);
  await page.getByRole('button', { name: 'Microphone' }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__micRequests.length)).toBe(1);

  await page.getByRole('button', { name: 'Quiet' }).click();
  await page.evaluate(() => (window as any).__resolveMic());

  await expect(page.getByText(/quiet — pick a sound source to begin/i)).toBeVisible();
  await expect(page.getByTestId('show-pause')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => (window as any).__stoppedMicTracks)).toBe(1);
});

test('switching templates while paused renders and streams exactly one new-size frame', async ({ page }) => {
  await openShow(page);
  await loadSong(page);
  await page.getByRole('button', { name: 'Play on the lights' }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__streamedFrames().length)).toBeGreaterThan(0);
  await page.getByTestId('show-pause').click();
  await page.waitForTimeout(120);

  const before = await page.getByTestId('show-stage').evaluate((node: HTMLElement) => ({
    version: Number(node.dataset.frameVersion),
    frames: (window as any).__distinctFrames().length,
    reads: (window as any).__audioReads,
  }));
  await page.getByTestId('show-template-mandala').click();

  await expect(page.getByTestId('show-stage')).toHaveAttribute('data-template', 'mandala');
  await expect.poll(async () => page.getByTestId('show-stage').getAttribute('data-frame-version')).toBe(String(before.version + 1));
  await expect.poll(async () => page.evaluate(() => (window as any).__distinctFrames().length)).toBe(before.frames + 1);
  const latest = await page.evaluate(() => (window as any).__distinctFrames().at(-1));
  // The WHOLE new-size frame has to reach the card, not just its head: this
  // reads the reassembled frame, so a dropped or misplaced tail chunk fails
  // here rather than passing as a 416-pixel "frame".
  expect(latest, 'the new-size frame reassembles from its chunks').toHaveLength(675);

  // Hold it across more than two keepalive windows. A frozen show must keep
  // RE-SENDING this one frame — going quiet for 2s hands the canvas back to
  // the card's frame-source watchdog mid-show — while never rendering again,
  // never reading the audio again, and never putting a DIFFERENT frame on the
  // wire. The old 200ms sample could only ever have caught the last of those.
  const settledFrames = await page.evaluate(() => (window as any).__streamedFrames().length);
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => (window as any).__distinctFrames().length)).toBe(before.frames + 1);
  await expect(page.getByTestId('show-stage')).toHaveAttribute('data-frame-version', String(before.version + 1));
  expect(await page.evaluate(() => (window as any).__audioReads)).toBe(before.reads);

  // The frozen frame must go out at the KEEPALIVE rhythm and no faster. Those
  // resends are byte-identical, so the distinct-frame count above cannot see
  // them at all — this is what catches a pump that re-streams the same frame
  // every tick, which would flood the card at 18fps for no visible change.
  // FRAME_KEEPALIVE_MS is 850ms, so a 2s freeze allows 2 resends plus one for
  // where the window falls, and one more of slack for a loaded machine
  // overshooting the wait. A starved pump can only ever resend LESS often, and
  // the 18fps pump this guards against puts ~36 here — the bound has room to
  // be generous without losing its teeth.
  const resends = await page.evaluate(() => (window as any).__streamedFrames().length) - settledFrames;
  expect(resends, 'the keepalive keeps the frozen frame on the wire').toBeGreaterThan(0);
  expect(resends, 'the frozen frame is re-sent by the keepalive, not re-streamed by the pump').toBeLessThanOrEqual(4);
});

test('pausing with lights active atomically pushes the displayed frame and freezes it', async ({ page }) => {
  await openShow(page);
  await loadSong(page);
  await page.getByRole('button', { name: 'Play on the lights' }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__streamedFrames().length)).toBeGreaterThan(0);
  const beforePauseFrames = await page.evaluate(() => (window as any).__distinctFrames().length);
  await page.getByTestId('show-pause').click();
  const frozen = await page.getByTestId('show-stage').getAttribute('data-frame-hash');
  await expect.poll(async () => page.evaluate(({ beforePauseFrames, frozen }) => {
    const frames = (window as any).__distinctFrames();
    if (frames.length <= beforePauseFrames) return false;
    let hash = 0x811C9DC5;
    for (const pixel of frames.at(-1)) {
      for (let offset = 0; offset < 6; offset += 2) hash = Math.imul(hash ^ Number.parseInt(pixel.slice(offset, offset + 2), 16), 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0') === frozen;
  }, { beforePauseFrames, frozen })).toBe(true);
  // Counting DISTINCT frames retires the old drain window: the copy already in
  // flight when Pause queued the authoritative frozen one, and every keepalive
  // resend behind it, are byte-identical and collapse into that single frame.
  // "Frozen" is therefore "never streams a different frame again", and it now
  // holds across a full keepalive window instead of a 200ms sample.
  const frozenFrames = await page.evaluate(() => (window as any).__distinctFrames().length);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => (window as any).__distinctFrames().length)).toBe(frozenFrames);
  expect(await page.getByTestId('show-stage').getAttribute('data-frame-hash')).toBe(frozen);
});

test('mobile Show uses one document column with the inspector below the canvas', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openShow(page);

  const layout = await page.evaluate(() => {
    const body = document.querySelector('.sh-body');
    const timeline = document.querySelector('.sh-body > :first-child');
    const inspector = document.querySelector('.sh-insp');
    if (!body || !timeline || !inspector) return null;
    const timelineBox = timeline.getBoundingClientRect();
    const inspectorBox = inspector.getBoundingClientRect();
    return {
      columns: getComputedStyle(body).gridTemplateColumns.split(' ').filter(Boolean).length,
      timelineBottom: timelineBox.bottom,
      inspectorTop: inspectorBox.top,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });

  expect(layout).not.toBeNull();
  expect(layout?.columns).toBe(1);
  expect(layout?.inspectorTop).toBeGreaterThanOrEqual((layout?.timelineBottom || 0) - 1);
  expect(layout?.scrollWidth).toBeLessThanOrEqual(layout?.viewportWidth || 0);
});
