import { prepareCardDeployment } from './cardDeployment.js';
import { normalizePatchBoard } from './patchBoard.js';

export function cardProjectFingerprint(project) {
  try {
    const strips = project?.layout?.strips || [];
    return prepareCardDeployment({
      projectId: project?.id,
      projectName: project?.name,
      projectRevision: 0,
      strips,
      // The live install surface always normalizes the patch board before it
      // builds the runtime package. Matching must hash that same canonical
      // board or a reconstructed card project can never appear installed.
      patchBoard: project?.layout?.patchBoard
        ? normalizePatchBoard(project.layout.patchBoard, strips)
        : null,
      wiring: project?.layout?.wiring || null,
      standaloneController: project?.devices?.standaloneController || {},
    }).config.projectFingerprint;
  } catch {
    return '';
  }
}

export function cardProjectId(value) {
  return typeof value === 'string' ? value : '';
}

export function matchesCardProjectEvidence(project, evidence) {
  if (!project || typeof project !== 'object'
    || cardProjectId(project.id) !== cardProjectId(evidence.projectId)) return false;
  return cardProjectFingerprint(project) === evidence.projectFingerprint;
}

const CARD_PROJECT_EVIDENCE_FIELDS = Object.freeze([
  'cardId',
  'firmwareVersion',
  'buildId',
  'projectId',
  'projectRevision',
  'projectFingerprint',
  'productionJobId',
  'productionJobDigest',
]);

export function sameCardProjectEvidence(expected = {}, actual = {}) {
  return CARD_PROJECT_EVIDENCE_FIELDS.every(field => (
    (expected[field] ?? '') === (actual[field] ?? '')
  ));
}

const CARD_RESOLUTION_CONTEXT_FIELDS = Object.freeze([
  'host',
  'cardId',
  'firmwareVersion',
  'buildId',
  'bootId',
  'operationGeneration',
  'revalidationGeneration',
]);

export function sameCardResolutionContext(expected = {}, actual = {}, { workspace = true } = {}) {
  return CARD_RESOLUTION_CONTEXT_FIELDS.every(field => expected[field] === actual[field])
    && (!workspace || (
      expected.projectGeneration === actual.projectGeneration
      && expected.workspaceFingerprint === actual.workspaceFingerprint
    ));
}

export function describeResolvedCardProject(match) {
  const name = String(
    match?.project?.name
    || match?.candidate?.project?.restoreSnapshot?.name
    || match?.project?.id
    || 'Matching project',
  );
  if (match?.source === 'current') return `${name} — current Studio project`;
  if (match?.source === 'cloud') {
    return `${name} — online revision ${match.candidate?.revision ?? 'unknown'}, remote ${match.remoteId || 'unknown'}`;
  }
  if (match?.source === 'browser') return `${name} — browser project ${match.recordId || 'unknown'}`;
  if (match?.source === 'production') {
    return `${name} — production job ${match.candidate?.jobId || 'unknown'}, project revision ${match.candidate?.project?.revision ?? 'unknown'}`;
  }
  return name;
}

function oneMatch(matches, source, projectOf) {
  if (!matches.length) return null;
  const resolved = matches.map(candidate => {
    const match = { status: 'match', source, project: projectOf(candidate), candidate };
    if (source === 'cloud') match.remoteId = candidate.id;
    if (source === 'browser') match.recordId = candidate.id;
    return match;
  });
  return resolved.length > 1 ? { status: 'ambiguous', source, matches: resolved } : resolved[0];
}

export function resolveCardProject({
  evidence = {},
  currentProject = null,
  productionJobs = [],
  cloudProjects = [],
  browserProjects = [],
} = {}) {
  const hasJobId = typeof evidence.productionJobId === 'string' && evidence.productionJobId.length > 0;
  const hasJobDigest = typeof evidence.productionJobDigest === 'string' && evidence.productionJobDigest.length > 0;
  if (!cardProjectId(evidence.projectId)
    || !Number.isSafeInteger(evidence.projectRevision)
    || evidence.projectRevision < 0
    || !/^[a-f0-9]{16,64}$/.test(evidence.projectFingerprint || '')
    || hasJobId !== hasJobDigest
    || (hasJobId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(evidence.productionJobId))
    || (hasJobDigest && !/^[a-f0-9]{64}$/.test(evidence.productionJobDigest))) {
    return { status: 'invalid' };
  }

  if (matchesCardProjectEvidence(currentProject, evidence)) {
    return { status: 'match', source: 'current', project: currentProject, candidate: currentProject };
  }

  if (hasJobId) {
    const productionMatches = productionJobs.filter(job => (
      job?.jobId === evidence.productionJobId
      && job?.digest === evidence.productionJobDigest
      && cardProjectId(job?.project?.id) === cardProjectId(evidence.projectId)
      && job?.project?.revision === evidence.projectRevision
      && job?.project?.fingerprint === evidence.projectFingerprint
    ));
    const production = oneMatch(productionMatches, 'production', job => job.project.restoreSnapshot);
    if (production) return production;
  }

  const cloud = oneMatch(
    cloudProjects.filter(remote => (
      cardProjectId(remote?.embeddedProjectId || remote?.document?.id) === cardProjectId(evidence.projectId)
      && matchesCardProjectEvidence(remote?.document, evidence)
    )),
    'cloud',
    remote => remote.document,
  );
  if (cloud) return cloud;

  const browser = oneMatch(
    browserProjects.filter(record => matchesCardProjectEvidence(record?.project, evidence)),
    'browser',
    record => record.project,
  );
  if (browser) return browser;

  return { status: 'none' };
}
