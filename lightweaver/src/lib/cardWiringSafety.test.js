import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CARD_WIRING_STATES,
  CardWiringSafetyError,
  activateAndWaitForCardWiring,
  activateCardWiringCandidate,
  confirmCardWiringCandidate,
  discoverCardWiring,
  getCardWiringStatus,
  normalizeCardWiringStatus,
  rollbackCardWiringCandidate,
  readCardWiringCandidateEvidence,
  stageCardWiringCandidate,
  waitForCardWiringReconnect,
} from './cardWiringSafety.js';

test('candidate evidence is an uncached exact status GET and rejects another activation', async () => {
  const calls = [];
  const common = { host: '192.168.4.1', transport: 'direct', fetchImpl: async (url, init) => {
    calls.push([url, init]);
    return jsonResponse({ ok: true, state: 'staged', activationId: 'candidate-a', outputs: [], cardId: 'lw-aabbccddeeff', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40), projectRevision: 7, projectFingerprint: 'f'.repeat(16), productionJobId: 'job-42', productionJobDigest: 'b'.repeat(64) });
  } };
  const evidence = await readCardWiringCandidateEvidence('candidate-a', common);
  assert.equal(evidence.activationId, 'candidate-a');
  assert.equal(evidence.productionJobId, 'job-42');
  assert.equal(evidence.productionJobDigest, 'b'.repeat(64));
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].cache, 'no-store');
  await assert.rejects(readCardWiringCandidateEvidence('candidate-b', common), /different wiring transaction/i);
});

test('candidate evidence rejects malformed card-owned project identity', async () => {
  await assert.rejects(readCardWiringCandidateEvidence('candidate-a', {
    host: '192.168.4.1',
    transport: 'bridge',
    bridgeRequestImpl: async () => ({
      ok: true,
      state: 'staged',
      activationId: 'candidate-a',
      outputs: [],
      cardId: 'lw-aabbccddeeff',
      firmwareVersion: '1.2.3',
      buildId: 'build-123',
      projectRevision: 7,
      projectFingerprint: 'NOT-HEX',
    }),
  }), /project identity/i);
});

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('normalizes every public wiring state and rejects unknown states', () => {
  assert.deepEqual(CARD_WIRING_STATES, [
    'known-good',
    'staged',
    'testing',
    'rolled-back',
    'safe-mode',
  ]);
  const normalized = normalizeCardWiringStatus({
      ok: true,
      state: 'awaiting-confirmation',
      activationId: 'card-7',
      currentOutputs: [{ pin: 18, pixels: 44 }],
      probationRemainingMs: 81234,
      nextStep: 'confirm',
    });
  assert.deepEqual(
    { ...normalized, raw: undefined },
    {
      ok: true,
      state: 'testing',
      activationId: 'card-7',
      outputs: [{ pin: 18, pixels: 44 }],
      remainingMs: 81234,
      nextStep: 'confirm',
      raw: undefined,
    },
  );
  assert.equal(normalized.raw.state, 'awaiting-confirmation');
  assert.throws(
    () => normalizeCardWiringStatus({ ok: true, state: 'mystery' }),
    error => error instanceof CardWiringSafetyError && error.reason === 'invalid-response',
  );
});

test('direct transport uses the wiring endpoints and card-issued activation id', async () => {
  const requests = [];
  const replies = [
    { ok: true, state: 'known-good', outputs: [{ pin: 16, pixels: 44 }] },
    { ok: true, state: 'staged', activationId: 'activation-card-1', outputs: [{ pin: 18, pixels: 44 }] },
    { ok: true, state: 'testing', activationId: 'activation-card-1', remainingMs: 90000 },
    { ok: true, state: 'known-good', activationId: 'activation-card-1' },
    { ok: true, state: 'rolled-back', activationId: 'activation-card-1' },
    { ok: true, batch: 2, assignments: [{ pin: 16, color: '#ff0000', label: 'Red' }] },
  ];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return jsonResponse(replies.shift());
  };
  const common = { host: '192.168.18.70', transport: 'direct', fetchImpl };

  await getCardWiringStatus(common);
  const staged = await stageCardWiringCandidate({ led: { outputs: [{ pin: 18, pixels: 44 }] } }, common);
  assert.equal(staged.activationId, 'activation-card-1');
  await activateCardWiringCandidate(staged.activationId, common);
  await confirmCardWiringCandidate(staged.activationId, common);
  await rollbackCardWiringCandidate(staged.activationId, common);
  const discovery = await discoverCardWiring({ pins: [16, 17], batch: 2 }, common);

  assert.deepEqual(requests.map(request => [request.options.method || 'GET', request.url]), [
    ['GET', 'http://192.168.18.70/api/wiring/status'],
    ['POST', 'http://192.168.18.70/api/wiring/candidate'],
    ['POST', 'http://192.168.18.70/api/wiring/activate'],
    ['POST', 'http://192.168.18.70/api/wiring/confirm'],
    ['POST', 'http://192.168.18.70/api/wiring/rollback'],
    ['POST', 'http://192.168.18.70/api/wiring/discover'],
  ]);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    candidate: { led: { outputs: [{ pin: 18, pixels: 44 }] } },
  });
  for (const index of [2, 3, 4]) {
    assert.deepEqual(JSON.parse(requests[index].options.body), { activationId: 'activation-card-1' });
  }
  assert.deepEqual(JSON.parse(requests[5].options.body), { pins: [16, 17], batch: 2 });
  assert.deepEqual(discovery.assignments, [{ pin: 16, color: '#ff0000', label: 'Red' }]);
  assert.equal(discovery.batch, 2);
});

test('direct wiring mutations verify expected identity before every POST', async () => {
  const values = new Map([['lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-expected' })]]);
  globalThis.window = {
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    },
  };
  try {
    for (const reportedIdentity of [{ cardId: 'lw-wrong' }, {}]) {
      const requests = [];
      const options = {
        host: '192.168.18.70',
        transport: 'direct',
        fetchImpl: async (url, request = {}) => {
          requests.push({ url, request });
          return jsonResponse(reportedIdentity);
        },
      };
      for (const operation of [
        () => stageCardWiringCandidate({ led: { outputs: [] } }, options),
        () => activateCardWiringCandidate('activation-1', options),
        () => confirmCardWiringCandidate('activation-1', options),
        () => rollbackCardWiringCandidate('activation-1', options),
        () => discoverCardWiring({ batch: 1 }, options),
        () => discoverCardWiring({ stop: true }, options),
      ]) {
        await assert.rejects(operation(), error => ['wrong-card', 'identity-missing'].includes(error?.reason));
      }
      assert.equal(requests.some(({ request }) => request.method === 'POST'), false, 'identity failure sends zero wiring POSTs');
    }
  } finally {
    delete globalThis.window;
  }
});

test('bridge transport uses the matching message types and retry policy', async () => {
  const calls = [];
  const bridgeRequestImpl = async (type, payload, options) => {
    calls.push({ type, payload, options });
    if (type === 'wiring-discover') {
      return { ok: true, assignments: [{ pin: 21, color: 'blue', label: 'Blue' }] };
    }
    return {
      ok: true,
      state: type === 'wiring-status' ? 'known-good' : 'staged',
      activationId: type === 'wiring-candidate' ? 'bridge-card-2' : undefined,
    };
  };
  const common = {
    host: 'lightweaver.local',
    transport: 'bridge',
    bridgeRequestImpl,
    timeoutMs: 1234,
  };

  await getCardWiringStatus(common);
  const staged = await stageCardWiringCandidate({ led: { outputs: [] } }, common);
  await discoverCardWiring({ batch: 0 }, common);

  assert.equal(staged.activationId, 'bridge-card-2');
  assert.deepEqual(calls.map(call => call.type), [
    'wiring-status',
    'wiring-candidate',
    'wiring-discover',
  ]);
  assert.equal(calls[0].options.retryOnTimeout, true);
  assert.equal(calls[1].options.retryOnTimeout, false);
  assert.equal(calls[2].options.retryOnTimeout, false);
  assert.deepEqual(calls[1].payload, { candidate: { led: { outputs: [] } } });
});

test('mutating transaction calls require the card-issued activation id', async () => {
  for (const operation of [
    activateCardWiringCandidate,
    confirmCardWiringCandidate,
    rollbackCardWiringCandidate,
  ]) {
    await assert.rejects(
      operation('', { transport: 'direct', fetchImpl: async () => assert.fail('must not fetch') }),
      error => error instanceof CardWiringSafetyError && error.reason === 'activation-required',
    );
  }
});

test('transaction replies must echo the matching card-issued activation id', async () => {
  await assert.rejects(
    confirmCardWiringCandidate('current-activation', {
      transport: 'direct',
      fetchImpl: async () => jsonResponse({ ok: true, state: 'known-good' }),
    }),
    error => error instanceof CardWiringSafetyError && error.reason === 'activation-mismatch',
  );
});

test('direct and bridge failures are normalized', async () => {
  await assert.rejects(
    getCardWiringStatus({
      transport: 'direct',
      fetchImpl: async () => jsonResponse({ ok: false, error: 'unsafe pin' }, { ok: false, status: 422 }),
    }),
    error => error instanceof CardWiringSafetyError && error.reason === 'http' && error.status === 422,
  );
  await assert.rejects(
    getCardWiringStatus({
      transport: 'bridge',
      bridgeRequestImpl: async () => {
        const error = new Error('bridge down');
        error.reason = 'bridge-timeout';
        throw error;
      },
    }),
    error => error instanceof CardWiringSafetyError && error.reason === 'bridge-timeout',
  );
});

test('reconnect polling ignores outages and stale activation replies', async () => {
  const replies = [
    new TypeError('card rebooting'),
    { ok: true, state: 'testing', activationId: 'old-activation', remainingMs: 85000 },
    { ok: true, state: 'testing', activationId: 'current-activation', remainingMs: 82000 },
  ];
  let now = 0;
  const result = await waitForCardWiringReconnect({
    activationId: 'current-activation',
    timeoutMs: 1000,
    pollIntervalMs: 10,
    nowImpl: () => now,
    waitImpl: async milliseconds => { now += milliseconds; },
    statusImpl: async () => {
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return normalizeCardWiringStatus(next);
    },
  });

  assert.equal(result.state, 'testing');
  assert.equal(result.activationId, 'current-activation');
  assert.equal(replies.length, 0);
});

test('reconnect polling reports a typed timeout with the last failure', async () => {
  let now = 0;
  await assert.rejects(
    waitForCardWiringReconnect({
      activationId: 'never-returned',
      timeoutMs: 20,
      pollIntervalMs: 10,
      nowImpl: () => now,
      waitImpl: async milliseconds => { now += milliseconds; },
      statusImpl: async () => { throw new TypeError('offline'); },
    }),
    error => error instanceof CardWiringSafetyError &&
      error.reason === 'reconnect-timeout' &&
      error.cause?.message === 'offline',
  );
});

test('ambiguous activation transport failure still polls the card-owned transaction', async () => {
  const calls = [];
  const status = await activateAndWaitForCardWiring('current-activation', {
    activateImpl: async () => {
      calls.push('activate');
      throw new CardWiringSafetyError('network', 'connection closed during reboot');
    },
    waitForReconnectImpl: async options => {
      calls.push(['poll', options.activationId]);
      return normalizeCardWiringStatus({
        ok: true,
        state: 'testing',
        activationId: 'current-activation',
        remainingProbationMs: 84000,
      });
    },
  });

  assert.deepEqual(calls, ['activate', ['poll', 'current-activation']]);
  assert.equal(status.state, 'testing');
  assert.equal(status.remainingMs, 84000);
});

test('activation reports the transport error only after reconnect polling also fails', async () => {
  const activationError = new CardWiringSafetyError('network', 'connection closed during reboot');
  await assert.rejects(
    activateAndWaitForCardWiring('current-activation', {
      activateImpl: async () => { throw activationError; },
      waitForReconnectImpl: async () => {
        throw new CardWiringSafetyError('reconnect-timeout', 'card did not return');
      },
    }),
    error => error?.reason === 'reconnect-timeout' && error?.cause === activationError,
  );
});
