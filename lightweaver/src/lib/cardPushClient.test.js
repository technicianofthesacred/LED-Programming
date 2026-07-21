import assert from 'node:assert/strict';
import test from 'node:test';
import { pushConfigToCard, readCardProjectEvidence, readCardStatusEnvelope } from './cardPushClient.js';

const runtimePackage = {
  format: 'lightweaver-card-runtime-package',
  config: {
    version: 1,
    piece: { id: 'commissioned-piece', name: 'Commissioned Piece' },
    led: {
      pixels: 8,
      colorOrder: 'GRB',
      outputs: [{ id: 'main', pin: 16, pixels: 8 }],
    },
    looks: [],
  },
};

function browserWithIdentity(protocol = 'http:') {
  const values = new Map([
    ['lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-aabbccddeeff' })],
  ]);
  return {
    location: { protocol },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    },
  };
}

function response(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('status preflight performs an uncached full status GET', async () => {
  let call;
  const status = { app: 'Lightweaver', cardId: 'lw-aabbccddeeff', commandReady: true };
  assert.equal(await readCardStatusEnvelope({
    host: '192.168.4.1', transport: 'direct',
    fetchImpl: async (url, init) => {
      call = { url, init };
      return { ok: true, json: async () => status };
    },
  }), status);
  assert.match(call.url, /\/api\/status$/);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.cache, 'no-store');
});

test('project evidence reader performs an uncached independent branded firmware-info GET', async () => {
  let call;
  const body = {
    app: 'Lightweaver',
    cardId: 'lw-aabbccddeeff',
    firmwareVersion: '1.2.3',
    buildId: 'build-123',
    projectRevision: 7,
    projectFingerprint: 'a'.repeat(16),
    productionJobId: 'job-42',
    productionJobDigest: 'b'.repeat(64),
  };
  const result = await readCardProjectEvidence({
    host: '192.168.4.1',
    transport: 'direct',
    fetchImpl: async (url, init) => {
      call = { url, init };
      return { ok: true, json: async () => body };
    },
  });
  assert.deepEqual(result, body);
  assert.match(call.url, /\/api\/firmware-info$/);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.cache, 'no-store');
});

test('project evidence reader rejects a response branded as another product', async () => {
  await assert.rejects(readCardProjectEvidence({
    host: '192.168.4.1',
    transport: 'direct',
    fetchImpl: async () => ({ ok: true, json: async () => ({ app: 'Other', cardId: 'lw-aabbccddeeff' }) }),
  }), /Lightweaver/i);
});

test('project evidence reader rejects identity without an exact Lightweaver provenance marker', async () => {
  await assert.rejects(readCardProjectEvidence({
    host: '192.168.4.1',
    transport: 'direct',
    fetchImpl: async () => ({ ok: true, json: async () => ({
      cardId: 'lw-aabbccddeeff',
      firmwareVersion: '1.2.3',
      buildId: 'build-123',
      projectRevision: 7,
      projectFingerprint: 'a'.repeat(16),
    }) }),
  }), /Lightweaver/i);
});

test('project evidence reader rejects malformed card-owned identity fields', async () => {
  await assert.rejects(readCardProjectEvidence({
    host: '192.168.4.1',
    transport: 'direct',
    fetchImpl: async () => ({ ok: true, json: async () => ({
      app: 'Lightweaver',
      cardId: 'lw-aabbccddeeff',
      firmwareVersion: '1.2.3',
      buildId: 'build-123',
      projectRevision: 7,
      projectFingerprint: 'ABCDEF0123456789',
    }) }),
  }), /project fingerprint/i);
});

test('project evidence rejects a partial production job identity', async () => {
  for (const partial of [
    { productionJobId: 'job-42' },
    { productionJobDigest: 'b'.repeat(64) },
  ]) {
    await assert.rejects(readCardProjectEvidence({
      host: '192.168.4.1',
      transport: 'direct',
      fetchImpl: async () => ({ ok: true, json: async () => ({
        app: 'Lightweaver',
        cardId: 'lw-aabbccddeeff',
        firmwareVersion: '1.2.3',
        buildId: 'build-123',
        projectRevision: 7,
        projectFingerprint: 'a'.repeat(16),
        ...partial,
      }) }),
    }), /production job identity/i);
  }
});

test('explicit bridge config transport is honored on an HTTP Studio page', { concurrency: false }, async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const bridgeCalls = [];
  globalThis.window = browserWithIdentity('http:');
  globalThis.fetch = async () => { throw new Error('direct HTTP must not run'); };
  try {
    const result = await pushConfigToCard(runtimePackage, {
      host: '192.168.18.70',
      transport: 'bridge',
      autoDiscover: false,
      reboot: 'if-needed',
      bridgeRequestImpl: async (type, payload, options) => {
        bridgeCalls.push({ type, payload, options });
        if (type === 'firmware-info') {
          return { piece: { id: 'commissioned-piece' }, outputs: [{ pin: 16, pixels: 8 }] };
        }
        if (type === 'config') return { ok: true, saved: true };
        throw new Error(`unexpected bridge request ${type}`);
      },
      initialConfigAuthorityImpl: () => false,
    });
    assert.equal(result.saved, true);
    assert.deepEqual(bridgeCalls.map(call => call.type), ['firmware-info', 'config']);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test('explicit direct config transport is honored on an HTTPS Studio page', { concurrency: false }, async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.window = browserWithIdentity('https:');
  globalThis.fetch = async () => { throw new Error('push must use the supplied direct transport'); };
  try {
    const result = await pushConfigToCard(runtimePackage, {
      host: '192.168.18.70',
      transport: 'direct',
      autoDiscover: false,
      reboot: false,
      bridgeRequestImpl: async () => { throw new Error('bridge must not run'); },
      fetchImpl: async (url) => {
        urls.push(String(url));
        if (String(url).endsWith('/api/firmware-info')) {
          return response({
            app: 'Lightweaver', cardId: 'lw-aabbccddeeff',
            firmwareVersion: '1.2.3', buildId: 'build-123',
            piece: { id: 'commissioned-piece' }, outputs: [{ pin: 16, pixels: 8 }],
          });
        }
        if (String(url).endsWith('/api/config')) return response({ ok: true, saved: true });
        throw new Error(`unexpected direct request ${url}`);
      },
    });
    assert.equal(result.saved, true);
    assert.equal(urls.filter(url => url.endsWith('/api/config')).length, 1);
    assert.equal(urls.some(url => url.includes('/api/wiring/')), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test('direct factory commissioning requires fresh exact blank authority and writes config once', { concurrency: false }, async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.window = browserWithIdentity('http:');
  globalThis.fetch = async () => { throw new Error('push must use the supplied direct transport'); };
  try {
    const result = await pushConfigToCard(runtimePackage, {
      host: '192.168.18.70',
      transport: 'direct',
      factoryBlank: true,
      autoDiscover: false,
      reboot: 'if-needed',
      allowProjectChange: true,
      allowLayoutChange: true,
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method || 'GET' });
        if (String(url).endsWith('/api/firmware-info')) {
          return response({
            app: 'Lightweaver', cardId: 'lw-aabbccddeeff',
            firmwareVersion: '1.2.3', buildId: 'build-123',
          });
        }
        if (String(url).endsWith('/api/status')) {
          return response({
            app: 'Lightweaver', provisioningContractVersion: 1,
            cardId: 'lw-aabbccddeeff', firmwareVersion: '1.2.3', buildId: 'build-123',
            bootId: 'boot-blank-1', runtimePhase: 'factory', knownGoodProject: false,
            commandReady: false, outputReady: true,
          });
        }
        if (String(url).endsWith('/api/config')) return response({ ok: true, saved: true });
        throw new Error(`unexpected direct request ${url}`);
      },
    });
    assert.equal(result.saved, true);
    assert.equal(calls.filter(call => call.url.endsWith('/api/config')).length, 1);
    assert.equal(calls.some(call => call.url.includes('/api/wiring/')), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test('direct factory commissioning refuses stale or nonblank authority before config write', { concurrency: false }, async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.window = browserWithIdentity('http:');
  globalThis.fetch = async () => { throw new Error('push must use the supplied direct transport'); };
  try {
    await assert.rejects(pushConfigToCard(runtimePackage, {
      host: '192.168.18.70',
      transport: 'direct',
      factoryBlank: true,
      autoDiscover: false,
      allowProjectChange: true,
      allowLayoutChange: true,
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method || 'GET' });
        if (String(url).endsWith('/api/firmware-info')) {
          return response({
            app: 'Lightweaver', cardId: 'lw-aabbccddeeff',
            firmwareVersion: '1.2.3', buildId: 'build-123',
          });
        }
        if (String(url).endsWith('/api/status')) {
          return response({
            app: 'Lightweaver', provisioningContractVersion: 1,
            cardId: 'lw-aabbccddeeff', firmwareVersion: '1.2.3', buildId: 'build-123',
            bootId: 'boot-ready-1', runtimePhase: 'ready', knownGoodProject: true,
            commandReady: true, outputReady: true,
          });
        }
        if (String(url).endsWith('/api/config')) return response({ ok: true, saved: true });
        throw new Error(`unexpected direct request ${url}`);
      },
    }), error => error?.reason === 'blank-authority');
    assert.equal(calls.filter(call => call.url.endsWith('/api/config')).length, 0);
    assert.equal(calls.some(call => call.url.includes('/api/wiring/')), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});
