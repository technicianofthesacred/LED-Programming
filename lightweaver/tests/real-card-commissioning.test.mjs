import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { runRealCardCommissioning } from '../scripts/real-card-commissioning.mjs';

const CARD_ID = 'lw-b0fe81f61b44';
const BUILD_ID = 'a'.repeat(40);

async function cardServer({ status = {}, firmware = {} } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/firmware-info') {
      response.end(JSON.stringify({
        app: 'Lightweaver', cardId: CARD_ID, firmwareVersion: '1.1.8',
        buildId: BUILD_ID, buildNumber: 1088, ...firmware,
      }));
      return;
    }
    if (request.url === '/api/status') {
      response.end(JSON.stringify({
        app: 'Lightweaver', ok: true, cardId: CARD_ID,
        firmwareVersion: '1.1.8', buildId: BUILD_ID, buildNumber: 1088,
        bootId: 'boot-real-card-test', runtimePhase: 'ready',
        knownGoodProject: true, commandReady: true, playbackReady: true,
        outputReady: true, projectId: 'bench-fixture', projectRevision: 1,
        projectFingerprint: '0123456789abcdef', pixels: 44,
        maxMilliamps: 1500, colorOrder: 'GRB', ...status,
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    host: `127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test('safe mode performs only real read-only GET preflight and read-back requests', async t => {
  const card = await cardServer();
  t.after(card.close);

  const result = await runRealCardCommissioning({
    cardHost: card.host,
    expectedCardId: CARD_ID,
    expectedBuildId: BUILD_ID,
  });

  assert.deepEqual(card.requests, [
    { method: 'GET', url: '/api/firmware-info' },
    { method: 'GET', url: '/api/status' },
  ]);
  assert.equal(result.mode, 'safe-read-only');
  assert.equal(result.verified, true);
  assert.equal(result.identity.cardId, CARD_ID);
  assert.equal(result.identity.buildId, BUILD_ID);
  assert.equal(result.status.bootId, 'boot-real-card-test');
  assert.equal(result.status.pixels, 44);
});

test('safe mode rejects identity mismatch after read-only requests', async t => {
  const card = await cardServer({ status: { cardId: 'lw-wrong-card' } });
  t.after(card.close);

  await assert.rejects(
    runRealCardCommissioning({
      cardHost: card.host,
      expectedCardId: CARD_ID,
      expectedBuildId: BUILD_ID,
    }),
    /status card ID.*expected/i,
  );
  assert.ok(card.requests.every(request => request.method === 'GET'));
});

test('read-back normalizes the real nested firmware status shape', async t => {
  const card = await cardServer({
    status: {
      pixels: undefined,
      colorOrder: undefined,
      led: { pixels: 0, type: 'WS2812B', colorOrder: '', maxMilliamps: 100 },
      limits: { pixels: 65535, outputs: 4, configStorageBytes: 3968 },
      wifi: { transport: 'station', ip: '192.168.18.70', configured: true },
      outputs: [],
    },
  });
  t.after(card.close);

  const result = await runRealCardCommissioning({
    cardHost: card.host,
    expectedCardId: CARD_ID,
    expectedBuildId: BUILD_ID,
  });

  assert.deepEqual(result.status.led, {
    pixels: 0, type: 'WS2812B', colorOrder: '', maxMilliamps: 100,
  });
  assert.deepEqual(result.status.limits, { pixels: 65535, outputs: 4, configStorageBytes: 3968 });
  assert.deepEqual(result.status.wifi, { transport: 'station', ip: '192.168.18.70', configured: true });
  assert.deepEqual(result.status.outputs, []);
});

test('safe mode rejects build mismatch between expected identity and card', async t => {
  const card = await cardServer({ firmware: { buildId: 'b'.repeat(40) } });
  t.after(card.close);

  await assert.rejects(
    runRealCardCommissioning({
      cardHost: card.host,
      expectedCardId: CARD_ID,
      expectedBuildId: BUILD_ID,
    }),
    /firmware build ID.*expected/i,
  );
  assert.ok(card.requests.every(request => request.method === 'GET'));
});

test('required identity inputs fail before any network request', async () => {
  await assert.rejects(
    runRealCardCommissioning({ cardHost: '192.0.2.1' }),
    /EXPECTED_CARD_ID.*required/i,
  );
});

test('--allow-mutation is reserved and provides no mutating operation', async () => {
  await assert.rejects(
    runRealCardCommissioning({
      cardHost: '192.0.2.1',
      expectedCardId: CARD_ID,
      expectedBuildId: BUILD_ID,
      allowMutation: true,
    }),
    /mutation operations are not implemented/i,
  );
});
