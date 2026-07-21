import assert from 'node:assert/strict';
import { makeCardRuntimePackage } from '../src/lib/cardRuntimeContract.js';
import {
  buildCardConfigHandoffUrl,
  cardStorageJson,
  decodeCardConfigHandoffPayload,
  pushConfigToCard,
} from '../src/lib/cardPushClient.js';
import { prepareCardStoragePayload } from '../src/lib/cardStoragePayload.js';
import {
  bootstrapCardBridgeFromOpener,
  sendCardBridgeRequest,
  verifyCardBridgeIdentity,
} from '../src/lib/cardBridge.js';

const pkg = makeCardRuntimePackage({
  projectName: 'Customer Piece',
  mode: 'website-flash',
  led: {
    pixels: 44,
    colorOrder: 'GRB',
    brightnessLimit: 0.5,
    outputs: [{ id: 'main', name: 'Main', pin: 16, pixels: 44 }],
  },
  controls: {
    encoder: {
      a: 4,
      b: 5,
      press: 0,
      alternatePress: 6,
      rotateDirection: 'clockwise-brighter',
      brightnessStep: 18,
      patternCycleIds: ['aurora', 'ember', 'scanner'],
    },
  },
});

const body = JSON.stringify(pkg.config);
assert.match(body, /"mode":"website-flash"/);
assert.match(body, /"patternCycleIds":\["aurora","ember","scanner"\]/);
assert.equal(pkg.config.led.outputs[0].pin, 16);
assert.equal(pkg.config.controls.encoder.press, 0);

const prepared = prepareCardStoragePayload(pkg);
assert.equal(cardStorageJson(pkg), prepared.json);
const handoffUrl = buildCardConfigHandoffUrl('lightweaver.local', pkg);
assert.ok(handoffUrl.startsWith('http://lightweaver.local/#lwconfig='));
const handoffParams = new URL(handoffUrl).hash.slice(1);
const handoffPayload = new URLSearchParams(handoffParams).get('lwconfig');
assert.equal(decodeCardConfigHandoffPayload(handoffPayload), prepared.json);
assert.deepEqual(JSON.parse(decodeCardConfigHandoffPayload(handoffPayload)), prepared.config);
assert.equal(new URLSearchParams(handoffParams).get('reboot'), '1');

{
  const calls = [];
  const values = new Map([['lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-config-expected' })]]);
  globalThis.window = {
    location: { protocol: 'http:' },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    },
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ cardId: 'lw-config-wrong' }) };
  };
  await assert.rejects(
    pushConfigToCard(pkg, { host: '192.168.18.70', autoDiscover: false }),
    error => error?.reason === 'wrong-card',
  );
  assert.deepEqual(calls.map(call => call.url), ['http://192.168.18.70/api/firmware-info']);
  delete globalThis.window;
}

const requests = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  if (String(url).startsWith('http://lightweaver.local/')) {
    throw new TypeError('mDNS failed');
  }
  if (String(url).endsWith('/api/status')) {
    return {
      ok: true,
      json: async () => ({ ok: true, led: { pixels: 44 } }),
    };
  }
  if (String(url).endsWith('/api/firmware-info')) {
    return {
      ok: true,
      json: async () => ({
        outputs: [
          { id: 'outer', pin: 16, pixels: 22 },
          { id: 'inner', pin: 17, pixels: 22 },
        ],
      }),
    };
  }
  if (String(url).endsWith('/api/reboot')) {
    return {
      ok: true,
      json: async () => ({ ok: true, message: 'rebooting' }),
    };
  }
  return {
    ok: true,
    json: async () => ({ ok: true, saved: true }),
  };
};

await assert.rejects(
  pushConfigToCard(pkg, { host: 'lightweaver.local', timeoutMs: 1000, reboot: 'if-needed' }),
  error => error?.reason === 'layout-mismatch',
);

requests.length = 0;
const pushed = await pushConfigToCard(pkg, {
  host: 'lightweaver.local',
  timeoutMs: 1000,
  reboot: 'if-needed',
  allowLayoutChange: true,
});
assert.equal(pushed.saved, true);
assert.equal(pushed.rebooting, true);
assert.deepEqual(requests.map(request => request.url), [
  'http://lightweaver.local/api/firmware-info',
  'http://lightweaver.local/api/config',
  'http://lightweaver.local/api/status',
  'http://192.168.4.1/api/status',
  'http://192.168.4.1/api/firmware-info',
  'http://192.168.4.1/api/config',
  'http://192.168.4.1/api/reboot',
]);
assert.equal(
  requests.find(request => request.url === 'http://192.168.4.1/api/config')?.options?.body,
  prepared.json,
);

requests.length = 0;
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  if (String(url).endsWith('/api/firmware-info')) {
    return {
      ok: true,
      json: async () => ({ outputs: [{ id: 'main', pin: 16, pixels: 44 }] }),
    };
  }
  if (String(url).endsWith('/api/config')) {
    return {
      ok: true,
      json: async () => ({ ok: true, saved: true, requiresReboot: true }),
    };
  }
  if (String(url).endsWith('/api/reboot')) {
    return {
      ok: true,
      json: async () => ({ ok: true, message: 'rebooting' }),
    };
  }
  throw new Error(`unexpected request ${url}`);
};

const pushedAfterFirmwareRequestedReboot = await pushConfigToCard(pkg, {
  host: 'lightweaver.local',
  timeoutMs: 1000,
  reboot: 'if-needed',
  autoDiscover: false,
});
assert.equal(pushedAfterFirmwareRequestedReboot.saved, true);
assert.equal(pushedAfterFirmwareRequestedReboot.rebooting, true);
assert.deepEqual(requests.map(request => request.url), [
  'http://lightweaver.local/api/firmware-info',
  'http://lightweaver.local/api/config',
  'http://lightweaver.local/api/reboot',
]);

requests.length = 0;
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  if (String(url).endsWith('/api/firmware-info')) {
    return {
      ok: true,
      json: async () => ({
        piece: { id: 'other-project', name: 'Other Project' },
        outputs: [{ id: 'main', pin: 16, pixels: 44 }],
      }),
    };
  }
  throw new Error(`unexpected request ${url}`);
};

await assert.rejects(
  pushConfigToCard(pkg, {
    host: 'lightweaver.local',
    timeoutMs: 1000,
    reboot: 'if-needed',
    autoDiscover: false,
  }),
  error => error?.reason === 'project-mismatch' &&
    /Other Project/.test(error.message) &&
    /Customer Piece/.test(error.message),
);
assert.deepEqual(requests.map(request => request.url), [
  'http://lightweaver.local/api/firmware-info',
]);

const bridgeMessages = [];
let bridgeCurrentOutputs = [{ id: 'main', pin: 16, pixels: 44 }];
const listeners = new Map();
const bridgeWindow = {
  postMessage(message, targetOrigin) {
    bridgeMessages.push({ message, targetOrigin });
    setTimeout(() => {
      listeners.get('message')?.({
        origin: 'http://lightweaver.local',
        source: bridgeWindow,
        data: {
          app: 'LightweaverCardBridge',
          id: message.id,
          ok: true,
          response: message.type === 'firmware-info'
            ? {
              ok: true, cardId: 'lw-installer-test', firmwareVersion: '1.0.0',
              buildId: 'installer-test-build', outputs: bridgeCurrentOutputs,
            }
            : message.type === 'status'
              ? {
                app: 'Lightweaver', provisioningContractVersion: 1,
                cardId: 'lw-installer-test', firmwareVersion: '1.0.0', buildId: 'installer-test-build',
                bootId: 'installer-test-boot', runtimePhase: 'ready', knownGoodProject: true,
                commandReady: true, outputReady: true,
              }
              : { ok: true, saved: true },
        },
      });
    }, 0);
  },
};
globalThis.window = {
  location: {
    protocol: 'https:',
    search: '?cardBridge=1&cardHost=lightweaver.local',
  },
  opener: bridgeWindow,
  localStorage: {
    getItem: key => key === 'lw_card_identity_v1'
      ? JSON.stringify({ version: 1, id: 'lw-installer-test' })
      : 'lightweaver.local',
    setItem: () => {},
  },
  addEventListener(type, listener) {
    listeners.set(type, listener);
  },
  removeEventListener(type, listener) {
    if (listeners.get(type) === listener) listeners.delete(type);
  },
  dispatchEvent: () => {},
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};

bootstrapCardBridgeFromOpener();
await verifyCardBridgeIdentity('lightweaver.local');
await sendCardBridgeRequest('status', {}, { host: 'lightweaver.local' });
bridgeMessages.length = 0;

const bridgePushed = await pushConfigToCard(pkg, {
  host: 'lightweaver.local',
  timeoutMs: 1000,
  reboot: 'if-needed',
});
assert.equal(bridgePushed.saved, true);
assert.equal(bridgeMessages[0].message.type, 'firmware-info');
assert.equal(bridgeMessages[1].message.type, 'config');
assert.equal(bridgeMessages[1].message.reboot, false);
assert.deepEqual(bridgeMessages[1].message.payload, prepared.config);

bridgeMessages.length = 0;
bridgeCurrentOutputs = [{ id: 'outer', pin: 16, pixels: 22 }, { id: 'inner', pin: 17, pixels: 22 }];
await assert.rejects(
  pushConfigToCard(pkg, {
    host: 'lightweaver.local',
    timeoutMs: 1000,
    reboot: 'if-needed',
  }),
  error => error?.reason === 'layout-mismatch',
);
assert.equal(bridgeMessages.length, 1);
assert.equal(bridgeMessages[0].message.type, 'firmware-info');

const oversizedPackage = {
  format: 'lightweaver-card-runtime-package',
  config: {
    version: 1,
    mode: 'website-flash',
    led: { pixels: 4, outputs: [{ id: 'main', pin: 16, pixels: 4 }] },
    looks: [{ id: 'huge', label: 'Huge', unknownFutureField: 'x'.repeat(5000) }],
  },
};
const callsBeforeOverflow = { fetch: 0, bridge: bridgeMessages.length };
globalThis.fetch = async () => {
  callsBeforeOverflow.fetch += 1;
  throw new Error('overflow must fail before fetch');
};
await assert.rejects(
  pushConfigToCard(oversizedPackage, {
    host: 'lightweaver.local',
    timeoutMs: 50,
    autoDiscover: false,
  }),
  error => error?.reason === 'config-too-large' && error.bytes > error.maxBytes,
);
assert.equal(callsBeforeOverflow.fetch, 0);
assert.equal(bridgeMessages.length, callsBeforeOverflow.bridge);
assert.throws(
  () => buildCardConfigHandoffUrl('lightweaver.local', oversizedPackage),
  error => error?.reason === 'config-too-large' && error.bytes > error.maxBytes,
);

console.log('card-installer-package tests passed');
