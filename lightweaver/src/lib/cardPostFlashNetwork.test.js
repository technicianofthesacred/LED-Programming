import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPostFlashSerialOutput,
  observePostFlashNetwork,
  readPostFlashSerialEvidence,
  usableCardStationIp,
} from './cardPostFlashNetwork.js';

// The exact boot narration from firmware/lightweaver-controller/src. The card
// that produced the reported bug printed this: no AP lines survived, the
// station line did, and Studio still sent the owner to 192.168.4.1.
const STATION_BOOT_LOG = [
  '',
  'Lightweaver standalone controller booting',
  'Runtime source: internal-flash / loaded saved runtime',
  'Lightweaver AP: Lightweaver-EEFF / 192.168.4.1',
  'Captive DNS up',
  'WiFi station association started',
  'mDNS responder up',
  'WiFi station associated at 192.168.18.70',
  'WLED realtime: rebound after reconnect',
  '',
].join('\r\n');

const BLANK_CARD_BOOT_LOG = [
  '',
  'Lightweaver standalone controller booting',
  'Runtime source: defaults / no saved runtime',
  'Lightweaver AP: Lightweaver-EEFF / 192.168.4.1',
  'Captive DNS up',
  'mDNS responder up',
  'Ready: Lightweaver / 0 pixels',
  '',
].join('\r\n');

test('a card that rejoined the LAN is classified as station with its exact address', () => {
  const result = classifyPostFlashSerialOutput(STATION_BOOT_LOG);
  assert.equal(result.state, 'station');
  assert.equal(result.stationIp, '192.168.18.70');
});

test('AP lines alone never prove station mode, because the firmware always starts the AP first', () => {
  const evidence = readPostFlashSerialEvidence(STATION_BOOT_LOG);
  assert.equal(evidence.apStarted, true);
  assert.equal(evidence.captiveDns, true);
  // Both AP and station lines are present; the station line has to win.
  assert.equal(classifyPostFlashSerialOutput(STATION_BOOT_LOG).state, 'station');
});

test('a genuinely factory-blank card is classified as setup-ap', () => {
  const result = classifyPostFlashSerialOutput(BLANK_CARD_BOOT_LOG);
  assert.equal(result.state, 'setup-ap');
  assert.equal(result.stationIp, '');
  assert.equal(result.evidence.runtimeSource, 'defaults');
});

test('AP evidence that has not settled yet stays inconclusive', () => {
  const result = classifyPostFlashSerialOutput(BLANK_CARD_BOOT_LOG, { settled: false });
  assert.equal(result.state, 'inconclusive');
});

test('saved credentials that have not finished associating stay inconclusive', () => {
  const pending = [
    'Lightweaver standalone controller booting',
    'Runtime source: internal-flash / loaded saved runtime',
    'Lightweaver AP: Lightweaver-EEFF / 192.168.4.1',
    'Captive DNS up',
    'WiFi station association started',
  ].join('\r\n');
  // The hotspot is genuinely up right now AND the card may still leave it.
  assert.equal(classifyPostFlashSerialOutput(pending).state, 'inconclusive');
});

test('silence on the serial port is inconclusive, never an assertion of AP mode', () => {
  assert.equal(classifyPostFlashSerialOutput('').state, 'inconclusive');
  assert.equal(classifyPostFlashSerialOutput('garbage from another device').state, 'inconclusive');
});

test('the soft-AP gateway and unroutable addresses are refused as station addresses', () => {
  assert.equal(usableCardStationIp('192.168.4.1'), '');
  assert.equal(usableCardStationIp('0.0.0.0'), '');
  assert.equal(usableCardStationIp('127.0.0.1'), '');
  assert.equal(usableCardStationIp('8.8.8.8'), '');
  assert.equal(usableCardStationIp('not-an-ip'), '');
  assert.equal(usableCardStationIp('10.0.0.42'), '10.0.0.42');
  assert.equal(usableCardStationIp('172.16.3.9'), '172.16.3.9');
});

test('a station line carrying an unusable address does not claim station mode', () => {
  const result = classifyPostFlashSerialOutput([
    'Lightweaver standalone controller booting',
    'Lightweaver AP: Lightweaver-EEFF / 192.168.4.1',
    'Captive DNS up',
    'WiFi station associated at 0.0.0.0',
  ].join('\n'));
  assert.equal(result.state, 'inconclusive');
});

function fakeClock(startedAt = 0) {
  let current = startedAt;
  return {
    now: () => current,
    // Real macrotask, virtual time: the loop's `Promise.race` must be able to
    // lose to an available read, so the timer branch may only move the clock
    // once it actually wins.
    sleep: ms => new Promise(resolve => setTimeout(() => { current += ms; resolve(); }, 0)),
    advance: ms => { current += ms; },
  };
}

function scriptedPort(chunks, { openErrors = 0, onRead = () => {} } = {}) {
  const encoder = new TextEncoder();
  const remaining = [...chunks];
  let failures = 0;
  const port = {
    opened: false,
    openAttempts: 0,
    closeCount: 0,
    cancelled: false,
    async open() {
      port.openAttempts += 1;
      if (failures < openErrors) { failures += 1; throw new Error('device busy'); }
      port.opened = true;
    },
    get readable() {
      return port.opened ? {
        getReader: () => ({
          read: async () => {
            if (!remaining.length) return new Promise(() => {});
            onRead();
            return { value: encoder.encode(remaining.shift()), done: false };
          },
          cancel: async () => { port.cancelled = true; },
          releaseLock: () => {},
        }),
      } : null;
    },
    async close() { port.closeCount += 1; port.opened = false; },
  };
  return port;
}

test('observePostFlashNetwork reads the reopened port and returns the LAN address', async () => {
  const clock = fakeClock();
  const port = scriptedPort([
    'Lightweaver standalone controller booting\r\n',
    'Runtime source: internal-flash / loaded\r\nLightweaver AP: Lightweaver-EEFF / 192.168.4.1\r\nCaptive DNS up\r\n',
    'WiFi station association started\r\n',
    'WiFi station associated at 192.168.18.70\r\n',
  ]);
  const result = await observePostFlashNetwork({ port, now: clock.now, sleep: clock.sleep });
  assert.equal(result.state, 'station');
  assert.equal(result.stationIp, '192.168.18.70');
  // The port must never be left held after the observation.
  assert.equal(port.closeCount, 1);
  assert.equal(port.cancelled, true);
});

test('observePostFlashNetwork stops early on a blank card instead of burning the whole budget', async () => {
  const clock = fakeClock();
  // Each read costs 1.6 s of virtual time, so the settle window closes while
  // the card is still chattering — proving the early exit, not the timeout.
  const port = scriptedPort([
    'Lightweaver standalone controller booting\r\nRuntime source: defaults / none\r\n',
    'Lightweaver AP: Lightweaver-EEFF / 192.168.4.1\r\nCaptive DNS up\r\n',
    'mDNS responder up\r\n',
    'Ready: Lightweaver / 0 pixels\r\n',
    'this chunk must never be reached\r\n',
  ], { onRead: () => clock.advance(1_600) });
  const result = await observePostFlashNetwork({
    port, now: clock.now, sleep: clock.sleep, timeoutMs: 25_000, settleMs: 3_000,
  });
  assert.equal(result.state, 'setup-ap');
  assert.equal(result.stationIp, '');
  assert.equal(result.reason, 'setup-ap-only');
  assert.equal(port.closeCount, 1);
});

test('observePostFlashNetwork retries the reopen while the ESP32-S3 re-enumerates its USB', async () => {
  const clock = fakeClock();
  const port = scriptedPort(['WiFi station associated at 10.0.0.42\r\n'], { openErrors: 3 });
  const result = await observePostFlashNetwork({ port, now: clock.now, sleep: clock.sleep });
  assert.equal(result.state, 'station');
  assert.equal(result.stationIp, '10.0.0.42');
  assert.equal(port.openAttempts, 4);
});

test('a port that never comes back degrades to inconclusive rather than asserting AP mode', async () => {
  const clock = fakeClock();
  const port = scriptedPort([], { openErrors: Number.MAX_SAFE_INTEGER });
  const result = await observePostFlashNetwork({ port, now: clock.now, sleep: clock.sleep, timeoutMs: 2_000 });
  assert.equal(result.state, 'inconclusive');
  assert.equal(result.reason, 'serial-unavailable');
});

test('no Web Serial port at all is inconclusive, not a failure', async () => {
  const result = await observePostFlashNetwork({ port: null });
  assert.deepEqual(result, { state: 'inconclusive', stationIp: '', reason: 'no-serial-port' });
});

test('a port that opens but never speaks is inconclusive after the budget elapses', async () => {
  const clock = fakeClock();
  const port = scriptedPort([]);
  const result = await observePostFlashNetwork({ port, now: clock.now, sleep: clock.sleep, timeoutMs: 5_000 });
  assert.equal(result.state, 'inconclusive');
  assert.equal(port.closeCount, 1);
});

// The observation is only useful if the commissioning flow accepts its exact
// shape. This is the seam the installer relies on: whatever
// observePostFlashNetwork() returns is handed straight to completeCardInstall().
test('an observation feeds completeCardInstall unmodified and moves the flow off the hotspot path', async () => {
  const { beginCardCommissioning, completeCardInstall } = await import('./cardCommissioningFlow.js');
  const clock = fakeClock();
  const port = scriptedPort([`${STATION_BOOT_LOG}\r\n`]);
  const postFlashNetwork = await observePostFlashNetwork({ port, now: clock.now, sleep: clock.sleep });

  const flow = completeCardInstall(beginCardCommissioning({
    source: 'web-serial',
    operation: 'install-current-release',
    projectRecord: {
      id: 'post-flash-record',
      updatedAt: 1,
      project: { version: 3, id: 'p', name: 'P', layout: { strips: [] }, devices: {} },
    },
    projectRevision: 1,
    flowId: 'flow-postflash-contract-1',
    now: 10,
  }), {
    operation: 'install-current-release',
    cardId: 'lw-aabbccddeeff',
    firmwareVersion: '1.2.3',
    buildId: 'a'.repeat(40),
    postFlashNetwork,
  }, { now: 20 });

  assert.equal(flow.networkState, 'station-detected');
  assert.equal(flow.stationHost, '192.168.18.70');
});
