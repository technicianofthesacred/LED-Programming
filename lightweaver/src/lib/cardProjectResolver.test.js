import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintCommissioningProject } from './cardCommissioningFlow.js';
import { prepareCardDeployment } from './cardDeployment.js';
import { createDefaultProject } from './projectModel.js';
import { projectSkeletonFromCardStatus } from './discoveryCommit.js';
import { normalizePatchBoard } from './patchBoard.js';
import { compileWiring } from './wiringCompiler.js';
import {
  cardProjectFingerprint,
  cardProjectId,
  describeResolvedCardProject,
  sameCardProjectEvidence,
  sameCardResolutionContext,
  resolveCardProject,
} from './cardProjectResolver.js';

function project(id, name = id) {
  const value = createDefaultProject();
  return {
    ...value,
    id,
    name,
    layout: {
      ...value.layout,
      starterPending: false,
    },
  };
}

function evidenceFor(value, overrides = {}) {
  return {
    cardId: 'lw-aabbccddeeff',
    projectId: value.id,
    projectRevision: 7,
    projectFingerprint: cardProjectFingerprint(value),
    ...overrides,
  };
}

test('matches the exact current project using the fingerprint written by the real deployment path', () => {
  const current = createDefaultProject();
  current.layout.starterPending = false;
  const deployed = prepareCardDeployment({
    projectId: current.id,
    projectName: current.name,
    projectRevision: 7,
    strips: current.layout.strips,
    patchBoard: current.layout.patchBoard,
    wiring: current.layout.wiring,
    standaloneController: current.devices.standaloneController,
  });
  const result = resolveCardProject({
    evidence: {
      cardId: 'lw-aabbccddeeff',
      projectId: deployed.config.piece.id,
      projectRevision: deployed.config.projectRevision,
      projectFingerprint: deployed.config.projectFingerprint,
    },
    currentProject: current,
  });

  assert.equal(result.status, 'match');
  assert.equal(result.source, 'current');
  assert.equal(result.project, current);
});

test('matches a project reconstructed from installed card geometry using the install surface canonical board', () => {
  const base = createDefaultProject();
  const skeleton = projectSkeletonFromCardStatus({
    knownGoodProject: true,
    outputReady: true,
    projectId: 'installed-piece',
    led: { colorOrder: 'RGB', type: 'WS2815', maxMilliamps: 1500 },
    outputs: [{
      id: 'out1', pin: 18, pixels: 41,
      segments: [{ id: 'run-strip-1', count: 41, direction: 'forward' }],
    }],
  });
  const current = {
    ...base,
    id: 'installed-piece',
    layout: {
      ...base.layout,
      strips: skeleton.strips,
      patchBoard: skeleton.patchBoard,
      wiring: skeleton.wiring,
    },
    devices: {
      ...base.devices,
      standaloneController: {
        ...base.devices.standaloneController,
        outputs: skeleton.outputs,
        led: { ...base.devices.standaloneController.led, ...skeleton.led, colorOrder: skeleton.colorOrder },
      },
    },
  };
  const board = normalizePatchBoard(current.layout.patchBoard, current.layout.strips);
  const compiledWiring = compileWiring({ wiring: current.layout.wiring, strips: current.layout.strips });
  const deployed = prepareCardDeployment({
    projectId: current.id,
    projectName: current.name,
    projectRevision: 0,
    strips: current.layout.strips,
    patchBoard: board,
    compiledWiring,
    standaloneController: current.devices.standaloneController,
  });

  assert.equal(cardProjectFingerprint(current), deployed.config.projectFingerprint);
  assert.equal(resolveCardProject({
    evidence: {
      cardId: 'lw-aabbccddeeff',
      projectId: current.id,
      projectRevision: 0,
      projectFingerprint: deployed.config.projectFingerprint,
    },
    currentProject: current,
  }).source, 'current');
});

test('prefers an exact currently open project over every stored source', () => {
  const current = project('gallery-piece');
  const evidence = evidenceFor(current);
  const result = resolveCardProject({
    evidence,
    currentProject: current,
    productionJobs: [{
      jobId: 'job-7', digest: 'b'.repeat(64),
      project: { id: current.id, revision: 7, fingerprint: evidence.projectFingerprint, restoreSnapshot: current },
    }],
    cloudProjects: [{ id: 'cloud-1', embeddedProjectId: current.id, document: current }],
    browserProjects: [{ id: 'browser-1', project: current }],
  });
  assert.equal(result.status, 'match');
  assert.equal(result.source, 'current');
  assert.equal(result.project, current);
});

test('matches a production job only with the complete exact card tuple', () => {
  const installed = project('production-piece');
  const fingerprint = fingerprintCommissioningProject(installed);
  const job = {
    jobId: 'job-7',
    digest: 'b'.repeat(64),
    project: { id: installed.id, revision: 7, fingerprint, restoreSnapshot: installed },
  };
  const productionEvidence = overrides => evidenceFor(installed, {
    projectFingerprint: fingerprint,
    productionJobId: job.jobId,
    productionJobDigest: job.digest,
    ...overrides,
  });
  const exact = resolveCardProject({
    evidence: productionEvidence(),
    productionJobs: [job],
  });
  assert.equal(exact.status, 'match');
  assert.equal(exact.source, 'production');
  assert.equal(exact.candidate, job);

  for (const evidence of [
    productionEvidence({ productionJobDigest: undefined }),
    productionEvidence({ productionJobId: undefined }),
    productionEvidence({ productionJobDigest: 'c'.repeat(64) }),
    productionEvidence({ projectRevision: 8 }),
    productionEvidence({ projectFingerprint: 'f'.repeat(16) }),
  ]) {
    assert.notEqual(resolveCardProject({ evidence, productionJobs: [job] }).status, 'match');
  }
});

test('an incomplete current workspace cannot block an exact production project match', () => {
  const installed = project('production-piece');
  const fingerprint = fingerprintCommissioningProject(installed);
  const job = {
    jobId: 'job-7',
    digest: 'b'.repeat(64),
    project: { id: installed.id, revision: 7, fingerprint, restoreSnapshot: installed },
  };
  const incompleteCurrent = project(installed.id, 'Incomplete local copy');
  incompleteCurrent.layout.strips = [{
    id: 'unfinished-strip', name: 'Unfinished strip', pixelCount: 17, pixels: [],
  }];

  const result = resolveCardProject({
    evidence: {
      ...evidenceFor(installed),
      projectFingerprint: fingerprint,
      productionJobId: job.jobId,
      productionJobDigest: job.digest,
    },
    currentProject: incompleteCurrent,
    productionJobs: [job],
  });

  assert.equal(result.status, 'match');
  assert.equal(result.source, 'production');
});

test('an incomplete workspace has no deployed fingerprint instead of throwing during reconnect correlation', () => {
  const incomplete = project('work-in-progress');
  incomplete.layout.strips = [{
    id: 'unfinished-strip', name: 'Unfinished strip', pixelCount: 17, pixels: [],
  }];

  assert.equal(cardProjectFingerprint(incomplete), '');
});

test('matches an exact active cloud document before an exact browser record', () => {
  const installed = project('cloud-piece');
  const evidence = evidenceFor(installed);
  const result = resolveCardProject({
    evidence,
    cloudProjects: [{ id: 'cloud-1', embeddedProjectId: installed.id, document: installed }],
    browserProjects: [{ id: 'browser-1', project: installed }],
  });
  assert.equal(result.status, 'match');
  assert.equal(result.source, 'cloud');
  assert.equal(result.remoteId, 'cloud-1');
});

test('matches an exact browser record when no higher-priority source matches', () => {
  const installed = project('browser-piece');
  const evidence = evidenceFor(installed);
  const result = resolveCardProject({
    evidence,
    browserProjects: [{ id: 'browser-1', project: installed }],
  });
  assert.equal(result.status, 'match');
  assert.equal(result.source, 'browser');
  assert.equal(result.recordId, 'browser-1');
});

test('never guesses by title and rejects ambiguous exact candidates', () => {
  const installed = project('installed-id', 'Same title');
  const titleOnly = project('different-id', 'Same title');
  assert.equal(resolveCardProject({
    evidence: evidenceFor(installed),
    cloudProjects: [{ id: 'cloud-title', embeddedProjectId: titleOnly.id, document: titleOnly }],
    browserProjects: [{ id: 'browser-title', project: titleOnly }],
  }).status, 'none');

  const exact = { id: 'cloud-a', embeddedProjectId: installed.id, document: installed };
  const ambiguous = resolveCardProject({
    evidence: evidenceFor(installed),
    cloudProjects: [exact, { ...exact, id: 'cloud-b' }],
  });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.source, 'cloud');
  assert.equal(ambiguous.matches.length, 2);
  assert.deepEqual(ambiguous.matches.map(match => match.remoteId), ['cloud-a', 'cloud-b']);
});

test('project identity rejects case and punctuation variants instead of slug-colliding', () => {
  const installed = project('Gallery-Piece.01');
  const evidence = evidenceFor(installed);

  for (const nearId of ['gallery-piece.01', 'Gallery-Piece-01', 'Gallery Piece 01']) {
    assert.notEqual(cardProjectId(nearId), cardProjectId(installed.id));
    const near = { ...installed, id: nearId };
    assert.equal(resolveCardProject({
      evidence,
      currentProject: near,
      cloudProjects: [{ id: 'cloud-near', embeddedProjectId: nearId, document: near }],
      browserProjects: [{ id: 'browser-near', project: near }],
    }).status, 'none');
  }
});

test('card evidence correlation rejects every changed lifecycle and project field', () => {
  const installed = project('correlated-piece');
  const evidence = {
    ...evidenceFor(installed),
    firmwareVersion: '1.2.3',
    buildId: 'a'.repeat(40),
    productionJobId: 'job-7',
    productionJobDigest: 'b'.repeat(64),
  };
  assert.equal(sameCardProjectEvidence(evidence, { ...evidence }), true);
  for (const [field, value] of [
    ['cardId', 'lw-other'],
    ['firmwareVersion', '1.2.4'],
    ['buildId', 'c'.repeat(40)],
    ['projectId', 'other-piece'],
    ['projectRevision', 8],
    ['projectFingerprint', 'f'.repeat(16)],
    ['productionJobId', 'job-8'],
    ['productionJobDigest', 'd'.repeat(64)],
  ]) {
    assert.equal(sameCardProjectEvidence(evidence, { ...evidence, [field]: value }), false, field);
  }
});

test('resolution context rejects stale host, card lifecycle, and Studio generation', () => {
  const context = {
    host: 'lightweaver.local', cardId: 'lw-card', firmwareVersion: '1.2.3',
    buildId: 'a'.repeat(40), bootId: 'boot-1', operationGeneration: 4,
    revalidationGeneration: 2, projectGeneration: 7, workspaceFingerprint: 'b'.repeat(16),
  };
  assert.equal(sameCardResolutionContext(context, { ...context }), true);
  for (const [field, value] of [
    ['host', '192.168.4.1'], ['cardId', 'lw-other'], ['firmwareVersion', '1.2.4'],
    ['buildId', 'c'.repeat(40)], ['bootId', 'boot-2'], ['operationGeneration', 5],
    ['revalidationGeneration', 3], ['projectGeneration', 8], ['workspaceFingerprint', 'd'.repeat(16)],
  ]) {
    assert.equal(sameCardResolutionContext(context, { ...context, [field]: value }), false, field);
  }
  assert.equal(sameCardResolutionContext(context, {
    ...context, projectGeneration: 8, workspaceFingerprint: 'd'.repeat(16),
  }, { workspace: false }), true);
});

test('matching actions identify their project source and immutable revision or record identity', () => {
  const installed = project('labeled-piece', 'Gallery Bloom');
  const evidence = evidenceFor(installed);
  const current = resolveCardProject({ evidence, currentProject: installed });
  assert.equal(describeResolvedCardProject(current), 'Gallery Bloom — current Studio project');

  const production = resolveCardProject({
    evidence: { ...evidence, productionJobId: 'job-7', productionJobDigest: 'b'.repeat(64) },
    productionJobs: [{
      jobId: 'job-7', digest: 'b'.repeat(64),
      project: { id: installed.id, revision: 7, fingerprint: evidence.projectFingerprint, restoreSnapshot: installed },
    }],
  });
  assert.equal(describeResolvedCardProject(production), 'Gallery Bloom — production job job-7, project revision 7');

  const cloud = resolveCardProject({
    evidence,
    cloudProjects: [{ id: 'cloud-1', revision: 12, embeddedProjectId: installed.id, document: installed }],
  });
  assert.equal(describeResolvedCardProject(cloud), 'Gallery Bloom — online revision 12, remote cloud-1');

  const browser = resolveCardProject({
    evidence,
    browserProjects: [{ id: 'browser-1', updatedAt: 123, project: installed }],
  });
  assert.equal(describeResolvedCardProject(browser), 'Gallery Bloom — browser project browser-1');
});

test('duplicate cloud names and revisions still produce distinct action labels', () => {
  const installed = project('duplicate-label-piece', 'Same cloud title');
  const evidence = evidenceFor(installed);
  const result = resolveCardProject({
    evidence,
    cloudProjects: [
      { id: 'cloud-a', revision: 4, embeddedProjectId: installed.id, document: installed },
      { id: 'cloud-b', revision: 4, embeddedProjectId: installed.id, document: installed },
    ],
  });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.matches.map(describeResolvedCardProject), [
    'Same cloud title — online revision 4, remote cloud-a',
    'Same cloud title — online revision 4, remote cloud-b',
  ]);
});
