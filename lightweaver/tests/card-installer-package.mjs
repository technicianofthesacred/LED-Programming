import assert from 'node:assert/strict';
import { makeCardRuntimePackage } from '../src/lib/cardRuntimeContract.js';
import {
  buildCardConfigHandoffUrl,
  decodeCardConfigHandoffPayload,
  pushConfigToCard,
} from '../src/lib/cardPushClient.js';

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

const handoffUrl = buildCardConfigHandoffUrl('lightweaver.local', pkg);
assert.ok(handoffUrl.startsWith('http://lightweaver.local/#lwconfig='));
const handoffParams = new URL(handoffUrl).hash.slice(1);
const handoffPayload = new URLSearchParams(handoffParams).get('lwconfig');
assert.deepEqual(JSON.parse(decodeCardConfigHandoffPayload(handoffPayload)), pkg.config);
assert.equal(new URLSearchParams(handoffParams).get('reboot'), '1');

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

const pushed = await pushConfigToCard(pkg, { host: 'lightweaver.local', timeoutMs: 1000, reboot: 'if-needed' });
assert.equal(pushed.saved, true);
assert.equal(pushed.rebooting, true);
assert.deepEqual(requests.map(request => request.url), [
  'http://lightweaver.local/api/config',
  'http://lightweaver.local/api/status',
  'http://192.168.18.70/api/status',
  'http://192.168.4.1/api/status',
  'http://192.168.18.70/api/config',
  'http://192.168.18.70/api/firmware-info',
  'http://192.168.18.70/api/reboot',
]);

console.log('card-installer-package tests passed');
