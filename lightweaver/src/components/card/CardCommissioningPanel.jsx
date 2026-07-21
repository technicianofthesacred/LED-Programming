import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../../state/ProjectContext.jsx';
import { buildCardRuntimePackageFromProject } from '../../lib/cardRuntimeProject.js';
import { pushConfigToCard, readCardProjectEvidence, readCardStatusEnvelope } from '../../lib/cardPushClient.js';
import {
  activateAndWaitForCardWiring,
  confirmCardWiringCandidate,
  readCardWiringCandidateEvidence,
  rollbackCardWiringCandidate,
} from '../../lib/cardWiringSafety.js';
import {
  connectCardLink,
  getCardLinkState,
  getSharedCardLink,
  isCardLinkConnected,
  reportCardStatusEnvelope,
  reportDirectCardStatus,
} from '../../lib/cardLink.js';
import { getCardBridgeState, retargetCardBridge, sendCardBridgeRequest } from '../../lib/cardBridge.js';
import { acceptWifiHandoff } from '../../lib/cardWifiHandoff.js';
import { canPushDirectlyToCard, discoverCardStatus } from '../../lib/cardConnection.js';
import { compileWiring } from '../../lib/wiringCompiler.js';
import { createWiringChaseSession } from '../../lib/wiringChase.js';
import {
  CARD_COMMISSIONING_CHANGED_EVENT,
  CARD_COMMISSIONING_STAGES,
  adaptCardRestorationReadback,
  acknowledgeCommissionedCard,
  acknowledgeCommissionedCardFromStatus,
  bindCardWiringActivationEvidence,
  beginCardLightCheckMutation,
  beginCardRestorationMutation,
  claimCardLightCheckMutation,
  claimCardRestoration,
  clearCardCommissioning,
  completeCardInstall,
  confirmCardSetupNetworkJoined,
  markCardProjectRestored,
  preflightCardCommissioningMutation,
  readCardCommissioning,
  readCardRestorationAttempt,
  recordCardRestorationResponse,
  inspectCardCommissioning,
  releaseCardRestoration,
  returnCardProjectToSetupAfterLightCheck,
  verifyCardRestorationMutation,
  verifyCardLightCheckMutation,
  resumeInstalledCardAfterInterruption,
  stageCardProjectForPhysicalCheck,
  writeCardCommissioning,
} from '../../lib/cardCommissioningFlow.js';

const STAGE_LABELS = {
  'connect-card': 'Connect card',
  'install-safely': 'Install safely',
  'set-up-card': 'Set up card',
  'check-lights': 'Check lights',
};

function runtimePackageFromSnapshot(snapshot = {}, identity = {}) {
  return buildCardRuntimePackageFromProject({
    projectId: snapshot.id,
    projectName: snapshot.name,
    projectRevision: identity.revision,
    projectFingerprint: identity.fingerprint,
    productionJobId: identity.productionJobId,
    productionJobDigest: identity.productionJobDigest,
    strips: snapshot.layout?.strips || [],
    patchBoard: snapshot.layout?.patchBoard || null,
    wiring: snapshot.layout?.wiring || null,
    standaloneController: snapshot.devices?.standaloneController || {},
  });
}

function commissioningMarkerFrame(snapshot = {}) {
  const strips = snapshot.layout?.strips || [];
  let compiled = null;
  if (snapshot.layout?.wiring) {
    try { compiled = compileWiring({ wiring: snapshot.layout.wiring, strips }); }
    catch { compiled = null; }
  }
  const fallbackCount = strips.reduce((sum, strip) => sum + Math.max(0, Number(strip.pixelCount ?? strip.pixels?.length ?? 0)), 0);
  const outputs = compiled?.ok && compiled.outputs.length
    ? compiled.outputs
    : fallbackCount > 0 ? [{ start: 0, count: fallbackCount }] : [];
  const totalPixels = compiled?.ok && compiled.totalPixels > 0 ? compiled.totalPixels : fallbackCount;
  const frame = Array.from({ length: totalPixels }, () => '001A00');
  for (const output of outputs) {
    const start = Math.max(0, Number(output.start) || 0);
    const end = Math.min(frame.length, start + Math.max(0, Number(output.count ?? output.pixels) || 0));
    if (start >= end) continue;
    if (end - start === 1) frame[start] = '1A001A';
    else {
      frame[start] = '00001A';
      frame[end - 1] = '1A0000';
    }
  }
  return frame;
}

export function CardCommissioningSteps({ stage = 'connect-card' }) {
  const activeIndex = Math.max(0, CARD_COMMISSIONING_STAGES.indexOf(stage));
  return (
    <ol className="card-commissioning-steps" aria-label="Card setup progress">
      {CARD_COMMISSIONING_STAGES.map((id, index) => (
        <li key={id} className={index < activeIndex ? 'complete' : index === activeIndex ? 'active' : ''} aria-current={index === activeIndex ? 'step' : undefined}>
          <span aria-hidden="true">{index < activeIndex ? '✓' : index + 1}</span>
          {STAGE_LABELS[id]}
        </li>
      ))}
    </ol>
  );
}

function identityMessage(reason, expected = {}, actual = {}) {
  if (reason === 'wrong-card') return `Studio expected ${expected.id}, but ${actual.id || 'another card'} answered. Reconnect the installed card.`;
  if (reason === 'wrong-firmware-version') return `Studio expected firmware ${expected.firmwareVersion}, but the card reports ${actual.firmwareVersion || 'no version'}.`;
  if (reason === 'wrong-firmware-build') return 'The card firmware build does not match the build verified during installation.';
  return 'Reconnect the installed card so Studio can verify its identity and firmware.';
}

export function CardCommissioningPanel({
  result = null,
  link = {},
  onReconnect,
  onComplete,
  openSetupCard = connectCardLink,
  pushProject = pushConfigToCard,
  readProjectEvidence = readCardProjectEvidence,
  readCandidateEvidence = readCardWiringCandidateEvidence,
}) {
  const { markProjectInstalled } = useProject();
  const [initialState] = useState(() => inspectCardCommissioning());
  const [flow, setFlow] = useState(initialState.flow);
  const [restoreState, setRestoreState] = useState('idle');
  const [detection, setDetection] = useState({ state: 'idle' });
  const [lightCheckState, setLightCheckState] = useState('idle');
  const [lightCheckNotice, setLightCheckNotice] = useState('');
  const [bridgeHandoffStatus, setBridgeHandoffStatus] = useState(null);
  const markerSessionRef = useRef(null);
  const markerTimeoutRef = useRef(null);
  const [failure, setFailure] = useState(initialState.error === 'corrupt'
    ? 'Saved card setup data is corrupt. Nothing was changed; restart the exact setup.'
    : initialState.error === 'invalid-lease'
      ? 'A saved card restore claim was invalid or stale and has been cleared. Verify the same card, then retry.'
    : '');

  useEffect(() => {
    const sync = () => {
      const state = inspectCardCommissioning();
      setFlow(state.flow);
      if (state.error === 'corrupt') setFailure('Saved card setup data is corrupt. Nothing was changed; restart the exact setup.');
      if (state.error === 'invalid-lease') setFailure('A saved card restore claim was invalid or stale and has been cleared. Verify the same card, then retry.');
    };
    window.addEventListener('storage', sync);
    window.addEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    };
  }, []);

  useEffect(() => () => {
    if (markerTimeoutRef.current != null) window.clearTimeout(markerTimeoutRef.current);
    markerTimeoutRef.current = null;
    const session = markerSessionRef.current;
    markerSessionRef.current = null;
    if (session) void session.stop().catch(() => {});
  }, []);

  useEffect(() => {
    if (result?.status !== 'awaiting-card-acknowledgement') return;
    void (async () => { try {
      let current = readCardCommissioning({ flowId: result.flowId });
      if (!current) throw new Error('This Bridge result has no matching saved setup in this browser profile. It was not applied; restart that exact setup.');
      if (current.source !== 'native-bridge') throw new Error('This Bridge result belongs to a different card setup attempt. Return to the setup that started it.');
      if (current.stage === 'install-safely') {
        current = completeCardInstall(current, result);
        await writeCardCommissioning(current);
      }
      setFlow(current);
      setFailure('');
    } catch (error) {
      setFailure(error?.message || 'Studio could not resume this card setup result.');
    } })();
  }, [result]);

  const cardAcknowledgement = useMemo(() => {
    if (!flow || flow.stage !== 'set-up-card') return null;
    const setupNetworkReset = ['setup-required', 'setup-joined'].includes(flow.networkState);
    const acknowledgedAt = Date.parse(link?.acknowledgedAt || '');
    const freshAfterSetupJoin = flow.networkState === 'setup-joined'
      && Number.isFinite(acknowledgedAt)
      && acknowledgedAt >= flow.updatedAt;
    if (!isCardLinkConnected(link) || (setupNetworkReset && !freshAfterSetupJoin)) return null;
    return acknowledgeCommissionedCardFromStatus(flow, link?.readiness || {});
  }, [flow, link]);

  const interruptedInstallEvidence = useMemo(() => {
    if (!flow || flow.stage !== 'install-safely' || flow.source !== 'web-serial' || !link?.card?.id || !isCardLinkConnected(link)) return null;
    return resumeInstalledCardAfterInterruption(flow, link.card);
  }, [flow, link]);

  const restorePreflight = useMemo(() => {
    if (!flow?.cardAcknowledgedAt) return { ok: false, reason: 'checking-card' };
    if (!isCardLinkConnected(link)) return { ok: false, reason: 'checking-card' };
    return preflightCardCommissioningMutation(flow, link.readiness);
  }, [flow, link]);

  const lightCheckPreflight = useMemo(() => {
    if (flow?.stage !== 'check-lights' || !flow.cardAcknowledgedAt) return { ok: false, reason: 'checking-card' };
    if (!isCardLinkConnected(link) || !link.validatedBootId) return { ok: false, reason: 'checking-card' };
    return preflightCardCommissioningMutation(flow, link.readiness);
  }, [flow, link]);

  useEffect(() => {
    if (!interruptedInstallEvidence?.ok) return;
    void (async () => { try {
      await writeCardCommissioning(interruptedInstallEvidence.flow);
      setFlow(interruptedInstallEvidence.flow);
    } catch (error) { setFailure(`Card setup could not be saved: ${error?.message || String(error)}`); } })();
  }, [interruptedInstallEvidence]);

  useEffect(() => {
    if (!cardAcknowledgement?.ok || flow?.cardAcknowledgedAt) return;
    void (async () => { try {
      await writeCardCommissioning(cardAcknowledgement.flow);
      setFlow(cardAcknowledgement.flow);
    } catch (error) { setFailure(`Card setup could not be saved: ${error?.message || String(error)}`); } })();
  }, [cardAcknowledgement, flow?.cardAcknowledgedAt]);

  useEffect(() => {
    if (
      !flow
      || flow.stage !== 'set-up-card'
      || flow.cardAcknowledgedAt
      || flow.networkState !== 'setup-joined'
      || canPushDirectlyToCard()
      || detection.state === 'return-to-gallery'
    ) return undefined;
    let active = true;
    let timer = null;
    const poll = async () => {
      try {
        const status = await sendCardBridgeRequest('status', { cache: 'no-store', nonce: Date.now() }, {
          host: '192.168.4.1', timeoutMs: 3000, retryOnTimeout: false,
        });
        if (active) {
          setBridgeHandoffStatus(status);
          timer = window.setTimeout(poll, 2500);
        }
      } catch {
        if (active) timer = window.setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => { active = false; if (timer != null) window.clearTimeout(timer); };
  }, [detection.state, flow]);

  // HTTPS cannot fetch the card's HTTP status directly. The tracked AP card
  // page supplies the complete status envelope over postMessage; exact
  // handoff-ready evidence retargets that same WindowProxy to the correlated
  // station address and leaves the setup flow in one explicit network-switch
  // state until final station truth arrives.
  useEffect(() => {
    if (
      !flow
      || flow.stage !== 'set-up-card'
      || flow.cardAcknowledgedAt
      || !(link?.readiness || bridgeHandoffStatus)
    ) return;
    const bridge = getCardBridgeState();
    const existing = bridge.handoffCorrelation;
    const expectedCard = flow.expectedCard;
    const status = bridgeHandoffStatus || link.readiness;
    let correlation = existing;
    if (!correlation) {
      correlation = acceptWifiHandoff({
        status,
        expectedCard,
        expectedBootId: status.bootId,
        lastGeneration: 0,
      });
    }
    if (!correlation
      || correlation.expectedCardId !== expectedCard?.id
      || correlation.expectedFirmwareVersion !== expectedCard?.firmwareVersion
      || correlation.expectedBuildId !== expectedCard?.buildId) return;
    const retargeted = retargetCardBridge(correlation.host, correlation);
    const lifecycle = getCardBridgeState().lifecycle;
    getSharedCardLink().dispatch({
      type: 'wifi-handoff-retargeted', host: correlation.host,
      correlation, bridgeLifecycle: lifecycle,
    });
    setFailure(retargeted.ok ? '' : 'The card page could not move to the verified gallery-network address. Return to gallery WiFi, then retry this same card page.');
    setDetection({
      state: 'return-to-gallery', correlation,
      retryable: retargeted.retryable !== false,
    });
  }, [bridgeHandoffStatus, flow, link?.readiness]);

  // Reality-driven auto-advance: while the wizard is waiting for the card to
  // rejoin home WiFi (stage 'set-up-card', not yet acknowledged), poll the LAN
  // for the EXPECTED card by identity. Once it answers /api/status in station
  // transport, advance the same verified acknowledge transition the manual
  // button uses — no click required. Only runs on http/file pages that can
  // actually reach the card; on HTTPS the bridge/link path stays the only route.
  const expectedCardId = flow?.stage === 'set-up-card' ? flow.expectedCard?.id : '';
  const pollHost = link?.host;
  useEffect(() => {
    if (!expectedCardId || flow?.cardAcknowledgedAt) {
      setDetection(prev => (prev.state === 'idle' ? prev : { state: 'idle' }));
      return undefined;
    }
    if (!canPushDirectlyToCard()) return undefined;
    let active = true;
    let timer = null;
    const flowId = flow.flowId;
    setDetection(prev => (prev.state === 'found' ? prev : { state: 'searching' }));
    const poll = async () => {
      if (!active) return;
      let result = null;
      try {
        result = await discoverCardStatus({
          preferredHost: pollHost,
          expectedCard: { id: expectedCardId },
          timeoutMs: 1500,
          persist: true,
        });
      } catch { result = null; }
      if (!active) return;
      if (result?.connected) {
        // The poll proved THIS host reachable for the expected card (discoverCardStatus
        // gated on the expected id). Feed it into the shared card link so restore(),
        // which targets link.host, reaches the host the poll actually used rather than
        // a stale remembered address — the same connected-link guarantee the manual
        // acknowledge path gives restore. allowAdopt is safe because the reached card
        // was already identity-matched (id gate above + strict id+fw+build in
        // acknowledgeCommissionedCardFromStatus below); reportDirectCardStatus also
        // persists that identity + stored host so the passive useCardStatus feed
        // converges on it, and its own comparison gate still refuses to overwrite a
        // different persisted pairing. Only done on the acknowledge paths (where
        // restore can follow), never on an identity/firmware-rejected poll.
        const propagateProvenHost = () => reportDirectCardStatus({
          connected: true, host: result.host, status: result.status, allowAdopt: true,
        });
        // Re-read authority so we acknowledge against the freshest generation
        // (another tab or the setup-joined click may have advanced it).
        const current = readCardCommissioning({ flowId }) || flow;
        if (current?.cardAcknowledgedAt) { propagateProvenHost(); if (active) setDetection({ state: 'found' }); return; }
        const ack = acknowledgeCommissionedCardFromStatus(current, result.status);
        if (ack.ok) {
          try {
            await writeCardCommissioning(ack.flow);
            propagateProvenHost();
            if (active) { setFlow(ack.flow); setDetection({ state: 'found' }); }
            return;
          } catch { /* stale generation — listener re-syncs; retry below */ }
        }
      }
      if (active) timer = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => { active = false; if (timer != null) window.clearTimeout(timer); };
  }, [expectedCardId, flow?.cardAcknowledgedAt, flow?.flowId, pollHost]);

  if (!flow && lightCheckState === 'complete') return (
    <div className="card-commissioning" aria-live="polite">
      <CardCommissioningSteps stage="check-lights" />
      <h3>Light check complete</h3>
      <p>The exact temporary wiring was confirmed on the card and is now its working setup.</p>
      {onComplete && <button type="button" className="btn primary" onClick={onComplete}>Done</button>}
    </div>
  );
  if (!flow) return <div className="card-commissioning" aria-live="polite"><CardCommissioningSteps stage="connect-card" />{failure && <p className="card-connection-failure" role="alert">{failure}</p>}</div>;

  const restore = async () => {
    if (restoreState === 'working' || !flow.cardAcknowledgedAt) return;
    if (!restorePreflight.ok) {
      setFailure('Checking card. Reconnect the exact installed card before restoring the saved project.');
      return;
    }
    setRestoreState('working');
    setFailure('');
    let lease = null;
    try {
      const freshStatus = await readCardStatusEnvelope({
        host: link.host,
        transport: link.transport,
        timeoutMs: 3000,
      });
      if (link.validatedBootId && freshStatus?.bootId !== link.validatedBootId) {
        throw new Error('Card restarted — verifying. Wait for Studio to finish checking it before restoring the project.');
      }
      const freshPreflight = preflightCardCommissioningMutation(flow, freshStatus);
      if (!freshPreflight.ok) {
        throw new Error(freshPreflight.reason === 'wrong-card'
          ? 'Wrong card. Reconnect the exact installed card before restoring the project.'
          : freshPreflight.reason === 'wrong-firmware-version' || freshPreflight.reason === 'wrong-firmware-build'
            ? 'The connected card firmware does not match the verified installation. Update or reconnect the expected card.'
            : 'Checking card. The card is not command-ready, so Studio refused to restore the project.');
      }
      const selectedReadback = typeof window.__LW_READ_COMMISSIONING_EVIDENCE_FOR_TEST__ === 'function'
        ? window.__LW_READ_COMMISSIONING_EVIDENCE_FOR_TEST__
        : readProjectEvidence;
      const priorAttempt = readCardRestorationAttempt(flow);
      if (priorAttempt) {
        try {
          const responseReadback = await selectedReadback({ host: link.host, endpoint: '/api/firmware-info', expectedCardId: flow.expectedCard.id });
          const evidence = adaptCardRestorationReadback({ method: 'GET', endpoint: '/api/firmware-info', response: responseReadback });
          const next = markCardProjectRestored(flow, evidence);
          await writeCardCommissioning(next);
          markProjectInstalled(flow.project.revision);
          setFlow(next);
          setRestoreState('complete');
          return;
        } catch {}
        if (priorAttempt.activationId) {
          try {
            const candidate = await readCandidateEvidence(priorAttempt.activationId, { host: link.host, timeoutMs: 8000 });
            const next = stageCardProjectForPhysicalCheck(flow, bindCardWiringActivationEvidence(candidate, candidate));
            await writeCardCommissioning(next);
            setFlow(next);
            setRestoreState('complete');
            return;
          } catch {}
        }
        throw new Error('A previous restore may already have reached this card, but exact independent evidence is inconclusive. Inspect or recover this setup; Studio will not send the project again automatically.');
      }
      const claim = await claimCardRestoration(flow);
      if (!claim.ok) throw new Error(claim.reason === 'restore-in-progress' ? 'This exact project restore is already running in another tab. Wait for it to finish or retry after the recovery window.' : claim.reason === 'recovery-required' ? 'A previous restore requires inspection and will not be sent again automatically.' : 'The saved setup is unavailable. Nothing was sent.');
      lease = claim.lease;
      const runtimePackage = runtimePackageFromSnapshot(flow.project.snapshot, flow.project);
      const selectedPush = typeof window.__LW_PUSH_COMMISSIONING_PROJECT_FOR_TEST__ === 'function'
        ? window.__LW_PUSH_COMMISSIONING_PROJECT_FOR_TEST__
        : pushProject;
      const mutation = await beginCardRestorationMutation(flow, lease);
      if (!mutation.ok || !verifyCardRestorationMutation(flow, lease.id, mutation.fencingToken)) {
        throw new Error('The durable project restore claim was lost before the card mutation. Nothing was sent.');
      }
      const response = await selectedPush(runtimePackage, {
        host: link.host,
        timeoutMs: 8000,
        reboot: 'if-needed',
        allowProjectChange: true,
        allowLayoutChange: true,
      });
      await recordCardRestorationResponse(flow, lease.id, mutation.fencingToken, response);
      const refreshedStatus = await readCardStatusEnvelope({
        host: link.host, transport: link.transport, timeoutMs: 3000,
      }).catch(() => null);
      if (refreshedStatus) {
        reportCardStatusEnvelope({ host: link.host, transport: link.transport, status: refreshedStatus });
      }
      if (response?.state === 'staged') {
        const candidateReadback = await readCandidateEvidence(response.activationId, { host: link.host, timeoutMs: 8000 });
        const activationEvidence = bindCardWiringActivationEvidence(response, candidateReadback);
        const next = stageCardProjectForPhysicalCheck(flow, activationEvidence);
        await writeCardCommissioning(next);
        setFlow(next);
        setRestoreState('complete');
        return;
      }
      if (typeof selectedReadback !== 'function') {
        throw new Error('The project was sent, but this firmware does not yet provide independent restoration read-back. Studio has not marked it restored.');
      }
      const responseReadback = await selectedReadback({
        host: link.host,
        endpoint: '/api/firmware-info',
        expectedCardId: flow.expectedCard.id,
      });
      const evidence = adaptCardRestorationReadback({
        method: 'GET', endpoint: '/api/firmware-info', response: responseReadback,
      });
      const next = markCardProjectRestored(flow, evidence);
      await writeCardCommissioning(next);
      markProjectInstalled(flow.project.revision);
      setFlow(next);
      setRestoreState('complete');
    } catch (error) {
      setFailure(error?.message || 'Studio could not restore the saved project. Reconnect the same card and try again.');
      setRestoreState('idle');
    } finally {
      if (lease) await releaseCardRestoration(flow.flowId, lease.id).catch(() => false);
    }
  };

  const reconnecting = link?.state === 'connecting' || link?.state === 'reconnecting-bridge';
  const currentCard = link?.card || link?.discoveredCard || {};
  const displayedIdentityCheck = flow.stage === 'set-up-card' && currentCard?.id
    ? acknowledgeCommissionedCard(flow, currentCard)
    : null;
  const identityFailure = flow.stage === 'set-up-card' && !flow.cardAcknowledgedAt && displayedIdentityCheck && !displayedIdentityCheck.ok
    ? identityMessage(displayedIdentityCheck.reason, flow.expectedCard, currentCard)
    : '';

  const confirmSetupNetwork = async () => {
    setFailure('');
    try {
      const next = confirmCardSetupNetworkJoined(flow);
      await writeCardCommissioning(next);
      setFlow(next);
    } catch (error) {
      setFailure(error?.message || 'Studio could not save the Wi-Fi handoff. Try again before leaving this network.');
    }
  };

  const reconnectHost = link?.handoffCorrelation?.host || link?.host || 'lightweaver.local';
  const reconnectInstalledCard = () => onReconnect?.(reconnectHost);
  const openSetupNetworkCard = () => {
    setFailure('');
    const opened = openSetupCard('192.168.4.1');
    if (!opened) setFailure('The browser blocked the tracked card page. Allow popups, then try opening Wi-Fi setup again.');
  };
  const retryStationRetarget = () => {
    const correlation = detection.correlation || getCardBridgeState().handoffCorrelation;
    if (!correlation) {
      setFailure('The verified Wi-Fi handoff is no longer available. Reconnect the exact card before retrying.');
      return;
    }
    const result = retargetCardBridge(correlation.host, correlation);
    const lifecycle = getCardBridgeState().lifecycle;
    getSharedCardLink().dispatch({
      type: 'wifi-handoff-retargeted', host: correlation.host,
      correlation, bridgeLifecycle: lifecycle,
    });
    setFailure(result.ok ? '' : 'The verified card page is still unreachable. Return to gallery WiFi and retry this same card page.');
  };

  const acquireFreshLightCheckMutation = async () => {
    const observed = getCardLinkState();
    if (!isCardLinkConnected(observed) || !observed.validatedBootId) {
      throw new Error('Checking card. Reconnect and revalidate the exact installed card before changing the light test.');
    }
    const generation = observed.operationGeneration || 0;
    const bootId = observed.validatedBootId;
    const status = await readCardStatusEnvelope({
      host: observed.host, transport: observed.transport, timeoutMs: 3000,
    });
    const current = getCardLinkState();
    if (!isCardLinkConnected(current)
      || current.host !== observed.host
      || (current.operationGeneration || 0) !== generation
      || current.validatedBootId !== bootId
      || status?.bootId !== bootId) {
      throw new Error('Card restarted or stopped answering. Wait for two stable checks before changing the light test.');
    }
    const preflight = preflightCardCommissioningMutation(flow, status);
    if (!preflight.ok) {
      throw new Error('Checking card. The exact installed card and firmware must be command-ready before changing the light test.');
    }
    const claim = await claimCardLightCheckMutation(flow);
    if (!claim.ok) throw new Error('Another Studio tab is changing this light check. Wait for it to finish, then try again.');
    try {
      const mutation = await beginCardLightCheckMutation(flow, claim.lease);
      const assertAuthority = () => {
        const latest = getCardLinkState();
        if (!mutation.ok
          || !verifyCardLightCheckMutation(flow, claim.lease.id, mutation.fencingToken)
          || !isCardLinkConnected(latest)
          || latest.host !== observed.host
          || latest.validatedBootId !== bootId
          || (latest.operationGeneration || 0) !== generation) {
          throw new Error('Card readiness changed before the light-check command. Nothing was changed.');
        }
      };
      assertAuthority();
      return { lease: claim.lease, host: observed.host, assertAuthority };
    } catch (error) {
      await releaseCardRestoration(flow.flowId, claim.lease.id).catch(() => false);
      throw error;
    }
  };

  const startLightCheck = async () => {
    const activationId = flow.project.pendingActivationId;
    if (lightCheckState !== 'idle') return;
    setFailure('');
    setLightCheckNotice('');
    setLightCheckState('starting');
    let mutationAuthority = null;
    try {
      mutationAuthority = await acquireFreshLightCheckMutation();
      if (!activationId) {
        const frame = commissioningMarkerFrame(flow.project.snapshot);
        if (!frame.length) throw new Error('The saved project has no LED outputs to test.');
        const startMarkers = window.__LW_START_COMMISSIONING_MARKERS_FOR_TEST__;
        let session;
        if (typeof startMarkers === 'function') {
          mutationAuthority.assertAuthority();
          session = await startMarkers(frame, { host: mutationAuthority.host });
        } else {
          session = createWiringChaseSession({ host: mutationAuthority.host });
        }
        markerSessionRef.current = session;
        if (typeof startMarkers !== 'function') {
          mutationAuthority.assertAuthority();
          await session.show(frame);
        }
        markerTimeoutRef.current = window.setTimeout(() => {
          const active = markerSessionRef.current;
          markerSessionRef.current = null;
          markerTimeoutRef.current = null;
          void active?.stop?.().catch(() => {});
          setLightCheckState('idle');
          setLightCheckNotice('The 30-second marker test ended and the working look is restored.');
        }, 30_000);
        setLightCheckState('testing');
        return;
      }
      const activate = typeof window.__LW_ACTIVATE_COMMISSIONING_WIRING_FOR_TEST__ === 'function'
        ? window.__LW_ACTIVATE_COMMISSIONING_WIRING_FOR_TEST__
        : activateAndWaitForCardWiring;
      mutationAuthority.assertAuthority();
      const status = await activate(activationId, { host: mutationAuthority.host, timeoutMs: 18000 });
      if (status?.state !== 'testing' || status?.activationId !== activationId) {
        throw new Error('The card did not start the exact temporary wiring test.');
      }
      setLightCheckState('testing');
    } catch (error) {
      const session = markerSessionRef.current;
      markerSessionRef.current = null;
      if (session) await session.stop().catch(() => {});
      setFailure(error?.message || 'The bounded light test did not start. The previous working setup remains protected.');
      setLightCheckState('idle');
    } finally {
      if (mutationAuthority?.lease) {
        await releaseCardRestoration(flow.flowId, mutationAuthority.lease.id).catch(() => false);
      }
    }
  };

  const finishLightCheck = async visible => {
    const activationId = flow.project.pendingActivationId;
    if (lightCheckState !== 'testing') return;
    setFailure('');
    setLightCheckNotice('');
    setLightCheckState(visible ? 'confirming' : 'restoring');
    let mutationAuthority = null;
    try {
      mutationAuthority = await acquireFreshLightCheckMutation();
      if (!activationId) {
        if (markerTimeoutRef.current != null) window.clearTimeout(markerTimeoutRef.current);
        markerTimeoutRef.current = null;
        const session = markerSessionRef.current;
        markerSessionRef.current = null;
        mutationAuthority.assertAuthority();
        await session?.stop?.();
        if (visible) {
          await clearCardCommissioning({ flowId: flow.flowId });
          setLightCheckState('complete');
        } else {
          setLightCheckState('idle');
          setLightCheckNotice('The bounded marker test stopped and the working look is restored.');
        }
        return;
      }
      if (visible) {
        const confirm = typeof window.__LW_CONFIRM_COMMISSIONING_WIRING_FOR_TEST__ === 'function'
          ? window.__LW_CONFIRM_COMMISSIONING_WIRING_FOR_TEST__
          : confirmCardWiringCandidate;
        mutationAuthority.assertAuthority();
        const status = await confirm(activationId, { host: mutationAuthority.host });
        if (status?.state !== 'known-good' || (status?.activationId && status.activationId !== activationId)) {
          throw new Error('The card did not confirm the exact temporary wiring.');
        }
        await clearCardCommissioning({ flowId: flow.flowId });
        setLightCheckState('complete');
      } else {
        const rollback = typeof window.__LW_ROLLBACK_COMMISSIONING_WIRING_FOR_TEST__ === 'function'
          ? window.__LW_ROLLBACK_COMMISSIONING_WIRING_FOR_TEST__
          : rollbackCardWiringCandidate;
        mutationAuthority.assertAuthority();
        const status = await rollback(activationId, { host: mutationAuthority.host });
        if (status?.state !== 'known-good' || (status?.activationId && status.activationId !== activationId)) {
          throw new Error('The card did not restore the previous working wiring.');
        }
        const next = returnCardProjectToSetupAfterLightCheck(flow);
        await writeCardCommissioning(next);
        setFlow(next);
        setLightCheckState('idle');
      }
    } catch (error) {
      setFailure(error?.message || 'The card could not finish the wiring check. It will restore the previous setup when the test window ends.');
      setLightCheckState('testing');
    } finally {
      if (mutationAuthority?.lease) {
        await releaseCardRestoration(flow.flowId, mutationAuthority.lease.id).catch(() => false);
      }
    }
  };

  return (
    <div className="card-commissioning" data-stage={flow.stage} aria-live="polite">
      <CardCommissioningSteps stage={flow.stage} />
      {flow.stage === 'install-safely' && (
        <>
          <h3>Install safely</h3>
          <p>{flow.source === 'web-serial'
            ? 'The browser was interrupted before it recorded the result. Reconnect the card; Studio will inspect the exact card and firmware build before deciding what to do. It will not flash again automatically.'
            : 'Lightweaver is verifying the official firmware and keeping your saved Studio project available for restoration.'}</p>
          {flow.source === 'web-serial' && <button type="button" className="btn primary" onClick={reconnectInstalledCard}>Reconnect and inspect card</button>}
          {interruptedInstallEvidence && !interruptedInstallEvidence.ok && link?.card?.id && <p className="card-connection-failure" role="alert">{identityMessage(interruptedInstallEvidence.reason, flow.installTarget, link.card)} Nothing was changed.</p>}
        </>
      )}
      {flow.stage === 'set-up-card' && (
        <>
          <h3>Set up card</h3>
          {!flow.cardAcknowledgedAt && detection.state === 'return-to-gallery' && (
            <div className="card-commissioning-network">
              <p role="status"><strong>Wi-Fi saved on the exact card.</strong> Return this device to gallery WiFi. Studio is reusing the same card page and will continue only after the correlated station card is command-ready.</p>
              {detection.retryable && <button type="button" className="btn" onClick={retryStationRetarget}>Retry verified card page</button>}
            </div>
          )}
          {!flow.cardAcknowledgedAt && detection.state === 'found' && (
            <div className="card-commissioning-network">
              <p aria-live="polite"><strong>Card is back on your network — continuing…</strong></p>
            </div>
          )}
          {!flow.cardAcknowledgedAt && !['found', 'return-to-gallery'].includes(detection.state) && flow.networkState === 'setup-required' && (
            <div className="card-commissioning-network">
              <p>The clean installation reset Wi-Fi. First open this device’s Wi-Fi settings and join <strong>Lightweaver-XXXX</strong>. The setup address only works while that network is joined.</p>
              <button type="button" className="btn primary" onClick={confirmSetupNetwork}>I’ve joined Lightweaver-XXXX</button>
              {detection.state === 'searching' && <p role="status">Looking for {flow.expectedCard.id} on your network…</p>}
            </div>
          )}
          {!flow.cardAcknowledgedAt && !['found', 'return-to-gallery'].includes(detection.state) && flow.networkState === 'setup-joined' && (
            <div className="card-commissioning-network">
              <p><strong>Lightweaver-XXXX joined.</strong> If the card is still on its setup network, open it at 192.168.4.1, choose its permanent Wi-Fi, and return here. Once it rejoins your network Studio continues automatically. This progress stays saved while networks change.</p>
              <button type="button" className="btn" onClick={openSetupNetworkCard}>Open 192.168.4.1 Wi-Fi setup</button>
              <p role="status">{detection.state === 'searching' ? `Waiting for the card to rejoin your network — looking for ${flow.expectedCard.id}…` : 'Waiting for the card to rejoin your network…'}</p>
            </div>
          )}
          {!flow.cardAcknowledgedAt ? (
            <>
              <p>{identityFailure || 'Studio continues automatically once the exact card, firmware version, and firmware build answer on your network. You can also reconnect the installed card manually.'}</p>
              <button type="button" className="btn" onClick={reconnectInstalledCard} disabled={reconnecting}>{reconnecting ? 'Reconnecting…' : 'Reconnect installed card'}</button>
            </>
          ) : (
            <>
              <p>The exact installed card and firmware build are verified. Restore the saved Studio revision that contains its GPIO outputs, LED map, zones, patterns, playlist, and controls.</p>
              {!restorePreflight.ok && <p role="status">Checking card. Restore stays locked until the exact installed card and firmware are command-ready.</p>}
              <button type="button" className="btn primary" onClick={restore} disabled={restoreState === 'working' || !restorePreflight.ok}>{restoreState === 'working' ? 'Restoring saved project…' : 'Restore saved project'}</button>
            </>
          )}
        </>
      )}
      {flow.stage === 'check-lights' && (
        <>
          <h3>Check lights</h3>
          {!lightCheckPreflight.ok && <p role="status">Checking card. Light-check controls stay locked until the exact card is stable and command-ready.</p>}
          <p>{flow.project.pendingActivationId
            ? 'The saved Studio project revision is staged on this exact card. The bounded physical light check will test its GPIO wiring before making it permanent.'
            : 'The saved Studio project revision is installed on this exact card. Continue to the bounded physical light check.'}</p>
          {flow.project.pendingActivationId ? (
            <div className="card-commissioning-network">
              {lightCheckState === 'testing' ? (
                <>
                  <p>Check every connected output. Do you see a <strong>blue first pixel and red final pixel</strong>, with the expected LEDs between them?</p>
                  <div className="card-connection-actions">
                    <button type="button" className="btn primary" disabled={!lightCheckPreflight.ok} onClick={() => finishLightCheck(true)}>Yes, every output is correct</button>
                    <button type="button" className="btn" disabled={!lightCheckPreflight.ok} onClick={() => finishLightCheck(false)}>No, restore working setup</button>
                  </div>
                </>
              ) : (
                <>
                  <p>The test lasts at most 90 seconds. Until you confirm the real LEDs, the card keeps the previous working wiring ready to restore automatically.</p>
                  <button type="button" className="btn primary" disabled={lightCheckState !== 'idle' || !lightCheckPreflight.ok} onClick={startLightCheck}>{lightCheckState === 'starting' ? 'Starting bounded light test…' : 'Start 90-second light test'}</button>
                </>
              )}
            </div>
          ) : (
            <div className="card-commissioning-network">
              {lightCheckState === 'testing' ? (
                <>
                  <p>Check every connected output. Do you see a <strong>blue first pixel and red final pixel</strong>, with green LEDs between them?</p>
                  <div className="card-connection-actions">
                    <button type="button" className="btn primary" disabled={!lightCheckPreflight.ok} onClick={() => finishLightCheck(true)}>Yes, every output is correct</button>
                    <button type="button" className="btn" disabled={!lightCheckPreflight.ok} onClick={() => finishLightCheck(false)}>No, restore working look</button>
                  </div>
                </>
              ) : (
                <>
                  <p>This marker frame runs for at most 30 seconds, then releases the card back to its normal working look automatically.</p>
                  <button type="button" className="btn primary" disabled={lightCheckState !== 'idle' || !lightCheckPreflight.ok} onClick={startLightCheck}>{lightCheckState === 'starting' ? 'Starting bounded marker test…' : 'Start bounded marker test'}</button>
                </>
              )}
              {lightCheckNotice && <p role="status">{lightCheckNotice}</p>}
            </div>
          )}
        </>
      )}
      {failure && <p className="card-connection-failure" role="alert">{failure}</p>}
    </div>
  );
}

export { runtimePackageFromSnapshot };
