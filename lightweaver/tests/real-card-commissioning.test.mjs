import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { runRealCardCommissioning } from '../scripts/real-card-commissioning.mjs';

const CARD_ID = 'lw-b0fe81f61b44';
const BUILD_ID = 'a'.repeat(40);
const EXPECTED_CARD = {
  expectedOutputPin: 18,
  expectedPixels: 41,
  expectedChipset: 'WS2815',
  expectedColorOrder: 'RGB',
  expectedProjectId: 'bench-fixture',
  expectedProjectFingerprint: '0123456789abcdef',
};
const FIRMWARE_UPDATE_STATE = {
  phase: 'idle', receivedBytes: 0, expectedBytes: 0, expectedBuildId: '',
  activeSlot: 'app0', pendingSlot: '', lastError: '', rollbackReason: '',
  rebootCorrelation: '', restoredFirmwareVersion: '', restoredBuildId: '',
  restoredBuildNumber: 0,
};

async function cardServer({ status = {}, firmware = {}, wiring = {}, patterns = {}, zones = {}, update = {} } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/firmware-info') {
      response.end(JSON.stringify({
        app: 'Lightweaver', cardId: CARD_ID, firmwareVersion: '1.1.8',
        buildId: BUILD_ID, buildNumber: 1088, bootId: 'boot-real-card-test', ...firmware,
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
        projectFingerprint: '0123456789abcdef', maxMilliamps: 1500,
        firmwareUpdate: { ...FIRMWARE_UPDATE_STATE },
        led: { pixels: 41, type: 'WS2815', colorOrder: 'RGB', maxMilliamps: 1500 },
        outputs: [{ id: 'main', pin: 18, pixels: 41, gpio: 18, count: 41 }],
        ...status,
      }));
      return;
    }
    if (request.url === '/api/wiring/status') {
      response.end(JSON.stringify({
        ok: true, cardId: CARD_ID, buildId: BUILD_ID, state: 'known-good',
        hasKnownGood: true, outputsReady: true, testing: false, hasCandidate: false,
        candidateState: 'none', bootedCandidate: false, discoveryActive: false,
        remainingProbationMs: 0, colorOrder: 'RGB',
        currentOutputs: [{ id: 'main', pin: 18, pixels: 41 }], ...wiring,
      }));
      return;
    }
    if (request.url === '/api/patterns') {
      response.end(JSON.stringify({
        currentId: 'aurora', patterns: [
          { id: 'aurora', label: 'Aurora' },
          { id: 'fire', label: 'Fire' },
          { id: 'ocean', label: 'Ocean' },
        ], ...patterns,
      }));
      return;
    }
    if (request.url === '/api/zones') {
      response.end(JSON.stringify({
        zones: [{
          id: 'all', patternId: 'aurora', hueShift: 0, customHue: 32,
          customSaturation: 230, blackout: false, ranges: [{ start: 0, count: 41 }],
        }], ...zones,
      }));
      return;
    }
    if (request.url === '/api/update/status') {
      response.end(JSON.stringify({
        ok: true, ...FIRMWARE_UPDATE_STATE, ...update,
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
    ...EXPECTED_CARD,
  });

  assert.deepEqual(card.requests, [
    { method: 'GET', url: '/api/firmware-info' },
    { method: 'GET', url: '/api/status' },
    { method: 'GET', url: '/api/wiring/status' },
    { method: 'GET', url: '/api/patterns' },
    { method: 'GET', url: '/api/zones' },
    { method: 'GET', url: '/api/update/status' },
  ]);
  assert.equal(result.mode, 'safe-read-only');
  assert.equal(result.verified, true);
  assert.equal(result.identity.cardId, CARD_ID);
  assert.equal(result.identity.buildId, BUILD_ID);
  assert.equal(result.status.bootId, 'boot-real-card-test');
  assert.equal(result.status.led.pixels, 41);
  assert.deepEqual(result.hardware, {
    outputPin: 18,
    pixels: 41,
    chipset: 'WS2815',
    colorOrder: 'RGB',
  });
  assert.equal(result.wiring.state, 'known-good');
  assert.deepEqual(result.patterns.map(pattern => pattern.label), ['Aurora', 'Fire', 'Ocean']);
  assert.equal(result.zones[0].ranges.reduce((sum, range) => sum + range.count, 0), 41);
  assert.equal(result.update.phase, 'idle');
});

test('safe mode rejects identity mismatch after read-only requests', async t => {
  const card = await cardServer({ status: { cardId: 'lw-wrong-card' } });
  t.after(card.close);

  await assert.rejects(
    runRealCardCommissioning({
      cardHost: card.host,
      expectedCardId: CARD_ID,
      expectedBuildId: BUILD_ID,
      ...EXPECTED_CARD,
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
      led: { pixels: 41, type: 'WS2815', colorOrder: 'RGB', maxMilliamps: 100 },
      limits: { pixels: 65535, outputs: 4, configStorageBytes: 3968 },
      wifi: { transport: 'station', ip: '192.168.18.70', configured: true },
      outputs: [{ id: 'main', pin: 18, pixels: 41, gpio: 18, count: 41 }],
    },
  });
  t.after(card.close);

  const result = await runRealCardCommissioning({
    cardHost: card.host,
    expectedCardId: CARD_ID,
    expectedBuildId: BUILD_ID,
    ...EXPECTED_CARD,
  });

  assert.deepEqual(result.status.led, {
    pixels: 41, type: 'WS2815', colorOrder: 'RGB', maxMilliamps: 100,
  });
  assert.deepEqual(result.status.limits, { pixels: 65535, outputs: 4, configStorageBytes: 3968 });
  assert.deepEqual(result.status.wifi, { transport: 'station', ip: '192.168.18.70', configured: true });
  assert.deepEqual(result.status.outputs, [
    { id: 'main', pin: 18, pixels: 41, gpio: 18, count: 41 },
  ]);
});

test('safe mode rejects build mismatch between expected identity and card', async t => {
  const card = await cardServer({ firmware: { buildId: 'b'.repeat(40) } });
  t.after(card.close);

  await assert.rejects(
    runRealCardCommissioning({
      cardHost: card.host,
      expectedCardId: CARD_ID,
      expectedBuildId: BUILD_ID,
      ...EXPECTED_CARD,
    }),
    /firmware build ID.*expected/i,
  );
  assert.ok(card.requests.every(request => request.method === 'GET'));
});

test('firmware acceptance requires matching versions and build numbers from both identity endpoints', async () => {
  const scenarios = [
    [{ firmware: { firmwareVersion: undefined } }, /firmware-info.*firmwareVersion.*required/i],
    [{ status: { firmwareVersion: undefined } }, /status.*firmwareVersion.*required/i],
    [{ firmware: { buildNumber: undefined } }, /firmware-info.*buildNumber.*required/i],
    [{ status: { buildNumber: undefined } }, /status.*buildNumber.*required/i],
    [{ status: { firmwareVersion: '1.1.9' } }, /firmware version.*did not match/i],
    [{ status: { buildNumber: 1089 } }, /build number.*did not match/i],
  ];

  for (const [overrides, message] of scenarios) {
    const card = await cardServer(overrides);
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
      assert.deepEqual(card.requests, [
        { method: 'GET', url: '/api/firmware-info' },
        { method: 'GET', url: '/api/status' },
      ]);
    } finally {
      await card.close();
    }
  }
});

test('firmware acceptance requires one exact boot identity from firmware-info and status', async () => {
  const scenarios = [
    [{ firmware: { bootId: undefined } }, /firmware-info.*bootId.*required/i],
    [{ status: { bootId: undefined } }, /status.*bootId.*required/i],
    [{ status: { bootId: 'boot-different' } }, /boot ID.*did not match/i],
  ];

  for (const [overrides, message] of scenarios) {
    const card = await cardServer(overrides);
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
      assert.deepEqual(card.requests, [
        { method: 'GET', url: '/api/firmware-info' },
        { method: 'GET', url: '/api/status' },
      ]);
    } finally {
      await card.close();
    }
  }
});

test('safe mode rejects a project ID mismatch before auxiliary acceptance reads', async t => {
  const card = await cardServer({ status: { projectId: 'different-project' } });
  t.after(card.close);

  await assert.rejects(
    runRealCardCommissioning({
      cardHost: card.host,
      expectedCardId: CARD_ID,
      expectedBuildId: BUILD_ID,
      ...EXPECTED_CARD,
    }),
    /status project ID.*expected bench-fixture/i,
  );
  assert.deepEqual(card.requests, [
    { method: 'GET', url: '/api/firmware-info' },
    { method: 'GET', url: '/api/status' },
  ]);
});

test('safe mode rejects a project fingerprint mismatch before verified acceptance', async t => {
  const card = await cardServer({ status: { projectFingerprint: 'f'.repeat(16) } });
  t.after(card.close);

  await assert.rejects(
    runRealCardCommissioning({
      cardHost: card.host,
      expectedCardId: CARD_ID,
      expectedBuildId: BUILD_ID,
      ...EXPECTED_CARD,
    }),
    /status project fingerprint.*expected 0123456789abcdef/i,
  );
  assert.ok(card.requests.every(request => request.method === 'GET'));
});

test('runtime acceptance requires ready known-good command, playback, and output status', async () => {
  const scenarios = [
    [{ ok: false }, /status did not report ok=true/i],
    [{ runtimePhase: 'loading' }, /runtime phase.*ready/i],
    [{ knownGoodProject: false }, /known-good project/i],
    [{ commandReady: false }, /command ready/i],
    [{ playbackReady: false }, /playback ready/i],
    [{ outputReady: false }, /output ready/i],
  ];

  for (const [status, message] of scenarios) {
    const card = await cardServer({ status });
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
      assert.ok(card.requests.every(request => request.method === 'GET'));
    } finally {
      await card.close();
    }
  }
});

test('safe mode rejects an identity mismatch reported by an auxiliary read-back endpoint', async t => {
  const card = await cardServer({ wiring: { buildId: 'b'.repeat(40) } });
  t.after(card.close);

  await assert.rejects(
    runRealCardCommissioning({
      cardHost: card.host,
      expectedCardId: CARD_ID,
      expectedBuildId: BUILD_ID,
      ...EXPECTED_CARD,
    }),
    /wiring status build ID.*expected/i,
  );
  assert.ok(card.requests.every(request => request.method === 'GET'));
});

test('wiring status rejects a reported card ID mismatch', async t => {
  const card = await cardServer({ wiring: { cardId: 'lw-wrong-card' } });
  t.after(card.close);

  await assert.rejects(
    runRealCardCommissioning({
      cardHost: card.host,
      expectedCardId: CARD_ID,
      expectedBuildId: BUILD_ID,
      ...EXPECTED_CARD,
    }),
    /wiring status card ID.*expected/i,
  );
  assert.ok(card.requests.every(request => request.method === 'GET'));
});

test('runtime acceptance rejects staged or testing wiring and every outstanding candidate', async () => {
  const scenarios = [
    [{ state: 'staged', hasCandidate: true }, /wiring status was not known-good/i],
    [{ state: 'testing', hasCandidate: true }, /wiring status was not known-good/i],
    [{ state: 'known-good', hasCandidate: true }, /wiring candidate is still present/i],
    [{ state: 'known-good', hasCandidate: false, testing: true }, /wiring test is still active/i],
  ];

  for (const [wiring, message] of scenarios) {
    const card = await cardServer({ wiring });
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
      assert.ok(card.requests.every(request => request.method === 'GET'));
    } finally {
      await card.close();
    }
  }
});

test('wiring acceptance requires explicit safety proofs and exact current outputs', async () => {
  const scenarios = [
    [{ ok: undefined }, /wiring status did not report ok=true/i],
    [{ hasKnownGood: undefined }, /wiring status did not report hasKnownGood=true/i],
    [{ outputsReady: false }, /wiring status did not report outputsReady=true/i],
    [{ testing: undefined }, /wiring status did not report testing=false/i],
    [{ hasCandidate: undefined }, /wiring status did not report hasCandidate=false/i],
    [{ currentOutputs: undefined }, /wiring current outputs.*exactly GPIO 18 with 41 pixels/i],
    [{ currentOutputs: [] }, /wiring current outputs.*exactly GPIO 18 with 41 pixels/i],
    [{ currentOutputs: [{ id: 'main', pin: 19, pixels: 41 }] }, /wiring current outputs.*exactly GPIO 18 with 41 pixels/i],
    [{ currentOutputs: [{ id: 'main', pin: 18, pixels: 40 }] }, /wiring current outputs.*exactly GPIO 18 with 41 pixels/i],
    [{ currentOutputs: [{ id: 'main', pin: 18, pixels: 41 }, { id: 'extra', pin: 19, pixels: 1 }] }, /wiring current outputs.*exactly GPIO 18 with 41 pixels/i],
  ];

  for (const [wiring, message] of scenarios) {
    const card = await cardServer({ wiring });
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
      assert.ok(card.requests.every(request => request.method === 'GET'));
    } finally {
      await card.close();
    }
  }
});

test('wiring acceptance rejects contradictory candidate, discovery, probation, and color evidence', async () => {
  const scenarios = [
    [{ candidateState: 'staged' }, /candidateState=none/i],
    [{ activationId: 'candidate-stale' }, /stale candidate evidence/i],
    [{ candidateOutputs: [{ id: 'candidate', pin: 19, pixels: 41 }] }, /stale candidate evidence/i],
    [{ bootedCandidate: true }, /bootedCandidate=false/i],
    [{ discoveryActive: true }, /discoveryActive=false/i],
    [{ discovery: { active: true, pin: 19 } }, /stale discovery evidence/i],
    [{ remainingProbationMs: 1 }, /remainingProbationMs=0/i],
    [{ colorOrder: 'GRB' }, /wiring color order.*RGB/i],
  ];

  for (const [wiring, message] of scenarios) {
    const card = await cardServer({ wiring });
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
    } finally {
      await card.close();
    }
  }
});

test('patterns, zones, and update status reject every reported card and build mismatch', async () => {
  const scenarios = [
    ['patterns', { cardId: 'lw-wrong-card' }, /patterns card ID.*expected/i],
    ['patterns', { buildId: 'b'.repeat(40) }, /patterns build ID.*expected/i],
    ['zones', { cardId: 'lw-wrong-card' }, /zones card ID.*expected/i],
    ['zones', { buildId: 'b'.repeat(40) }, /zones build ID.*expected/i],
    ['update', { cardId: 'lw-wrong-card' }, /update status card ID.*expected/i],
    ['update', { buildId: 'b'.repeat(40) }, /update status build ID.*expected/i],
  ];

  for (const [endpoint, mismatch, message] of scenarios) {
    const card = await cardServer({ [endpoint]: mismatch });
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
      assert.ok(card.requests.every(request => request.method === 'GET'));
    } finally {
      await card.close();
    }
  }
});

test('update endpoint must exactly correlate with status firmwareUpdate evidence', async () => {
  const scenarios = [
    [{ status: { firmwareUpdate: undefined } }, /status firmwareUpdate.*required/i],
    ...Object.keys(FIRMWARE_UPDATE_STATE).map(field => [{
      update: {
        [field]: typeof FIRMWARE_UPDATE_STATE[field] === 'number'
          ? FIRMWARE_UPDATE_STATE[field] + 1 : `${FIRMWARE_UPDATE_STATE[field]}changed`,
      },
    }, new RegExp(`update status.*${field}.*did not match`, 'i')]),
  ];

  for (const [overrides, message] of scenarios) {
    const card = await cardServer(overrides);
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
    } finally {
      await card.close();
    }
  }
});

test('runtime acceptance requires installed patterns, configured zones, and an idle healthy updater', async () => {
  const scenarios = [
    [{ patterns: { patterns: [] } }, /patterns.*at least one/i],
    [{ zones: { zones: [] } }, /zones.*at least one/i],
    [{
      update: { ok: false, phase: 'failed' },
      status: { firmwareUpdate: { ...FIRMWARE_UPDATE_STATE, phase: 'failed' } },
    }, /updater.*healthy/i],
    [{
      update: { ok: true, phase: 'receiving' },
      status: { firmwareUpdate: { ...FIRMWARE_UPDATE_STATE, phase: 'receiving' } },
    }, /updater phase.*idle/i],
  ];

  for (const [overrides, message] of scenarios) {
    const card = await cardServer(overrides);
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
      assert.ok(card.requests.every(request => request.method === 'GET'));
    } finally {
      await card.close();
    }
  }
});

test('look acceptance requires exact Aurora, Fire, Ocean installation with Aurora active', async () => {
  const expectedPatterns = [
    { id: 'aurora', label: 'Aurora' },
    { id: 'fire', label: 'Fire' },
    { id: 'ocean', label: 'Ocean' },
  ];
  const scenarios = [
    [{ currentId: 'fire' }, /current pattern.*aurora/i],
    [{ patterns: expectedPatterns.slice(0, 2) }, /installed patterns.*Aurora.*Fire.*Ocean/i],
    [{ patterns: [expectedPatterns[1], expectedPatterns[0], expectedPatterns[2]] }, /installed patterns.*Aurora.*Fire.*Ocean/i],
    [{ patterns: [{ id: 'aurora', label: 'Northern Lights' }, ...expectedPatterns.slice(1)] }, /installed patterns.*Aurora.*Fire.*Ocean/i],
  ];

  for (const [patterns, message] of scenarios) {
    const card = await cardServer({ patterns });
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
    } finally {
      await card.close();
    }
  }
});

test('zone acceptance requires the restored Aurora color state', async () => {
  const baseZone = {
    id: 'all', patternId: 'aurora', hueShift: 0, customHue: 32,
    customSaturation: 230, blackout: false, ranges: [{ start: 0, count: 41 }],
  };
  const scenarios = [
    [[{ ...baseZone, patternId: 'fire' }], /zone pattern.*aurora/i],
    [[{ ...baseZone, hueShift: 1 }], /zone color.*restored/i],
    [[{ ...baseZone, customHue: 33 }], /zone color.*restored/i],
    [[{ ...baseZone, customSaturation: 229 }], /zone color.*restored/i],
    [[{ ...baseZone, blackout: true }], /zone color.*restored/i],
    [[{ ...baseZone, ranges: [{ start: 0, count: 20 }] }, { ...baseZone, id: 'second', ranges: [{ start: 20, count: 21 }] }], /exactly one zone/i],
  ];

  for (const [zoneList, message] of scenarios) {
    const card = await cardServer({ zones: { zones: zoneList } });
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
    } finally {
      await card.close();
    }
  }
});

test('zone acceptance requires valid ranges that cover every expected pixel exactly once', async () => {
  const scenarios = [
    [{ zones: [{ id: 'all', ranges: [{ start: 0, count: 40 }] }] }, /zone ranges.*exactly 41/i],
    [{ zones: [{ id: 'all', ranges: [{ start: 0, count: 42 }] }] }, /zone ranges.*exactly 41/i],
    [{ zones: [{ id: 'all', ranges: [{ start: 0, count: 21 }, { start: 20, count: 21 }] }] }, /zone ranges.*exactly 41/i],
    [{ zones: [{ id: 'all', ranges: [{ start: 0, count: 20 }, { start: 21, count: 20 }] }] }, /zone ranges.*exactly 41/i],
  ];

  for (const [zones, message] of scenarios) {
    const card = await cardServer({ zones });
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
      assert.ok(card.requests.every(request => request.method === 'GET'));
    } finally {
      await card.close();
    }
  }
});

test('expected commissioning inputs are validated before the first network request', async () => {
  let networkRequests = 0;
  const fetchImpl = async () => {
    networkRequests += 1;
    throw new Error('network should not be reached');
  };
  const base = {
    cardHost: '192.0.2.1',
    expectedCardId: CARD_ID,
    expectedBuildId: BUILD_ID,
    ...EXPECTED_CARD,
    fetchImpl,
  };

  for (const [field, value, message] of [
    ['expectedOutputPin', '', /EXPECTED_OUTPUT_PIN.*required/i],
    ['expectedPixels', '41.5', /EXPECTED_PIXELS.*integer/i],
    ['expectedChipset', 'WS 2815', /EXPECTED_CHIPSET.*valid/i],
    ['expectedColorOrder', 'RRR', /EXPECTED_COLOR_ORDER.*supported/i],
    ['expectedProjectId', '', /EXPECTED_PROJECT_ID.*required/i],
    ['expectedProjectFingerprint', 'ABCDEF0123456789', /EXPECTED_PROJECT_FINGERPRINT.*lowercase hex/i],
  ]) {
    await assert.rejects(runRealCardCommissioning({ ...base, [field]: value }), message);
  }
  assert.equal(networkRequests, 0);
});

test('safe mode rejects changed hardware read-back without requesting later endpoints', async t => {
  const card = await cardServer({ status: { outputs: [{ pin: 19, pixels: 41 }] } });
  t.after(card.close);

  await assert.rejects(
    runRealCardCommissioning({
      cardHost: card.host,
      expectedCardId: CARD_ID,
      expectedBuildId: BUILD_ID,
      ...EXPECTED_CARD,
    }),
    /hardware read-back changed.*"outputPin":19/i,
  );
  assert.deepEqual(card.requests, [
    { method: 'GET', url: '/api/firmware-info' },
    { method: 'GET', url: '/api/status' },
  ]);
});

test('hardware acceptance requires the exact output set and aggregate pixel agreement', async () => {
  const exactOutput = { id: 'main', pin: 18, pixels: 41, gpio: 18, count: 41 };
  const scenarios = [
    [{ outputs: [] }, /exactly one configured output/i],
    [{ outputs: [exactOutput, { id: 'extra', pin: 19, pixels: 1 }] }, /exactly one configured output/i],
    [{ led: { pixels: 40, type: 'WS2815', colorOrder: 'RGB' } }, /aggregate pixel read-back changed/i],
    [{ pixels: 40 }, /aggregate pixel read-back changed/i],
  ];

  for (const [status, message] of scenarios) {
    const card = await cardServer({ status });
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
      assert.deepEqual(card.requests, [
        { method: 'GET', url: '/api/firmware-info' },
        { method: 'GET', url: '/api/status' },
      ]);
    } finally {
      await card.close();
    }
  }
});

test('hardware acceptance rejects contradictory output aliases', async () => {
  const scenarios = [
    [{ id: 'main', pin: 18, gpio: 19, pixels: 41, count: 41 }, /output pin aliases.*disagree/i],
    [{ id: 'main', pin: 18, gpio: 18, pixels: 41, count: 40 }, /output pixel aliases.*disagree/i],
    [{ id: 'main', pin: 18, gpio: 18, pixels: 41, pixelCount: 40, count: 41 }, /output pixel aliases.*disagree/i],
  ];

  for (const [output, message] of scenarios) {
    const card = await cardServer({ status: { outputs: [output] } });
    try {
      await assert.rejects(
        runRealCardCommissioning({
          cardHost: card.host,
          expectedCardId: CARD_ID,
          expectedBuildId: BUILD_ID,
          ...EXPECTED_CARD,
        }),
        message,
      );
      assert.deepEqual(card.requests, [
        { method: 'GET', url: '/api/firmware-info' },
        { method: 'GET', url: '/api/status' },
      ]);
    } finally {
      await card.close();
    }
  }
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
      ...EXPECTED_CARD,
      allowMutation: true,
    }),
    /mutation operations are not implemented/i,
  );
});
