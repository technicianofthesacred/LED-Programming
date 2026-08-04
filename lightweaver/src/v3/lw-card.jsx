import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AutomaticInstallScreen, TechnicianFlashScreen } from './lw-flash.jsx';
import { InstallerScreen } from './lw-installer.jsx';
import { DeploymentCheckPanel } from '../components/card/DeploymentCheckPanel.jsx';
import { ProductionScreen } from './lw-production.jsx';
import { SettingsScreen } from './lw-settings.jsx';
import { consumeCardSectionNavigation } from './cardWorkspaceRoute.js';
import { cardLinkReasonText, getCardLinkState, isCardLinkConnected } from '../lib/cardLink.js';
import {
  CARD_COMMISSIONING_CHANGED_EVENT,
  inspectCardCommissioning,
} from '../lib/cardCommissioningFlow.js';
import { loadProductionJobFromIndexEntry, loadProductionJobIndex } from '../lib/productionJobPackage.js';
import { createDefaultProject } from '../lib/projectModel.js';
import { readCardProjectEvidence, readCardStatusEnvelope } from '../lib/cardPushClient.js';
import { recoverCardLights } from '../lib/cardLiveControl.js';
import {
  cardProjectFingerprint,
  cardProjectId,
  describeResolvedCardProject,
  resolveCardProject,
  sameCardProjectEvidence,
  sameCardResolutionContext,
} from '../lib/cardProjectResolver.js';
import { normalizeCardHost } from '../lib/cardConnection.js';
import { classifyCardReadiness } from '../lib/cardReadiness.js';
import {
  clearCardEditAuthorization,
  issueCardEditAuthorization,
  issueSignedProductionCardEditAuthorization,
} from '../lib/cardEditAuthorization.js';

// Section bar labels. `workshop` is deliberately absent: Batch production is a
// manufacturing surface reached from the overview link, the support tile, or a
// deep link (#screen=production / #screen=card&section=workshop) — never a tab.
const SECTION_LABELS = Object.freeze({
  overview: 'Hardware',
  install: 'Install or update',
  settings: 'Hardware settings',
  support: 'Advanced & Support',
  preferences: 'Preferences',
});

const SAVE_FAILURE_MESSAGES = Object.freeze({
  'browser-recovery-failed': 'Studio could not create a browser recovery copy. Your current project is still open; free browser storage and retry.',
  offline: 'The current online project has not been saved because Studio is offline. Reconnect, then retry.',
  queued: 'The current online save is still pending. Wait for Saved online, then retry.',
  conflict: 'The current online project has a save conflict. Resolve it in Preferences before switching.',
  'stale-session': 'Your session changed before the current project was saved. Sign in again, then retry.',
  'workspace-changed': 'The current project changed while Studio was saving it. Your edits are still open; retry to save the newest version.',
  'association-handoff-failed': 'Studio could not establish a safe save destination for this project. Saving is blocked; open another project or retry after browser storage is available.',
});

function projectSwitchSaveFailureMessage(reason) {
  return SAVE_FAILURE_MESSAGES[reason]
    || 'Studio could not confirm that the current project was saved. Your current project is still open; retry before switching.';
}

function resolvedMatchKey(match) {
  if (match?.source === 'cloud') return `cloud:${match.remoteId}:${match.candidate?.revision ?? ''}`;
  if (match?.source === 'browser') return `browser:${match.recordId}`;
  if (match?.source === 'production') return `production:${match.candidate?.jobId}:${match.candidate?.digest}`;
  return `current:${match?.project?.id || ''}`;
}

function cardEditIntent() {
  const params = new URLSearchParams(window.location.search);
  const pattern = String(params.get('editPattern') || '').trim();
  const look = String(params.get('editLook') || '').trim();
  if (pattern) return `pattern:${pattern}`;
  if (look) return `look:${look}`;
  return '';
}

function CardOverview({
  connected,
  cardHost,
  cardLink,
  onConnectCard,
  onOpenConnectionCenter,
  onOpenSection,
  go,
  replaceProject,
  currentProject,
  projectGeneration,
  activeCloudProjects = [],
  browserProjects = [],
  readBrowserProjects,
  readCloudProject,
  openMatchingCardProject,
  saveBeforeCardProjectSwitch,
  isProjectSwitchSnapshotCurrent,
  onMatchedProjectLoaded,
}) {
  const [commissioningFlow, setCommissioningFlow] = useState(() => inspectCardCommissioning().flow);
  const [matchingProjectState, setMatchingProjectState] = useState({ status: 'idle', message: '' });
  const [hardwareActionState, setHardwareActionState] = useState({ status: 'idle', message: '' });
  const resolutionContextRef = useRef(null);
  const projectSwitchInFlightRef = useRef(false);
  const cardProjectProbeRef = useRef('');
  const pendingCardProjectProbeRef = useRef(null);
  const [cardProjectProbeRevision, requestCardProjectProbe] = React.useReducer(value => value + 1, 0);
  resolutionContextRef.current = {
    browserProjects,
    cardLink,
    currentProject,
    projectGeneration,
    ready: cardLink ? isCardLinkConnected(cardLink) : connected,
  };
  useEffect(() => {
    const syncCommissioning = () => setCommissioningFlow(inspectCardCommissioning().flow);
    window.addEventListener('storage', syncCommissioning);
    window.addEventListener(CARD_COMMISSIONING_CHANGED_EVENT, syncCommissioning);
    return () => {
      window.removeEventListener('storage', syncCommissioning);
      window.removeEventListener(CARD_COMMISSIONING_CHANGED_EVENT, syncCommissioning);
    };
  }, []);

  const identity = cardLink?.identity?.name
    || cardLink?.identity?.id
    || cardLink?.card?.name
    || cardLink?.card?.id
    || cardLink?.cardName
    || cardLink?.cardId
    || cardLink?.host
    || cardHost;
  const ready = cardLink ? isCardLinkConnected(cardLink) : connected;
  const state = cardLink?.state || (ready ? 'connected-direct' : 'disconnected');
  const reason = cardLink?.reason || '';
  const activity = cardLink?.activity || 'idle';
  const verifiedTransport = Boolean(cardLink?.card?.id && (
    state === 'connected-direct' || state === 'connected-bridge'
  ));
  const setupLabels = ['Connect', 'Install firmware', 'WiFi', 'Install on card', 'Test lights'];
  let currentSetupIndex = ready ? 3 : 0;
  if (commissioningFlow?.stage === 'install-safely') currentSetupIndex = 1;
  else if (commissioningFlow?.stage === 'set-up-card') {
    currentSetupIndex = ['setup-required', 'setup-joined'].includes(commissioningFlow.networkState) ? 2 : 3;
  } else if (commissioningFlow?.stage === 'check-lights') currentSetupIndex = 4;

  let commissioningAction = null;
  if (commissioningFlow?.stage === 'install-safely') {
    commissioningAction = { label: 'Continue installation', section: 'install' };
  } else if (commissioningFlow?.stage === 'set-up-card') {
    if (['setup-required', 'setup-joined'].includes(commissioningFlow.networkState)) {
      commissioningAction = { label: 'Continue WiFi setup', section: 'install' };
    } else if (commissioningFlow.cardAcknowledgedAt) {
      commissioningAction = { label: 'Install project on card', section: 'install' };
    } else {
      commissioningAction = { label: 'Reconnect installed card', section: 'install' };
    }
  } else if (commissioningFlow?.stage === 'check-lights') {
    commissioningAction = { label: 'Test lights', section: 'install' };
  }

  let presentation;
  if (activity === 'failed') {
    presentation = {
      tone: 'failure',
      message: 'The last card operation failed. Reconnect and inspect the card before retrying it.',
      primary: { label: 'Reconnect card', action: 'connect' },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (state === 'revalidating' && reason === 'card-restarted') {
    presentation = {
      tone: 'connecting',
      message: 'Card restarted — verifying the exact card, firmware, and project before commands resume.',
      primary: { label: 'Card restarted — verifying', disabled: true },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (state === 'revalidating') {
    presentation = {
      tone: 'connecting',
      message: 'Checking card. Studio is waiting for two stable exact status checks before commands resume.',
      primary: { label: 'Checking card', disabled: true },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (state === 'reconnecting-bridge' || state === 'reconnecting') {
    presentation = {
      tone: 'connecting',
      message: 'Card stopped responding. Studio is reconnecting and will require fresh status before commands resume.',
      primary: { label: 'Card stopped responding', disabled: true },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (activity === 'recovering') {
    presentation = {
      tone: 'connecting',
      message: 'Studio is recovering the last card operation. Keep this page open until the result is confirmed.',
      primary: { label: 'Recovery in progress…', disabled: true },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (state === 'connecting' || activity === 'pending') {
    presentation = {
      tone: 'connecting',
      message: activity === 'pending'
        ? 'A card operation is in progress. Keep this page open until Studio confirms the result.'
        : 'Studio is looking for the card. Keep the card page open while its identity is verified.',
      primary: { label: activity === 'pending' ? 'Card operation in progress…' : 'Connecting…', disabled: true },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (verifiedTransport && cardLink?.cardBlank === true) {
    presentation = {
      tone: 'failure',
      message: 'Blank — load a project before using this card.',
      primary: { label: 'Start layout', view: 'layout' },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (ready) {
    presentation = {
      tone: 'connected',
      message: `${identity || 'A Lightweaver card'} is connected and ready for light check.`,
      primary: { label: 'Install on card', section: 'settings' },
    };
  } else if (verifiedTransport) {
    presentation = {
      tone: 'connecting',
      message: 'Checking card. Studio is waiting for complete identity, project, and command readiness evidence.',
      primary: { label: 'Checking card', disabled: true },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (reason && reason !== 'never-connected') {
    const updateNeeded = reason === 'firmware-too-old' || reason === 'identity-missing';
    presentation = {
      tone: 'failure',
      message: updateNeeded
        ? `${cardLinkReasonText(reason)} Update it before loading changes.`
        : `${cardLinkReasonText(reason)} Reconnect and inspect the card before loading changes.`,
      primary: updateNeeded
        ? { label: 'Update card', section: 'install' }
        : { label: reason === 'wrong-card' ? 'Connect expected card' : 'Reconnect card', action: 'connect' },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else {
    presentation = {
      tone: 'disconnected',
      message: 'A Lightweaver card is not connected. Connect one to inspect it before installing or loading a project.',
      primary: { label: 'Connect card', action: 'connect' },
      secondary: { label: 'Install Lightweaver', section: 'install' },
    };
  }

  // Connect actions must be visible: prefer the connection center when the
  // shell provides it, and fall back to the background probe otherwise.
  const openConnection = () => (onOpenConnectionCenter ? onOpenConnectionCenter() : onConnectCard?.());
  const requireExactReadyStatus = (status) => {
    const expectedCardId = String(cardLink?.card?.id || '').trim();
    if (!status || status.cardId !== expectedCardId) throw new Error('A different card answered the hardware check. Reconnect the expected card.');
    if (status.runtimePhase !== 'ready' || status.knownGoodProject !== true || status.commandReady !== true || status.outputReady !== true) {
      throw new Error('The card answered, but its runtime or LED output is not ready. Open support before retrying.');
    }
    return status;
  };
  const verifyHardware = async () => {
    if (hardwareActionState.status === 'loading') return;
    setHardwareActionState({ status: 'loading', message: 'Reading exact card hardware state…' });
    try {
      const status = requireExactReadyStatus(await readCardStatusEnvelope({ host: cardLink?.host || cardHost }));
      const pixels = Number(status.led?.pixels) || Number(cardLink?.card?.pixelCount) || 0;
      setHardwareActionState({
        status: 'ok',
        message: `Hardware readback verified for ${status.cardId}${pixels ? ` · ${pixels} LEDs` : ''}. This confirms card state, not visible light output.`,
      });
    } catch (error) {
      setHardwareActionState({ status: 'error', message: error?.message || 'Hardware readback failed. Reconnect the card and try again.' });
    }
  };
  const recoverLights = async () => {
    if (hardwareActionState.status === 'loading') return;
    setHardwareActionState({ status: 'loading', message: 'Sending safe warm-white recovery…' });
    try {
      const response = await recoverCardLights(
        { patternId: 'warm-white', brightness: 0.35, syncZones: true },
        { host: cardLink?.host || cardHost, timeoutMs: 3200 },
      );
      requireExactReadyStatus(await readCardStatusEnvelope({ host: cardLink?.host || cardHost }));
      setHardwareActionState({
        status: 'ok',
        message: `Recovery command ${response?.restarted ? 'survived restart and was' : 'was'} acknowledged with ready-state readback. Check the real LEDs; visible warm white is not confirmed automatically.`,
      });
    } catch (error) {
      setHardwareActionState({ status: 'error', message: error?.message || 'Recovery was not verified. Keep the card powered, reconnect, and retry.' });
    }
  };
  const loadMatchingCardProject = useCallback(async ({ probeOnly = false, selectionKey = '', autoIntent = '', probeSignature = '' } = {}) => {
    if (!ready) return;
    if (projectSwitchInFlightRef.current) {
      if (probeSignature) {
        pendingCardProjectProbeRef.current = { probeOnly, autoIntent, probeSignature };
      }
      return;
    }
    projectSwitchInFlightRef.current = true;
    if (probeSignature) {
      cardProjectProbeRef.current = probeSignature;
      if (pendingCardProjectProbeRef.current?.probeSignature === probeSignature) {
        pendingCardProjectProbeRef.current = null;
      }
    }
    setMatchingProjectState({ status: 'loading', message: 'Reading the exact project installed on this card…' });
    let replacementCommitted = false;
    let associationHandoffFailed = false;
    let replacementCloudSessionLost = false;
    clearCardEditAuthorization();
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
        const latest = resolutionContextRef.current || {};
        const latestLink = latest.cardLink || {};
        const sharedLink = getCardLinkState();
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
            !isCardLinkConnected(sharedLink)
            || !sameCardResolutionContext(requestContext, contextFrom(sharedLink), { workspace: false })
          ))) {
          throw new Error('The card or open Studio project changed while resolving. Nothing was replaced.');
        }
      };
      const readExactCardSnapshot = async (expectedEvidence = null, { workspace = true } = {}) => {
        const [evidence, status] = await Promise.all([
          readCardProjectEvidence({ host: requestContext.host, transport: cardLink?.transport }),
          readCardStatusEnvelope({ host: requestContext.host, transport: cardLink?.transport }),
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
        const binding = {
          intent: cardEditIntent(),
          cardId: evidence.cardId,
          firmwareVersion: evidence.firmwareVersion,
          buildId: evidence.buildId,
          bootId: requestContext.bootId,
          installedProjectId: evidence.projectId,
          installedProjectFingerprint: evidence.projectFingerprint,
          studioProjectId: project?.id,
          studioProjectFingerprint: cardProjectFingerprint(project),
          projectGeneration: generation,
        };
        const issued = signedProductionProject
          ? issueSignedProductionCardEditAuthorization(binding, signedProductionProject)
          : issueCardEditAuthorization(binding);
        if (!issued) {
          throw new Error('Studio could not authorize this exact card and project for Pattern commands. Nothing was opened in Patterns.');
        }
      };

      const productionJobs = [];
      if (evidence.productionJobId || evidence.productionJobDigest) {
        const index = await loadProductionJobIndex();
        const entry = index.jobs.find(candidate => candidate.jobId === evidence.productionJobId);
        if (!entry || entry.digest !== evidence.productionJobDigest) {
          throw new Error('No verified production project matches the exact job digest reported by this card.');
        }
        productionJobs.push(await loadProductionJobFromIndexEntry(entry));
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
        const cloudProjects = readCloudProject
          ? await Promise.all(cloudMetadata.map(async metadata => ({
              ...metadata,
              ...(await readCloudProject(metadata.id)),
            })))
          : [];
        const freshBrowserProjects = readBrowserProjects?.() || browserProjects;
        resolved = resolveCardProject({ evidence, cloudProjects, browserProjects: freshBrowserProjects });
      }
      // Source discovery may include production package fetches and multiple
      // cloud reads. Do not publish an offer/ambiguity from that stale window.
      await readExactCardSnapshot(evidence);
      if (resolved.status === 'ambiguous') {
        if (!selectionKey) {
          setMatchingProjectState({
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
        setMatchingProjectState({
          status: 'offer',
          message: `Exact match found: “${describeResolvedCardProject(resolved)}”. Load it to save the current workspace and continue to Patterns.`,
          selectionKey: resolvedMatchKey(resolved),
          matchLabel: describeResolvedCardProject(resolved),
        });
        return;
      }
      if (autoIntent && resolved.source !== 'current') {
        setMatchingProjectState({
          status: 'offer',
          message: `Exact match found: “${describeResolvedCardProject(resolved)}”. Load it to save the current workspace before Studio opens the card project.`,
          selectionKey: resolvedMatchKey(resolved),
          matchLabel: describeResolvedCardProject(resolved),
        });
        return;
      }
      if (resolved.source === 'current') {
        await readExactCardSnapshot(evidence);
        if (autoIntent && cardEditIntent() !== autoIntent) {
          throw new Error('The requested pattern or look changed while Studio was resolving the card. Nothing was opened.');
        }
        authorizeResolvedProject(resolved.project, projectGeneration);
        window.location.hash = '#screen=pattern';
        return;
      }

      setMatchingProjectState({ status: 'saving', message: 'Saving current project…' });
      let savedCurrent;
      try {
        savedCurrent = await saveBeforeCardProjectSwitch?.();
      } catch {
        savedCurrent = { ok: false, reason: 'authoritative-save-failed' };
      }
      if (!savedCurrent?.ok) {
        throw new Error(projectSwitchSaveFailureMessage(savedCurrent?.reason));
      }
      const assertSavedProjectStillCurrent = () => {
        if (!savedCurrent.snapshot
          || isProjectSwitchSnapshotCurrent?.(savedCurrent.snapshot) !== true) {
          throw new Error(projectSwitchSaveFailureMessage('workspace-changed'));
        }
      };
      assertSavedProjectStillCurrent();
      await readExactCardSnapshot(evidence);
      assertSavedProjectStillCurrent();

      if (resolved.source === 'cloud') {
        const result = await openMatchingCardProject?.(resolved.remoteId, evidence, {
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
            const associationResult = await onMatchedProjectLoaded?.({
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
        const associationResult = await onMatchedProjectLoaded?.({
          source: 'cloud',
          remoteId: resolved.remoteId,
        });
        if (!associationResult?.ok) {
          associationHandoffFailed = true;
          throw new Error(projectSwitchSaveFailureMessage('association-handoff-failed'));
        }
        await readExactCardSnapshot(evidence, { workspace: false });
        authorizeResolvedProject(resolved.project, projectGeneration + 1);
        window.location.hash = '#screen=pattern';
        return;
      }
      let revalidated = null;
      if (resolved.source === 'browser') {
        revalidated = resolveCardProject({
          evidence,
          browserProjects: readBrowserProjects?.() || [],
        });
      } else if (resolved.source === 'production') {
        const freshIndex = await loadProductionJobIndex();
        const freshEntry = freshIndex.jobs.find(candidate => candidate.jobId === evidence.productionJobId);
        const freshJobs = freshEntry?.digest === evidence.productionJobDigest
          ? [await loadProductionJobFromIndexEntry(freshEntry)]
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
      const result = await replaceProject(studioProject, { confirmDiscard: () => true });
      if (!result.ok) {
        setMatchingProjectState({
          status: result.reason === 'cancelled' ? 'idle' : 'error',
          message: result.reason === 'cancelled' ? 'The current Studio project was kept.' : 'The matching card project could not be opened.',
        });
        return;
      }
      replacementCommitted = true;
      const associationResult = await onMatchedProjectLoaded?.({
        source: resolved.source,
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
      await readExactCardSnapshot(evidence, { workspace: false });
      authorizeResolvedProject(studioProject, projectGeneration + 1, resolved.source === 'production' ? {
        jobId: resolved.candidate.jobId,
        jobDigest: resolved.candidate.digest,
        projectId: resolved.candidate.project.id,
        projectFingerprint: resolved.candidate.project.fingerprint,
      } : null);
      window.location.hash = '#screen=pattern';
    } catch (error) {
      setMatchingProjectState({
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
      projectSwitchInFlightRef.current = false;
      const pendingProbe = pendingCardProjectProbeRef.current;
      if (pendingProbe && pendingProbe.probeSignature !== cardProjectProbeRef.current) {
        pendingCardProjectProbeRef.current = null;
        requestCardProjectProbe();
      }
    }
  }, [
    activeCloudProjects,
    browserProjects,
    cardHost,
    cardLink,
    currentProject,
    matchingProjectState.status,
    onMatchedProjectLoaded,
    openMatchingCardProject,
    readCloudProject,
    readBrowserProjects,
    ready,
    replaceProject,
    projectGeneration,
    saveBeforeCardProjectSwitch,
    isProjectSwitchSnapshotCurrent,
  ]);
  useEffect(() => {
    if (!ready) return;
    const candidateSourceSignature = [
      activeCloudProjects
        .map(project => `${project?.id || ''}:${project?.revision ?? ''}:${project?.embeddedProjectId || ''}`)
        .sort()
        .join(','),
      browserProjects
        .map(record => `${record?.id || ''}:${record?.updatedAt ?? ''}:${record?.project?.id || ''}`)
        .sort()
        .join(','),
    ].join('::');
    const signature = [
      normalizeCardHost(cardLink?.host || cardHost),
      cardLink?.card?.id,
      cardLink?.card?.buildId,
      cardLink?.readiness?.bootId,
      cardLink?.operationGeneration,
      cardLink?.revalidationGeneration,
      cardLink?.readiness?.projectId,
      cardLink?.readiness?.projectRevision,
      cardLink?.readiness?.projectFingerprint,
      cardLink?.readiness?.productionJobId,
      cardLink?.readiness?.productionJobDigest,
      projectGeneration,
      candidateSourceSignature,
    ].join('|');
    if (cardProjectProbeRef.current === signature) return;
    const autoIntent = cardEditIntent();
    void loadMatchingCardProject({ probeOnly: !autoIntent, autoIntent, probeSignature: signature });
  }, [activeCloudProjects, browserProjects, cardHost, cardLink, cardProjectProbeRevision, loadMatchingCardProject, projectGeneration, ready]);
  const renderAction = (action, primary = false) => action && (
    <button
      type="button"
      className={`btn${primary ? ' primary' : ''}`}
      disabled={action.disabled}
      onClick={() => action.action === 'connect'
        ? openConnection()
        : action.view
          ? go(action.view)
          : onOpenSection(action.section)}
    >
      {action.label}
    </button>
  );

  return (
    <div className="card-overview">
      <div className="card-overview-state">
        <span className={`card-overview-signal ${presentation.tone}`} aria-hidden="true" />
        <div>
          <span className="card-workspace-kicker">Detected state</span>
          <p data-testid="card-detected-state">{presentation.message}</p>
        </div>
      </div>

      <ol className="card-setup-steps" data-testid="card-setup-steps" aria-label="Card setup order">
        {setupLabels.map((label, index) => {
          const stepState = index < currentSetupIndex ? 'complete' : index === currentSetupIndex ? 'current' : 'upcoming';
          return (
            <li key={label} data-step-state={stepState} aria-current={stepState === 'current' ? 'step' : undefined}>
              <span className="card-setup-number" aria-hidden="true">{stepState === 'complete' ? '✓' : index + 1}</span>
              <span className="card-setup-label">{label}</span>
            </li>
          );
        })}
      </ol>

      <div className="card-overview-actions">
        {commissioningAction ? (
          <>
            {renderAction(commissioningAction, true)}
            <button type="button" className="btn" onClick={() => onOpenSection('support')}>Open support</button>
          </>
        ) : ready && activity === 'idle' ? (
          <>
            {renderAction(presentation.primary, true)}
            <button type="button" className="btn" onClick={() => onOpenSection('install')}>Check for update</button>
          </>
        ) : (
          <>
            {renderAction(presentation.primary, true)}
            {renderAction(presentation.secondary)}
          </>
        )}
      </div>

      {ready && (
        <section className="card-support-panel" aria-label="Matching card project">
          <h2>Matching card project</h2>
          <p>Open the exact active Studio project installed on this card before changing patterns, so its LED count, wiring, protocol, and power limit stay aligned.</p>
          {matchingProjectState.status !== 'ambiguous' && (
            <button
              type="button"
              className="btn primary"
              disabled={matchingProjectState.status === 'loading' || matchingProjectState.status === 'saving'}
              onClick={() => void loadMatchingCardProject({ selectionKey: matchingProjectState.selectionKey || '' })}
            >
              {matchingProjectState.status === 'saving'
                ? 'Saving current project…'
                : matchingProjectState.status === 'loading'
                ? 'Verifying project…'
                : matchingProjectState.matchLabel
                  ? `Load ${matchingProjectState.matchLabel}`
                  : 'Load matching card project'}
            </button>
          )}
          {matchingProjectState.status === 'ambiguous' && (
            <div className="card-overview-actions" aria-label="Exact matching projects">
              {matchingProjectState.matches.map(match => (
                <button
                  key={resolvedMatchKey(match)}
                  type="button"
                  className="btn"
                  onClick={() => void loadMatchingCardProject({ selectionKey: resolvedMatchKey(match) })}
                >
                  Load {describeResolvedCardProject(match)}
                </button>
              ))}
            </div>
          )}
          {matchingProjectState.message && (
            <p role={matchingProjectState.status === 'error' ? 'alert' : 'status'}>{matchingProjectState.message}</p>
          )}
        </section>
      )}

      {ready && (
        <section className="card-support-panel" aria-label="Hardware checks and recovery">
          <h2>Checks &amp; recovery</h2>
          <p>These actions report card acknowledgements and state readback. Studio never marks a visual LED or color test passed without your confirmation.</p>
          <div className="card-overview-actions">
            <button type="button" className="btn" disabled={hardwareActionState.status === 'loading'} onClick={() => void verifyHardware()}>Verify hardware</button>
            <button type="button" className="btn" disabled={hardwareActionState.status === 'loading'} onClick={() => void recoverLights()}>Recover lights</button>
            <button type="button" className="btn" onClick={() => { window.location.hash = '#screen=card&section=settings&tool=color-order'; }}>Color-order test</button>
          </div>
          {hardwareActionState.message && (
            <p role={hardwareActionState.status === 'error' ? 'alert' : 'status'}>{hardwareActionState.message}</p>
          )}
        </section>
      )}

      <p className="card-overview-batch" data-testid="card-batch-link">
        <span style={{ color: 'var(--text-faint)' }}>Making many cards? </span>
        <button type="button" className="link-btn" onClick={() => onOpenSection('workshop')}>Batch production</button>
      </p>
    </div>
  );
}

function RecoverySupport({ onConnectCard, onOpenConnectionCenter }) {
  return (
    <section className="card-support-panel">
      <h2>Safe recovery</h2>
      <p>Reconnect and inspect the card before choosing an install or write action. Opening recovery here does not erase firmware, WiFi, or the saved project.</p>
      <button
        type="button"
        className="btn primary"
        onClick={() => (onOpenConnectionCenter ? onOpenConnectionCenter() : onConnectCard?.())}
      >
        Reconnect card
      </button>
    </section>
  );
}

function CardSupport({ initialTool, cardProps, onOpenConnectionCenter, onOpenSection }) {
  const [tool, setTool] = useState(initialTool);
  useEffect(() => setTool(initialTool), [initialTool]);

  const installerGo = target => {
    if (target === 'flash') onOpenSection('install');
    else if (target === 'settings') onOpenSection('settings');
  };

  return (
    <div className="card-support">
      <div className="card-support-grid" aria-label="Advanced and support tools">
        <button type="button" aria-label="Technician firmware & logs" className={tool === 'technician' ? 'selected' : ''} aria-pressed={tool === 'technician'} onClick={() => setTool('technician')}>
          <strong>Technician firmware &amp; logs</strong><span>Manual firmware, offsets, erase controls, and serial output.</span>
        </button>
        <button type="button" aria-label="GPIO & install guide" className={tool === 'guide' ? 'selected' : ''} aria-pressed={tool === 'guide'} onClick={() => setTool('guide')}>
          <strong>GPIO &amp; install guide</strong><span>Worker sequence, wiring pins, hard stops, and bench signoff.</span>
        </button>
        <button type="button" aria-label="Designer JSON" className={tool === 'json' ? 'selected' : ''} aria-pressed={tool === 'json'} onClick={() => setTool('json')}>
          <strong>Designer JSON</strong><span>Inspect the exact configuration Studio would write.</span>
        </button>
        <button type="button" aria-label="Recovery" className={tool === 'recovery' ? 'selected' : ''} aria-pressed={tool === 'recovery'} onClick={() => setTool('recovery')}>
          <strong>Recovery</strong><span>Reconnect safely and choose the next evidence-based action.</span>
        </button>
        <button type="button" aria-label="Deployment check" className={tool === 'deployment' ? 'selected' : ''} aria-pressed={tool === 'deployment'} onClick={() => setTool('deployment')}>
          <strong>Deployment check</strong><span>Verify this site's signed release from the browser — no install needed.</span>
        </button>
        <button type="button" aria-label="Batch production" onClick={() => onOpenSection('workshop')}>
          <strong>Batch production</strong><span>Signed-job manufacturing flow with identity binding and pass records.</span>
        </button>
      </div>

      {tool && (
        <div className="card-support-tool">
          {tool === 'technician' && <TechnicianFlashScreen embedded />}
          {tool === 'guide' && <InstallerScreen embedded go={installerGo} cardLink={cardProps.cardLink} />}
          {tool === 'json' && <SettingsScreen embedded mode="advanced" {...cardProps} />}
          {tool === 'recovery' && <RecoverySupport onConnectCard={cardProps.onConnectCard} onOpenConnectionCenter={onOpenConnectionCenter} />}
          {tool === 'deployment' && <DeploymentCheckPanel />}
        </div>
      )}
    </div>
  );
}

export function CardScreen({ connected, cardHost, cardLink, onConnectCard, onOpenConnectionCenter, onOpenSection, go, replaceProject, currentProject, projectGeneration, activeCloudProjects, browserProjects, readBrowserProjects, readCloudProject, openMatchingCardProject, confirmProjectReplacement, saveBeforeCardProjectSwitch, saveProjectToBrowserGuarded, isProjectSwitchSnapshotCurrent, onMatchedProjectLoaded, route = { section: 'overview', supportTool: '' } }) {
  const headingRef = useRef(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    // Focus the section heading after in-app section navigation (required
    // a11y behavior), but never on a direct page load — mount-time focus
    // steals whatever the user or a keyboard test is about to activate.
    const navigated = consumeCardSectionNavigation();
    if (!mountedRef.current) {
      mountedRef.current = true;
      if (!navigated) return undefined;
    }
    const frame = requestAnimationFrame(() => headingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [route.section]);

  const cardProps = { connected, cardHost, cardLink, onConnectCard };
  let content;
  if (route.section === 'install') content = (
    <AutomaticInstallScreen
      embedded
      cardLink={cardLink}
      onConnectCard={onConnectCard}
      persistCurrentProjectToBrowser={saveProjectToBrowserGuarded}
      onCommissioningComplete={() => onOpenSection('overview')}
    />
  );
  else if (route.section === 'settings') content = <SettingsScreen embedded mode="card" {...cardProps} />;
  else if (route.section === 'workshop') content = <ProductionScreen embedded cardHost={cardHost} cardLink={cardLink} onConnectCard={onConnectCard} />;
  else if (route.section === 'preferences') content = <SettingsScreen embedded mode="preferences" {...cardProps} />;
  else if (route.section === 'support') content = <CardSupport initialTool={route.supportTool} cardProps={cardProps} onOpenConnectionCenter={onOpenConnectionCenter} onOpenSection={onOpenSection} />;
  else content = <CardOverview {...cardProps} onOpenConnectionCenter={onOpenConnectionCenter} onOpenSection={onOpenSection} go={go} replaceProject={replaceProject} currentProject={currentProject} projectGeneration={projectGeneration} activeCloudProjects={activeCloudProjects} browserProjects={browserProjects} readBrowserProjects={readBrowserProjects} readCloudProject={readCloudProject} openMatchingCardProject={openMatchingCardProject} confirmProjectReplacement={confirmProjectReplacement} saveBeforeCardProjectSwitch={saveBeforeCardProjectSwitch} isProjectSwitchSnapshotCurrent={isProjectSwitchSnapshotCurrent} onMatchedProjectLoaded={onMatchedProjectLoaded} />;

  // Batch production (route.section === 'workshop') renders outside the tab
  // set: its own heading and kicker, no section tab highlighted.
  const workshop = route.section === 'workshop';
  const heading = route.section === 'overview'
    ? 'Your Lightweaver hardware'
    : workshop ? 'Batch production' : SECTION_LABELS[route.section];
  return (
    <div className="screen card-workspace-screen">
      <div className="card-workspace">
        <nav className="card-section-nav" aria-label="Hardware sections">
          {Object.entries(SECTION_LABELS).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-current={route.section === key ? 'page' : undefined}
              onClick={() => onOpenSection(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <main className="card-workspace-body">
          <header className="card-workspace-header">
            <span className="card-workspace-kicker">{workshop ? 'Manufacturing mode' : 'Lightweaver hardware'}</span>
            <h1 ref={headingRef} tabIndex={-1}>{heading}</h1>
            {workshop && (
              <button type="button" className="btn" onClick={() => onOpenSection('overview')}>Back to Hardware</button>
            )}
          </header>
          {content}
        </main>
      </div>
    </div>
  );
}
