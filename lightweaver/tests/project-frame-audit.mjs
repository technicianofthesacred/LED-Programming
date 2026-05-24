import assert from 'node:assert/strict';
import { PATTERNS } from '../src/lib/patterns-library.js';
import { compile, evalPixel } from '../src/lib/patterns.js';
import { createDefaultProject, migrateProject, PROJECT_VERSION } from '../src/lib/projectModel.js';
import { normalizePalette, renderPixelFrame } from '../src/lib/frameEngine.js';
import {
  easeCrossfade,
  formatMotionSpeed,
  smoothPixelFrame,
} from '../src/lib/motionSmoothing.js';
import { applySymmetry } from '../src/lib/symmetry.js';
import { clampClipMove, clampClipResize, placeClipInTrackGap } from '../src/lib/timelineLayout.js';
import { recordLivePattern } from '../src/lib/liveRecorder.js';
import {
  makeBlackoutFrame,
  makeWledFrameMessage,
  makeWledSegments,
  makeWledProxyUrl,
  makeWledWsUrl,
  requestWledJson,
} from '../src/lib/deviceController.js';
import {
  DEFAULT_WLED_APP_FLASH_ADDRESS,
  validateFlashPlan,
} from '../src/lib/flashPlan.js';
import {
  makeSafeWledTestState,
  pickBestWledDevice,
  sortWledDevices,
  summarizeWledInfo,
} from '../src/lib/wledDiscovery.js';
import {
  buildControllerProfile,
  controllerProfileReadiness,
  estimatePowerBudget,
  makeArtNetNotes,
  makeDhcpReservationNote,
  makeInstallReadinessReport,
  makeKnownGoodRecoveryState,
  makePixelMarkerState,
  makeWledHostname,
} from '../src/lib/controllerProfiles.js';

const palette = normalizePalette(['#123456', '#abcdef', '#ffcc00']);
const duplicateIds = PATTERNS.map(p => p.id).filter((id, i, arr) => arr.indexOf(id) !== i);
assert.deepEqual(duplicateIds, [], 'pattern ids must be unique');

for (const pattern of PATTERNS) {
  const { fn, error } = compile(pattern.code || 'return [0,0,0];');
  assert.equal(error, null, `${pattern.id} should compile`);
  assert.ok(fn, `${pattern.id} should return a compiled function`);
  for (const sample of [
    { index: 0, x: 0, y: 0, t: 0, time: 0, pixelCount: 1, stripProgress: 0 },
    { index: 1, x: 0.25, y: 0.5, t: 0.25, time: 0.1, pixelCount: 8, stripProgress: 0.2 },
    { index: 7, x: 1, y: 1, t: 1.5, time: 0.75, pixelCount: 8, stripProgress: 1 },
  ]) {
    const out = evalPixel(fn, sample.index, sample.x, sample.y, sample.t, sample.time, sample.pixelCount, palette, 0.25, 0.5, {}, 'audit', sample.stripProgress);
    assert.ok(Number.isFinite(out.r) && Number.isFinite(out.g) && Number.isFinite(out.b), `${pattern.id} produced invalid RGB`);
  }
}

const defaultProject = createDefaultProject();
assert.equal(defaultProject.version, PROJECT_VERSION);
assert.deepEqual(defaultProject.devices, { wledIp: '', segmentMap: {}, controllerProfiles: [], activeControllerId: '' });
assert.equal(defaultProject.pattern.motionSmoothing, 'soft');
const migratedV1 = migrateProject({
  version: 1,
  name: 'Legacy',
  strips: [{ id: 's1', name: 'Strip 1', pixelCount: 2, pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }],
  showClips: [{ id: 'c', track: 0, patternId: 'aurora', start: 0, end: 1 }],
});
assert.equal(migratedV1.version, PROJECT_VERSION);
assert.equal(migratedV1.layout.strips.length, 1);
assert.equal(migratedV1.show.clips.length, 1);
const migratedV3 = migrateProject({
  version: PROJECT_VERSION,
  name: 'Hardware',
  devices: { wledIp: '192.168.4.22', segmentMap: { s1: 2 } },
});
assert.equal(migratedV3.devices.wledIp, '192.168.4.22');
assert.deepEqual(migratedV3.devices.segmentMap, { s1: 2 });
assert.deepEqual(migratedV3.devices.controllerProfiles, []);
assert.equal(migratedV3.pattern.symSettings.guide.mode, 'fold');
assert.equal(migrateProject({ version: PROJECT_VERSION, pattern: { motionSmoothing: 'silk' } }).pattern.motionSmoothing, 'silk');
assert.equal(migrateProject({ version: PROJECT_VERSION, pattern: { motionSmoothing: 'invalid' } }).pattern.motionSmoothing, 'soft');
assert.equal(migrateProject({ version: 2, motionSmoothing: 'off' }).pattern.motionSmoothing, 'off');

const guideAxis = { x1: 0.5, y1: 0, x2: 0.5, y2: 1 };
const guideFold = applySymmetry(0.25, 0.4, { enabled: true, type: 'guide-mirror', guide: { mode: 'fold', axis: guideAxis } });
assert.equal(guideFold.x, 0.5);
assert.equal(guideFold.y, 0.4);
assert.equal(guideFold.progress, 0.5);
const guideReflectLeft = applySymmetry(0.25, 0.4, { enabled: true, type: 'guide-mirror', guide: { mode: 'reflect', axis: guideAxis } });
assert.equal(guideReflectLeft.x, 0.5);
assert.equal(guideReflectLeft.y, 0.4);
const guideReflectRight = applySymmetry(0.75, 0.4, { enabled: true, type: 'guide-mirror', guide: { mode: 'reflect', axis: guideAxis } });
assert.equal(guideReflectRight.x, 0.5);
assert.equal(guideReflectRight.y, 0.4);
const guideSplit = applySymmetry(0.25, 0.4, { enabled: true, type: 'guide-mirror', guide: { mode: 'split', axis: guideAxis } });
assert.equal(guideSplit.split, true);

const guideProgressFn = compile('return rgb(stripProgress, 0, 0);').fn;
const guideProgressFrame = renderPixelFrame({
  t: 0,
  strips: [{
    id: 'guide-strip',
    pts: [
      { x: 0, y: 0.5, p: 0 },
      { x: 0.5, y: 0.5, p: 0.5 },
      { x: 1, y: 0.5, p: 1 },
    ],
  }],
  activeFn: guideProgressFn,
  symSettings: { enabled: true, type: 'guide-mirror', guide: { mode: 'fold', axis: guideAxis } },
});
assert.deepEqual(guideProgressFrame.pixels.map(px => px.r), [255, 0, 255]);

const guideIndexFn = compile('return rgb(index / max(pixelCount - 1, 1), 0, 0);').fn;
const guideIndexFrame = renderPixelFrame({
  t: 0,
  strips: [{
    id: 'guide-index-strip',
    pts: [
      { x: 0, y: 0.5, p: 0 },
      { x: 0.5, y: 0.5, p: 0.5 },
      { x: 1, y: 0.5, p: 1 },
    ],
  }],
  activeFn: guideIndexFn,
  symSettings: { enabled: true, type: 'guide-mirror', guide: { mode: 'fold', axis: guideAxis } },
});
assert.deepEqual(guideIndexFrame.pixels.map(px => px.r), [255, 0, 255]);

const timelineClips = [
  { id: 'a', track: 0, patternId: 'aurora', start: 0, end: 10 },
  { id: 'b', track: 0, patternId: 'ember', start: 12, end: 22 },
  { id: 'c', track: 1, patternId: 'wave', start: 8, end: 18 },
];
assert.deepEqual(clampClipMove(timelineClips, 'a', 8, 40), { start: 2, end: 12 });
assert.deepEqual(clampClipMove(timelineClips, 'b', 1, 40), { start: 10, end: 20 });
assert.deepEqual(clampClipMove(timelineClips, 'c', 2, 40), { start: 2, end: 12 });
assert.deepEqual(clampClipResize(timelineClips, 'a', 'end', 16, 40), { start: 0, end: 12 });
assert.deepEqual(clampClipResize(timelineClips, 'b', 'start', 4, 40), { start: 10, end: 22 });
assert.deepEqual(
  placeClipInTrackGap(timelineClips, { track: 0, preferredStart: 9, duration: 30, showDuration: 40 }),
  { start: 22, end: 40 },
);
const overlappingTimelineClips = [
  { id: 'a', track: 0, patternId: 'calm', start: 0, end: 10 },
  { id: 'b', track: 0, patternId: 'aurora', start: 8, end: 18 },
];
assert.deepEqual(clampClipMove(overlappingTimelineClips, 'a', 4, 40), { start: 0, end: 10 });
assert.deepEqual(clampClipResize(overlappingTimelineClips, 'a', 'end', 14, 40), { start: 0, end: 10 });

const liveFirst = recordLivePattern({
  clips: [],
  transitions: [],
  patternId: 'aurora',
  at: 3.1,
  crossfadeSecs: 2,
  showDuration: 60,
});
assert.equal(liveFirst.clips.length, 1);
assert.deepEqual(liveFirst.clips[0], {
  id: 'live_3100_aurora',
  track: 0,
  patternId: 'aurora',
  start: 3.1,
  end: 60,
  label: 'aurora',
  recorded: true,
});
assert.deepEqual(liveFirst.transitions, []);

const liveSecond = recordLivePattern({
  clips: liveFirst.clips,
  transitions: liveFirst.transitions,
  patternId: 'ember',
  at: 10,
  crossfadeSecs: 3,
  showDuration: 60,
});
assert.equal(liveSecond.clips.find(c => c.patternId === 'aurora').end, 13);
assert.equal(liveSecond.clips.find(c => c.patternId === 'ember').start, 10);
assert.equal(liveSecond.clips.find(c => c.patternId === 'ember').end, 60);
assert.deepEqual(liveSecond.transitions, [{
  id: 'live_10000_ember_xfade',
  clipA: 'live_3100_aurora',
  clipB: 'live_10000_ember',
  type: 'crossfade',
  curve: 'ease-in-out',
  start: 10,
  end: 13,
  recorded: true,
}]);

const liveBeat = recordLivePattern({
  clips: [],
  transitions: [],
  patternId: 'wave',
  at: 10.31,
  bpm: 120,
  quantize: 'beat',
  crossfadeSecs: 1,
  showDuration: 60,
});
assert.equal(liveBeat.clips[0].start, 10.5);

const liveSameMoment = recordLivePattern({
  clips: liveFirst.clips,
  transitions: liveFirst.transitions,
  patternId: 'ember',
  at: 3.1,
  crossfadeSecs: 2,
  showDuration: 60,
});
assert.equal(liveSameMoment.clips.length, 2);
assert.equal(liveSameMoment.transitions.length, 1);
assert.equal(liveSameMoment.transitions[0].clipA, 'live_3100_aurora');
assert.equal(liveSameMoment.transitions[0].clipB, 'live_3100_ember');

const frame = renderPixelFrame({
  t: 0.2,
  strips: [{
    id: 's1',
    pts: [{ x: 0, y: 0, p: 0 }, { x: 1, y: 0, p: 1 }],
  }],
  patternId: 'aurora',
  paletteNorm: palette,
});
assert.equal(frame.pixels.length, 2);
assert.equal(frame.stripFrames.length, 1);
frame.pixels.forEach(px => {
  assert.ok(Number.isFinite(px.r) && Number.isFinite(px.g) && Number.isFinite(px.b));
});

assert.deepEqual(
  smoothPixelFrame([{ r: 100, g: 50, b: 0 }], [{ r: 0, g: 0, b: 0 }], { mode: 'off', dt: 1 / 60 }),
  [{ r: 100, g: 50, b: 0 }],
);
const softFrame = smoothPixelFrame([{ r: 100, g: 0, b: 0 }], [{ r: 0, g: 0, b: 0 }], { mode: 'soft', dt: 1 / 60 });
assert.ok(softFrame[0].r > 0 && softFrame[0].r < 100, 'soft smoothing moves toward target without overshoot');
const silkFrame = smoothPixelFrame([{ r: 100, g: 0, b: 0 }], [{ r: 0, g: 0, b: 0 }], { mode: 'silk', dt: 1 / 60 });
assert.ok(silkFrame[0].r > 0 && silkFrame[0].r < softFrame[0].r, 'silk smoothing is slower than soft');
assert.deepEqual(
  smoothPixelFrame([{ r: 10, g: 20, b: 30 }, { r: 40, g: 50, b: 60 }], [{ r: 0, g: 0, b: 0 }], { mode: 'silk', dt: 1 / 60 }),
  [{ r: 10, g: 20, b: 30 }, { r: 40, g: 50, b: 60 }],
);
assert.equal(easeCrossfade(0, 'ease-in-out'), 0);
assert.equal(easeCrossfade(1, 'ease-in-out'), 1);
assert.equal(easeCrossfade(-1, 'ease-in-out'), 0);
assert.equal(easeCrossfade(2, 'ease-in-out'), 1);
assert.equal(easeCrossfade(0.5, 'linear'), 0.5);
assert.ok(easeCrossfade(0.25, 'ease-in-out') < 0.25);
assert.ok(easeCrossfade(0.75, 'ease-in-out') > 0.75);
assert.equal(formatMotionSpeed(0.03), '0.03x');
assert.equal(formatMotionSpeed(1), '1.0x');

assert.deepEqual(makeBlackoutFrame(2), [{ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }]);
assert.deepEqual(makeBlackoutFrame(-1), []);
assert.deepEqual(makeWledFrameMessage([{ r: 1.2, g: 2.8, b: 300 }]).seg[0].i, [1, 3, 255]);
assert.deepEqual(makeWledFrameMessage([{ r: -5, g: Number.NaN, b: 12.4 }]).seg[0].i, [0, 0, 12]);
assert.throws(
  () => makeWledFrameMessage([{ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }], { maxPixels: 1 }),
  /max 1/,
);
assert.deepEqual(makeWledSegments([{ id: 'a', pixels: [1, 2] }, { id: 'b', pixelCount: 3 }], { b: 4 }), [
  { id: 0, start: 0, stop: 2, on: true },
  { id: 4, start: 2, stop: 5, on: true },
]);
assert.deepEqual(makeWledSegments([{ id: 'z', pixelCount: 0 }, { id: 'a', pixelCount: 2 }, { id: 'b', pixels: [1, 2, 3] }], { z: 9, a: 2, b: 3 }), [
  { id: 9, start: 0, stop: 0, on: true },
  { id: 2, start: 0, stop: 2, on: true },
  { id: 3, start: 2, stop: 5, on: true },
]);

assert.equal(makeWledProxyUrl('http://192.168.1.50/json', 'state'), '/api/wled/state?ip=192.168.1.50');
assert.equal(makeWledWsUrl('192.168.1.50', { preferProxy: false }), 'ws://192.168.1.50/ws');
assert.equal(
  makeWledWsUrl('192.168.1.50', { locationObj: { protocol: 'https:', host: 'lightweaver.local' } }),
  'wss://lightweaver.local/api/wled/ws?ip=192.168.1.50',
);
assert.equal(DEFAULT_WLED_APP_FLASH_ADDRESS, '0x10000');
assert.deepEqual(validateFlashPlan({ address: '0x10000', eraseAll: false }), { address: 0x10000 });
assert.throws(
  () => validateFlashPlan({ address: '0x10000', eraseAll: true }),
  /single WLED app binary cannot be flashed after erasing all flash/,
);
assert.deepEqual(
  summarizeWledInfo({
    name: 'WLED',
    ver: '0.15.4',
    release: 'ESP32-S3_16MB_opi',
    arch: 'ESP32-S3',
    ip: '192.168.18.66',
    mac: 'aca704e2ece0',
    freeheap: 230000,
    psram: 8300000,
    wifi: { signal: 86 },
    leds: { count: 30, fps: 2 },
  }, { ip: '192.168.18.66', source: 'probe' }),
  {
    name: 'WLED',
    ip: '192.168.18.66',
    source: 'probe',
    ver: '0.15.4',
    release: 'ESP32-S3_16MB_opi',
    arch: 'ESP32-S3',
    mac: 'aca704e2ece0',
    leds: 30,
    fps: 2,
    signal: 86,
    freeheap: 230000,
    psram: 8300000,
    uptime: null,
    healthy: true,
  },
);
assert.equal(
  pickBestWledDevice([
    { ip: '192.168.18.10', source: 'scan', healthy: true },
    { ip: '192.168.18.66', source: 'default', healthy: true },
  ], '192.168.18.66').ip,
  '192.168.18.66',
);
assert.deepEqual(
  sortWledDevices([
    { ip: '192.168.18.10', source: 'scan', signal: 45, healthy: true },
    { ip: '192.168.18.11', source: 'mdns', signal: 80, healthy: true },
    { ip: '192.168.18.12', source: 'scan', healthy: false },
  ]).map(d => d.ip),
  ['192.168.18.11', '192.168.18.10', '192.168.18.12'],
);
assert.deepEqual(makeSafeWledTestState('blue'), {
  on: true,
  bri: 32,
  transition: 0,
  seg: [{ id: 0, fx: 0, col: [[0, 80, 255], [0, 0, 0], [0, 0, 0]] }],
});
const profile = buildControllerProfile({
  name: 'WLED',
  ver: '0.15.4',
  release: 'ESP32-S3_16MB_opi',
  arch: 'ESP32-S3',
  ip: '192.168.18.66',
  mac: 'aca704e2ece0',
  flash: 16,
  psram: 8300000,
  leds: { count: 30 },
}, {
  led: { type: 'WS2815', length: 240, dataPin: 16, colorOrder: 'GRB', maxBrightness: 180 },
  power: { voltage: 12, psuAmps: 10, milliampsPerPixel: 12 },
  artnet: { startUniverse: 0, fps: 40 },
});
assert.equal(profile.id, 'aca704e2ece0');
assert.equal(makeWledHostname(profile), 'lightweaver-e2ece0.local');
assert.equal(makeDhcpReservationNote(profile), 'Reserve MAC ac:a7:04:e2:ec:e0 as 192.168.18.66.');
assert.deepEqual(estimatePowerBudget(profile), {
  maxAmps: 2.03,
  safeAmps: 8,
  headroomAmps: 5.97,
  status: 'ok',
});
assert.match(makeArtNetNotes(profile), /Universe start: 0/);
assert.match(makeArtNetNotes(profile), /Channels: 720/);
assert.equal(controllerProfileReadiness(profile).ready, false);
assert.deepEqual(makeKnownGoodRecoveryState(), makeSafeWledTestState('amber'));
assert.equal(makePixelMarkerState(5, 4).seg[0].i.length, 15);
assert.match(makeInstallReadinessReport(profile, { snapshotSaved: true }), /Lightweaver Install Readiness/);
assert.match(makeInstallReadinessReport(profile, { snapshotSaved: true }), /aca704e2ece0/);

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

function textResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

{
  const calls = [];
  const data = await requestWledJson('192.168.1.51', 'state', {
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: opts.method });
      return jsonResponse(200, { on: true });
    },
  });
  assert.deepEqual(data, { on: true });
  assert.equal(calls[0].url, '/api/wled/state?ip=192.168.1.51');
}

{
  const calls = [];
  const data = await requestWledJson('192.168.1.52', 'info', {
    fetchImpl: async (url) => {
      calls.push(url);
      return calls.length === 1
        ? textResponse(200, '<!doctype html><div>Vite fallback</div>')
        : jsonResponse(200, { ver: '0.15.4' });
    },
  });
  assert.deepEqual(data, { ver: '0.15.4' });
  assert.deepEqual(calls, ['/api/wled/info?ip=192.168.1.52', 'http://192.168.1.52/json/info']);
}

{
  let calls = 0;
  await assert.rejects(
    () => requestWledJson('192.168.1.53', 'state', {
      method: 'POST',
      body: { on: false },
      fetchImpl: async () => {
        calls++;
        return jsonResponse(500, { error: 'state rejected' });
      },
    }),
    /HTTP 500/,
  );
  assert.equal(calls, 1, 'Pi API WLED failures should not be hidden by direct fallback');
}

{
  await assert.rejects(
    () => requestWledJson('192.168.1.54', 'state', {
      method: 'POST',
      body: { on: true },
      preferProxy: false,
      fetchImpl: async () => jsonResponse(503, { error: 'offline' }),
    }),
    /HTTP 503/,
  );
}

console.log('project-frame-audit passed');
