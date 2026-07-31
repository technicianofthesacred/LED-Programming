import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LiveCardVerificationError,
  runLiveCardPatternVerification,
} from './live-card-pattern-verify.mjs';

const CARD_ID = 'lw-001122aabbcc';
const OUTPUTS = [{ id: 'out1', pin: 18, pixels: 44 }];

function status(patternId = 'aurora', overrides = {}) {
  return {
    app: 'Lightweaver',
    cardId: CARD_ID,
    firmwareVersion: '1.0.0',
    buildId: 'test-build',
    bootId: 'boot-test',
    runtimePhase: 'ready',
    commandReady: true,
    outputReady: true,
    configValid: true,
    knownGoodProject: true,
    wiringRevision: 7,
    wiringDigest: 'a'.repeat(64),
    led: { type: 'WS2815', pixels: 44, colorOrder: 'GRB', maxMilliamps: 1500 },
    outputs: OUTPUTS,
    wifi: {
      transport: 'station', hostname: 'lightweaver', ip: '192.168.18.70', configured: true,
      phase: 'station', transitionPending: false,
    },
    currentLookId: patternId,
    currentPatternId: patternId,
    streaming: false,
    frameSource: 'internal',
    ...overrides,
  };
}

function firmwareInfo(overrides = {}) {
  return {
    ...status('aurora'),
    pixels: 44,
    ledType: 'WS2815',
    ...overrides,
  };
}

function jsonResponse(body, { status: responseStatus = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status: responseStatus,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeCardFetch({
  ack = null,
  finalStatus = status('fire'),
  finalPatterns = { currentId: 'fire', patterns: [{ id: 'fire' }, { id: 'plasma' }] },
  finalZones = { syncZones: true, zones: [{ id: 'all', patternId: 'fire' }] },
} = {}) {
  const calls = [];
  let controlCount = 0;
  let statusReads = 0;
  let patternReads = 0;
  let zoneReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    calls.push({ method, path: parsed.pathname, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'POST' && parsed.pathname === '/api/control') {
      controlCount += 1;
      const request = JSON.parse(options.body || '{}');
      const response = ack?.(request, controlCount) ?? {
        ok: true,
        cardId: CARD_ID,
        patternId: request.patternId,
        appliedPatternId: request.patternId,
        revision: request.revision,
        confirmedRevision: request.revision,
        stateRevision: 100 + controlCount,
        affectedOutputCount: 1,
        affectedOutputs: ['out1'],
      };
      return jsonResponse(response);
    }
    if (method !== 'GET') return jsonResponse({ error: 'unexpected mutation' }, { status: 405 });
    if (parsed.pathname === '/api/firmware-info') return jsonResponse(firmwareInfo());
    if (parsed.pathname === '/api/status') {
      statusReads += 1;
      return jsonResponse(statusReads === 1 ? status('aurora') : finalStatus);
    }
    if (parsed.pathname === '/api/patterns') {
      patternReads += 1;
      return jsonResponse(patternReads === 1
        ? { currentId: 'aurora', patterns: [{ id: 'fire' }, { id: 'plasma' }] }
        : finalPatterns);
    }
    if (parsed.pathname === '/api/zones') {
      zoneReads += 1;
      return jsonResponse(zoneReads === 1
        ? { syncZones: true, zones: [{ id: 'all', patternId: 'aurora' }] }
        : finalZones);
    }
    return jsonResponse({ error: 'not found' }, { status: 404 });
  };
  return { fetchImpl, calls };
}

test('verifies exact acknowledgements, final runtime truth, and unchanged hardware invariants', async () => {
  const card = makeCardFetch();
  const report = await runLiveCardPatternVerification({
    fetchImpl: card.fetchImpl,
    revisionBase: 40,
    sleep: async () => {},
  });

  assert.equal(report.ok, true);
  assert.equal(report.cardId, CARD_ID);
  assert.deepEqual(report.patternSequence, ['fire', 'plasma', 'fire']);
  assert.deepEqual(report.acknowledgements.map(item => item.revision), [41, 42, 43]);
  assert.equal(report.final.truth.status, 'fire');
  assert.equal(report.final.truth.patterns, 'fire');
  assert.deepEqual(report.final.truth.zones, ['fire']);
  assert.deepEqual(report.baseline.invariants, report.final.invariants);
  assert.equal(report.physicalVisibilityVerified, false);
  assert.deepEqual(
    card.calls.filter(call => call.method === 'POST').map(call => call.path),
    ['/api/control', '/api/control', '/api/control'],
  );
  for (const call of card.calls.filter(item => item.method === 'POST')) {
    assert.deepEqual(Object.keys(call.body).sort(), ['cancelStream', 'patternId', 'revision', 'syncZones']);
  }
});

test('fails a mismatched control acknowledgement and never calls another mutation endpoint', async () => {
  const card = makeCardFetch({
    ack(request) {
      return {
        ok: true, cardId: CARD_ID, patternId: request.patternId === 'fire' ? 'plasma' : request.patternId,
        revision: request.revision, confirmedRevision: request.revision, stateRevision: 101,
        affectedOutputCount: 1, affectedOutputs: ['out1'],
      };
    },
  });

  await assert.rejects(
    runLiveCardPatternVerification({ fetchImpl: card.fetchImpl, revisionBase: 10, sleep: async () => {} }),
    error => error instanceof LiveCardVerificationError
      && error.report.failures.some(failure => failure.code === 'ack-pattern-mismatch'),
  );
  assert.deepEqual(card.calls.filter(call => call.method === 'POST').map(call => call.path), ['/api/control']);
});

test('fails when a control changes a captured wiring, LED, identity, or WiFi invariant', async () => {
  const card = makeCardFetch({
    finalStatus: status('fire', { outputs: [{ id: 'out1', pin: 16, pixels: 44 }] }),
  });

  await assert.rejects(
    runLiveCardPatternVerification({ fetchImpl: card.fetchImpl, revisionBase: 20, sleep: async () => {} }),
    error => error instanceof LiveCardVerificationError
      && error.report.failures.some(failure => failure.code === 'invariant-drift'),
  );
});

test('reports stale status and patterns truth separately from correct final zones', async () => {
  const card = makeCardFetch({
    finalStatus: status('aurora'),
    finalPatterns: { currentId: 'aurora', patterns: [{ id: 'fire' }, { id: 'plasma' }] },
  });

  await assert.rejects(
    runLiveCardPatternVerification({ fetchImpl: card.fetchImpl, revisionBase: 30, sleep: async () => {} }),
    error => {
      assert.ok(error instanceof LiveCardVerificationError);
      assert.deepEqual(error.report.final.truth.zones, ['fire']);
      assert.deepEqual(
        error.report.failures.filter(failure => failure.code === 'state-truth-mismatch').map(failure => failure.source),
        ['status', 'patterns'],
      );
      return true;
    },
  );
});

test('the request timeout includes reading the response body', async () => {
  const card = makeCardFetch();
  let first = true;
  const fetchImpl = async (...args) => {
    const response = await card.fetchImpl(...args);
    if (!first) return response;
    first = false;
    const text = await response.text();
    return {
      ok: true,
      status: 200,
      async text() {
        await new Promise(resolve => setTimeout(resolve, 140));
        return text;
      },
    };
  };
  const startedAt = Date.now();
  await assert.rejects(
    runLiveCardPatternVerification({ fetchImpl, timeoutMs: 100, revisionBase: 50, sleep: async () => {} }),
    error => error instanceof LiveCardVerificationError
      && error.report.failures.some(failure => /timed out/.test(failure.message)),
  );
  assert.ok(Date.now() - startedAt < 130, 'body timeout should settle near the configured deadline');
});
