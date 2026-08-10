import assert from 'node:assert/strict';
import {
  DEFAULT_TEST_STRIP,
  TEST_STRIP_ZONE_ID,
  applyTestStripToRuntimePackage,
  captureTestStripCandidate,
  readTestStrip,
  recordTestStripCandidate,
  runtimePackageForCardOperation,
  startTestStripSession,
  stopTestStripSession,
  writeTestStrip,
} from '../src/lib/testStrip.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

const previousWindow = globalThis.window;
const localStorage = memoryStorage();
const sessionStorage = memoryStorage();
globalThis.window = {
  localStorage,
  sessionStorage,
  dispatchEvent() {},
};

localStorage.setItem('lw:test-strip', JSON.stringify({ enabled: true, length: 17 }));
assert.deepEqual(readTestStrip(), DEFAULT_TEST_STRIP, 'a stale cross-session override is ignored');

const started = startTestStripSession({ length: 30, sessionId: 'test-session' });
assert.deepEqual(started, {
  enabled: true,
  length: 30,
  sessionId: 'test-session',
  activationId: '',
});
writeTestStrip({ length: 41 });
assert.equal(readTestStrip().sessionId, 'test-session', 'editing the length keeps transaction identity');

recordTestStripCandidate('candidate-owned');
const rollbackCalls = [];
const projectEditedAfterStart = { playlist: ['aurora', 'fire'] };
const stopped = await stopTestStripSession({
  readStatus: async () => ({ state: 'staged', activationId: 'candidate-owned' }),
  rollback: async activationId => rollbackCalls.push(activationId),
});
assert.deepEqual(rollbackCalls, ['candidate-owned']);
assert.equal(stopped.rolledBack, true);
assert.equal(readTestStrip().enabled, false);
assert.deepEqual(projectEditedAfterStart, { playlist: ['aurora', 'fire'] }, 'stopping does not restore a stale project snapshot');

startTestStripSession({ length: 22, sessionId: 'other-session' });
recordTestStripCandidate('candidate-owned-by-test');
const foreignRollbackCalls = [];
const foreign = await stopTestStripSession({
  readStatus: async () => ({ state: 'testing', activationId: 'candidate-created-elsewhere' }),
  rollback: async activationId => foreignRollbackCalls.push(activationId),
});
assert.deepEqual(foreignRollbackCalls, [], 'Stop never rolls back another workflow candidate');
assert.equal(foreign.rolledBack, false);

const runtimePackage = {
  app: 'Lightweaver',
  format: 'lightweaver-card-runtime-package',
  version: 1,
  config: {
    version: 1,
    mode: 'website-flash',
    piece: { id: 'shanghai-mandala', name: 'Shanghai Mandala' },
    led: {
      pixels: 94,
      outputs: [
        { id: 'out1', name: 'Output 1', pin: 16, pixels: 44 },
        { id: 'out2', name: 'Output 2', pin: 17, pixels: 50 },
      ],
      colorOrder: 'RGB',
      brightnessLimit: 0.65,
    },
    controls: {},
    patterns: [],
    looks: [
      { id: 'fire', label: 'Fire', mode: 'procedural', preset: 'fire', brightness: 1 },
      {
        id: 'sunrise-mix',
        label: 'Sunrise mix',
        mode: 'combo',
        preset: 'aurora',
        brightness: 1,
        zones: [
          { id: 'outer', label: 'Outer', patternId: 'aurora', brightness: 1, speed: 1, hueShift: 0, customHue: 32, customSaturation: 230, customBreathe: false, customDrift: true },
          { id: 'inner', label: 'Inner', patternId: 'ripple', brightness: 0.8, speed: 1.2, hueShift: 10, customHue: 40, customSaturation: 200, customBreathe: true, customDrift: false },
        ],
      },
    ],
    startupPatternId: 'fire',
    zones: [
      { id: 'outer', label: 'Outer', patternId: 'aurora', brightness: 1, speed: 1, hueShift: 0, customHue: 32, customSaturation: 230, customBreathe: false, customDrift: true, ranges: [{ start: 0, count: 44 }] },
      { id: 'inner', label: 'Inner', patternId: 'ripple', brightness: 0.8, speed: 1.2, hueShift: 10, customHue: 40, customSaturation: 200, customBreathe: true, customDrift: false, ranges: [{ start: 44, count: 50 }] },
    ],
    syncZones: false,
  },
};

// Keep a deep snapshot to prove the transform never mutates its input.
const snapshotBefore = JSON.parse(JSON.stringify(runtimePackage));

const testPackage = applyTestStripToRuntimePackage(runtimePackage, 30);

// Input is untouched.
assert.deepEqual(runtimePackage, snapshotBefore);
assert.notEqual(testPackage, runtimePackage);
assert.notEqual(testPackage.config, runtimePackage.config);

// Single output of the requested length.
assert.equal(testPackage.config.led.pixels, 30);
assert.equal(testPackage.config.led.outputs.length, 1);
assert.equal(testPackage.config.led.outputs[0].pixels, 30);
assert.equal(testPackage.config.led.outputs[0].pin, 16); // first real output's pin

// One full-range zone, carrying the first real zone's look.
assert.equal(testPackage.config.zones.length, 1);
assert.equal(testPackage.config.zones[0].id, TEST_STRIP_ZONE_ID);
assert.deepEqual(testPackage.config.zones[0].ranges, [{ start: 0, count: 30 }]);
assert.equal(testPackage.config.zones[0].patternId, 'aurora');
assert.equal(testPackage.config.syncZones, true);

// Looks keep playlist order and their primary pattern; combo looks collapse
// to the single full-piece zone instead of listing multiple zones.
assert.equal(testPackage.config.looks.length, 2);
assert.equal(testPackage.config.looks[0].id, 'fire');
assert.equal(testPackage.config.looks[0].preset, 'fire');
assert.ok(!testPackage.config.looks[0].zones);
assert.equal(testPackage.config.looks[1].id, 'sunrise-mix');
assert.equal(testPackage.config.looks[1].preset, 'aurora');
assert.equal(testPackage.config.looks[1].zones.length, 1);
assert.equal(testPackage.config.looks[1].zones[0].id, TEST_STRIP_ZONE_ID);
assert.equal(testPackage.config.looks[1].zones[0].patternId, 'aurora');

// A non-positive/garbage length falls back to the default rather than
// producing a zero/negative-pixel package.
const fallbackPackage = applyTestStripToRuntimePackage(runtimePackage, 0);
assert.equal(fallbackPackage.config.led.pixels, 30);

const ordinarySavePackage = runtimePackageForCardOperation(runtimePackage, {
  operation: 'save',
  testStrip: { enabled: true, length: 30 },
});
assert.equal(ordinarySavePackage, runtimePackage, 'ordinary Save always installs the real project package');

const explicitPreviewPackage = runtimePackageForCardOperation(runtimePackage, {
  operation: 'preview',
  testStrip: { enabled: true, length: 30 },
});
assert.equal(explicitPreviewPackage.config.led.pixels, 30, 'explicit preview uses the short strip package');

startTestStripSession({ length: 30, sessionId: 'capture-session' });
assert.equal(await captureTestStripCandidate({
  readStatus: async () => ({ state: 'staged', activationId: 'candidate-captured' }),
}), 'candidate-captured');
assert.equal(readTestStrip().activationId, 'candidate-captured');

startTestStripSession({ length: 30, sessionId: 'preexisting-session' });
assert.equal(await captureTestStripCandidate({
  previousActivationId: 'candidate-preexisting',
  readStatus: async () => ({ state: 'staged', activationId: 'candidate-preexisting' }),
}), '');
assert.equal(readTestStrip().activationId, undefined, 'a pre-existing candidate is never claimed by this test session');

if (previousWindow === undefined) delete globalThis.window;
else globalThis.window = previousWindow;

console.log('test-strip tests passed');
