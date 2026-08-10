import { buildCardRuntimePackageFromProject } from './cardRuntimeProject.js';
import { runtimeConfigUsesKaleidoscope } from './cardKaleidoscope.js';
import { normalizeCardKaleidoscopeMappings } from './cardRuntimeContract.js';
import { connectCardTransport } from './cardTransport.js';

export function prepareCardDeployment(project = {}, cardEvidence = {}) {
  const needsFingerprint = Number.isSafeInteger(project.projectRevision) && project.projectRevision >= 0 && !project.projectFingerprint;
  const baseline = needsFingerprint
    ? buildCardRuntimePackageFromProject({ ...project, projectRevision: undefined, projectFingerprint: undefined })
    : null;
  const runtimePackage = buildCardRuntimePackageFromProject(needsFingerprint
    ? { ...project, projectFingerprint: semanticFingerprint(baseline.config) }
    : project);
  const config = runtimePackage.config;
  return Object.freeze({
    runtimePackage,
    config,
    fingerprint: semanticFingerprint(config),
    cardId: String(cardEvidence.cardId || '').trim(),
    buildId: String(cardEvidence.buildId || '').trim(),
    activationId: String(cardEvidence.activationId || '').trim(),
    revision: Number(config.projectRevision || project.projectRevision || 0),
    previousConfig: cardEvidence.previousConfig || null,
    changes: classifyCardChanges(cardEvidence.previousConfig, config),
  });
}

export function classifyCardDeploymentResume(prepared = {}, status = {}) {
  const state = String(status.state || '').trim().toLowerCase();
  const candidateState = String(status.candidateState || '').trim().toLowerCase();
  const nextStep = String(status.nextStep || '').trim().toLowerCase();
  const hasCandidate = Boolean(status.hasCandidate) || ['staged', 'testing'].includes(state)
    || !['', 'none', 'known-good', 'rolled-back', 'safe-mode'].includes(candidateState);

  if (!hasCandidate) {
    if (!status.cardId && !status.buildId) return 'stage-new';
    return exactText(prepared.cardId, status.cardId) && exactText(prepared.buildId, status.buildId)
      ? 'stage-new'
      : 'candidate-conflict';
  }

  const config = prepared.config || {};
  const exactCandidate = exactText(prepared.cardId, status.cardId)
    && exactText(prepared.buildId, status.buildId)
    && exactNumber(config.projectRevision, status.projectRevision)
    && exactText(config.projectFingerprint, status.projectFingerprint)
    && Boolean(String(status.activationId || '').trim())
    && (!prepared.activationId || exactText(prepared.activationId, status.activationId))
    && optionalIdentityMatches(
      [config.productionJobId, config.productionJobDigest],
      [status.productionJobId, status.productionJobDigest],
    )
    && optionalWiringIdentityMatches(config, status);
  if (!exactCandidate) return 'candidate-conflict';

  if (state === 'staged' || candidateState === 'staged') return 'resume-activation';
  if (candidateState === 'awaiting-confirmation' || /confirm|rollback/.test(nextStep)) {
    return 'resume-confirmation';
  }
  if (nextStep === 'activate') return 'resume-activation';
  return 'resume-physical-test';
}

export function assertCardDeploymentPreflightIdentity(firmwareInfo = {}, status = {}) {
  if (!exactText(firmwareInfo.cardId, status.cardId) || !exactText(firmwareInfo.buildId, status.buildId)) {
    const error = new Error('Card identity or firmware build changed during install preflight. Nothing was sent.');
    error.reason = 'preflight-identity-mismatch';
    throw error;
  }
  return true;
}

export async function orchestrateCardDeploymentStart(prepared, operations = {}) {
  if (typeof operations.readFirmwareInfo !== 'function' ||
      typeof operations.readStatus !== 'function' ||
      typeof operations.readWiringStatus !== 'function') {
    throw new Error('All independent card preflight reads are required before deployment.');
  }
  const [firmwareInfo, status, wiringStatus] = await Promise.all([
    operations.readFirmwareInfo(),
    operations.readStatus(),
    operations.readWiringStatus(),
  ]);
  assertCardDeploymentPreflightIdentity(prepared, firmwareInfo);
  assertCardDeploymentPreflightIdentity(firmwareInfo, status);
  const action = classifyCardDeploymentResume(prepared, wiringStatus);
  if (action !== 'stage-new') return { action, status: wiringStatus, response: null };
  if (typeof operations.config !== 'function') {
    throw new Error('A config mutation is required to stage a new deployment.');
  }
  return { action, status: wiringStatus, response: await operations.config() };
}

export function correlateCardDeploymentReadinessEvidence(project = {}, status = {}) {
  const exactIdentity = exactText(project.cardId, status.cardId)
    && exactText(project.buildId, status.buildId)
    && exactNumber(project.projectRevision, status.projectRevision)
    && exactText(project.projectFingerprint, status.projectFingerprint);
  if (!exactIdentity) {
    const error = new Error('Card readiness did not carry the exact card, build, and project identity.');
    error.reason = 'readiness-identity-mismatch';
    throw error;
  }
  return {
    ...project,
    knownGoodProject: status.knownGoodProject,
    commandReady: status.commandReady,
    runtimePhase: status.runtimePhase,
    playbackReady: status.playbackReady,
    outputReady: status.outputReady,
  };
}

export function classifyCardChanges(previousConfig, nextConfig) {
  if (!previousConfig) return { kind: 'hardware', requiresPhysicalTest: true, groups: ['Wiring'] };
  const previous = hardwareFacts(previousConfig);
  const next = hardwareFacts(nextConfig);
  const groups = [];
  if (stableJson(previous.outputs) !== stableJson(next.outputs)) groups.push('Wiring');
  if (stableJson(previous.power) !== stableJson(next.power)) groups.push('Power');
  if (stableJson(previous.color) !== stableJson(next.color)) groups.push('Calibration');
  return groups.length
    ? { kind: 'hardware', requiresPhysicalTest: true, groups }
    : { kind: 'visual', requiresPhysicalTest: false, groups: ['Playback'] };
}

export function cardStatusAsConfig(status = {}) {
  const led = status.led || {};
  return {
    led: {
      outputs: (status.outputs || []).map((output, index) => {
        const segments = Array.isArray(output.segments) ? output.segments : [];
        const directions = new Set(segments.map(segment => segment.direction || 'forward'));
        return {
          id: output.id || `out${index + 1}`,
          pin: Number(output.pin ?? output.gpio),
          pixels: Number(output.pixels ?? output.count),
          direction: directions.size > 1 ? 'mixed' : [...directions][0] || 'forward',
          segments,
        };
      }),
      maxMilliamps: Number(led.maxMilliamps),
      colorOrder: led.colorOrder,
      outputGammaEnabled: led.outputGammaEnabled,
      outputGammaValue: led.outputGammaValue,
      calibration: led.calibration,
    },
  };
}

export async function runCardDeployment(prepared, transport = {}, callbacks = {}) {
  const state = value => callbacks.onState?.(value);
  state('Sending');
  let response;
  if (prepared.changes.requiresPhysicalTest) {
    response = await transport.stage?.(prepared.runtimePackage);
    if (!response?.activationId) return { installed: false, reason: 'stage-failed' };
    await transport.startTest?.(response.activationId);
    state('Test lights');
    const confirmed = await callbacks.confirmHardware?.(response);
    if (!confirmed) {
      await transport.rollback?.(response.activationId);
      state('Restored previous setup');
      return { installed: false, reason: 'rolled-back' };
    }
    await transport.confirm?.(response.activationId);
  } else {
    response = await transport.install?.(prepared.runtimePackage);
    if (!response?.ok || response.delivered === false) return { installed: false, reason: 'send-failed' };
  }
  state('Verifying card');
  const readBack = await transport.readBack?.();
  const verification = verifyCardDeployment(prepared, readBack, { requireReady: true });
  if (!verification.ok) {
    callbacks.onVerificationFailed?.(verification);
    return { installed: false, reason: verification.reason };
  }
  callbacks.onInstalled?.(verification);
  state('Installed');
  return { installed: true, verification };
}

export function verifyCardDeployment(prepared, readBack = {}, { requireReady = false } = {}) {
  if (!readBack || readBack.cardId !== prepared.cardId) return { ok: false, reason: 'card-mismatch' };
  if (readBack.config && semanticFingerprint(readBack.config) !== prepared.fingerprint) return { ok: false, reason: 'read-back-mismatch' };
  if (!readBack.config && (
    readBack.projectRevision !== prepared.config.projectRevision ||
    readBack.projectFingerprint !== prepared.config.projectFingerprint
  )) return { ok: false, reason: 'read-back-mismatch' };
  if (requireReady && readBack.runtimePhase !== 'ready') return { ok: false, reason: 'runtime-not-ready' };
  if (requireReady && readBack.playbackReady !== true) return { ok: false, reason: 'playback-not-ready' };
  if (requireReady && readBack.outputReady !== true) return { ok: false, reason: 'output-not-ready' };
  if (requireReady && (readBack.knownGoodProject !== true || readBack.commandReady !== true)) {
    return { ok: false, reason: 'card-not-ready' };
  }
  if (runtimeConfigUsesKaleidoscope(prepared.config)) {
    const appliedMappings = readBack.config?.kaleidoscopeMappings ?? readBack.kaleidoscopeMappings;
    if (!Array.isArray(appliedMappings)) return { ok: false, reason: 'read-back-mismatch' };
    try {
      const totalPixels = prepared.config.led?.pixels;
      const zones = prepared.config.zones;
      const expected = normalizeCardKaleidoscopeMappings(
        prepared.config.kaleidoscopeMappings, totalPixels, zones,
      );
      const actual = normalizeCardKaleidoscopeMappings(appliedMappings, totalPixels, zones);
      if (stableJson(actual) !== stableJson(expected)) return { ok: false, reason: 'read-back-mismatch' };
    } catch {
      return { ok: false, reason: 'read-back-mismatch' };
    }
  }
  return { ok: true, cardId: prepared.cardId, fingerprint: prepared.fingerprint };
}

function postSaveVerificationError(reason, message) {
  const error = new Error(message);
  error.reason = reason;
  return error;
}

function installedIds(items = []) {
  return new Set(Array.isArray(items) ? items.map(item => String(item?.id || '')).filter(Boolean) : []);
}

export async function verifyCardPostSaveState({
  prepared,
  host,
  expectedCardId = prepared?.cardId || '',
  requiredPatternIds = [],
  requiredZoneIds = [],
  acquireAuthority = options => connectCardTransport(options),
} = {}) {
  if (!prepared || !expectedCardId) {
    throw postSaveVerificationError('identity-missing', 'Exact card identity is required after saving.');
  }
  const authority = await acquireAuthority({ host, expectedCardId });
  if (!authority?.connected && typeof authority?.request !== 'function') {
    throw postSaveVerificationError(
      authority?.reason || 'direct-unavailable',
      'Studio could not reacquire the exact card after saving.',
    );
  }
  if (String(authority.cardId || authority.card?.id || '') !== expectedCardId) {
    throw postSaveVerificationError('card-mismatch', 'A different Lightweaver card answered after saving.');
  }
  const [status, wiring, patterns, zones] = await Promise.all([
    authority.request('/api/status'),
    authority.request('/api/wiring/status'),
    authority.request('/api/patterns'),
    authority.request('/api/zones'),
  ]);
  const installed = verifyCardDeployment(prepared, status, { requireReady: true });
  if (!installed.ok) throw postSaveVerificationError(installed.reason, 'The card still reports the previous project after saving.');
  if (wiring?.hasCandidate === true || String(wiring?.state || '').toLowerCase() !== 'known-good') {
    throw postSaveVerificationError('wiring-not-known-good', 'The saved wiring is not the card’s known-good setup.');
  }
  const patternIds = installedIds(patterns?.patterns);
  if (requiredPatternIds.some(id => !patternIds.has(String(id)))) {
    throw postSaveVerificationError('patterns-missing', 'The card did not expose every saved pattern.');
  }
  const zoneIds = installedIds(zones?.zones);
  if (requiredZoneIds.some(id => !zoneIds.has(String(id)))) {
    throw postSaveVerificationError('zones-missing', 'The card did not expose every saved section.');
  }
  return { ...installed, status, wiring, patterns, zones, authority };
}

export async function waitForCardDeploymentVerification(prepared, {
  readEvidence,
  attempts = 20,
  intervalMs = 600,
  requireReady = false,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!prepared?.cardId) throw new Error('Exact card identity is required before installation.');
  if (typeof readEvidence !== 'function') throw new Error('Card read-back is required after installation.');
  let last = { ok: false, reason: 'read-back-missing' };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(intervalMs);
    try {
      const evidence = await readEvidence();
      last = verifyCardDeployment(prepared, evidence, { requireReady });
      if (last.ok) return last;
      if (last.reason === 'card-mismatch') {
        throw new Error(`Wrong card answered during verification. Expected ${prepared.cardId}.`);
      }
    } catch (error) {
      if (/Wrong card answered/.test(error?.message || '')) throw error;
      last = { ok: false, reason: error?.reason || 'read-back-missing', error };
    }
  }
  const error = new Error('The card did not verify the exact installed project. Studio still shows the previous installed state.');
  error.reason = last.reason;
  throw error;
}

function exactText(left, right) {
  const a = String(left ?? '').trim();
  const b = String(right ?? '').trim();
  return Boolean(a) && a === b;
}

function exactNumber(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function optionalIdentityMatches(left, right) {
  const a = left.map(value => String(value ?? '').trim().toLowerCase());
  const b = right.map(value => String(value ?? '').trim().toLowerCase());
  if (![...a, ...b].some(Boolean)) return true;
  return a.every((value, index) => Boolean(value) && value === b[index]);
}

function optionalWiringIdentityMatches(config, status) {
  const leftRevision = Number(config.wiringRevision || 0);
  const rightRevision = Number(status.wiringRevision || 0);
  const leftDigest = String(config.wiringDigest || '').trim().toLowerCase();
  const rightDigest = String(status.wiringDigest || '').trim().toLowerCase();
  if (!leftRevision && !rightRevision && !leftDigest && !rightDigest) return true;
  return leftRevision > 0 && leftRevision === rightRevision && Boolean(leftDigest) && leftDigest === rightDigest;
}

function hardwareFacts(config = {}) {
  const led = config.led || {};
  return {
    outputs: (led.outputs || []).map(output => {
      const segments = Array.isArray(output.segments) ? output.segments : [];
      const directions = new Set(segments.map(segment => segment.direction || 'forward'));
      const direction = directions.size > 1
        ? 'mixed'
        : output.direction || [...directions][0] || 'forward';
      return {
        pin: output.pin,
        pixels: output.pixels,
        direction,
        // Boundaries between same-direction runs do not alter electrical
        // output. Preserve the split only when direction changes physically.
        segments: direction === 'mixed'
          ? segments.map(segment => ({ count: segment.count, direction: segment.direction || 'forward' }))
          : [],
      };
    }),
    power: { maxMilliamps: led.maxMilliamps },
    color: {
      colorOrder: led.colorOrder,
      outputGammaEnabled: led.outputGammaEnabled,
      outputGammaValue: led.outputGammaValue,
      calibration: led.calibration,
    },
  };
}

function semanticFingerprint(value) {
  const text = stableJson(value);
  return [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]
    .map(seed => fnv1a(text, seed).toString(16).padStart(8, '0'))
    .join('').repeat(2);
}

function fnv1a(text, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
