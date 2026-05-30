import assert from 'node:assert/strict';
import {
  buildLivePreviewControlPayload,
  pushLivePreviewToCard,
  pushSectionPreviewToCard,
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
  syncZones: false,
});

assert.deepEqual(payload, {
  cancelStream: true,
  zone: 'patch-inner',
  syncZones: false,
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

const requests = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  if (String(url).endsWith('/api/zones')) {
    return {
      ok: true,
      json: async () => ({
        syncZones: true,
        zones: [{ id: 'all', label: 'All', ranges: [{ start: 0, count: 44 }] }],
      }),
    };
  }
  return {
    ok: true,
    json: async () => ({ ok: true }),
  };
};

const fallbackResponse = await pushLivePreviewToCard({
  patternId: 'sparkle',
  zone: 'patch-default-outer-circle',
}, {
  host: '192.168.18.70',
  timeoutMs: 1000,
  fallbackMissingZoneToAll: true,
});

assert.equal(fallbackResponse.previewZoneFallback, true);
assert.equal(requests[0].url, 'http://192.168.18.70/api/zones');
assert.equal(requests[1].url, 'http://192.168.18.70/api/control');
assert.equal(JSON.parse(requests[1].options.body).zone, undefined);
assert.equal(JSON.parse(requests[1].options.body).patternId, 'sparkle');

const targetedRequests = [];
globalThis.fetch = async (url, options = {}) => {
  targetedRequests.push({ url, options });
  if (String(url).endsWith('/api/zones')) {
    return {
      ok: true,
      json: async () => ({
        syncZones: false,
        zones: [{ id: 'patch-default-inner-circle', label: 'Inner circle', ranges: [{ start: 22, count: 22 }] }],
      }),
    };
  }
  return {
    ok: true,
    json: async () => ({ ok: true }),
  };
};

const targetedResponse = await pushLivePreviewToCard({
  patternId: 'ocean',
  zone: 'patch-default-inner-circle',
}, {
  host: '192.168.18.70',
  timeoutMs: 1000,
  fallbackMissingZoneToAll: true,
});

assert.equal(targetedResponse.previewZoneFallback, undefined);
assert.equal(JSON.parse(targetedRequests[1].options.body).zone, 'patch-default-inner-circle');

const comboRequests = [];
globalThis.fetch = async (url, options = {}) => {
  comboRequests.push({ url, options });
  if (String(url).endsWith('/api/zones')) {
    return {
      ok: true,
      json: async () => ({
        syncZones: false,
        zones: [
          { id: 'patch-default-outer-circle', label: 'Outer circle', ranges: [{ start: 0, count: 22 }] },
          { id: 'patch-default-inner-circle', label: 'Inner circle', ranges: [{ start: 22, count: 22 }] },
        ],
      }),
    };
  }
  return {
    ok: true,
    json: async () => ({ ok: true }),
  };
};

const comboResponse = await pushSectionPreviewToCard([
  { id: 'all', kind: 'all', look: { patternId: 'aurora' } },
  { id: 'patch-default-outer-circle', zoneId: 'patch-default-outer-circle', kind: 'section', look: { patternId: 'ocean' } },
  { id: 'patch-default-inner-circle', zoneId: 'patch-default-inner-circle', kind: 'section', look: { patternId: 'sparkle' } },
], {
  host: '192.168.18.70',
  timeoutMs: 1000,
});

assert.equal(comboResponse.zonesPreviewed, 2);
assert.equal(comboRequests[0].url, 'http://192.168.18.70/api/zones');
assert.deepEqual(comboRequests.slice(1).map(item => JSON.parse(item.options.body)).map(body => ({
  zone: body.zone,
  patternId: body.patternId,
  syncZones: body.syncZones,
})), [
  { zone: 'patch-default-outer-circle', patternId: 'ocean', syncZones: false },
  { zone: 'patch-default-inner-circle', patternId: 'sparkle', syncZones: false },
]);

const retryRequests = [];
globalThis.fetch = async (url, options = {}) => {
  retryRequests.push({ url, options });
  if (String(url).startsWith('http://lightweaver.local/')) {
    throw new TypeError('mDNS failed');
  }
  if (String(url).endsWith('/api/status')) {
    return {
      ok: true,
      json: async () => ({ ok: true, led: { pixels: 44 } }),
    };
  }
  return {
    ok: true,
    json: async () => ({ ok: true, recovered: true }),
  };
};

const retryResponse = await pushLivePreviewToCard({
  patternId: 'rainbow',
}, {
  host: 'lightweaver.local',
  timeoutMs: 1000,
});

assert.equal(retryResponse.recovered, true);
assert.deepEqual(retryRequests.map(item => item.url), [
  'http://lightweaver.local/api/control',
  'http://lightweaver.local/api/status',
  'http://192.168.18.70/api/status',
  'http://192.168.18.70/api/control',
]);

console.log('card-live-preview tests passed');
