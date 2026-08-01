import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildLivePreviewControlPayload, readCardZonesFromCard } from './cardLiveControl.js';
import { patchBoardToZones } from './cardRuntimeContract.js';
import { compactCardStorageConfig } from './cardStoragePayload.js';
import { normalizeSavedLooks } from './sectionLookModel.js';

const settings = { customBreathe: true, breatheLowerPct: 72, breatheUpperPct: 94, breatheCycleSeconds: 14 };

test('live control carries breathe envelope settings', () => {
  const payload = buildLivePreviewControlPayload({ patternId: 'aurora', ...settings });
  assert.deepEqual({
    breathe: payload.breathe,
    breatheLowerPct: payload.breatheLowerPct,
    breatheUpperPct: payload.breatheUpperPct,
    breatheCycleSeconds: payload.breatheCycleSeconds,
  }, { breathe: true, breatheLowerPct: 72, breatheUpperPct: 94, breatheCycleSeconds: 14 });
});

test('patch playback compiles breathe envelope settings into zones', () => {
  const zones = patchBoardToZones({ patches: [{
    id: 'outer', name: 'Outer',
    source: { type: 'strip', stripId: 'outer', startLed: 0, endLed: 9 },
    output: { mode: 'main' }, playback: settings,
  }], chain: { rowIds: ['outer'] } }, [{ id: 'outer', pixelCount: 10 }]);
  assert.deepEqual(zones[0] && {
    breatheLowerPct: zones[0].breatheLowerPct,
    breatheUpperPct: zones[0].breatheUpperPct,
    breatheCycleSeconds: zones[0].breatheCycleSeconds,
  }, { breatheLowerPct: 72, breatheUpperPct: 94, breatheCycleSeconds: 14 });
});

test('storage compacts defaults but retains customized breathe settings', () => {
  const compact = compactCardStorageConfig({ zones: [
    { id: 'default', breatheLowerPct: 85, breatheUpperPct: 100, breatheCycleSeconds: 9 },
    { id: 'custom', breatheLowerPct: 72, breatheUpperPct: 94, breatheCycleSeconds: 14 },
  ] });
  assert.deepEqual(compact.zones[0], { id: 'default' });
  assert.deepEqual(compact.zones[1], { id: 'custom', breatheLowerPct: 72, breatheUpperPct: 94, breatheCycleSeconds: 14 });
});

test('saved section looks retain a custom envelope through JSON persistence', () => {
  const persisted = JSON.parse(JSON.stringify(normalizeSavedLooks([{
    id: 'gallery-night',
    label: 'Gallery night',
    defaultLook: { patternId: 'aurora' },
    sectionLooks: { outer: { patternId: 'breathe', ...settings } },
  }])));
  const restored = normalizeSavedLooks(persisted);
  assert.deepEqual({
    customBreathe: restored[0].sectionLooks.outer.customBreathe,
    breatheLowerPct: restored[0].sectionLooks.outer.breatheLowerPct,
    breatheUpperPct: restored[0].sectionLooks.outer.breatheUpperPct,
    breatheCycleSeconds: restored[0].sectionLooks.outer.breatheCycleSeconds,
  }, settings);
});

test('/api/zones custom envelope readback is preserved verbatim for live restoration', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ syncZones: false, zones: [{ id: 'outer', patternId: 'breathe', ...settings }] }),
  });
  try {
    const readback = await readCardZonesFromCard({ host: '192.168.4.1', timeoutMs: 50 });
    assert.deepEqual(readback.zones[0], { id: 'outer', patternId: 'breathe', ...settings });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Patterns Advanced UI exposes compact breathe summary and bounded controls', () => {
  const source = readFileSync(new URL('../v3/lw-pattern.jsx', import.meta.url), 'utf8');
  for (const id of ['breathe-summary', 'breathe-lower', 'breathe-upper', 'breathe-cycle']) {
    assert.match(source, new RegExp(`testId=\\"${id}\\"|data-testid=\\"${id}\\"`));
  }
  assert.match(source, /Breathe · \$\{look\.breatheLowerPct\}/);
});
