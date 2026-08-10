import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CARD_TRANSPORTS,
  cardLocalStudioUrl,
  connectCardTransport,
} from './cardTransport.js';

function response(body, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body };
}

function readyStatus(overrides = {}) {
  return {
    app: 'Lightweaver', provisioningContractVersion: 1,
    cardId: 'lw-card-a', firmwareVersion: '1.1.3', buildId: 'b'.repeat(40),
    bootId: 'boot-2', runtimePhase: 'ready', knownGoodProject: true,
    commandReady: true, playbackReady: true, outputReady: true,
    ...overrides,
  };
}

function linkFor(status) {
  let state = {
    host: '192.168.18.70',
    card: { id: status.cardId },
    readiness: status,
    validatedBootId: status.bootId,
    operationGeneration: 4,
    state: 'connected-direct',
  };
  return {
    getState: () => state,
    dispatch(event) {
      if (event.type === 'direct-status' && event.connected) state = {
        ...state,
        host: event.host,
        card: event.card,
        readiness: event.readiness,
        validatedBootId: event.readiness.bootId,
      };
    },
    replace(next) { state = next; },
  };
}

test('direct transport is selected only after an exact fresh status probe', async () => {
  const status = readyStatus();
  const calls = [];
  const link = linkFor(status);
  const authority = await connectCardTransport({
    host: '192.168.18.70',
    expectedCardId: 'lw-card-a',
    link,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response(status); },
  });
  assert.equal(authority.transport, CARD_TRANSPORTS.DIRECT);
  assert.equal(authority.cardId, 'lw-card-a');
  assert.equal(authority.bootId, 'boot-2');
  assert.equal(calls[0].url, 'http://192.168.18.70/api/status');
  assert.equal(calls[0].init.targetAddressSpace, 'local');
  assert.deepEqual(calls[0].init.headers, { Accept: 'application/json' },
    'a read-only status GET must stay CORS-safelisted so released cards can answer it');
  assert.ok(Object.isFrozen(authority));
});

test('identified firmware that predates exact boot identity is an actionable incompatibility', async () => {
  const result = await connectCardTransport({
    host: '192.168.18.70', expectedCardId: 'lw-card-a',
    fetchImpl: async () => response({
      app: 'Lightweaver', cardId: 'lw-card-a', firmwareVersion: '1.1.1',
      buildNumber: 1198, buildId: 'a'.repeat(40), bootId: 'boot-old-contract',
      provisioningContractVersion: 0, commandReady: true,
    }),
  });
  assert.equal(result.connected, false);
  assert.equal(result.reason, 'firmware-incompatible');
  assert.deepEqual(result.observedCard, {
    id: 'lw-card-a', firmwareVersion: '1.1.1', buildNumber: 1198,
    buildId: 'a'.repeat(40),
  });
});

test('a non-Lightweaver JSON response never becomes a firmware diagnosis', async () => {
  const result = await connectCardTransport({
    host: '192.168.18.70',
    fetchImpl: async () => response({
      app: 'Other device', cardId: 'lw-card-a', firmwareVersion: '1.1.1',
      buildNumber: 1198, buildId: 'a'.repeat(40),
    }),
  });
  assert.equal(result.connected, false);
  assert.equal(result.reason, 'identity-missing');
  assert.notEqual(result.reason, 'firmware-incompatible');
});

test('wrong card is a blocked result with expected and observed evidence', async () => {
  const result = await connectCardTransport({
    host: '192.168.18.70', expectedCardId: 'lw-expected',
    fetchImpl: async () => response({ cardId: 'lw-other', bootId: 'boot-1', commandReady: true }),
  });
  assert.equal(result.connected, false);
  assert.equal(result.reason, 'wrong-card');
  assert.equal(result.expectedCardId, 'lw-expected');
  assert.equal(result.observedCardId, 'lw-other');
});

test('failed probe returns same-tab local fallback and never opens a window', async () => {
  let opened = 0;
  const result = await connectCardTransport({
    host: 'lightweaver.local',
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    openImpl: () => { opened += 1; },
  });
  assert.equal(result.recovery.localStudioUrl, 'http://lightweaver.local/studio/');
  assert.equal(cardLocalStudioUrl('192.168.4.1'), 'http://192.168.4.1/studio/');
  assert.equal(opened, 0);
});

test('authority is revoked immediately when its cardLink generation changes', async () => {
  const status = readyStatus();
  const link = linkFor(status);
  const authority = await connectCardTransport({
    host: '192.168.18.70', expectedCardId: 'lw-card-a', link,
    fetchImpl: async () => response(status),
  });
  link.replace({ ...link.getState(), operationGeneration: 5 });
  await assert.rejects(() => authority.request('/api/control', { method: 'POST', body: {} }), /revoked/i);
});

test('owner capability issuance is explicit, bounded, and bound to the probed project head', async () => {
  const status = readyStatus({ projectHead: 'a'.repeat(64) });
  const calls = [];
  const link = linkFor(status);
  const authority = await connectCardTransport({
    host: '192.168.18.70', expectedCardId: 'lw-card-a', link,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/owner/capability')) return response({ ok: true, capability: 'cap-1', expiresInMs: 60000, cardId: 'lw-card-a', bootId: 'boot-2' });
      return response(status);
    },
  });
  assert.equal(authority.ownerCapability, '');
  assert.equal(authority.projectHead, status.projectHead);
  await assert.rejects(() => authority.issueOwnerCapability(), /commissioning proof/i);
  assert.equal(calls.length, 1, 'missing proof never reaches the card');
  const issued = await authority.issueOwnerCapability({ commissioningProof: 'physical-pairing-confirmed' });
  assert.equal(issued, 'cap-1');
  assert.equal(authority.ownerCapability, 'cap-1');
  assert.equal(new URL(calls[1].url).pathname, '/api/owner/capability');
  assert.equal(JSON.parse(calls[1].init.body).expectedProjectHead, status.projectHead);
});

test('Connection Center exposes deliberate physical confirmation for live control', async () => {
  const source = await readFile(new URL('../components/card/CardConnectionCenter.jsx', import.meta.url), 'utf8');
  assert.match(source, /Enable live control/);
  assert.match(source, /Touch a physical card control/);
  assert.match(source, /issueOwnerCapability/);
});
