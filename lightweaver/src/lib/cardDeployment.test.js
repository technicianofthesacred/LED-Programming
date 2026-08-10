import assert from 'node:assert/strict';
import test from 'node:test';

async function deploymentApi() {
  try {
    return await import('./cardDeployment.js');
  } catch (error) {
    assert.fail(`missing canonical card deployment coordinator: ${error.message}`);
  }
}

function projectFixture() {
  return {
    projectId: 'installation-7',
    projectName: 'Installation Seven',
    projectRevision: 7,
    projectFingerprint: 'a'.repeat(64),
    strips: [{ id: 'outer', name: 'Outer', pixelCount: 8 }],
    standaloneController: {
      outputs: [{
        id: 'out-a', name: 'Outer output', pin: 16, pixels: 8, direction: 'reverse',
        segments: [
          { id: 'outer-a', count: 3, direction: 'reverse' },
          { id: 'outer-b', count: 5, direction: 'forward' },
        ],
      }],
      led: {
        maxMilliamps: 1300,
        outputGammaEnabled: true,
        outputGammaValue: 2.4,
        calibration: { red: 0.9, green: 0.8, blue: 0.7 },
      },
      defaultLook: { patternId: 'ocean', brightness: 0.55 },
      playlist: [{ id: 'ocean', type: 'pattern', patternId: 'ocean', label: 'Ocean', enabled: true }],
    },
  };
}

function mappedProjectFixture() {
  const project = projectFixture();
  const mapping = {
    id: 'outer', zoneId: 'outer', pixelCount: 8,
    pointCount: 4, startLed: 0, offsets: [0, 0, 0, 0],
    spans: [{ start: 0, count: 8, sourceStart: 0, sourceStep: 1 }],
  };
  project.strips[0].kaleidoscope = { enabled: true, pointCount: 4, startLed: 0, offsets: [0, 0, 0, 0] };
  project.compiledWiring = {
    ok: true,
    totalPixels: 8,
    outputs: [{
      id: 'out-a', name: 'Outer output', pin: 16, pixels: 8, direction: 'reverse',
      segments: [
        { id: 'outer-a', count: 3, direction: 'reverse' },
        { id: 'outer-b', count: 5, direction: 'forward' },
      ],
    }],
    zones: [{ id: 'outer', label: 'Outer', ranges: [{ start: 0, count: 8 }] }],
    kaleidoscopeMappings: [mapping],
  };
  return project;
}

function preparedResumeIdentity(overrides = {}) {
  return {
    cardId: 'lw-aabbccddeeff',
    buildId: 'build-1123',
    activationId: 'candidate-7',
    config: {
      projectRevision: 7,
      projectFingerprint: 'a'.repeat(64),
      productionJobId: 'job-7',
      productionJobDigest: 'b'.repeat(64),
      wiringRevision: 3,
      wiringDigest: 'c'.repeat(64),
    },
    ...overrides,
  };
}

function matchingCandidate(overrides = {}) {
  return {
    app: 'Lightweaver',
    state: 'staged',
    candidateState: 'staged',
    nextStep: 'activate',
    cardId: 'lw-aabbccddeeff',
    buildId: 'build-1123',
    activationId: 'candidate-7',
    projectRevision: 7,
    projectFingerprint: 'a'.repeat(64),
    productionJobId: 'job-7',
    productionJobDigest: 'b'.repeat(64),
    wiringRevision: 3,
    wiringDigest: 'c'.repeat(64),
    ...overrides,
  };
}

test('prepares one canonical package that preserves wiring, playback, power, and calibration', async () => {
  const { prepareCardDeployment } = await deploymentApi();
  const prepared = prepareCardDeployment(projectFixture(), { cardId: 'lw-aabbccddeeff' });

  assert.equal(prepared.cardId, 'lw-aabbccddeeff');
  assert.equal(prepared.config.led.outputs[0].direction, 'reverse');
  assert.deepEqual(prepared.config.led.outputs[0].segments, [
    { id: 'outer-a', count: 3, direction: 'reverse' },
    { id: 'outer-b', count: 5, direction: 'forward' },
  ]);
  assert.equal(prepared.config.led.maxMilliamps, 1300);
  assert.equal(prepared.config.led.outputGammaEnabled, true);
  assert.deepEqual(prepared.config.led.calibration, { red: 0.9, green: 0.8, blue: 0.7 });
  assert.equal(prepared.config.looks[0].id, 'ocean');
  assert.match(prepared.fingerprint, /^[a-f0-9]{64}$/);
});

test('derives a deterministic project fingerprint before building a revised package', async () => {
  const { prepareCardDeployment } = await deploymentApi();
  const project = projectFixture();
  delete project.projectFingerprint;

  const prepared = prepareCardDeployment(project, { cardId: 'lw-aabbccddeeff' });

  assert.equal(prepared.config.projectRevision, 7);
  assert.match(prepared.config.projectFingerprint, /^[a-f0-9]{64}$/);
});

test('classifies visual-only changes as short updates and wiring changes as physical tests', async () => {
  const { classifyCardChanges } = await deploymentApi();
  const base = { led: { outputs: [{ pin: 16, pixels: 8, direction: 'forward' }], maxMilliamps: 1000 }, looks: [{ id: 'aurora' }] };
  const visual = classifyCardChanges(base, { ...base, looks: [{ id: 'ocean' }] });
  const hardware = classifyCardChanges(base, { ...base, led: { ...base.led, outputs: [{ pin: 17, pixels: 8, direction: 'forward' }] } });

  assert.deepEqual(visual, { kind: 'visual', requiresPhysicalTest: false, groups: ['Playback'] });
  assert.deepEqual(hardware, { kind: 'hardware', requiresPhysicalTest: true, groups: ['Wiring'] });
});

test('normalizes card status into the same hardware comparison shape', async () => {
  const { cardStatusAsConfig, classifyCardChanges } = await deploymentApi();
  const previous = cardStatusAsConfig({
    led: {
      maxMilliamps: 1300,
      colorOrder: 'RGB',
      outputGammaEnabled: true,
      outputGammaValue: 2.4,
      calibration: { red: 0.9, green: 0.8, blue: 0.7 },
    },
    outputs: [{
      id: 'out-a', pin: 16, pixels: 8,
      segments: [
        { id: 'outer-a', count: 3, direction: 'reverse' },
        { id: 'outer-b', count: 5, direction: 'forward' },
      ],
    }],
  });
  const next = projectFixture();
  const prepared = (await deploymentApi()).prepareCardDeployment(next).config;
  assert.equal(classifyCardChanges(previous, prepared).requiresPhysicalTest, false);
});

test('classifies new, activation, physical-test, and confirmation deployment steps', async () => {
  const { classifyCardDeploymentResume } = await deploymentApi();
  const prepared = preparedResumeIdentity();

  assert.equal(classifyCardDeploymentResume(prepared, matchingCandidate({
    state: 'known-good', candidateState: 'none', activationId: '', nextStep: 'stage-candidate',
  })), 'stage-new');
  assert.equal(classifyCardDeploymentResume(prepared, matchingCandidate()), 'resume-activation');
  assert.equal(classifyCardDeploymentResume(prepared, matchingCandidate({
    state: 'testing', candidateState: 'testing', nextStep: 'test-physical-lights',
  })), 'resume-physical-test');
  assert.equal(classifyCardDeploymentResume(prepared, matchingCandidate({
    state: 'testing', candidateState: 'booting', nextStep: 'wait-for-card',
  })), 'resume-physical-test');
  assert.equal(classifyCardDeploymentResume(prepared, matchingCandidate({
    state: 'testing', candidateState: 'awaiting-confirmation', nextStep: 'confirm-or-rollback',
  })), 'resume-confirmation');
});

test('a candidate-free card must still match the exact card and firmware build before staging', async () => {
  const { classifyCardDeploymentResume } = await deploymentApi();
  const status = matchingCandidate({
    state: 'known-good', candidateState: 'none', activationId: '', nextStep: 'stage-candidate',
  });
  assert.equal(classifyCardDeploymentResume(preparedResumeIdentity(), { ...status, cardId: 'lw-other' }), 'candidate-conflict');
  assert.equal(classifyCardDeploymentResume(preparedResumeIdentity(), { ...status, buildId: 'build-other' }), 'candidate-conflict');
});

test('the real candidate-free wiring status shape stages after the independent card preflight', async () => {
  const { classifyCardDeploymentResume } = await deploymentApi();
  const realKnownGoodStatus = {
    ok: true,
    state: 'known-good',
    candidateState: 'none',
    hasCandidate: false,
    activationId: '',
    outputs: [{ pin: 16, pixels: 8 }],
    nextStep: 'stage-candidate',
  };
  assert.equal(classifyCardDeploymentResume(preparedResumeIdentity(), realKnownGoodStatus), 'stage-new');
});

test('candidate-free staging requires exact card and build identity from both independent preflight reads', async () => {
  const { assertCardDeploymentPreflightIdentity } = await deploymentApi();
  const firmwareInfo = { cardId: 'lw-aabbccddeeff', buildId: 'build-1123' };
  const status = { cardId: 'lw-aabbccddeeff', buildId: 'build-1123' };
  assert.equal(assertCardDeploymentPreflightIdentity(firmwareInfo, status), true);
  for (const [left, right] of [
    [{ ...firmwareInfo, buildId: '' }, status],
    [firmwareInfo, { ...status, buildId: '' }],
    [firmwareInfo, { ...status, buildId: 'build-other' }],
    [{ ...firmwareInfo, cardId: '' }, status],
    [firmwareInfo, { ...status, cardId: '' }],
    [firmwareInfo, { ...status, cardId: 'lw-other' }],
  ]) {
    assert.throws(
      () => assertCardDeploymentPreflightIdentity(left, right),
      error => error?.reason === 'preflight-identity-mismatch',
    );
  }
});

test('conflicts on every exact candidate identity mismatch without mutating inputs', async () => {
  const { classifyCardDeploymentResume } = await deploymentApi();
  const prepared = preparedResumeIdentity();
  const status = matchingCandidate();
  const before = structuredClone(status);
  const mismatches = [
    { cardId: 'lw-other' },
    { buildId: 'build-other' },
    { activationId: 'candidate-other' },
    { projectRevision: 8 },
    { projectFingerprint: 'd'.repeat(64) },
    { productionJobId: 'job-other' },
    { productionJobDigest: 'd'.repeat(64) },
    { wiringRevision: 4 },
    { wiringDigest: 'd'.repeat(64) },
  ];
  for (const mismatch of mismatches) {
    assert.equal(
      classifyCardDeploymentResume(prepared, { ...status, ...mismatch }),
      'candidate-conflict',
      `must reject ${Object.keys(mismatch)[0]} mismatch`,
    );
  }
  assert.equal(classifyCardDeploymentResume(prepared, { ...status, activationId: '' }), 'candidate-conflict');
  assert.deepEqual(status, before, 'classification must remain pure');
});

test('optional production and wiring identity must match whenever either candidate declares it', async () => {
  const { classifyCardDeploymentResume } = await deploymentApi();
  const prepared = preparedResumeIdentity({
    activationId: '',
    config: { projectRevision: 7, projectFingerprint: 'a'.repeat(64) },
  });
  const ordinary = matchingCandidate({
    productionJobId: undefined,
    productionJobDigest: undefined,
    wiringRevision: 0,
    wiringDigest: undefined,
  });
  assert.equal(classifyCardDeploymentResume(prepared, ordinary), 'resume-activation');
  assert.equal(classifyCardDeploymentResume(prepared, {
    ...ordinary,
    wiringRevision: 3,
    wiringDigest: 'c'.repeat(64),
  }), 'candidate-conflict');
});

test('resume and conflict orchestration perform no card mutation before explicit user action', async () => {
  const { orchestrateCardDeploymentStart } = await deploymentApi();
  const prepared = preparedResumeIdentity();
  const mutationNames = ['stage', 'activate', 'confirm', 'rollback', 'config'];
  const calls = Object.fromEntries(mutationNames.map(name => [name, 0]));
  const mutations = Object.fromEntries(mutationNames.map(name => [name, async () => { calls[name] += 1; }]));
  const statuses = [
    matchingCandidate(),
    matchingCandidate({ state: 'testing', candidateState: 'testing', nextStep: 'test-physical-lights' }),
    matchingCandidate({ state: 'testing', candidateState: 'awaiting-confirmation', nextStep: 'confirm-or-rollback' }),
    matchingCandidate({ projectFingerprint: 'd'.repeat(64) }),
  ];

  const actions = [];
  for (const status of statuses) {
    actions.push((await orchestrateCardDeploymentStart(prepared, {
      readFirmwareInfo: async () => ({ cardId: prepared.cardId, buildId: prepared.buildId }),
      readStatus: async () => ({ cardId: prepared.cardId, buildId: prepared.buildId }),
      readWiringStatus: async () => status,
      ...mutations,
    })).action);
  }
  assert.deepEqual(actions, [
    'resume-activation',
    'resume-physical-test',
    'resume-confirmation',
    'candidate-conflict',
  ]);
  assert.deepEqual(calls, { stage: 0, activate: 0, confirm: 0, rollback: 0, config: 0 });
});

test('new deployment orchestration issues exactly one config mutation', async () => {
  const { orchestrateCardDeploymentStart } = await deploymentApi();
  let configCalls = 0;
  const result = await orchestrateCardDeploymentStart(preparedResumeIdentity(), {
    readFirmwareInfo: async () => ({ cardId: 'lw-aabbccddeeff', buildId: 'build-1123' }),
    readStatus: async () => ({ cardId: 'lw-aabbccddeeff', buildId: 'build-1123' }),
    readWiringStatus: async () => ({
      state: 'known-good', candidateState: 'none', hasCandidate: false, nextStep: 'stage-candidate',
    }),
    config: async () => { configCalls += 1; return { ok: true, state: 'staged', activationId: 'candidate-new' }; },
  });
  assert.equal(configCalls, 1);
  assert.equal(result.action, 'stage-new');
  assert.equal(result.response.activationId, 'candidate-new');
});

test('new deployment orchestration rejects missing or changed build evidence before config mutation', async () => {
  const { orchestrateCardDeploymentStart } = await deploymentApi();
  let configCalls = 0;
  for (const preflightStatus of [
    { cardId: 'lw-aabbccddeeff' },
    { cardId: 'lw-aabbccddeeff', buildId: 'build-other' },
  ]) {
    await assert.rejects(
      orchestrateCardDeploymentStart(preparedResumeIdentity(), {
        readFirmwareInfo: async () => ({ cardId: 'lw-aabbccddeeff', buildId: 'build-1123' }),
        readStatus: async () => preflightStatus,
        readWiringStatus: async () => ({
          state: 'known-good', candidateState: 'none', hasCandidate: false, nextStep: 'stage-candidate',
        }),
        config: async () => { configCalls += 1; },
      }),
      error => error?.reason === 'preflight-identity-mismatch',
    );
  }
  assert.equal(configCalls, 0);
});

test('does not report a deployment installed until exact-card read-back verifies it', async () => {
  const { prepareCardDeployment, runCardDeployment, verifyCardDeployment } = await deploymentApi();
  const initial = prepareCardDeployment(projectFixture(), { cardId: 'lw-aabbccddeeff' });
  const prepared = prepareCardDeployment(projectFixture(), {
    cardId: 'lw-aabbccddeeff',
    previousConfig: initial.config,
  });
  const states = [];
  let installed = 0;
  const transport = {
    async install() { return { ok: true }; },
    async readBack() { return { cardId: 'lw-aabbccddeeff', config: structuredClone(prepared.config), knownGoodProject: true, commandReady: true, runtimePhase: 'ready', playbackReady: true, outputReady: true }; },
  };

  const result = await runCardDeployment(prepared, transport, {
    onState: state => states.push(state),
    onInstalled: () => { installed += 1; },
  });

  assert.equal(installed, 1);
  assert.equal(result.installed, true);
  assert.deepEqual(states, ['Sending', 'Verifying card', 'Installed']);
  assert.equal(verifyCardDeployment(prepared, { cardId: 'lw-other', config: prepared.config }).ok, false);
  assert.equal(verifyCardDeployment(prepared, { cardId: 'lw-aabbccddeeff', config: { ...prepared.config, led: { ...prepared.config.led, maxMilliamps: 1200 } } }).ok, false);
  assert.equal(verifyCardDeployment(prepared, {
    cardId: 'lw-aabbccddeeff',
    projectRevision: 7,
    projectFingerprint: 'a'.repeat(64),
    knownGoodProject: true,
    commandReady: true,
    runtimePhase: 'ready',
    playbackReady: true,
    outputReady: true,
  }).ok, true);
});

test('installed verification requires exact known-good command and playback readiness', async () => {
  const { prepareCardDeployment, verifyCardDeployment } = await deploymentApi();
  const prepared = prepareCardDeployment(projectFixture(), { cardId: 'lw-aabbccddeeff' });
  const ready = {
    cardId: prepared.cardId,
    projectRevision: prepared.config.projectRevision,
    projectFingerprint: prepared.config.projectFingerprint,
    knownGoodProject: true,
    commandReady: true,
    runtimePhase: 'ready',
    playbackReady: true,
    outputReady: true,
  };
  assert.equal(verifyCardDeployment(prepared, ready, { requireReady: true }).ok, true);
  for (const [field, reason] of [
    ['knownGoodProject', 'card-not-ready'],
    ['commandReady', 'card-not-ready'],
    ['playbackReady', 'playback-not-ready'],
  ]) {
    assert.deepEqual(verifyCardDeployment(prepared, { ...ready, [field]: false }, { requireReady: true }), {
      ok: false,
      reason,
    });
    const missing = { ...ready };
    delete missing[field];
    assert.deepEqual(verifyCardDeployment(prepared, missing, { requireReady: true }), {
      ok: false,
      reason,
    });
  }
});

test('installed verification also requires runtime and output readiness', async () => {
  const { prepareCardDeployment, verifyCardDeployment } = await deploymentApi();
  const prepared = prepareCardDeployment(projectFixture(), { cardId: 'lw-aabbccddeeff' });
  const ready = {
    cardId: prepared.cardId,
    projectRevision: prepared.config.projectRevision,
    projectFingerprint: prepared.config.projectFingerprint,
    knownGoodProject: true,
    commandReady: true,
    runtimePhase: 'ready',
    playbackReady: true,
    outputReady: true,
  };
  assert.equal(verifyCardDeployment(prepared, ready, { requireReady: true }).ok, true);
  assert.deepEqual(verifyCardDeployment(prepared, { ...ready, runtimePhase: 'recovering' }, { requireReady: true }), { ok: false, reason: 'runtime-not-ready' });
  assert.deepEqual(verifyCardDeployment(prepared, { ...ready, outputReady: false }, { requireReady: true }), { ok: false, reason: 'output-not-ready' });
});

test('readiness evidence must carry its own exact card build and project identity', async () => {
  const { correlateCardDeploymentReadinessEvidence } = await deploymentApi();
  const project = {
    cardId: 'lw-aabbccddeeff',
    buildId: 'build-1123',
    projectRevision: 7,
    projectFingerprint: 'a'.repeat(64),
  };
  const readiness = {
    cardId: project.cardId,
    buildId: project.buildId,
    projectRevision: project.projectRevision,
    projectFingerprint: project.projectFingerprint,
    knownGoodProject: true,
    commandReady: true,
    runtimePhase: 'ready',
    playbackReady: true,
    outputReady: true,
  };
  assert.deepEqual(correlateCardDeploymentReadinessEvidence(project, readiness), {
    ...project,
    knownGoodProject: true,
    commandReady: true,
    runtimePhase: 'ready',
    playbackReady: true,
    outputReady: true,
  });
  assert.throws(
    () => correlateCardDeploymentReadinessEvidence(project, {
      knownGoodProject: true,
      commandReady: true,
      playbackReady: true,
    }),
    error => error?.reason === 'readiness-identity-mismatch',
  );
  for (const field of ['cardId', 'buildId', 'projectRevision', 'projectFingerprint']) {
    assert.throws(
      () => correlateCardDeploymentReadinessEvidence(project, { ...readiness, [field]: undefined }),
      error => error?.reason === 'readiness-identity-mismatch',
      `missing readiness ${field} must fail closed`,
    );
  }
});

test('requires an explicit hardware confirmation and rolls back when it is declined', async () => {
  const { prepareCardDeployment, runCardDeployment } = await deploymentApi();
  const prepared = prepareCardDeployment(projectFixture(), { cardId: 'lw-aabbccddeeff', previousConfig: { led: { outputs: [{ pin: 17, pixels: 8 }] } } });
  const states = [];
  let rollback = 0;
  const result = await runCardDeployment(prepared, {
    async stage() { return { activationId: 'candidate-7' }; },
    async rollback() { rollback += 1; },
  }, {
    onState: state => states.push(state),
    confirmHardware: async () => false,
  });

  assert.equal(result.installed, false);
  assert.equal(rollback, 1);
  assert.deepEqual(states, ['Sending', 'Test lights', 'Restored previous setup']);
});

test('requires exact applied Kaleidoscope mapping read-back before reporting installed', async () => {
  const { prepareCardDeployment, verifyCardDeployment } = await deploymentApi();
  const prepared = prepareCardDeployment(mappedProjectFixture(), { cardId: 'lw-aabbccddeeff' });
  const identity = {
    cardId: 'lw-aabbccddeeff',
    projectRevision: prepared.config.projectRevision,
    projectFingerprint: prepared.config.projectFingerprint,
    knownGoodProject: true,
    commandReady: true,
    playbackReady: true,
  };

  assert.deepEqual(verifyCardDeployment(prepared, identity), { ok: false, reason: 'read-back-mismatch' });
  assert.equal(verifyCardDeployment(prepared, {
    ...identity,
    kaleidoscopeMappings: structuredClone(prepared.config.kaleidoscopeMappings),
  }).ok, true);
  const mismatched = structuredClone(prepared.config.kaleidoscopeMappings);
  mismatched[0].offsets[0] = 1;
  assert.deepEqual(verifyCardDeployment(prepared, {
    ...identity,
    kaleidoscopeMappings: mismatched,
  }), { ok: false, reason: 'read-back-mismatch' });
});

test('rejects Kaleidoscope read-back whose pixels moved outside the declared zone', async () => {
  const { verifyCardDeployment } = await deploymentApi();
  const expectedMapping = {
    id: 'outer-map', zoneId: 'outer', pixelCount: 4,
    pointCount: 4, startLed: 0, offsets: [0, 0, 0, 0],
    spans: [{ start: 4, count: 4, sourceStart: 0, sourceStep: 1 }],
  };
  const prepared = {
    cardId: 'lw-aabbccddeeff', fingerprint: 'f'.repeat(64),
    config: {
      projectRevision: 9, projectFingerprint: 'f'.repeat(64),
      led: { pixels: 8 },
      zones: [
        { id: 'outer', ranges: [{ start: 0, count: 4 }] },
        { id: 'inner', ranges: [{ start: 4, count: 4 }] },
      ],
      kaleidoscopeMappings: [expectedMapping],
    },
  };
  const evidence = {
    cardId: prepared.cardId,
    projectRevision: 9,
    projectFingerprint: 'f'.repeat(64),
    kaleidoscopeMappings: [structuredClone(expectedMapping)],
    knownGoodProject: true,
    commandReady: true,
    playbackReady: true,
  };

  assert.deepEqual(verifyCardDeployment(prepared, evidence), {
    ok: false, reason: 'read-back-mismatch',
  });
});

test('starts the candidate test before asking and confirms only after the user sees the lights', async () => {
  const { prepareCardDeployment, runCardDeployment } = await deploymentApi();
  const prepared = prepareCardDeployment(projectFixture(), {
    cardId: 'lw-aabbccddeeff',
    previousConfig: { led: { outputs: [{ pin: 17, pixels: 8 }] } },
  });
  const order = [];
  const result = await runCardDeployment(prepared, {
    async stage() { order.push('stage'); return { activationId: 'candidate-7' }; },
    async startTest() { order.push('start-test'); },
    async confirm() { order.push('confirm'); },
    async readBack() {
      order.push('read-back');
      return { cardId: 'lw-aabbccddeeff', config: structuredClone(prepared.config), knownGoodProject: true, commandReady: true, runtimePhase: 'ready', playbackReady: true, outputReady: true };
    },
  }, {
    confirmHardware: async () => { order.push('ask-user'); return true; },
  });

  assert.equal(result.installed, true);
  assert.deepEqual(order, ['stage', 'start-test', 'ask-user', 'confirm', 'read-back']);
});

test('retries reboot read-back but fails immediately if a different card answers', async () => {
  const { prepareCardDeployment, waitForCardDeploymentVerification } = await deploymentApi();
  const prepared = prepareCardDeployment(projectFixture(), { cardId: 'lw-aabbccddeeff' });
  let reads = 0;
  const verified = await waitForCardDeploymentVerification(prepared, {
    attempts: 3,
    sleep: async () => {},
    readEvidence: async () => {
      reads += 1;
      if (reads < 3) throw new Error('restarting');
      return {
        cardId: 'lw-aabbccddeeff',
        projectRevision: prepared.config.projectRevision,
        projectFingerprint: prepared.config.projectFingerprint,
        knownGoodProject: true,
        commandReady: true,
        playbackReady: true,
      };
    },
  });
  assert.equal(verified.ok, true);
  assert.equal(reads, 3);

  await assert.rejects(
    waitForCardDeploymentVerification(prepared, {
      readEvidence: async () => ({ cardId: 'lw-other' }),
    }),
    /Wrong card answered/,
  );
});
