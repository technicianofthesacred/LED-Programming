import assert from 'node:assert/strict';
import {
  buildLivePreviewControlPayload,
  pushLivePreviewToCard,
} from '../src/lib/cardLiveControl.js';

const payload = buildLivePreviewControlPayload({
  patternId: 'ocean',
  brightness: 0.72,
  speed: 1.35,
  hueShift: -9,
  customHue: 138,
  customSaturation: 210,
  customBreathe: true,
  customDrift: false,
  zone: 'patch-inner',
});

assert.deepEqual(payload, {
  cancelStream: true,
  zone: 'patch-inner',
  patternId: 'ocean',
  brightness: 0.72,
  speed: 1.35,
  hueShift: -9,
  hue: 138,
  saturation: 210,
  breathe: true,
  drift: false,
});

let request = null;
globalThis.fetch = async (url, options) => {
  request = { url, options };
  return {
    ok: true,
    json: async () => ({ ok: true, patternId: 'ocean' }),
  };
};

const response = await pushLivePreviewToCard({
  patternId: 'ocean',
  brightness: 0.72,
  customHue: 138,
  customSaturation: 210,
  customBreathe: true,
  customDrift: false,
}, {
  host: 'lightweaver.local',
  timeoutMs: 1000,
});

assert.equal(response.ok, true);
assert.equal(request.url, 'http://lightweaver.local/api/control');
assert.equal(request.options.method, 'POST');
assert.equal(request.options.headers['Content-Type'], 'application/json');
assert.equal(JSON.parse(request.options.body).patternId, 'ocean');
assert.equal(JSON.parse(request.options.body).cancelStream, true);

console.log('card-live-preview tests passed');
