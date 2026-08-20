import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedResolutionRun, resolvedMatchKey } from './cardProjectAdoption.js';
import { cardProjectFingerprint } from './cardProjectResolver.js';
import { createDefaultProject } from './projectModel.js';

const CARD_ID = 'lw-adoption-test-card';
const FIRMWARE_VERSION = '1.0.0';
const BUILD_ID = 'b'.repeat(40);
const BOOT_ID = 'boot-adoption-1';
const INSTALLED_PROJECT_ID = 'proj-installed';

function project(id, name) {
  const created = createDefaultProject();
  created.id = id;
  created.name = name;
  created.layout.starterPending = false;
  return created;
}

const installedProject = project(INSTALLED_PROJECT_ID, 'Installed piece');
const installedFingerprint = cardProjectFingerprint(installedProject);

function statusEnvelope(overrides = {}) {
  return {
    app: 'Lightweaver',
    provisioningContractVersion: 1,
    cardId: CARD_ID,
    firmwareVersion: FIRMWARE_VERSION,
    buildId: BUILD_ID,
    bootId: BOOT_ID,
    runtimePhase: 'ready',
    knownGoodProject: true,
    commandReady: true,
    outputReady: true,
    projectId: INSTALLED_PROJECT_ID,
    ...overrides,
  };
}

function projectEvidence(overrides = {}) {
  return {
    cardId: CARD_ID,
    firmwareVersion: FIRMWARE_VERSION,
    buildId: BUILD_ID,
    projectId: INSTALLED_PROJECT_ID,
    projectRevision: 3,
    projectFingerprint: installedFingerprint,
    ...overrides,
  };
}

function cardLinkState(overrides = {}) {
  return {
    state: 'connected-direct',
    transport: 'direct',
    host: 'lightweaver.local',
    card: { id: CARD_ID, firmwareVersion: FIRMWARE_VERSION, buildId: BUILD_ID },
    readiness: statusEnvelope(),
    validatedBootId: BOOT_ID,
    operationGeneration: 0,
    revalidationGeneration: 0,
    ...overrides,
  };
}

// A deps bundle whose IO and actions record every call, mirroring the shape
// CardOverview and CardActionsProvider inject. Tests mutate the returned
// handles to model drift, in-flight runs, and failing sources.
function makeDeps({
  currentProject = project('current-open-project', 'Work in progress'),
  browserProjects = [{ id: 'rec-1', project: installedProject }],
  readiness = statusEnvelope(),
} = {}) {
  const reports = [];
  const calls = {
    save: 0, replace: 0, association: 0, verified: 0, openPatterns: 0,
    requestProbe: 0, issued: [], appliedParts: [],
  };
  const flight = {
    inFlight: { current: false },
    pendingProbe: { current: null },
    probeSignature: { current: '' },
  };
  const context = {
    ready: true,
    cardLink: cardLinkState({ readiness }),
    cardHost: 'lightweaver.local',
    currentProject,
    projectGeneration: 7,
    activeCloudProjects: [],
    browserProjects,
  };
  const latest = {
    ready: true,
    cardLink: context.cardLink,
    currentProject: context.currentProject,
    projectGeneration: context.projectGeneration,
    browserProjects,
  };
  const deps = {
    context,
    getLatestContext: () => latest,
    getSharedCardLink: () => ({}),
    isCardLinkConnected: () => true,
    io: {
      readCardProjectEvidence: async () => projectEvidence(),
      readCardStatusEnvelope: async () => statusEnvelope(),
      loadProductionJobIndex: async () => ({ jobs: [] }),
      loadProductionJobFromIndexEntry: async () => null,
      readCloudProject: null,
      readBrowserProjects: () => browserProjects,
      readCardPatternsFromCard: async () => null,
      readCardZonesFromCard: async () => null,
    },
    actions: {
      replaceProject: async () => {
        calls.replace += 1;
        return { ok: true, marker: { generation: 8, revision: 0 } };
      },
      saveBeforeCardProjectSwitch: async () => {
        calls.save += 1;
        return {
          ok: true,
          destination: 'browser',
          snapshot: { project: currentProject, marker: { generation: 7, revision: 4 }, remoteId: '' },
        };
      },
      isProjectSwitchSnapshotCurrent: () => true,
      openMatchingCardProject: async () => ({ ok: true }),
      onMatchedProjectLoaded: async () => {
        calls.association += 1;
        return { ok: true };
      },
      onMatchedProjectVerified: () => {
        calls.verified += 1;
        return { ok: true };
      },
      applyCardParts: async (parts, status) => {
        calls.appliedParts.push({ parts, status });
        return { ok: true };
      },
    },
    authorization: {
      clearCardEditAuthorization: () => {},
      issueCardEditAuthorization: binding => {
        calls.issued.push(binding);
        return { binding };
      },
      issueSignedProductionCardEditAuthorization: binding => {
        calls.issued.push(binding);
        return { binding };
      },
      clearAbandonedCardEditIntent: () => {},
      getCardEditIntent: () => '',
    },
    ui: {
      report: state => reports.push(state),
      openPatterns: () => { calls.openPatterns += 1; },
    },
    flight,
    requestProbe: () => { calls.requestProbe += 1; },
  };
  return { deps, reports, calls, flight, context, latest };
}

test('probe strategy publishes an exact-match offer and replaces nothing', async () => {
  const { deps, reports, calls } = makeDeps();
  await guardedResolutionRun(deps, { strategy: 'probe' });
  const last = reports.at(-1);
  assert.equal(last.status, 'offer');
  assert.equal(last.selectionKey, 'browser:rec-1');
  assert.match(last.message, /^Exact match found:/);
  assert.equal(calls.save, 0);
  assert.equal(calls.replace, 0);
  assert.equal(calls.openPatterns, 0);
  assert.equal(calls.issued.length, 0);
});

test('resolved strategy runs save barrier, replacement, association, verification, and opens Patterns', async () => {
  const { deps, calls } = makeDeps();
  await guardedResolutionRun(deps, { strategy: 'resolved', selectionKey: 'browser:rec-1' });
  assert.deepEqual(
    { save: calls.save, replace: calls.replace, association: calls.association, verified: calls.verified, openPatterns: calls.openPatterns },
    { save: 1, replace: 1, association: 1, verified: 1, openPatterns: 1 },
  );
  assert.equal(calls.issued.length, 1);
});

test('authorization binds the installed project id from the STATUS envelope, not firmware-info', async () => {
  // The card-link readiness envelope carries `projectId`; the firmware-info
  // evidence carries the same id under `piece`. The issued binding must come
  // from the status envelope, because that is the payload Patterns can see.
  const { deps, calls } = makeDeps();
  await guardedResolutionRun(deps, { strategy: 'resolved' });
  const binding = calls.issued[0];
  assert.equal(binding.installedProjectId, INSTALLED_PROJECT_ID);
  assert.equal(binding.cardId, CARD_ID);
  assert.equal(binding.bootId, BOOT_ID);
  assert.equal(binding.installedProjectFingerprint, installedFingerprint);
  assert.equal(binding.studioProjectId, INSTALLED_PROJECT_ID);
  // A replacement bumps the workspace generation; the grant binds the new one.
  assert.equal(binding.projectGeneration, 8);
});

test('a status envelope without an installed project id refuses authorization by name', async () => {
  const readiness = statusEnvelope({ projectId: '' });
  delete readiness.projectId;
  const { deps, reports, calls } = makeDeps({
    // Open project IS the installed project, so the machine reaches the
    // authorization step without any replacement masking the error copy.
    currentProject: installedProject,
    readiness,
  });
  await guardedResolutionRun(deps, { strategy: 'resolved' });
  const last = reports.at(-1);
  assert.equal(last.status, 'error');
  assert.match(last.message, /does not report which project is installed/);
  assert.equal(calls.openPatterns, 0);
  assert.equal(calls.issued.length, 0);
});

test('a current-source match authorizes against the live generation and opens Patterns without saving', async () => {
  const { deps, calls } = makeDeps({ currentProject: installedProject });
  await guardedResolutionRun(deps, { strategy: 'resolved' });
  assert.equal(calls.save, 0);
  assert.equal(calls.replace, 0);
  assert.equal(calls.openPatterns, 1);
  assert.equal(calls.issued[0].projectGeneration, 7);
});

for (const [name, mutate] of Object.entries({
  'card id': link => { link.card = { ...link.card, id: 'lw-different-card' }; },
  'firmware version': link => { link.card = { ...link.card, firmwareVersion: '9.9.9' }; },
  'boot id': link => { link.validatedBootId = 'boot-after-restart'; },
})) {
  test(`context drift mid-resolution (${name} changed) refuses and replaces nothing`, async () => {
    const { deps, reports, calls, latest } = makeDeps();
    const readEvidence = deps.io.readCardProjectEvidence;
    let reads = 0;
    deps.io.readCardProjectEvidence = async (...args) => {
      reads += 1;
      if (reads === 1) {
        // The card changes underneath the run after the first snapshot.
        const drifted = cardLinkState();
        mutate(drifted);
        latest.cardLink = drifted;
      }
      return readEvidence(...args);
    };
    await guardedResolutionRun(deps, { strategy: 'resolved' });
    const last = reports.at(-1);
    assert.equal(last.status, 'error');
    assert.equal(last.message, 'The card or open Studio project changed while resolving. Nothing was replaced.');
    assert.equal(calls.replace, 0);
    assert.equal(calls.openPatterns, 0);
  });
}

test('installed-project evidence drift between snapshots refuses and replaces nothing', async () => {
  const { deps, reports, calls } = makeDeps();
  let reads = 0;
  deps.io.readCardProjectEvidence = async () => {
    reads += 1;
    return reads === 1
      ? projectEvidence()
      : projectEvidence({ projectRevision: 4 });
  };
  await guardedResolutionRun(deps, { strategy: 'resolved' });
  const last = reports.at(-1);
  assert.equal(last.status, 'error');
  assert.equal(last.message, 'The project installed on the card changed while Studio was resolving it. Nothing was replaced.');
  assert.equal(calls.replace, 0);
});

test('a shared card link that lost its connection refuses the run', async () => {
  const { deps, reports, calls } = makeDeps();
  deps.getSharedCardLink = () => cardLinkState({ state: 'reconnecting' });
  deps.isCardLinkConnected = link => link.state === 'connected-direct';
  await guardedResolutionRun(deps, { strategy: 'resolved' });
  assert.equal(reports.at(-1).status, 'error');
  assert.equal(reports.at(-1).message, 'The card or open Studio project changed while resolving. Nothing was replaced.');
  assert.equal(calls.replace, 0);
});

test('single-flight: a run while one is in flight returns without touching the card', async () => {
  const { deps, reports, calls, flight } = makeDeps();
  flight.inFlight.current = true;
  let evidenceReads = 0;
  deps.io.readCardProjectEvidence = async () => { evidenceReads += 1; return projectEvidence(); };

  await guardedResolutionRun(deps, { strategy: 'resolved' });
  assert.equal(reports.length, 0);
  assert.equal(evidenceReads, 0);
  assert.equal(flight.pendingProbe.current, null);

  await guardedResolutionRun(deps, { strategy: 'probe', probeSignature: 'sig-queued' });
  assert.deepEqual(flight.pendingProbe.current, { probeOnly: true, autoIntent: '', probeSignature: 'sig-queued' });
  assert.equal(calls.save, 0);
});

test('a queued probe with a new signature re-arms exactly one background probe after the run', async () => {
  const { deps, calls, flight } = makeDeps();
  flight.pendingProbe.current = { probeOnly: true, autoIntent: '', probeSignature: 'sig-newer' };
  await guardedResolutionRun(deps, { strategy: 'probe', probeSignature: 'sig-current' });
  assert.equal(calls.requestProbe, 1);
  assert.equal(flight.pendingProbe.current, null);
  assert.equal(flight.inFlight.current, false);
});

test('a not-ready context is a no-op', async () => {
  const { deps, reports, calls, context } = makeDeps();
  context.ready = false;
  await guardedResolutionRun(deps, { strategy: 'resolved' });
  assert.equal(reports.length, 0);
  assert.equal(calls.save, 0);
});

test('reconstruct strategy rebuilds looks, playlist, and startup state from the card readback', async () => {
  const { deps, calls } = makeDeps();
  deps.io.readCardStatusEnvelope = async () => statusEnvelope({
    outputs: [{ id: 'out1', pin: 18, pixels: 41 }],
  });
  deps.io.readCardPatternsFromCard = async () => ({
    currentId: 'fire',
    patterns: [
      { id: 'aurora', label: 'Aurora', zones: [{ id: 'strip-1', patternId: 'aurora' }] },
      { id: 'fire', label: 'Fire', zones: [{ id: 'strip-1', patternId: 'fire' }] },
    ],
  });
  deps.io.readCardZonesFromCard = async () => ({
    startupPatternId: 'aurora',
    zones: [{ id: 'strip-1', patternId: 'aurora', brightness: 0.72 }],
  });
  const result = await guardedResolutionRun(deps, { strategy: 'reconstruct' });
  assert.equal(result.ok, true);
  assert.equal(calls.appliedParts.length, 1);
  const controller = calls.appliedParts[0].parts.devices.standaloneController;
  assert.equal(controller.activeLookId, 'fire');
  assert.deepEqual(controller.looks.map(look => look.id), ['aurora', 'fire']);
  assert.deepEqual(controller.playlist.map(item => item.lookId), ['aurora', 'fire']);
  assert.equal(controller.defaultLook.patternId, 'aurora');
  assert.equal(controller.defaultLook.brightness, 0.72);
  assert.equal(calls.appliedParts[0].status.cardId, CARD_ID);
});

test('reconstruct still adopts from the status skeleton alone when patterns and zones endpoints fail', async () => {
  const { deps, calls } = makeDeps();
  deps.io.readCardStatusEnvelope = async () => statusEnvelope({
    outputs: [{ id: 'out1', pin: 18, pixels: 41 }],
  });
  deps.io.readCardPatternsFromCard = async () => { throw new Error('404'); };
  deps.io.readCardZonesFromCard = async () => { throw new Error('404'); };
  const result = await guardedResolutionRun(deps, { strategy: 'reconstruct' });
  assert.equal(result.ok, true);
  assert.equal(calls.appliedParts.length, 1);
  assert.deepEqual(calls.appliedParts[0].parts.devices.standaloneController.looks, []);
});

test('reconstruct refuses a card that reports no light outputs', async () => {
  const { deps, calls } = makeDeps();
  deps.io.readCardStatusEnvelope = async () => statusEnvelope({ outputs: [] });
  const result = await guardedResolutionRun(deps, { strategy: 'reconstruct' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-geometry');
  assert.equal(calls.appliedParts.length, 0);
});

test('reconstruct surfaces a rejected replacement as its reason instead of silence', async () => {
  const { deps } = makeDeps();
  deps.io.readCardStatusEnvelope = async () => statusEnvelope({
    outputs: [{ id: 'out1', pin: 18, pixels: 41 }],
  });
  deps.actions.applyCardParts = async () => ({ ok: false, reason: 'cancelled' });
  const result = await guardedResolutionRun(deps, { strategy: 'reconstruct' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cancelled');
});

test('resolvedMatchKey names each source unambiguously', () => {
  assert.equal(resolvedMatchKey({ source: 'browser', recordId: 'rec-9' }), 'browser:rec-9');
  assert.equal(resolvedMatchKey({ source: 'cloud', remoteId: 'rem-1', candidate: { revision: 5 } }), 'cloud:rem-1:5');
  assert.equal(resolvedMatchKey({ source: 'production', candidate: { jobId: 'job-1', digest: 'd'.repeat(64) } }), `production:job-1:${'d'.repeat(64)}`);
  assert.equal(resolvedMatchKey({ source: 'current', project: { id: 'p-1' } }), 'current:p-1');
});
