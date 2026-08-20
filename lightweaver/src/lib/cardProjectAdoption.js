// Card project adoption — the one guarded path from "this card holds a
// project" to "that project is open in Studio".
//
// This is the safety machine that used to live inline in lw-card.jsx's
// loadMatchingCardProject: the project-switch save barrier, the exact-card
// re-snapshot (/api/firmware-info evidence + /api/status readiness), the
// sameCardResolutionContext / sameCardProjectEvidence drift guards, resolution
// against current/production/cloud/browser sources, edit-intent authorization
// (bound to the STATUS envelope's installed project id — see
// installedProjectIdFromCardStatus in cardReadiness.js for why), and the
// single-flight guard. It moved here verbatim so Setup's lighter adoption
// paths run through the same machine instead of shipping their own weaker
// copies.
//
// Everything effectful is injected through `deps`, so the machine is a pure
// orchestration unit-testable without React or a browser:
//
//   deps = {
//     context: { ready, cardLink, cardHost, currentProject, projectGeneration,
//                activeCloudProjects, browserProjects },
//     getLatestContext,   // () => the LIVE { ready, cardLink, currentProject,
//                         //   projectGeneration, browserProjects } — never the
//                         //   snapshot the run started from
//     getSharedCardLink,  // () => the shared card-link state (getCardLinkState)
//     isCardLinkConnected,
//     io: { readCardProjectEvidence, readCardStatusEnvelope,
//           loadProductionJobIndex, loadProductionJobFromIndexEntry,
//           readCloudProject?, readBrowserProjects?,
//           readCardPatternsFromCard?, readCardZonesFromCard? },
//     actions: { replaceProject, saveBeforeCardProjectSwitch?,
//                isProjectSwitchSnapshotCurrent?, openMatchingCardProject?,
//                onMatchedProjectLoaded?, onMatchedProjectVerified?,
//                applyCardParts? },
//     authorization: { clearCardEditAuthorization, issueCardEditAuthorization,
//                      issueSignedProductionCardEditAuthorization,
//                      clearAbandonedCardEditIntent, getCardEditIntent },
//     ui: { report, openPatterns },
//     flight: { inFlight, pendingProbe, probeSignature }, // ref-like {current}
//     requestProbe,       // () => void — re-arm the background probe
//   }
//
// Three named strategies:
//   'resolved'    — resolve the card's installed project against Studio's
//                   sources and open the exact match (the full machine).
//   'probe'       — the same resolution, stopping at an offer; nothing is
//                   saved or replaced.
//   'reconstruct' — rebuild a project from the card's own /api/status +
//                   installed patterns + zones readback (Setup's "Use this
//                   card's project"), applied through the caller's
//                   applyCardParts.
import { classifyCardReadiness, installedProjectIdFromCardStatus } from './cardReadiness.js';
import { normalizeCardHost } from './cardConnection.js';
import {
  cardProjectFingerprint,
  cardProjectId,
  describeResolvedCardProject,
  resolveCardProject,
  sameCardProjectEvidence,
  sameCardResolutionContext,
} from './cardProjectResolver.js';
import { projectSkeletonFromCardStatus } from './discoveryCommit.js';
import { createDefaultProject } from './projectModel.js';

export const SAVE_FAILURE_MESSAGES = Object.freeze({
  'browser-recovery-failed': 'Studio could not create a browser recovery copy. Your current project is still open; free browser storage and retry.',
  offline: 'The current online project has not been saved because Studio is offline. Reconnect, then retry.',
  queued: 'The current online save is still pending. Wait for Saved online, then retry.',
  conflict: 'The current online project has a save conflict. Resolve it in Preferences before switching.',
  'stale-session': 'Your session changed before the current project was saved. Sign in again, then retry.',
  'workspace-changed': 'The current project changed while Studio was saving it. Your edits are still open; retry to save the newest version.',
  'association-handoff-failed': 'Studio could not establish a safe save destination for this project. Saving is blocked; open another project or retry after browser storage is available.',
});

export function projectSwitchSaveFailureMessage(reason) {
  return SAVE_FAILURE_MESSAGES[reason]
    || 'Studio could not confirm that the current project was saved. Your current project is still open; retry before switching.';
}

export function resolvedMatchKey(match) {
  if (match?.source === 'cloud') return `cloud:${match.remoteId}:${match.candidate?.revision ?? ''}`;
  if (match?.source === 'browser') return `browser:${match.recordId}`;
  if (match?.source === 'production') return `production:${match.candidate?.jobId}:${match.candidate?.digest}`;
  return `current:${match?.project?.id || ''}`;
}

function visualLookFromZone(zone = {}, fallbackPatternId = 'aurora') {
  return {
    patternId: zone.patternId || fallbackPatternId,
    ...(Number.isFinite(Number(zone.brightness)) ? { brightness: Number(zone.brightness) } : {}),
    ...(Number.isFinite(Number(zone.speed)) ? { speed: Number(zone.speed) } : {}),
    ...(Number.isFinite(Number(zone.hueShift)) ? { hueShift: Number(zone.hueShift) } : {}),
    ...(Number.isFinite(Number(zone.customHue)) ? { customHue: Number(zone.customHue) } : {}),
    ...(Number.isFinite(Number(zone.customSaturation)) ? { customSaturation: Number(zone.customSaturation) } : {}),
    ...(typeof zone.customBreathe === 'boolean' ? { customBreathe: zone.customBreathe } : {}),
    ...(Number.isFinite(Number(zone.breatheLowerPct)) ? { breatheLowerPct: Number(zone.breatheLowerPct) } : {}),
    ...(Number.isFinite(Number(zone.breatheUpperPct)) ? { breatheUpperPct: Number(zone.breatheUpperPct) } : {}),
    ...(Number.isFinite(Number(zone.breatheCycleSeconds)) ? { breatheCycleSeconds: Number(zone.breatheCycleSeconds) } : {}),
    ...(typeof zone.customDrift === 'boolean' ? { customDrift: zone.customDrift } : {}),
  };
}

export function reconstructInstalledCardState({ skeleton = {}, patterns = null, zones = null } = {}) {
  const installedPatterns = Array.isArray(patterns?.patterns) ? patterns.patterns : [];
  const installedZones = Array.isArray(zones?.zones) ? zones.zones : [];
  const startupPatternId = String(zones?.startupPatternId || installedZones[0]?.patternId || installedPatterns[0]?.id || 'aurora');
  const startupZone = installedZones.find(zone => zone?.patternId === startupPatternId) || installedZones[0] || {};
  const looks = installedPatterns.map(pattern => ({
      id: pattern.id,
      type: 'compound',
      label: pattern.label || pattern.id,
      defaultLook: visualLookFromZone(pattern.zones?.[0], pattern.runtimePatternId || pattern.id || startupPatternId),
      sectionLooks: Object.fromEntries((pattern.zones || [])
        .filter(zone => zone?.id)
        .map(zone => [zone.id, visualLookFromZone(zone, pattern.runtimePatternId || pattern.id || startupPatternId)])),
      updatedAt: 0,
    }));
  const playlist = installedPatterns.map((pattern, index) => ({
    id: pattern.id,
    type: 'combo',
    lookId: pattern.id,
    label: pattern.label || pattern.id,
    enabled: true,
    createdAt: index,
  }));
  return {
    ...skeleton,
    devices: {
      standaloneController: {
        defaultLook: visualLookFromZone(startupZone, startupPatternId),
        activeLookId: String(patterns?.currentId || startupPatternId),
        looks,
        playlist,
        controls: { encoder: { patternCycleIds: looks.map(look => look.defaultLook.patternId) } },
      },
    },
  };
}

// The 'reconstruct' strategy: lw-setup's startFromCard, verbatim. Reads the
// card's status (retrying over direct transport on http pages when the first
// answer omits geometry), tolerates missing patterns/zones endpoints (a legacy
// card must still adopt from the status skeleton alone), and hands the
// reconstructed parts to the caller's applyCardParts. Returns a result instead
// of reporting, so the calling screen keeps its own failure copy.
async function runReconstructStrategy(deps, params = {}) {
  const { context, io, actions } = deps;
  const cardLink = context.cardLink;
  const readHost = cardLink?.host || context.cardHost || '';
  let status = params.initialStatus || null;
  try {
    status = await io.readCardStatusEnvelope({ host: readHost, transport: cardLink?.transport });
    if ((!Array.isArray(status?.outputs) || !status.outputs.length) && params.allowDirectRetry) {
      status = await io.readCardStatusEnvelope({ host: readHost, transport: 'direct' });
    }
    params.onStatus?.(status);
  } catch {
    // A recently completed background read is still authoritative. The
    // readiness summary is intentionally last because it may omit geometry.
    status = status || cardLink?.readiness || null;
  }
  const installedState = await Promise.allSettled([
    io.readCardPatternsFromCard({ host: readHost }),
    io.readCardZonesFromCard({ host: readHost }),
  ]);
  const patterns = installedState[0].status === 'fulfilled' ? installedState[0].value : null;
  const zones = installedState[1].status === 'fulfilled' ? installedState[1].value : null;
  const skeleton = projectSkeletonFromCardStatus(status || {});
  if (!skeleton.strips.length) {
    return { ok: false, reason: 'no-geometry', status };
  }
  try {
    const applied = await actions.applyCardParts(reconstructInstalledCardState({ skeleton, patterns, zones }), status);
    if (!applied?.ok) return { ok: false, reason: applied?.reason, status };
    return { ok: true, status };
  } catch (error) {
    return { ok: false, reason: '', error, status };
  }
}

async function runResolvedStrategy(deps, {
  probeOnly = false,
  selectionKey = '',
  autoIntent = '',
  probeSignature = '',
} = {}) {
  const { context, io, actions, authorization, ui, flight } = deps;
  const {
    cardLink,
    cardHost,
    currentProject,
    projectGeneration,
    activeCloudProjects = [],
    browserProjects = [],
    ready,
  } = context;
  if (!ready) return;
  if (flight.inFlight.current) {
    if (probeSignature) {
      flight.pendingProbe.current = { probeOnly, autoIntent, probeSignature };
    }
    return;
  }
  flight.inFlight.current = true;
  if (probeSignature) {
    flight.probeSignature.current = probeSignature;
    if (flight.pendingProbe.current?.probeSignature === probeSignature) {
      flight.pendingProbe.current = null;
    }
  }
  ui.report({ status: 'loading', message: 'Reading the exact project installed on this card…' });
  let replacementCommitted = false;
  let associationHandoffFailed = false;
  let replacementCloudSessionLost = false;
  authorization.clearCardEditAuthorization();
  try {
    const requestContext = {
      host: normalizeCardHost(cardLink?.host || cardHost),
      cardId: String(cardLink?.card?.id || '').trim(),
      firmwareVersion: String(cardLink?.card?.firmwareVersion || '').trim(),
      buildId: String(cardLink?.card?.buildId || '').trim(),
      bootId: String(cardLink?.validatedBootId || cardLink?.readiness?.bootId || '').trim(),
      operationGeneration: Number(cardLink?.operationGeneration || 0),
      revalidationGeneration: Number(cardLink?.revalidationGeneration || 0),
      projectGeneration,
      workspaceFingerprint: cardProjectFingerprint(currentProject),
    };
    const assertContextCurrent = ({ workspace = true } = {}) => {
      const latest = deps.getLatestContext() || {};
      const latestLink = latest.cardLink || {};
      const sharedLink = deps.getSharedCardLink();
      const contextFrom = (link, includeWorkspace = false) => ({
        host: normalizeCardHost(link.host || cardHost),
        cardId: String(link.card?.id || '').trim(),
        firmwareVersion: String(link.card?.firmwareVersion || '').trim(),
        buildId: String(link.card?.buildId || '').trim(),
        bootId: String(link.validatedBootId || link.readiness?.bootId || '').trim(),
        operationGeneration: Number(link.operationGeneration || 0),
        revalidationGeneration: Number(link.revalidationGeneration || 0),
        ...(includeWorkspace ? {
          projectGeneration: latest.projectGeneration,
          workspaceFingerprint: cardProjectFingerprint(latest.currentProject),
        } : {}),
      });
      if (!latest.ready
        || !sameCardResolutionContext(requestContext, contextFrom(latestLink, true), { workspace })
        || (sharedLink.card?.id && (
          !deps.isCardLinkConnected(sharedLink)
          || !sameCardResolutionContext(requestContext, contextFrom(sharedLink), { workspace: false })
        ))) {
        throw new Error('The card or open Studio project changed while resolving. Nothing was replaced.');
      }
    };
    const readExactCardSnapshot = async (expectedEvidence = null, { workspace = true } = {}) => {
      const [evidence, status] = await Promise.all([
        io.readCardProjectEvidence({ host: requestContext.host, transport: cardLink?.transport }),
        io.readCardStatusEnvelope({ host: requestContext.host, transport: cardLink?.transport }),
      ]);
      const exactReadiness = classifyCardReadiness(status, {
        expectedCard: {
          id: requestContext.cardId,
          firmwareVersion: requestContext.firmwareVersion,
          buildId: requestContext.buildId,
        },
        previousBootId: requestContext.bootId,
      });
      if (!requestContext.cardId
        || exactReadiness.patternAccess !== 'ready'
        || evidence.cardId !== requestContext.cardId
        || (requestContext.firmwareVersion && evidence.firmwareVersion !== requestContext.firmwareVersion)
        || (requestContext.buildId && evidence.buildId !== requestContext.buildId)) {
        throw new Error('The exact card is no longer Ready. Nothing was replaced.');
      }
      if (expectedEvidence && !sameCardProjectEvidence(expectedEvidence, evidence)) {
        throw new Error('The project installed on the card changed while Studio was resolving it. Nothing was replaced.');
      }
      assertContextCurrent({ workspace });
      return evidence;
    };
    const evidence = await readExactCardSnapshot();
    const authorizeResolvedProject = (project, generation, signedProductionProject = null) => {
      // Bind the installed project id from the STATUS envelope, because that
      // is the only payload Patterns can see when it claims this
      // authorization. Binding it from /api/firmware-info instead — which
      // carries the same id under `piece.id` — issued authorizations that
      // Patterns could never claim on firmware that predates `projectId` on
      // /api/status, and the handoff looped rather than opening.
      const statusProjectId = installedProjectIdFromCardStatus(cardLink?.readiness);
      if (!statusProjectId) {
        throw new Error('This card’s firmware does not report which project is installed, so Studio cannot open Patterns against it. Update the card from Install or update, then try again.');
      }
      if (evidence.projectId && evidence.projectId !== statusProjectId) {
        throw new Error('The card reported two different installed projects while Studio was resolving it. Nothing was opened in Patterns.');
      }
      const binding = {
        intent: authorization.getCardEditIntent(),
        cardId: evidence.cardId,
        firmwareVersion: evidence.firmwareVersion,
        buildId: evidence.buildId,
        bootId: requestContext.bootId,
        installedProjectId: statusProjectId,
        installedProjectFingerprint: evidence.projectFingerprint,
        studioProjectId: project?.id,
        studioProjectFingerprint: cardProjectFingerprint(project),
        projectGeneration: generation,
      };
      const issued = signedProductionProject
        ? authorization.issueSignedProductionCardEditAuthorization(binding, signedProductionProject)
        : authorization.issueCardEditAuthorization(binding);
      if (!issued) {
        throw new Error('Studio could not authorize this exact card and project for Pattern commands. Nothing was opened in Patterns.');
      }
      // A fresh grant supersedes an earlier failed claim: whatever went
      // wrong last time, this card and this project are authorized now.
      authorization.clearAbandonedCardEditIntent();
    };

    const productionJobs = [];
    if (evidence.productionJobId || evidence.productionJobDigest) {
      const index = await io.loadProductionJobIndex();
      const entry = index.jobs.find(candidate => candidate.jobId === evidence.productionJobId);
      if (!entry || entry.digest !== evidence.productionJobDigest) {
        throw new Error('No verified production project matches the exact job digest reported by this card.');
      }
      productionJobs.push(await io.loadProductionJobFromIndexEntry(entry));
    }

    // Resolve sources in priority order. In particular, an already-open
    // exact project must remain usable when the online library is offline.
    let resolved = resolveCardProject({
      evidence,
      currentProject,
      productionJobs,
    });
    if (resolved.status === 'none') {
      const cloudMetadata = activeCloudProjects.filter(project => (
        cardProjectId(project?.embeddedProjectId) === cardProjectId(evidence.projectId)
      ));
      const cloudProjects = io.readCloudProject
        ? await Promise.all(cloudMetadata.map(async metadata => ({
            ...metadata,
            ...(await io.readCloudProject(metadata.id)),
          })))
        : [];
      const freshBrowserProjects = io.readBrowserProjects?.() || browserProjects;
      resolved = resolveCardProject({ evidence, cloudProjects, browserProjects: freshBrowserProjects });
    }
    // Source discovery may include production package fetches and multiple
    // cloud reads. Do not publish an offer/ambiguity from that stale window.
    await readExactCardSnapshot(evidence);
    if (resolved.status === 'ambiguous') {
      if (!selectionKey) {
        ui.report({
          status: 'ambiguous',
          message: 'More than one exact active match was found. Choose the project to load; Studio will verify it again before replacing anything.',
          matches: resolved.matches,
        });
        return;
      }
      resolved = resolved.matches.find(match => resolvedMatchKey(match) === selectionKey);
      if (!resolved) throw new Error('The selected exact match changed. Nothing was replaced.');
    }
    if (resolved.status !== 'match') {
      throw new Error('No active Studio project exactly matches the project identity on this card.');
    }
    if (selectionKey && resolvedMatchKey(resolved) !== selectionKey) {
      throw new Error('The selected exact match changed. Nothing was replaced.');
    }
    if (probeOnly) {
      ui.report({
        status: 'offer',
        message: `Exact match found: “${describeResolvedCardProject(resolved)}”. Load it to save the current workspace and continue to Patterns.`,
        selectionKey: resolvedMatchKey(resolved),
        matchLabel: describeResolvedCardProject(resolved),
      });
      return;
    }
    if (autoIntent && resolved.source !== 'current') {
      ui.report({
        status: 'offer',
        message: `Exact match found: “${describeResolvedCardProject(resolved)}”. Load it to save the current workspace before Studio opens the card project.`,
        selectionKey: resolvedMatchKey(resolved),
        matchLabel: describeResolvedCardProject(resolved),
      });
      return;
    }
    if (resolved.source === 'current') {
      await readExactCardSnapshot(evidence);
      if (autoIntent && authorization.getCardEditIntent() !== autoIntent) {
        throw new Error('The requested pattern or look changed while Studio was resolving the card. Nothing was opened.');
      }
      authorizeResolvedProject(resolved.project, projectGeneration);
      ui.openPatterns();
      return;
    }

    ui.report({ status: 'saving', message: 'Saving current project…' });
    let savedCurrent;
    try {
      savedCurrent = await actions.saveBeforeCardProjectSwitch?.();
    } catch {
      savedCurrent = { ok: false, reason: 'authoritative-save-failed' };
    }
    if (!savedCurrent?.ok) {
      throw new Error(projectSwitchSaveFailureMessage(savedCurrent?.reason));
    }
    const assertSavedProjectStillCurrent = () => {
      if (!savedCurrent.snapshot
        || actions.isProjectSwitchSnapshotCurrent?.(savedCurrent.snapshot) !== true) {
        throw new Error(projectSwitchSaveFailureMessage('workspace-changed'));
      }
    };
    assertSavedProjectStillCurrent();
    await readExactCardSnapshot(evidence);
    assertSavedProjectStillCurrent();

    if (resolved.source === 'cloud') {
      const result = await actions.openMatchingCardProject?.(resolved.remoteId, evidence, {
        expectedRevision: resolved.candidate?.revision,
        currentProjectSaved: true,
        beforeMutation: async () => {
          await readExactCardSnapshot(evidence);
          assertSavedProjectStillCurrent();
        },
      });
      if (!result?.ok) {
        if (result?.replacementCommitted === true) {
          replacementCommitted = true;
          const associationResult = await actions.onMatchedProjectLoaded?.({
            source: 'unassociated',
            remoteId: resolved.remoteId,
          });
          if (!associationResult?.ok) {
            associationHandoffFailed = true;
            throw new Error(projectSwitchSaveFailureMessage('association-handoff-failed'));
          }
          replacementCloudSessionLost = true;
          throw new Error('The online project was loaded, but the session changed before Studio could associate it.');
        }
        throw new Error(result?.reason === 'precondition-changed'
          ? 'The card or current project changed after saving. Your current project is still open; retry.'
          : result?.reason === 'cancelled'
            ? 'The current Studio project was kept.'
            : 'The active online project changed or was archived before Studio could open it. Nothing was opened in Patterns.');
      }
      replacementCommitted = true;
      const associationResult = await actions.onMatchedProjectLoaded?.({
        source: 'cloud',
        remoteId: resolved.remoteId,
      });
      if (!associationResult?.ok) {
        associationHandoffFailed = true;
        throw new Error(projectSwitchSaveFailureMessage('association-handoff-failed'));
      }
      const verifiedEvidence = await readExactCardSnapshot(evidence, { workspace: false });
      const installed = actions.onMatchedProjectVerified?.({ evidence: verifiedEvidence, expectedMarker: result.marker });
      if (installed?.ok !== true) {
        throw new Error('The matching project loaded, but Studio could not bind its exact installed revision. Controls remain paused.');
      }
      authorizeResolvedProject(resolved.project, projectGeneration + 1);
      ui.openPatterns();
      return;
    }
    let revalidated = null;
    if (resolved.source === 'browser') {
      revalidated = resolveCardProject({
        evidence,
        browserProjects: io.readBrowserProjects?.() || [],
      });
    } else if (resolved.source === 'production') {
      const freshIndex = await io.loadProductionJobIndex();
      const freshEntry = freshIndex.jobs.find(candidate => candidate.jobId === evidence.productionJobId);
      const freshJobs = freshEntry?.digest === evidence.productionJobDigest
        ? [await io.loadProductionJobFromIndexEntry(freshEntry)]
        : [];
      revalidated = resolveCardProject({ evidence, productionJobs: freshJobs });
    }
    if (revalidated?.status !== 'match' || resolvedMatchKey(revalidated) !== resolvedMatchKey(resolved)) {
      throw new Error('The selected project changed while Studio was saving the current project. Nothing was replaced.');
    }
    resolved = revalidated;
    if (resolved.source === 'production') {
      // The index and signed package were both reread after confirmation;
      // bind their result to one last exact live card/workspace snapshot.
      await readExactCardSnapshot(evidence);
    }
    assertSavedProjectStillCurrent();

    let studioProject = resolved.project;
    if (resolved.source === 'production') {
      const snapshot = resolved.candidate.project.restoreSnapshot;
      const defaults = createDefaultProject();
      studioProject = {
        ...defaults,
        id: snapshot.id,
        name: snapshot.name,
        layout: { ...defaults.layout, ...snapshot.layout, starterPending: false },
        devices: { ...defaults.devices, ...snapshot.devices },
      };
    }
    const result = await actions.replaceProject(studioProject, { confirmDiscard: () => true });
    if (!result.ok) {
      ui.report({
        status: result.reason === 'cancelled' ? 'idle' : 'error',
        message: result.reason === 'cancelled' ? 'The current Studio project was kept.' : 'The matching card project could not be opened.',
      });
      return;
    }
    replacementCommitted = true;
    const associationResult = await actions.onMatchedProjectLoaded?.({
      source: resolved.source,
      expectedMarker: result.marker,
      recordId: resolved.recordId,
      recordSnapshot: resolved.source === 'browser'
        ? { recordId: resolved.recordId, record: resolved.candidate }
        : null,
      remoteId: resolved.remoteId,
    });
    if (!associationResult?.ok) {
      associationHandoffFailed = true;
      throw new Error(projectSwitchSaveFailureMessage('association-handoff-failed'));
    }
    const verifiedEvidence = await readExactCardSnapshot(evidence, { workspace: false });
    const installed = actions.onMatchedProjectVerified?.({ evidence: verifiedEvidence, expectedMarker: result.marker });
    if (installed?.ok !== true) {
      throw new Error('The matching project loaded, but Studio could not bind its exact installed revision. Controls remain paused.');
    }
    authorizeResolvedProject(studioProject, projectGeneration + 1, resolved.source === 'production' ? {
      jobId: resolved.candidate.jobId,
      jobDigest: resolved.candidate.digest,
      projectId: resolved.candidate.project.id,
      projectFingerprint: resolved.candidate.project.fingerprint,
    } : null);
    ui.openPatterns();
  } catch (error) {
    ui.report({
      status: 'error',
      message: associationHandoffFailed
        ? 'The matching project was loaded and your previous project was saved, but Studio could not establish a safe save destination for the loaded project. Saving is blocked; open another project or retry after browser storage is available.'
        : replacementCloudSessionLost
          ? 'The matching online project was loaded and your previous project was saved, but your session changed before Studio could associate the loaded project. Sign in again before saving online.'
        : replacementCommitted
        ? 'The matching project was loaded and your previous project was saved, but Studio could not complete the final card check. Reconnect the card before changing patterns.'
        : error?.message || 'The matching card project could not be loaded.',
    });
  } finally {
    flight.inFlight.current = false;
    const pendingProbe = flight.pendingProbe.current;
    if (pendingProbe && pendingProbe.probeSignature !== flight.probeSignature.current) {
      flight.pendingProbe.current = null;
      deps.requestProbe?.();
    }
  }
}

export async function guardedResolutionRun(deps, params = {}) {
  const strategy = params.strategy || 'resolved';
  if (strategy === 'reconstruct') return runReconstructStrategy(deps, params);
  return runResolvedStrategy(deps, { ...params, probeOnly: strategy === 'probe' });
}
