import assert from 'node:assert/strict';
import {
  buildMirroredLedRepairPackage,
  buildLiveHardwareControlPayload,
  buildLivePreviewControlPayload,
  pushLiveHardwareToCard,
  pushLivePreviewToCard,
  requireLivePreviewAcknowledgement,
  recoverCardLights,
  repairMirroredLedOutputOnCard,
  resetLiveOutputOnCard,
  pushSectionPreviewToCard,
  readCardZonesFromCard,
} from '../src/lib/cardLiveControl.js';
import { prepareCardStoragePayload } from '../src/lib/cardStoragePayload.js';
import { requestCardReboot } from '../src/lib/cardPushClient.js';
import { bootstrapCardBridgeFromOpener, verifyCardBridgeIdentity } from '../src/lib/cardBridge.js';

const payload = buildLivePreviewControlPayload({
  patternId: 'ocean',
  brightness: 0.72,
  speed: 1.35,
  hueShift: -9,
  customHue: 138,
  customSaturation: 210,
  customBreathe: true,
  customDrift: false,
  driftHueMin: 17,
  driftHueMax: 203,
  zone: 'patch-inner',
  syncZones: false,
});

assert.throws(
  () => requireLivePreviewAcknowledgement(
    { ok: true, patternId: 'ocean' },
    { patternId: 'ocean' },
    { expectedCardId: 'lw-expected' },
    { id: 'lw-expected' },
  ),
  error => error?.reason === 'identity-missing',
  'a matching preflight identity must not substitute for a missing mutation acknowledgement identity',
);
assert.throws(
  () => requireLivePreviewAcknowledgement(
    { ok: true },
    { patternId: 'ocean' },
    { expectedCardId: 'lw-expected', previewAcknowledgementCapability: 'legacy-ok-only' },
    { id: 'lw-expected' },
  ),
  error => error?.reason === 'identity-missing',
  'legacy acknowledgement mode must not silently waive mutation-response identity proof',
);

// A remembered address is only a route hint. Direct mutations must verify the
// stable card ID at that exact host before issuing POST requests.
{
  const calls = [];
  const values = new Map([['lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-expected' })]]);
  globalThis.window = {
    location: { protocol: 'http:' },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    },
  };
  globalThis.localStorage = globalThis.window.localStorage;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ cardId: 'lw-wrong', firmwareVersion: '1.0.0' }) };
  };
  await assert.rejects(
    pushLiveHardwareToCard({ colorOrder: 'RGB' }, { host: '192.168.18.70', autoDiscover: false }),
    error => error?.reason === 'wrong-card',
  );
  assert.deepEqual(calls.map(call => call.url), ['http://192.168.18.70/api/firmware-info']);
  delete globalThis.window;
  delete globalThis.localStorage;
}

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
  driftMin: 17,
  driftMax: 203,
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

// A transport response is not a physical acknowledgement unless it is valid
// JSON, says ok:true, belongs to the paired card, and does not contradict the
// requested look/revision when the firmware echoes those fields.
for (const [label, responseBody, reason] of [
  ['malformed JSON', null, 'invalid-acknowledgement'],
  ['ok:false', { ok: false, cardId: 'lw-expected' }, 'preview-unconfirmed'],
  ['wrong card', { ok: true, cardId: 'lw-other', patternId: 'ocean' }, 'wrong-card'],
  ['missing look and revision proof', { ok: true, cardId: 'lw-expected' }, 'physical-output-unconfirmed'],
  ['wrong echoed look', { ok: true, cardId: 'lw-expected', patternId: 'fire' }, 'preview-mismatch'],
  ['wrong echoed revision', { ok: true, cardId: 'lw-expected', revision: 6 }, 'preview-mismatch'],
]) {
  globalThis.fetch = async () => ({
    ok: true,
    json: responseBody === null
      ? async () => { throw new SyntaxError('bad json'); }
      : async () => responseBody,
  });
  await assert.rejects(
    pushLivePreviewToCard(
      { patternId: 'ocean' },
      { host: 'lightweaver.local', expectedCardId: 'lw-expected', revision: 7, autoDiscover: false, latestOnly: false },
    ),
    error => {
      assert.equal(error?.reason, reason, label);
      return true;
    },
  );
}

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ ok: true, cardId: 'lw-expected', patternId: 'ocean', revision: 7 }),
});
const acknowledgedPreview = await pushLivePreviewToCard(
  { patternId: 'ocean' },
  { host: 'lightweaver.local', expectedCardId: 'lw-expected', revision: 7, autoDiscover: false, latestOnly: false },
);
assert.equal(acknowledgedPreview.cardId, 'lw-expected');
assert.equal(acknowledgedPreview.patternId, 'ocean');
assert.equal(acknowledgedPreview.revision, 7);

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ ok: true, cardId: 'lw-expected' }),
});
const explicitLegacyPreview = await pushLivePreviewToCard(
  { patternId: 'ocean' },
  {
    host: 'lightweaver.local',
    expectedCardId: 'lw-expected',
    revision: 7,
    previewAcknowledgementCapability: 'legacy-ok-only',
    autoDiscover: false,
    latestOnly: false,
  },
);
assert.equal(explicitLegacyPreview.ok, true, 'legacy acknowledgement is allowed only by an explicit compatibility decision');

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ ok: true, cardId: 'lw-expected', confirmedRevision: 7 }),
});
const revisionOnlyProof = await pushLivePreviewToCard(
  { patternId: 'ocean' },
  { host: 'lightweaver.local', expectedCardId: 'lw-expected', revision: 7, autoDiscover: false, latestOnly: false },
);
assert.equal(revisionOnlyProof.confirmedRevision, 7);

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ ok: true, cardId: 'lw-expected', confirmedLook: { patternId: 'ocean' } }),
});
const lookOnlyProof = await pushLivePreviewToCard(
  { patternId: 'ocean' },
  { host: 'lightweaver.local', expectedCardId: 'lw-expected', revision: 7, autoDiscover: false, latestOnly: false },
);
assert.equal(lookOnlyProof.confirmedLook.patternId, 'ocean');

let aliasRequestBody = null;
globalThis.fetch = async (url, options = {}) => {
  aliasRequestBody = JSON.parse(options.body || '{}');
  return {
    ok: true,
    json: async () => ({
      ok: true,
      cardId: 'lw-expected',
      patternId: aliasRequestBody.patternId,
      revision: aliasRequestBody.revision,
    }),
  };
};
const aliasAcknowledgement = await pushLivePreviewToCard(
  { patternId: 'gradient' },
  { host: 'lightweaver.local', expectedCardId: 'lw-expected', revision: 19, autoDiscover: false, latestOnly: false },
);
assert.equal(aliasRequestBody.patternId, 'aurora', 'display-only pattern ids must transmit their firmware runtime alias');
assert.equal(aliasAcknowledgement.patternId, 'aurora', 'firmware echo is validated against the transmitted runtime id');
assert.equal(aliasAcknowledgement.revision, 19, 'alias-aware acknowledgement must preserve physical preview revision proof');

const controlResponseLimit = 8192;
const exactLimitBase = JSON.stringify({ ok: true, cardId: 'lw-expected', patternId: 'ocean', padding: '' });
const exactLimitBody = exactLimitBase.slice(0, -2) + 'x'.repeat(controlResponseLimit - exactLimitBase.length) + '"}';
assert.equal(new TextEncoder().encode(exactLimitBody).byteLength, controlResponseLimit);
globalThis.fetch = async () => new Response(exactLimitBody, {
  status: 200,
  headers: { 'Content-Type': 'application/json', 'Content-Length': String(controlResponseLimit) },
});
const exactLimitAcknowledgement = await pushLivePreviewToCard(
  { patternId: 'ocean' },
  { host: 'lightweaver.local', expectedCardId: 'lw-expected', autoDiscover: false, latestOnly: false },
);
assert.equal(exactLimitAcknowledgement.patternId, 'ocean', 'a response exactly at the ceiling remains valid');

for (const [label, responseFactory] of [
  ['declared oversized acknowledgement', () => new Response(
    `${exactLimitBody} `,
    { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': String(controlResponseLimit + 1) } },
  )],
  ['streamed oversized acknowledgement', () => new Response(
    JSON.stringify({ ok: true, cardId: 'lw-expected', patternId: 'ocean', padding: 'x'.repeat(12000) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )],
  ['oversized error body', () => new Response('x'.repeat(controlResponseLimit + 1), {
    status: 422,
    headers: { 'Content-Type': 'text/plain' },
  })],
]) {
  globalThis.fetch = async () => responseFactory();
  await assert.rejects(
    pushLivePreviewToCard(
      { patternId: 'ocean' },
      { host: 'lightweaver.local', expectedCardId: 'lw-expected', autoDiscover: false, latestOnly: false },
    ),
    error => {
      assert.equal(error?.reason, 'response-too-large', label);
      return true;
    },
  );
}

globalThis.fetch = async () => { throw new TypeError('network down'); };
await assert.rejects(
  readCardZonesFromCard({ host: 'lightweaver.local', timeoutMs: 50 }),
  error => error?.reason === 'offline',
);

assert.deepEqual(buildLiveHardwareControlPayload({ colorOrder: 'grb' }), {
  colorOrder: 'GRB',
});

const hardwareRequests = [];
globalThis.fetch = async (url, options = {}) => {
  hardwareRequests.push({ url, options });
  return {
    ok: true,
    json: async () => ({ ok: true, colorOrder: 'GBR' }),
  };
};

const hardwareResponse = await pushLiveHardwareToCard({
  colorOrder: 'GBR',
}, {
  host: '192.168.18.70',
  timeoutMs: 1000,
});

assert.equal(hardwareResponse.colorOrder, 'GBR');
assert.equal(hardwareRequests[0].url, 'http://192.168.18.70/api/control');
assert.deepEqual(JSON.parse(hardwareRequests[0].options.body), { colorOrder: 'GBR' });

const recoveryRequests = [];
const recoveryOrder = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/api/wiring/status')) {
    recoveryOrder.push('safety-status');
    return { ok: true, json: async () => ({ ok: true, state: 'known-good', currentOutputs: [] }) };
  }
  recoveryOrder.push('recover-post');
  recoveryRequests.push({ url, options });
  return {
    ok: true,
    json: async () => ({
      ok: true,
      accepted: true,
      diagnostics: {
        brightnessByte: 220,
        nonBlackPixels: 44,
        firstLogicalPixel: { r: 255, g: 244, b: 220 },
      },
    }),
  };
};

const recoveryResponse = await recoverCardLights({
  patternId: 'warm-white',
  brightness: 1,
  syncZones: true,
}, {
  host: '192.168.18.70',
  timeoutMs: 1000,
  reclaimDelayMs: 17,
  reclaimFrameStreams: async (host, options) => {
    recoveryOrder.push('browser-reclaimed');
    assert.equal(host, '192.168.18.70');
    assert.equal(options.handoffMs, 17);
  },
});

assert.equal(recoveryResponse.accepted, true);
assert.deepEqual(recoveryOrder, ['browser-reclaimed', 'safety-status', 'recover-post'], 'browser producers stop and wiring safety is checked before card recovery is posted');
assert.equal(recoveryRequests[0].url, 'http://192.168.18.70/api/recover-lights');
assert.equal(recoveryRequests[0].options.method, 'POST');
assert.deepEqual(JSON.parse(recoveryRequests[0].options.body), {
  patternId: 'warm-white',
  brightness: 1,
  syncZones: true,
});

const hardRecoveryOrder = [];
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/api/wiring/status')) {
    hardRecoveryOrder.push('safety-status');
    return { ok: true, json: async () => ({ ok: true, state: 'known-good', currentOutputs: [] }) };
  }
  hardRecoveryOrder.push(String(url).endsWith('/api/reboot') ? 'reboot' : 'recover');
  return {
    ok: true,
    json: async () => ({
      ok: true,
      accepted: true,
      diagnostics: { nonBlackPixels: 44, brightnessByte: 180 },
    }),
  };
};
const hardRecovery = await recoverCardLights(
  { patternId: 'warm-white', brightness: 1, syncZones: true },
  {
    host: '192.168.18.70',
    restartCard: true,
    restartSettleMs: 0,
    setTimeoutImpl: callback => { callback(); return 0; },
    reclaimFrameStreams: async () => hardRecoveryOrder.push('reclaim'),
  },
);
assert.deepEqual(hardRecoveryOrder, ['reclaim', 'safety-status', 'recover', 'reboot', 'recover']);
assert.equal(hardRecovery.restarted, true, 'hard recovery reports the completed LED driver restart');

globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'restart failed' });
await assert.rejects(
  requestCardReboot('192.168.18.70'),
  error => error?.reason === 'http',
  'an HTTP failure must not be reported as an accepted restart',
);

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ ok: true, recovered: true }),
});
await assert.rejects(
  recoverCardLights(
    { patternId: 'warm-white', brightness: 1, syncZones: true },
    { host: '192.168.18.70', autoDiscover: false, reclaimFrameStreams: async () => {} },
  ),
  error => error?.reason === 'recovery-unconfirmed',
  'a transport-level 200 without frame diagnostics must not be presented as recovered lights',
);

const repairPackage = buildMirroredLedRepairPackage({
  app: 'Lightweaver',
  format: 'lightweaver-card-runtime-package',
  version: 1,
  config: {
    version: 1,
    mode: 'website-flash',
    piece: { id: 'piece', name: 'Two output project' },
    led: {
      pixels: 44,
      colorOrder: 'RGB',
      brightnessLimit: 0.65,
      maxMilliamps: 1700,
      outputGammaEnabled: true,
      outputGammaValue: 2.4,
      calibration: { red: 0.84, green: 0.92, blue: 0.73 },
      outputs: [
        { id: 'outer', name: 'Outer', pin: 16, pixels: 22 },
        { id: 'inner', name: 'Inner', pin: 17, pixels: 22 },
      ],
    },
    controls: {},
    patterns: [{ id: 'fire', label: 'Fire', mode: 'procedural' }],
    looks: [{ id: 'fire', label: 'Fire', mode: 'procedural', preset: 'fire', brightness: 1 }],
    startupPatternId: 'fire',
    zones: [
      { id: 'outer', label: 'Outer', patternId: 'fire', ranges: [{ start: 0, count: 22 }] },
      { id: 'inner', label: 'Inner', patternId: 'ripple', ranges: [{ start: 22, count: 22 }] },
    ],
    syncZones: false,
  },
});
assert.deepEqual(repairPackage.config.led.outputs, [
  { id: 'out1', name: 'Output 1 mirrored', pin: 16, pixels: 44 },
]);
assert.equal(repairPackage.config.led.pixels, 44);
assert.equal(repairPackage.config.led.maxMilliamps, 1700);
assert.equal(repairPackage.config.led.outputGammaEnabled, true);
assert.equal(repairPackage.config.led.outputGammaValue, 2.4);
assert.deepEqual(repairPackage.config.led.calibration, { red: 0.84, green: 0.92, blue: 0.73 });
assert.equal(repairPackage.config.syncZones, true);
assert.equal(repairPackage.config.startupPatternId, 'fire');

const legacyRepairPackage = buildMirroredLedRepairPackage({
  config: {
    led: { pixels: 44, maxMilliamps: 1500 },
    gammaEnabled: true,
    gammaValue: 3,
    pattern: { gammaEnabled: true, gammaValue: 3 },
  },
});
assert.equal(legacyRepairPackage.config.led.maxMilliamps, 1500);
assert.equal(legacyRepairPackage.config.led.outputGammaEnabled, false);
assert.equal(legacyRepairPackage.config.led.outputGammaValue, 2.2);
assert.deepEqual(legacyRepairPackage.config.led.calibration, { red: 1, green: 1, blue: 1 });

const repairRequests = [];
globalThis.fetch = async (url, options = {}) => {
  repairRequests.push({ url, options });
  if (String(url).endsWith('/api/firmware-info')) {
    return {
      ok: true,
      json: async () => ({
        pixels: 44,
        outputs: [
          { id: 'outer', pin: 16, pixels: 22 },
          { id: 'inner', pin: 17, pixels: 22 },
        ],
      }),
    };
  }
  if (String(url).endsWith('/api/wiring/candidate')) {
    return {
      ok: true,
      json: async () => ({ ok: true, state: 'staged', activationId: 'card-issued-repair', currentOutputs: [] }),
    };
  }
  return {
    ok: true,
    json: async () => ({ ok: true }),
  };
};

const repairResponse = await repairMirroredLedOutputOnCard(repairPackage, {
  host: '192.168.18.70',
  timeoutMs: 1000,
});

assert.equal(repairResponse.state, 'staged');
assert.equal(repairResponse.activationId, 'card-issued-repair');
assert.deepEqual(repairRequests.map(item => item.url), [
  'http://192.168.18.70/api/firmware-info',
  'http://192.168.18.70/api/wiring/candidate',
]);
assert.deepEqual(JSON.parse(repairRequests[1].options.body).candidate.led.outputs, [
  { id: 'out1', name: 'Output 1 mirrored', pin: 16, pixels: 44 },
]);
assert.equal(
  JSON.stringify(JSON.parse(repairRequests[1].options.body).candidate),
  prepareCardStoragePayload(repairPackage).json,
);

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
    json: async () => ({ ok: true, patternId: JSON.parse(options.body || '{}').patternId }),
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
    json: async () => ({ ok: true, patternId: JSON.parse(options.body || '{}').patternId }),
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
    json: async () => ({ ok: true, patternId: JSON.parse(options.body || '{}').patternId }),
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
    json: async () => ({ ok: true, recovered: true, patternId: JSON.parse(options.body || '{}').patternId }),
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
  'http://192.168.4.1/api/status',
  'http://192.168.4.1/api/control',
]);

const resetRequests = [];
globalThis.fetch = async (url, options = {}) => {
  resetRequests.push({ url, options });
  if (String(url).endsWith('/api/zones')) {
    return {
      ok: true,
      json: async () => ({
        syncZones: false,
        zones: [
          {
            id: 'patch-default-outer-circle',
            patternId: 'fire',
            brightness: 0.8,
            speed: 1.2,
            hueShift: 4,
            customHue: 34,
            customSaturation: 220,
            customBreathe: true,
            customDrift: false,
            blackout: true,
          },
          {
            id: 'patch-default-inner-circle',
            patternId: 'sparkle',
            brightness: 1,
            speed: 0.75,
            hueShift: -2,
            customHue: 160,
            customSaturation: 190,
            customBreathe: false,
            customDrift: true,
            blackout: false,
          },
        ],
      }),
    };
  }
  return {
    ok: true,
    json: async () => ({ ok: true, patternId: JSON.parse(options.body || '{}').patternId }),
  };
};

const resetResponse = await resetLiveOutputOnCard({
  patternId: 'fire',
}, {
  host: '192.168.18.70',
  timeoutMs: 1000,
});

assert.equal(resetResponse.source, 'zones');
assert.equal(resetResponse.zonesPreviewed, 2);
assert.deepEqual(resetRequests.map(item => item.url), [
  'http://192.168.18.70/api/zones',
  'http://192.168.18.70/api/control',
  'http://192.168.18.70/api/control',
]);
assert.deepEqual(resetRequests.slice(1).map(item => {
  const body = JSON.parse(item.options.body);
  return {
    zone: body.zone,
    patternId: body.patternId,
    syncZones: body.syncZones,
    cancelStream: body.cancelStream,
    blackout: body.blackout,
    brightness: body.brightness,
    speed: body.speed,
  };
}), [
  {
    zone: 'patch-default-outer-circle',
    patternId: 'fire',
    syncZones: false,
    cancelStream: true,
    blackout: false,
    brightness: 0.8,
    speed: 1.2,
  },
  {
    zone: 'patch-default-inner-circle',
    patternId: 'sparkle',
    syncZones: false,
    cancelStream: true,
    blackout: false,
    brightness: 1,
    speed: 0.75,
  },
]);

const resetFallbackRequests = [];
globalThis.fetch = async (url, options = {}) => {
  resetFallbackRequests.push({ url, options });
  if (String(url).endsWith('/api/zones')) {
    return { ok: false, json: async () => ({ ok: false }) };
  }
  return {
    ok: true,
    json: async () => ({ ok: true, fallback: true, patternId: JSON.parse(options.body || '{}').patternId }),
  };
};

const resetFallbackResponse = await resetLiveOutputOnCard({
  patternId: 'ocean',
  brightness: 0.66,
}, {
  host: '192.168.18.70',
  timeoutMs: 1000,
});

assert.equal(resetFallbackResponse.source, 'fallback');
assert.equal(resetFallbackResponse.fallback, true);
assert.deepEqual(resetFallbackRequests.map(item => item.url), [
  'http://192.168.18.70/api/zones',
  'http://192.168.18.70/api/control',
]);
assert.deepEqual(JSON.parse(resetFallbackRequests[1].options.body), {
  cancelStream: true,
  syncZones: true,
  blackout: false,
  patternId: 'ocean',
  brightness: 0.66,
  speed: 1,
  hueShift: 0,
  hue: 32,
  saturation: 230,
  breathe: false,
  drift: false,
});

delete globalThis.window;
let releaseStaleZoneProbe;
let staleZoneProbeStarted;
const staleZoneProbeReady = new Promise(resolve => { staleZoneProbeStarted = resolve; });
const arbitratedControlRequests = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/api/zones')) {
    staleZoneProbeStarted();
    await new Promise(resolve => { releaseStaleZoneProbe = resolve; });
    return { ok: true, json: async () => ({ zones: [{ id: 'zone-a' }] }) };
  }
  const body = JSON.parse(options.body || '{}');
  arbitratedControlRequests.push(body.patternId);
  return { ok: true, json: async () => ({ ok: true, patternId: body.patternId }) };
};
const staleAurora = pushLivePreviewToCard({ patternId: 'aurora', zone: 'zone-a' }, {
  host: '192.168.18.69',
  fallbackMissingZoneToAll: true,
  autoDiscover: false,
}).catch(error => error);
await staleZoneProbeReady;
const currentFire = pushLivePreviewToCard({ patternId: 'fire' }, {
  host: '192.168.18.69',
  autoDiscover: false,
});
releaseStaleZoneProbe();
const [staleAuroraError, currentFireResponse] = await Promise.all([staleAurora, currentFire]);
assert.equal(staleAuroraError.reason, 'superseded');
assert.equal(currentFireResponse.patternId, 'fire');
assert.deepEqual(arbitratedControlRequests, ['fire'], 'an obsolete preview must not POST after deferred preflight');

let releaseFirstPreview;
const latestPreviewRequests = [];
globalThis.fetch = async (url, options = {}) => {
  const body = JSON.parse(options.body || '{}');
  latestPreviewRequests.push(body.patternId);
  if (body.patternId === 'aurora') {
    await new Promise(resolve => { releaseFirstPreview = resolve; });
  }
  return {
    ok: true,
    json: async () => ({ ok: true, patternId: body.patternId }),
  };
};

const firstPreview = pushLivePreviewToCard({ patternId: 'aurora' }, {
  host: '192.168.18.70',
  timeoutMs: 1000,
});
await Promise.resolve();
const secondPreview = pushLivePreviewToCard({ patternId: 'fire' }, {
  host: '192.168.18.70',
  timeoutMs: 1000,
}).catch(error => error);
const thirdPreview = pushLivePreviewToCard({ patternId: 'ocean' }, {
  host: '192.168.18.70',
  timeoutMs: 1000,
});
await Promise.resolve();
assert.deepEqual(latestPreviewRequests, ['aurora']);
releaseFirstPreview();

const [firstPreviewResponse, secondPreviewError, thirdPreviewResponse] = await Promise.all([
  firstPreview,
  secondPreview,
  thirdPreview,
]);
assert.equal(firstPreviewResponse.patternId, 'aurora');
assert.equal(secondPreviewError.reason, 'superseded');
assert.equal(thirdPreviewResponse.patternId, 'ocean');
assert.deepEqual(latestPreviewRequests, ['aurora', 'ocean']);

// Section combos and single-pattern taps share the same per-host arbitration.
// Once the newer pattern intent exists, the older combo may finish its in-flight
// zone but must never start another zone write.
let releaseComboZoneOne;
const interleavedPreviewRequests = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/api/zones')) {
    return {
      ok: true,
      json: async () => ({
        zones: [
          { id: 'zone-one', patternId: 'aurora' },
          { id: 'zone-two', patternId: 'aurora' },
        ],
      }),
    };
  }
  const body = JSON.parse(options.body || '{}');
  interleavedPreviewRequests.push({ zone: body.zone || '', patternId: body.patternId });
  if (body.zone === 'zone-one') {
    await new Promise(resolve => { releaseComboZoneOne = resolve; });
  }
  return {
    ok: true,
    json: async () => ({ ok: true, patternId: body.patternId, revision: body.revision }),
  };
};

const olderCombo = pushSectionPreviewToCard([
  { id: 'zone-one', zoneId: 'zone-one', kind: 'section', look: { patternId: 'ocean' } },
  { id: 'zone-two', zoneId: 'zone-two', kind: 'section', look: { patternId: 'sparkle' } },
], {
  host: '192.168.18.71',
  revision: 20,
  autoDiscover: false,
}).catch(error => error);
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(interleavedPreviewRequests, [{ zone: 'zone-one', patternId: 'ocean' }]);
const newerPattern = pushLivePreviewToCard({ patternId: 'fire' }, {
  host: '192.168.18.71',
  revision: 21,
  autoDiscover: false,
});
releaseComboZoneOne();
const [olderComboError, newerPatternResponse] = await Promise.all([olderCombo, newerPattern]);
assert.equal(olderComboError.reason, 'superseded');
assert.equal(newerPatternResponse.patternId, 'fire');
assert.deepEqual(interleavedPreviewRequests, [
  { zone: 'zone-one', patternId: 'ocean' },
  { zone: '', patternId: 'fire' },
]);

const listeners = new Map();
const bridgeMessages = [];
let bridgeControlPadding = '';
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
            ? { cardId: 'lw-live-preview', firmwareVersion: '1.0.0' }
            : { ok: true, bridged: true, cardId: 'lw-live-preview', patternId: message.payload?.patternId, padding: bridgeControlPadding },
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
      ? JSON.stringify({ version: 1, id: 'lw-live-preview' })
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
bridgeMessages.length = 0;

const bridgedPreview = await pushLivePreviewToCard({
  patternId: 'ocean',
}, {
  host: 'lightweaver.local',
  timeoutMs: 1000,
});

assert.equal(bridgedPreview.bridged, true);
assert.equal(bridgedPreview.patternId, 'ocean');
assert.equal(bridgeMessages[0].targetOrigin, 'http://lightweaver.local');
assert.equal(bridgeMessages[0].message.app, 'LightweaverStudioBridge');
assert.equal(bridgeMessages[0].message.type, 'control');
assert.equal(bridgeMessages[0].message.payload.patternId, 'ocean');

bridgeControlPadding = 'x'.repeat(controlResponseLimit + 1);
await assert.rejects(
  pushLivePreviewToCard(
    { patternId: 'fire' },
    { host: 'lightweaver.local', timeoutMs: 1000, latestOnly: false, autoDiscover: false },
  ),
  error => error?.reason === 'response-too-large',
  'the HTTPS card-page bridge must enforce the same bounded acknowledgement contract',
);

console.log('card-live-preview tests passed');
